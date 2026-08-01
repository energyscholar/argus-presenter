/*
 * Plan 0522 P15 (R18) — THE ▣ PROJECTION ON THE MCP SURFACE.
 *
 *   t42 — the capability an operator has on the control page's station tier is reachable by the
 *         agent, is the SAME implementation, still writes no seat, refuses by name, and is
 *         DECLARED in the coverage manifest.
 *
 * WHY THIS TEST EXISTS. P15 first shipped the projection as a closure plus a wire case, so it
 * was controller-page-only — and worse, because it was not on the object `createServer()` returns,
 * `test/unit/0488-surface-coverage.test.mjs` could not see it: the one instrument built to catch a
 * capability missing from the agent surface was structurally blind to this one. 0488 exists
 * because six capabilities went missing in a single session (S210), one of which ran a six-person
 * table on the solo profile. I1 permits a difference between the two surfaces only where it is
 * "declared AND tested, never discovered live", and a note in a commit message is neither.
 *
 * The behavioural half drives the REAL MCP handlers — presenter_start / presenter_station_project /
 * presenter_stations / presenter_stop — rather than asserting on the handler's source, because the
 * failure being guarded against is "the agent cannot reach it", and only running it proves reach.
 *
 * Unit tier: no browser. `port: 0` and `tunnel:false`, so nothing binds :3000, :4300 or :4399.
 * ⛔ §ANNEAL E — PRESENTER_MODULES_DIR points at a throwaway dir; nothing here goes near the
 * repo's real modules/ directory.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { coreTools, voiceTools } from '../../mcp/tools.mjs';
import { API_COVERAGE } from '../../mcp/surface-coverage.mjs';
import { makePluginsDir, stationManifest, connect } from './_0514-fixtures.mjs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocket } from 'ws';

const T = Object.fromEntries([...coreTools, ...voiceTools].map((t) => [t.name, t]));
const ALPHA = 1, BETA = 2, ABSENT = 999;

const STATIONS = [
  { stationUid: ALPHA, stationCode: 'alpha', stationLabel: 'Alpha', group: 'Group A', icon: 'A', maxOccupants: null, sortOrder: 1 },
  { stationUid: BETA, stationCode: 'beta', stationLabel: 'Beta', group: 'Group A', icon: 'B', maxOccupants: null, sortOrder: 2 },
];

/** Records every select() — the ONE call that can write a seat — on globalThis (same process). */
const RESOLVER = `
export function register(ctx) {
  const seats = new Map();
  const known = new Set((ctx.stations && ctx.stations.list || []).map(function(s){ return s.stationUid; }));
  const dflt = ctx.stations && ctx.stations.defaultUid;
  globalThis.__p15mcp = { selects: [] };
  ctx.provideSeatResolver({
    select: function (userId, uid) {
      globalThis.__p15mcp.selects.push([userId, uid]);
      const u = known.has(uid) ? uid : dflt;
      seats.set(userId, { uid: u });
      return { uid: u };
    },
    get: function (userId) { return seats.get(userId) || null; },
    release: function (userId) { seats.delete(userId); },
  });
}
`;

