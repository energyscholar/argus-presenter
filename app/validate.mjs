/*
 * validate.mjs — content-module validator (Plan 0438 Group D, 0440 §5 schema).
 * Pure, no throw, WARN-never-blocks. Importable in the browser (panels) and on the
 * server (setModule + /api/modules). A module ALWAYS loads/delivers; this only informs.
 *
 *   import { validate, summarize } from './validate.mjs';
 *   const { warnings } = validate(module, { knownComponents, availableRequires });
 *   // warnings: [{ code, level:'warn'|'info', msg, beatIndex? }]
 *
 * Schema (neutral naming — Library › Series › Module › Section › Sequence › Beat › Layer):
 *   { manifest:{title,version,kind,summary,requirements:{terminalClear,gateTimeoutMs,assets,perUserPush}},
 *     sections:[{id,title,kind,summary,beatIds:[],sequences?:[{id,title,beatIds:[]}]}],
 *     beats:[{id,component,opts,promptId?,target?,requires?,gate?:{user,target},branch?,variantOf?,
 *             layers?:[{target|when,opts}],durationSec?,onDemand?}] }
 */

/*
 * The 16 real components in components/, plus 'clear' as a recognised terminal pseudo-beat.
 *
 * ⛓ THIS IS THE THIRD OF THREE LISTS THAT MUST AGREE, and it is the one that drifted.
 * The other two are the `components/` directory listing (the server-side registry) and
 * `harness/core-schemas.mjs` (from which `docs/component-manifest.json` is GENERATED —
 * do not hand-edit the JSON, it is rewritten by `harness/gen-manifest.mjs`).
 *
 * `navmap` (S210) and `prose` (0493) joined `components/` and were added to `core-schemas.mjs`
 * by plan 0525 P5 — which never touched this file. The result: for months, every authored beat
 * using either one was reported `V3-unknown-component` by any caller that did not pass its own
 * `knownComponents`, and neither appeared in the authoring pick-list built off this default.
 * The test that was written to catch exactly this drift (`t80`) compared the OTHER TWO lists and
 * not this one, so a 14-vs-16 disagreement survived its own guard. `t80` now compares all three.
 * ⇒ Adding a directory under `components/` means editing `core-schemas.mjs` AND this list.
 */
export const DEFAULT_COMPONENTS = [
  'card', 'choice', 'crud', 'dice', 'form', 'image', 'map', 'narration', 'navmap',
  'poll-results', 'prose', 'scene', 'slider', 'stepper', 'svg-reactive', 'text-input',
];
/*
 * Plan 0525 P1.3 — THE DECLARED BEAT KEYS.
 *
 * `onDemand` — a note to whoever is presenting, meaning "this beat is prepared but is not on the
 * linear path; show it only when they ask for it" — sat inert in authored modules for months
 * because NOTHING ANYWHERE SAID THE FIELD EXISTED. Neither presenting surface rendered it and the
 * validator did not know its name, so the marker could not be seen, and its absence could not be
 * noticed either. This list is the cure: every beat-level key the product actually reads, in one
 * place, so the next field an author invents is ANNOUNCED rather than silently ignored.
 *
 * ⚠ ALLOW-LIST, ADVISORY ONLY (I4 — the permissive default). An unlisted key produces `info`,
 * NEVER `warn` and never an error, because authoring metadata the product does not read is
 * perfectly legitimate: a beat may carry whatever its author finds useful. The only fact being
 * reported is "the product will not act on this" — precisely the fact that was missing.
 */
export const KNOWN_BEAT_KEYS = [
  'id', 'component', 'opts', 'promptId', 'target', 'requires',
  'gate', 'branch', 'variantOf', 'layers', 'durationSec',
  // Read by presenter_beats (the MCP cue sheet) and beatRow() (the GM outline) — 0525 P1.1/P1.2.
  // It informs the presenter and changes NO navigation: R5.
  'onDemand',
  /*
   * `sectionId` — a beat's back-reference to the `sections[].id` it belongs to, the inverse of the
   * `sections[].beatIds[]` edge the schema already carries. DECLARED AHEAD OF ITS USE, on purpose:
   * 0527 P2 renames the existing authored key `phase` → `sectionId` across 29 modules. V21 reports
   * every distinct beat key outside this list as `info`, so landing that rename first would have
   * made all 29 modules announce an undeclared key on load — a seam shipping as noise, in the very
   * mechanism 0525 P1.3 added to make new fields VISIBLE rather than silent. Listing the name here
   * costs one line and means the rename arrives quiet.
   * ⚠ Like every entry in this list, this declares only that the name is KNOWN. Nothing reads it
   * yet; V21's contract is "the product will not act on this", and that remains true until it does.
   */
  'sectionId',
];

