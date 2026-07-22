/*
 * Plan 0488 — MCP SURFACE COVERAGE.
 *
 * Guards the recurring S210 bug: the server gains a capability, the agent-facing MCP surface
 * does not, and NOTHING FAILS. Six instances in one evening; the worst was `profile`, which
 * silently ran a live six-person session on the SOLO `wearable` profile (maxPending:1, floor
 * disabled) and produced symptoms that looked like a backpressure defect that did not exist.
 *
 * Every createServer() option and every api method must be declared in mcp/surface-coverage.mjs
 * as {tool} or {declined:'reason'}. This test diffs the manifest against the real code IN BOTH
 * DIRECTIONS, so a new option fails and a stale manifest entry fails too.
 *
 * NOTE (plan §5): the option list is parsed from createServer.toString(). That is deliberately
 * brittle — if the signature style changes this fails LOUDLY and a human looks. A brittle test
 * that fires on a real change beats no test at all. Keep it cheap (port 0, no fixtures) so it
 * never becomes annoying enough to delete.
 *
 * The tool lists are read as DECLARED (coreTools + voiceTools), never through activeTools(),
 * because the env gate on the voice tools is itself one of the six gaps — checking through the
 * gate would hide the very bug from its own test.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { coreTools, voiceTools } from '../../mcp/tools.mjs';
import { CONSTRUCTOR_COVERAGE, API_COVERAGE } from '../../mcp/surface-coverage.mjs';

const ALL_TOOLS = [...coreTools, ...voiceTools];
const TOOL = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t]));

function constructorOptions() {
  const src = createServer.toString();
  const open = src.indexOf('({');
  const close = src.indexOf('} = {})', open);
  expect(open > -1 && close > open, 'createServer signature is parseable — if this fails the signature STYLE changed; update the parser here, then re-check the manifest');
  return src.slice(open + 2, close)
    .split(/,(?![^{[]*[}\]])/)
    .map((p) => p.trim().split('=')[0].trim())
    .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
}

function checkEntry(name, entry, kind, schemaCheck) {
  expect(entry, `${kind} "${name}" is MISSING from the coverage manifest. Add it to mcp/surface-coverage.mjs as {tool:'<toolName>'} (reachable by the agent) or {declined:'<why not>'} (deliberate). Saying no is fine — saying nothing is not.`);
  const hasTool = typeof entry.tool === 'string' && entry.tool.length > 0;
  const hasDeclined = typeof entry.declined === 'string' && entry.declined.trim().length > 0;
  expect(hasTool || hasDeclined, `${kind} "${name}" must declare {tool} or a NON-EMPTY {declined} reason — an unargued "no" is not a decision`);
  if (hasTool) {
    expect(TOOL[entry.tool], `${kind} "${name}" claims tool "${entry.tool}", which is not a declared tool`);
    if (schemaCheck) schemaCheck(name, entry);
  }
}

test('0488 — every createServer() option is covered or reasonedly declined', async () => {
  const opts = constructorOptions();
  expect(opts.length >= 10, 'parsed a plausible option list', opts.length);
  for (const name of opts) {
    checkEntry(name, CONSTRUCTOR_COVERAGE[name], 'createServer option', (n, entry) => {
      // A tool that merely EXISTS does not cover an option — its input schema must actually
      // accept it (under its own name or a declared `as:` alias).
      const props = (TOOL[entry.tool].input && TOOL[entry.tool].input.properties) || {};
      const key = entry.as || n;
      expect(Object.prototype.hasOwnProperty.call(props, key),
        `createServer option "${n}" is mapped to tool "${entry.tool}", but that tool's input schema has no "${key}" property — the option is still unreachable`);
    });
  }
  // Reverse direction: a manifest entry for an option that no longer exists is stale.
  for (const name of Object.keys(CONSTRUCTOR_COVERAGE)) {
    expect(opts.includes(name), `manifest lists createServer option "${name}", which no longer exists — remove or rename it`);
  }
});

test('0488 — every api method is covered or reasonedly declined', async () => {
  const server = await createServer({ port: 0 });
  try {
    const keys = Object.keys(server);
    expect(keys.length > 20, 'api surface looks plausible', keys.length);
    for (const name of keys) checkEntry(name, API_COVERAGE[name], 'api method', null);
    for (const name of Object.keys(API_COVERAGE)) {
      expect(keys.includes(name), `manifest lists api method "${name}", which no longer exists — remove or rename it`);
    }
  } finally { await server.close(); }
});

test('0488 — the guard itself fails on drift (meta-test)', async () => {
  // T2: an undeclared option must be rejected.
  let threw = false;
  try { checkEntry('brandNewKnob', undefined, 'createServer option', null); } catch (e) { threw = true; }
  expect(threw, 'an undeclared option FAILS');
  // T4: an empty declined reason must be rejected.
  threw = false;
  try { checkEntry('x', { declined: '   ' }, 'createServer option', null); } catch (e) { threw = true; }
  expect(threw, 'an empty {declined} reason FAILS');
  // T5: a tool whose schema lacks the property must be rejected.
  threw = false;
  try {
    checkEntry('nope', { tool: 'presenter_start' }, 'createServer option', (n, entry) => {
      const props = (TOOL[entry.tool].input && TOOL[entry.tool].input.properties) || {};
      expect(Object.prototype.hasOwnProperty.call(props, n), 'schema must carry the property');
    });
  } catch (e) { threw = true; }
  expect(threw, 'a tool whose schema lacks the property FAILS');
  // A real tool name resolves.
  expect(TOOL.presenter_start, 'presenter_start is a declared tool');
});

test('0488 — voice tools are covered as DECLARED, not through the env gate', async () => {
  // The env gate on voice tools was itself gap #3 (agent could not open a mic). If this test
  // resolved tools through activeTools(), that gap would hide from its own guard.
  expect(voiceTools.length > 0, 'voiceTools is non-empty as declared');
  const names = new Set(ALL_TOOLS.map((t) => t.name));
  expect(names.has('presenter_voice_enable'), 'presenter_voice_enable is visible to the guard regardless of PRESENTER_VOICE_ENABLED');
  expect(API_COVERAGE.voiceEnable && API_COVERAGE.voiceEnable.tool === 'presenter_voice_enable', 'api.voiceEnable maps to the voice tool');
});