/** Point the env at throwaway trees, run `fn`, restore no matter what. */
async function withDeployment(plugins, fn) {
  const dir = makePluginsDir(plugins);
  const mods = mkdtempSync(join(tmpdir(), 'ap-0522-p15-mcp-'));
  const prevP = process.env.PRESENTER_PLUGINS_DIR;
  const prevM = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_PLUGINS_DIR = dir;
  process.env.PRESENTER_MODULES_DIR = mods;
  try { return await fn(); }
  finally {
    if (prevP === undefined) delete process.env.PRESENTER_PLUGINS_DIR; else process.env.PRESENTER_PLUGINS_DIR = prevP;
    if (prevM === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prevM;
  }
}

const seatsOf = (st) => st.seats.map((s) => ({ userId: s.userId, stationUid: s.stationUid }))
  .sort((a, b) => String(a.userId).localeCompare(String(b.userId)));

test('0522 t42 (R18) — the ▣ projection is on the MCP surface, is the SAME capability, and still writes no seat', async () => {
  // ── (1) DECLARED. The manifest binding first: if this is missing, 0488 fails too, and the
  // capability has gone back to being invisible to the guard rather than merely unexposed.
  const entry = API_COVERAGE.stationProject;
  expect('api.stationProject is declared in mcp/surface-coverage.mjs at all', !!entry,
    'API_COVERAGE.stationProject is missing — a capability with no declaration is the exact S210 bug the manifest exists to catch');
  expect('…and it is EXPOSED, not declined', !!(entry && entry.tool) && !(entry && entry.declined), JSON.stringify(entry));
  const tool = T[entry && entry.tool];
  expect('…and the tool it names really exists on the surface', !!tool, String(entry && entry.tool));
  expect('the tool tells the agent it is TRANSIENT and writes no seat — the one property a caller could not otherwise know',
    /TRANSIENT/.test(tool.description) && /NO SEAT IS WRITTEN/.test(tool.description), tool.description.slice(0, 120));
  expect('…and names both refusals, so a caller can distinguish them from success',
    /no-stations/.test(tool.description) && /no-such-station/.test(tool.description), tool.description.slice(0, 120));
  expect('…and takes the uid, not a label (strings drift and fail silently)',
    tool.input.required.includes('stationUid') && tool.input.properties.stationUid.type === 'number', JSON.stringify(tool.input));

  // ── (2) REACHABLE. Drive the real handlers end to end.
  await T.presenter_stop.handler({ tunnel: false }).catch(() => {});   // a leaked instance from an earlier file would answer `already`
  let started = null, a = null, b = null;
  try {
    started = await withDeployment(
      { p15mcp: { 'plugin.json': stationManifest({ name: 'p15mcp', server: 'seats.mjs', stationSelectorLabel: 'Post', stationDefaultUid: BETA, stations: STATIONS }), 'seats.mjs': RESOLVER } },
      () => T.presenter_start.handler({ port: 0, voice: false, tunnel: false }));
    expect('presenter_start really started a NEW server (not "already running" from another file)',
      !started.already && typeof started.url === 'string', JSON.stringify(started).slice(0, 160));

    const wsUrl = started.url.replace('http', 'ws');
    a = await connect(WebSocket, wsUrl, { userId: 'pa', userName: 'PlayerA' });
    b = await connect(WebSocket, wsUrl, { userId: 'pb', userName: 'PlayerB' });
    a.send({ t: 'station-select', stationUid: ALPHA });
    b.send({ t: 'station-select', stationUid: BETA });
    await new Promise((r) => setTimeout(r, 200));

    const before = seatsOf(await T.presenter_stations.handler({}));
    expect('precondition: the two players are seated at DIFFERENT stations',
      before.length === 2 && new Set(before.map((s) => s.stationUid)).size === 2, JSON.stringify(before));

    // Zero the ledger AFTER everybody has joined and self-selected, so only the projection can move it.
    globalThis.__p15mcp.selects.length = 0;
    a.clear(); b.clear();

    const r = await T.presenter_station_project.handler({ stationUid: ALPHA });
    expect('the agent can project a station', r && r.ok === true, JSON.stringify(r));
    expect('…and is told WHICH station, by label, and how many displays it actually reached (I5)',
      r.stationUid === ALPHA && r.stationLabel === 'Alpha' && r.projected >= 2, JSON.stringify(r));
    expect('…addressed at the room by default', JSON.stringify(r.targets) === JSON.stringify(['all']), JSON.stringify(r.targets));

    // ── (3) THE SAME CAPABILITY, NOT A SECOND ONE. Both players really received Alpha's screen —
    // the fixture declares no screen descriptor, so it is the core generic placeholder, built from
    // registry values only (t0514-15) and therefore carrying the station's label.
    await new Promise((r2) => setTimeout(r2, 200));
    for (const [name, c] of [['PlayerA', a], ['PlayerB', b]]) {
      expect(name + ' received the projected screen',
        c.frames.some((f) => f.t === 'content' && typeof f.html === 'string' && f.html.includes('Alpha')),
        JSON.stringify(c.frames.map((f) => f.t)));
    }

    // ── (4) STILL WRITES NO SEAT — the I3 property, asserted on the MCP path in its own right,
    // because "the control page does not re-seat" says nothing about what a second surface does.
    expect('the seat resolver\'s select() was NEVER reached from the MCP surface either',
      globalThis.__p15mcp.selects.length === 0, JSON.stringify(globalThis.__p15mcp.selects));
    const after = seatsOf(await T.presenter_stations.handler({}));
    expect('EVERY seat\'s stationUid is unchanged', JSON.stringify(after) === JSON.stringify(before),
      JSON.stringify({ before, after }));
    expect('…and specifically, the player at BETA was not dragged to ALPHA',
      (after.find((s) => s.userId === 'pb') || {}).stationUid === BETA, JSON.stringify(after));

    // ── (5) REFUSES BY NAME. An unknown uid must NOT resolve to the deployment default the way
    // seating does: silently projecting a different station than the one asked for is a wrong
    // answer delivered confidently, which is worse on an agent surface than a refusal.
    const bad = await T.presenter_station_project.handler({ stationUid: ABSENT });
    expect('an unknown uid is refused BY NAME', bad && bad.ok === false && bad.reason === 'no-such-station', JSON.stringify(bad));
    expect('…and nothing was projected, and no seat was written, on the way to refusing',
      bad.projected === 0 && globalThis.__p15mcp.selects.length === 0, JSON.stringify({ bad, selects: globalThis.__p15mcp.selects }));
    const stillThere = seatsOf(await T.presenter_stations.handler({}));
    expect('…and the refusal did not disturb the seating either', JSON.stringify(stillThere) === JSON.stringify(before), JSON.stringify(stillThere));
  } finally {
    if (a) a.ws.close();
    if (b) b.ws.close();
    if (started) await T.presenter_stop.handler({ tunnel: false }).catch(() => {});
  }

  // ── (6) A TEACHING DEPLOYMENT REFUSES BY NAME TOO, and does not throw at an agent mid-session.
  // Direct api call: this is the same function the tool handler calls, and a second start/stop
  // cycle to prove one refusal would be cost with no information in it.
  const teaching = await withDeployment(
    { p15teach: { 'plugin.json': { name: 'p15teach', requires: [], components: [], presets: {}, fieldSchemas: {} } } },
    () => createServer({ port: 0 }));
  try {
    expect('precondition: this deployment declares no stations', teaching.stations().stations.length === 0, JSON.stringify(teaching.stations()));
    const none = teaching.stationProject(ALPHA);
    expect('a station-free deployment refuses by name rather than throwing',
      none && none.ok === false && none.reason === 'no-stations' && none.projected === 0, JSON.stringify(none));
  } finally { await teaching.close(); }
});
