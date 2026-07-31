/*
 * Plan 0522 P6 — THE DECLARED DIFFERENCE, AND THE SLOT THAT HOLDS ONE BEAT.
 *
 *   t16a (R18) — `stage_beat` / `send_beat` are deliberately ABSENT from the MCP surface. Under
 *         I1 that is legitimate ONLY while it is declared and tested: *"where they must differ,
 *         the difference is declared and tested, never discovered live."* This test fails if the
 *         `declined:` declaration disappears, and fails if the tools appear on the MCP surface
 *         while still declared declined. It does NOT close the hole — closing it is plan 0523's
 *         job — it stops the hole from being rediscovered by an agent mid-session.
 *         `show_beat`'s parity is asserted UNCHANGED: two-stage delivery added a difference, it
 *         did not take one away.
 *
 *   t16 (server half) — staging a second beat destroys the first. The slot holds one candidate,
 *         so the ack must SAY which one it evicted; an unsent beat that disappears without a word
 *         is I5's silent non-delivery wearing a different coat. The browser half of t16 lives in
 *         test/component/0522-p6-staged-vs-live.test.mjs.
 *
 * Unit tier: pure server + a static manifest read. No browser, no port but `port: 0`, and
 * nothing here reads or writes the repo's modules/ directory (§ANNEAL E).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { coreTools, voiceTools } from '../../mcp/tools.mjs';
import { API_COVERAGE } from '../../mcp/surface-coverage.mjs';

const TOOL_NAMES = new Set([...coreTools, ...voiceTools].map((t) => t.name));

/** Every place a capability can be declared: the manifest entry, and the live tool list. */
function surfaceOf(apiName, toolName) {
  const entry = API_COVERAGE[apiName];
  return {
    declaredAtAll: !!entry,
    declined: !!(entry && typeof entry.declined === 'string' && entry.declined.trim().length > 0),
    reason: entry && entry.declined,
    boundTool: entry && entry.tool,
    toolExists: TOOL_NAMES.has(toolName),
  };
}

test('0522 t16a (R18) — the MCP surface\'s lack of stage_beat/send_beat is DECLARED, not a gap', async () => {
  // ── The declaration must EXIST. A capability that vanishes from the manifest is exactly the
  // S210 failure the manifest was built to prevent, and deleting the entry is the cheapest way
  // to make this test green — so that is the first thing it refuses.
  for (const [api, tool] of [['stageBeat', 'stage_beat'], ['sendBeat', 'send_beat']]) {
    const s = surfaceOf(api, tool);
    expect(`api.${api} is declared in mcp/surface-coverage.mjs at all`, s.declaredAtAll,
      `API_COVERAGE.${api} is missing — a capability with no declaration is the exact bug this manifest exists to catch`);

    // ── Either it is DECLINED and absent, or it is BOUND to a tool that really exists. What is
    // forbidden is the third state: the tool appearing on the surface while the manifest still
    // says it was declined — a difference that is no longer declared, i.e. a live surprise.
    if (s.declined) {
      expect(`api.${api} carries a REASON, not a bare flag`, s.reason.length > 40, JSON.stringify(s.reason));
      expect(`the declined reason names the ruling and the plan that owes closure (R18 → 0523)`,
        /R18/.test(s.reason) && /0523/.test(s.reason), JSON.stringify(s.reason));
      expect(`${tool} is NOT on the MCP surface while api.${api} is declared declined`, !s.toolExists,
        `${tool} exists as a tool but the manifest still calls it declined — the difference stopped being declared`);
    } else {
      expect(`api.${api} is bound to a tool`, !!s.boundTool, JSON.stringify(s));
      expect(`the tool api.${api} names actually exists on the MCP surface`, TOOL_NAMES.has(s.boundTool),
        `manifest says ${s.boundTool}, which is not in coreTools+voiceTools`);
    }
  }

  // ── show_beat's PARITY IS UNCHANGED. R4's whole safety argument is that nothing an agent does
  // today regresses: the publish path stays reachable and identical from both surfaces. If this
  // ever fails, two-stage delivery did not add a declared difference — it removed a capability.
  const sb = surfaceOf('showBeat', 'show_beat');
  expect('api.showBeat is still BOUND to a tool, not declined', !sb.declined && sb.boundTool === 'show_beat', JSON.stringify(sb));
  expect('show_beat is still on the MCP surface (R4 parity, unchanged)', sb.toolExists, [...TOOL_NAMES].join(','));

  // ── And the publish path still behaves the same in-process, which is what "identical on both
  // surfaces" actually means. A manifest entry alone would be a paper parity.
  const server = await createServer({ port: 0 });
  try {
    server.setModule({ title: 'parity', beats: [{ id: 'p1', component: 'card', opts: { title: 'One' } }, { id: 'p2', component: 'card', opts: { title: 'Two' } }] });
    const r = server.showBeat('p2');
    expect('show_beat still publishes immediately from the in-process surface', r && r.index === 1, JSON.stringify(r));
    expect('and moves the live beat, exactly as before', server.store.get('module/current') === 1, String(server.store.get('module/current')));
    expect('with no staging slot involved', server.stagedBeat({ key: 'api' }) === null, JSON.stringify(server.stagedBeat({ key: 'api' })));
  } finally { await server.close(); }
});

test('0522 t16 (server) — staging over an UNSENT candidate reports what it destroyed', async () => {
  const server = await createServer({ port: 0 });
  try {
    server.setModule({ title: 'stack', beats: [
      { id: 'a1', component: 'card', opts: { title: 'Alpha' } },
      { id: 'a2', component: 'card', opts: { title: 'Beta' } },
      { id: 'a3', component: 'card', opts: { title: 'Gamma' } },
    ] });
    const KEY = 'ws:t16';

    // First stage into an empty slot destroys nothing, and must not invent a loss.
    const first = server.stageBeat('a1', { key: KEY });
    expect('the first stage reports NOTHING replaced', first.ok === true && first.replaced === null, JSON.stringify(first));

    // Second stage evicts the first — and says so, naming the beat that never shipped.
    const second = server.stageBeat('a2', { key: KEY });
    expect('the second stage reports the beat it evicted', second.ok === true && second.replaced && second.replaced.beatId === 'a1',
      JSON.stringify(second));
    expect('and names its index too, so an id-less beat is still describable (I4)',
      second.replaced.index === 0, JSON.stringify(second.replaced));
    expect('the slot now holds the SECOND beat', (server.stagedBeat({ key: KEY }) || {}).beatId === 'a2',
      JSON.stringify(server.stagedBeat({ key: KEY })));

    // Re-staging the SAME beat loses nothing, so it must not cry wolf — a warning that fires on a
    // harmless action is a warning the operator learns to ignore before the one that matters.
    const again = server.stageBeat('a2', { key: KEY });
    expect('re-staging the same beat reports no replacement', again.ok === true && again.replaced === null, JSON.stringify(again));

    // Eviction is PER-CALLER: a second controller staging its own beat destroys nothing of ours.
    const other = server.stageBeat('a3', { key: 'ws:other' });
    expect('another controller\'s stage evicts nothing of ours', other.replaced === null, JSON.stringify(other));
    expect('and leaves our slot intact', (server.stagedBeat({ key: KEY }) || {}).beatId === 'a2',
      JSON.stringify(server.stagedBeat({ key: KEY })));

    // Nothing durable moved through any of it (I3, still true after P6).
    expect('staging never moved the live beat', server.store.get('module/current') === -1 || server.store.get('module/current') == null,
      String(server.store.get('module/current')));
  } finally { await server.close(); }
});
