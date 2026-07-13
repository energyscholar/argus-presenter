/*
 * branch.mjs — pure branch resolution shared by the panel's branch navigation
 * and the Arabus runner. Dependency-free; never throws.
 *
 * Branch-table shapes on a beat (neutral schema, plans 0439/0440):
 *   choice beat:  branch: { "<choiceValue>": "<beatId>", ... }
 *   dice beat:    gate: { user, target } + branch: { ok: "<beatId>", fail: "<beatId>" }
 *   flag route:   branch: { default: "<beatId>", ifFlag: { "<flagName>": "<beatId>" } }
 *   plain/linear: branch: { next: "<beatId>" }
 */

/** Resolve the next beat id (string) or null. Pure; never throws. */
export function resolveNext(beat, result = {}, flags = {}) {
  if (!beat || !beat.branch) return null;
  const branch = beat.branch;

  // 1. ifFlag first: first truthy flag wins.
  if (branch.ifFlag && typeof branch.ifFlag === 'object') {
    for (const k of Object.keys(branch.ifFlag)) {
      if (flags && flags[k]) return branch.ifFlag[k];
    }
  }

  // 2. dice: numeric gate target compared against result.value.
  if (beat.component === 'dice' && beat.gate && typeof beat.gate.target === 'number') {
    const total = Number(result && result.value);
    if (!Number.isNaN(total)) {
      return total >= beat.gate.target ? (branch.ok ?? null) : (branch.fail ?? null);
    }
  }

  // 3. value branch (choice etc.).
  if (result && result.value != null && branch[result.value] != null) {
    return branch[result.value];
  }

  // 4. default / linear.
  return branch.next ?? branch.default ?? null;
}
