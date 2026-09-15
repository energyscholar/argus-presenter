/*
 * 0800-whisper-slice.test.mjs — Plan 0800 / R-270 / R-273 (E27s): the engine's whisper/{station}
 * read rule. `private` is gm-readable by design; a directed message needs its OWN slice, private
 * from the GM too (R-270) — and exempt from the presenter/ai controller override, which today
 * bypasses canRead unconditionally and would otherwise make the rule unenforceable from the
 * control page (R-273). `system` (the writer) keeps its override.
 *
 *   node test/unit/0800-whisper-slice.test.mjs
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { createPermissions, DEFAULT_POLICY, DEFAULT_READ_POLICY } from '../../app/permissions.mjs';
import { makePluginsDir, stationManifest, connect, last, wait } from './_0514-fixtures.mjs';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Direct: canRead alone proves every role's outcome — it is the one function every read path
//    (snapshot, live diff, replay) calls, so a direct assertion here is exactly "receives nothing".

test('t0800-01 — canRead: whisper/{station} admits only the matching seat; gm/presenter/ai read nothing; system (the writer) reads all', () => {
  const perms = createPermissions(DEFAULT_POLICY, DEFAULT_READ_POLICY);
  expect(perms.canRead({ role: 'participant', userId: 'u22', stationUid: 22 }, 'whisper/22') === true,
    'a participant seated at 22 reads whisper/22');
  expect(perms.canRead({ role: 'participant', userId: 'u23', stationUid: 23 }, 'whisper/22') === false,
    'a participant seated at 23 does NOT read whisper/22');
  expect(perms.canRead({ role: 'participant', userId: 'ghost' }, 'whisper/22') === false,
    'a participant with no seat reads nothing under whisper/');
  expect(perms.canRead({ role: 'gm', userId: 'g' }, 'whisper/22') === false,
    'the gm — unlike private/station/answers/gm — does NOT read whisper (R-270)');
  expect(perms.canRead({ role: 'presenter', userId: 'p' }, 'whisper/22') === false,
    'a presenter-role controller does NOT read whisper — the override is exempted here (R-273)');
  expect(perms.canRead({ role: 'ai', userId: 'a' }, 'whisper/22') === false,
    'an ai-role controller does NOT read whisper (R-273)');
  expect(perms.canRead({ role: 'system', userId: 's' }, 'whisper/22') === true,
    'system — the writer — still reads whisper; its override is UNCHANGED');
  expect(perms.canRead({ role: 'participant', userId: 'u22', stationUid: 22 }, 'whisper') === false,
    'the bare whisper collection matches no row (readMatch requires path.length >= glob.length): default-denied to everyone, gm included');
});

// ── Live: seats at 22 and 23, and one seatless connection, per GATE ─────────────────────────────

const MANIFEST = stationManifest({
  name: 't0800spy', server: 'spy.mjs', stationDefaultUid: 22,
  stations: [
    { stationUid: 22, stationCode: 't0800-a', stationLabel: 'A', group: 'G', icon: 'A', color: '#111', maxOccupants: null, sortOrder: 1 },
    { stationUid: 23, stationCode: 't0800-b', stationLabel: 'B', group: 'G', icon: 'B', color: '#222', maxOccupants: null, sortOrder: 2 },
  ],
});

/*
 * A spy seat resolver (the 0522-p14 pattern, reused by 0780/0751). `'t0800-seatless'` is this
 * fixture's own way of producing a genuinely-unseated connection — wire-actions.mjs's `hello`
 * handler seats every real connection at the default uid when stations are active, so this is not
 * reachable through a real client; it isolates the PERMISSION behaviour under test (0780's own
 * documented limitation, reused verbatim here).
 */
const SPY = `
export function register(ctx) {
  const seats = new Map();
  const known = new Set((ctx.stations && ctx.stations.list || []).map(function (s) { return s.stationUid; }));
  const dflt = ctx.stations && ctx.stations.defaultUid;
  ctx.provideSeatResolver({
    select: function (userId, uid) {
      if (userId === 't0800-seatless') return { uid: null };
      const u = known.has(uid) ? uid : dflt;
      seats.set(userId, { uid: u });
      return { uid: u };
    },
    get: function (userId) { return seats.get(userId) || null; },
    release: function (userId) { seats.delete(userId); },
  });
}
`;

