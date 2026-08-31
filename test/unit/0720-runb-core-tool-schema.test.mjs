/*
 * Plan 0720 RUN B — B11's LINT, EXTENDED TO THE TOOLS B11 COULD NOT SEE.
 *
 * ⛔⛔ WHY A SECOND FILE AND NOT A LINE IN THE FIRST ONE. `0720-b11-schema-matches-handler` reads
 * PLUGIN SOURCES off disk and text-scans for `addTool({…})`. CORE tools are not registered that way:
 * they are object literals in `coreTools` (mcp/tools.mjs), so the existing lint globs right past all
 * forty-eight of them. RUN B adds five core tools, and shipping them into a blind spot would put
 * them in exactly the position `combat_acted` was in — declaring `stations` while its handler read
 * `station`, answering 200 with the wrong branch, with fourteen tests calling it the handler's way.
 * → [[feedback-a-test-written-from-the-implementation-cannot-catch-a-contract-mismatch]]
 *
 * ⭐⭐ AND THIS ONE READS THE RUNTIME, NOT THE SOURCE — which the plugin lint could not do, because
 * `pluginTools()` returns a projection without handlers. `coreTools` carries the real functions, so
 * `Function.prototype.toString` gives the parameter pattern exactly as the engine parsed it. No
 * globbing, no window heuristics, nothing skipped for being unparseable.
 *
 * ⛔ AND THE BRACE-MATCHING IS THE WHOLE OF THE PARSER. The obvious `\\(\\s*\\{([^}]*)\\}` truncates at
 * the FIRST `}`, which in practice is an object DEFAULT — `opts = {}`, `requires = []`. Run over the
 * core surface it reported EIGHT offenders, every one a false positive, all from `push_component`
 * and `presenter_push_content` whose handlers destructure perfectly well. ⭐ That matters more than
 * a tidy regex: a lint that is mostly noise teaches people to skim it, and skimming is how the one
 * true positive gets missed. Measured 2026-08-31, and the same expression is still in the plugin
 * lint — see the note there.
 *
 * ⛔ DOMAIN-FREE: this reads whatever the core surface happens to declare and names nothing.
 */
import { test, expect, check } from '../../harness/test.mjs';
import { coreTools, voiceTools } from '../../mcp/tools.mjs';

/**
 * The destructured parameter names of a function whose first parameter is an object pattern.
 * Returns null for an opaque or absent argument, 'REST' when a rest element makes every remaining
 * key reachable, else the list of names.
 */
export function destructuredNames(fn) {
  const src = String(fn);
  const open = src.indexOf('{');
  const paren = src.indexOf(')');
  if (open < 0) return null;
  if (paren >= 0 && paren < open) return null;                 // `()` / `(x)` — no object pattern
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  const body = src.slice(open + 1, end);
  /* ⛔ A REST ELEMENT COLLECTS EVERY REMAINING KEY, so a declared property the handler never NAMES
     is still reachable through it. Nothing can be proved about such a tool; say so, do not accuse. */
  if (/\.\.\./.test(body)) return 'REST';
  const parts = [];
  let d = 0, cur = '';
  for (const ch of body) {                                      // split on TOP-LEVEL commas only
    if (ch === '{' || ch === '[' || ch === '(') d++;
    else if (ch === '}' || ch === ']' || ch === ')') d--;
    if (ch === ',' && d === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim().split(/[:=]/)[0].trim()).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
}

test('0720 RUN-B — the lint can report BAD (a gate seen only passing is untested)', () => {
  const decoy = { input: { properties: { misspelled: {} } }, handler: async ({ correct = null } = {}) => correct };
  const read = destructuredNames(decoy.handler);
  check('the decoy declares a property', 'misspelled' in decoy.input.properties);
  check('and the lint sees the handler does not read it', !read.includes('misspelled'), JSON.stringify(read));

  /* ⛔ THE FALSE-POSITIVE CASE, PINNED. This is the shape the naive expression truncates on. */
  const withDefault = { handler: async ({ component, opts = {}, target = 'all', requires = [] } = {}) => [component, opts, target, requires] };
  const names = destructuredNames(withDefault.handler);
  check('⛔ a name AFTER an object default is still seen — the naive `[^}]*` stops at `opts = {`',
    names.includes('target') && names.includes('requires'), JSON.stringify(names));
});

test('0720 RUN-B — every CORE tool declares only inputs its handler actually reads', () => {
  const tools = [...coreTools, ...voiceTools];
  expect(tools.length > 0, 'there is a core surface to lint', String(tools.length));

  const offenders = [], skipped = [];
  let checked = 0;
  for (const t of tools) {
    const props = t.input && t.input.properties ? Object.keys(t.input.properties) : [];
    if (!props.length) { skipped.push(`${t.name} (declares no properties)`); continue; }
    const read = destructuredNames(t.handler);
    if (read === null) { skipped.push(`${t.name} (opaque argument)`); continue; }
    if (read === 'REST') { skipped.push(`${t.name} (rest element)`); continue; }
    checked++;
    for (const key of props) {
      /* ⛔ THE DIRECTION THAT MATTERS: a declared property the handler never reads is a promise the
         tool does not keep. The caller supplies it, gets a 200, and the value is discarded. */
      if (!read.includes(key)) offenders.push(`${t.name} declares "${key}" — handler reads [${read.join(', ')}]`);
    }
  }
  console.log(`      linted ${checked} core tool(s) of ${tools.length}; skipped ${skipped.length}`);
  expect(checked > 0, 'the sweep was not vacuous');
  expect(offenders.length === 0, 'no core tool declares an input its handler never reads', offenders.join(' | '));
});

test('0720 RUN-B — the five board tools are IN this lint\'s scope, not merely passing it', () => {
  /* ⚠ A lint that silently skips the thing it was extended for reports green and proves nothing —
     which is precisely how B11's first draft reported `checked 0`. */
  const T = Object.fromEntries(coreTools.map((t) => [t.name, t]));
  for (const name of ['board_read', 'board_write', 'board_add', 'board_remove', 'board_path']) {
    expect(!!T[name], `${name} is on the core surface`);
    const read = destructuredNames(T[name].handler);
    check(`${name} is parseable — not skipped as opaque or rest`, Array.isArray(read), String(read));
    check(`${name} declares at least one input`, Object.keys(T[name].input.properties || {}).length > 0);
  }
});