const TERMINAL_PSEUDO = 'clear';
const INTERACTIVE = new Set(['choice', 'dice', 'text-input', 'slider', 'form']);
const PASSIVE = new Set(['card', 'narration', 'image']);

const pid = (b) => (b && (b.promptId != null ? b.promptId : (b.opts && b.opts.promptId))) || null;

export function validate(module, ctx = {}) {
  const warnings = [];
  const warn = (code, msg, beatIndex) => warnings.push({ code, level: 'warn', msg, beatIndex });
  const info = (code, msg, beatIndex) => warnings.push({ code, level: 'info', msg, beatIndex });

  const known = new Set([...(ctx.knownComponents || DEFAULT_COMPONENTS), TERMINAL_PSEUDO]);
  const avail = ctx.availableRequires ? new Set(ctx.availableRequires) : null;
  const m = module || {};
  const beats = Array.isArray(m.beats) ? m.beats : [];
  const sections = Array.isArray(m.sections) ? m.sections : [];
  const req = (m.manifest && m.manifest.requirements) || {};

  if (!m.manifest) info('V1-no-manifest', 'module has no manifest (title/version/requirements)');
  if (beats.length === 0) { warn('V2-empty', 'module has zero beats'); return { warnings }; }

  // --- beat id index (V11) ---
  const idIndex = new Map();      // id -> first index
  beats.forEach((b, i) => {
    if (b && b.id != null) { if (idIndex.has(b.id)) warn('V11-dup-beat-id', `beat ${i}: duplicate id "${b.id}" (also beat ${idIndex.get(b.id)})`, i); else idIndex.set(b.id, i); }
  });
  const beatIdSet = new Set(idIndex.keys());

  // --- per-beat checks ---
  const promptSeen = new Map();  // promptId -> index (interactive, non-variant only) — V5
  let passiveRun = 0;
  beats.forEach((b, i) => {
    const comp = b && b.component;
    if (!comp || !known.has(comp)) warn('V3-unknown-component', `beat ${i}: unknown component "${comp}"`, i);

    const p = pid(b);
    if (p && String(p).includes(':')) warn('V4-promptid-colon', `beat ${i}: promptId "${p}" contains ':' — use '-'`, i);
    // V5 dup-promptId: only among INTERACTIVE beats that are NOT declared variants (variantOf).
    if (p && INTERACTIVE.has(comp) && !b.variantOf) {
      if (promptSeen.has(p)) warn('V5-dup-promptid', `beat ${i}: interactive promptId "${p}" also at beat ${promptSeen.get(p)}`, i);
      else promptSeen.set(p, i);
    }
    if (INTERACTIVE.has(comp) && !p) warn('V6-interactive-no-promptid', `beat ${i}: ${comp} has no promptId`, i);

    // V13 dice needs a gate.target to compare a roll; a branch{ok,fail} needs gate; gated beat needs gate.user.
    if (comp === 'dice') {
      const g = b.gate || {};
      if (b.branch && (b.branch.ok || b.branch.fail) && typeof g.target !== 'number') warn('V13-dice-no-gate', `beat ${i}: dice branch has no gate.target to compare the roll`, i);
      if (b.gate && !b.gate.user) warn('V13-dice-no-gate', `beat ${i}: gated beat has no gate.user`, i);
    }

    // V12 branch targets must exist among beat ids.
    if (b.branch && typeof b.branch === 'object') {
      const targets = [];
      for (const k of Object.keys(b.branch)) {
        const v = b.branch[k];
        if (k === 'ifFlag' && v && typeof v === 'object') Object.values(v).forEach((t) => targets.push(t));
        else if (typeof v === 'string') targets.push(v);
      }
      targets.forEach((t) => { if (t && t !== TERMINAL_PSEUDO && !beatIdSet.has(t)) warn('V12-branch-target-missing', `beat ${i}: branch target "${t}" is not a beat id`, i); });
    }

    // V18 layer target shape (per-user variant): target must look like a userId/role, or `when` present.
    if (Array.isArray(b.layers)) b.layers.forEach((L, li) => {
      if (L && L.target == null && L.when == null) info('V18-layer-target', `beat ${i} layer ${li}: neither target nor when specified`, i);
    });

    if (avail && Array.isArray(b.requires)) b.requires.forEach((r) => { if (!avail.has(r)) info('V9-requires-unknown', `beat ${i}: requires "${r}" not in available set`, i); });

    if (PASSIVE.has(comp)) { passiveRun++; if (passiveRun === 3) info('V8-passive-run', `beats ${i - 2}-${i}: 3+ passive beats in a row (pacing smell)`, i); } else passiveRun = 0;
  });

  // --- section / sequence structure (V14-V17) ---
  const secIds = new Set();
  const inSomeSection = new Set();
  sections.forEach((s, si) => {
    if (s.id != null) { if (secIds.has(s.id)) warn('V17-dup-section-id', `section ${si}: duplicate id "${s.id}"`); else secIds.add(s.id); }
    const sBeatIds = Array.isArray(s.beatIds) ? s.beatIds : [];
    sBeatIds.forEach((bid) => { if (!beatIdSet.has(bid)) warn('V14-section-beatid-missing', `section "${s.id || si}": beatId "${bid}" is not a beat id`); else inSomeSection.add(bid); });
    if (Array.isArray(s.sequences)) s.sequences.forEach((sq) => {
      (sq.beatIds || []).forEach((bid) => {
        if (!beatIdSet.has(bid)) warn('V14-section-beatid-missing', `sequence "${sq.id}": beatId "${bid}" is not a beat id`);
        else { inSomeSection.add(bid); if (!sBeatIds.includes(bid)) info('V16-sequence-subset', `sequence "${sq.id}" beat "${bid}" is not in parent section "${s.id}" beatIds`); }
      });
    });
  });
  // V15 orphan beats (only meaningful if sections are declared)
  if (sections.length) beats.forEach((b, i) => { if (b.id != null && !inSomeSection.has(b.id)) info('V15-orphan-beat', `beat ${i} ("${b.id}") is in no section`, i); });

  // V7 terminal affordance: a clear pseudo-beat, a branch that clears, or a manifest declaration.
  const hasTerminalClear = beats.some((b) => b && (b.component === TERMINAL_PSEUDO || (b.branch && b.branch.clear))) || req.terminalClear === true;
  if (!hasTerminalClear) info('V7-no-terminal-affordance', 'no terminal clear beat and manifest.requirements.terminalClear not declared — clients may stick on the last beat');

  // V10 declared gate timeout too short for humans
  if (typeof req.gateTimeoutMs === 'number' && req.gateTimeoutMs < 60000) info('V10-gate-timeout-short', `manifest gateTimeoutMs=${req.gateTimeoutMs} < 60000 (human-latency risk)`);

  // V19 (SCH-1) advisory-only, module-level (not per-beat, to avoid noise): a module with beats
  // but zero numeric durationSec anywhere → no time estimate rolls up in the GM outline.
  const anyDuration = beats.some((b) => b && Number.isFinite(b.durationSec));
  if (!anyDuration) info('V19-no-duration', 'no beat carries a numeric durationSec — no time estimate in the outline');

  // V20 (DEF-1) advisory-only, module-level: a module with beats but no manifest.defaultBeatId
  // has no title/default page, so it shows branding on load until Start. Advisory (matches V19's
  // tone) even though most existing modules trip it.
  if (beats.length && !(m.manifest && m.manifest.defaultBeatId)) info('V20-no-default', 'no manifest.defaultBeatId — module shows branding on load until Start (no title page)');

  // V21 (Plan 0525 P1.3) advisory-only, MODULE-level — not per-beat, for the reason V19/V20 give:
  // a key repeated across 300 beats would produce 300 lines and be deleted within a week. Reports
  // the DISTINCT beat-level keys outside KNOWN_BEAT_KEYS once, with the allow-list beside them so
  // the reader can tell a typo from deliberate metadata without opening this file.
  const knownBeatKeys = new Set(KNOWN_BEAT_KEYS);
  const undeclaredKeys = [...new Set(beats.reduce((acc, b) => (b && typeof b === 'object') ? acc.concat(Object.keys(b)) : acc, []))]
    .filter((k) => !knownBeatKeys.has(k)).sort();
  if (undeclaredKeys.length) info('V21-undeclared-beat-key', `beat keys the product does not read: ${undeclaredKeys.join(', ')} — authoring metadata is fine, nothing acts on them. Declared keys: ${KNOWN_BEAT_KEYS.join(', ')}`);

  return { warnings };
}

export function summarize(result) {
  const w = (result.warnings || []).filter((x) => x.level === 'warn');
  const i = (result.warnings || []).filter((x) => x.level === 'info');
  return { warn: w.length, info: i.length, warnings: w, infos: i };
}