async function boot() {
  const dir = makePluginsDir({ t0800spy: { 'plugin.json': MANIFEST, 'spy.mjs': SPY } });
  const mods = mkdtempSync(join(tmpdir(), 'ap-0800-mod-'));
  const prevP = process.env.PRESENTER_PLUGINS_DIR;
  const prevM = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_PLUGINS_DIR = dir;
  process.env.PRESENTER_MODULES_DIR = mods;
  let server;
  try { server = await createServer({ port: 0 }); }
  finally {
    if (prevP === undefined) delete process.env.PRESENTER_PLUGINS_DIR; else process.env.PRESENTER_PLUGINS_DIR = prevP;
    if (prevM === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prevM;
  }
  return server;
}

test('t0800-11 — the seat at 22 reads whisper/22 live and in snapshot; the seat at 23 and a seatless connection read neither', async () => {
  const server = await boot();
  const url = server.url().replace('http', 'ws');
  let atTwentyTwo = null, atTwentyThree = null, seatless = null;
  try {
    // Seed BEFORE anyone connects, so the SNAPSHOT half is exercised, not only the live diff.
    server.set('whisper/22', { text: 'seed', at: 0 });

    atTwentyTwo = await connect(WebSocket, url, { stationUID: 22, userName: 'AtTwentyTwo' });
    atTwentyThree = await connect(WebSocket, url, { stationUID: 23, userName: 'AtTwentyThree' });
    seatless = await connect(WebSocket, url, { userId: 't0800-seatless', userName: 'Ghost' });

    const snapTwo = last(atTwentyTwo, 'snapshot');
    const snapThree = last(atTwentyThree, 'snapshot');
    const snapGhost = last(seatless, 'snapshot');

    expect(!!(snapTwo && snapTwo.state.whisper && snapTwo.state.whisper['22'] && snapTwo.state.whisper['22'].text === 'seed'),
      'the seat at 22 sees whisper/22 in its snapshot', JSON.stringify(snapTwo && snapTwo.state));
    expect(!(snapThree && snapThree.state.whisper),
      'the seat at 23 sees NO whisper key in its snapshot', JSON.stringify(snapThree && snapThree.state));
    expect(!(snapGhost && snapGhost.state.whisper),
      'the seatless connection sees NO whisper key in its snapshot', JSON.stringify(snapGhost && snapGhost.state));

    // The LIVE half: update after everyone has converged, and watch who hears what.
    atTwentyTwo.clear(); atTwentyThree.clear(); seatless.clear();
    server.set('whisper/22', { text: 'live update', at: 1 });
    await wait(160);

    const diffsTwo = atTwentyTwo.frames.filter((f) => f.t === 'host' && f.msg && f.msg.diff);
    expect(diffsTwo.some((f) => f.msg.diff['whisper/22'] && f.msg.diff['whisper/22'].text === 'live update'),
      'the seat at 22 receives whisper/22 LIVE', JSON.stringify(diffsTwo));

    const diffsThree = atTwentyThree.frames.filter((f) => f.t === 'host' && f.msg && f.msg.diff);
    expect(!diffsThree.some((f) => 'whisper/22' in f.msg.diff),
      'the seat at 23 receives NOTHING for whisper/22 live', JSON.stringify(diffsThree));

    const ghostSawAnyWhisper = seatless.frames.some((f) => f.t === 'host' && f.msg && f.msg.diff
      && Object.keys(f.msg.diff).some((k) => k.startsWith('whisper/')));
    expect(!ghostSawAnyWhisper, 'the seatless connection receives NO whisper/ diff at all, live', JSON.stringify(seatless.frames));
  } finally {
    if (atTwentyTwo) atTwentyTwo.ws.close(); if (atTwentyThree) atTwentyThree.ws.close(); if (seatless) seatless.ws.close();
    await server.close();
  }
});
