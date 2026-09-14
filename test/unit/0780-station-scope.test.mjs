/*
 * 0780-station-scope.test.mjs — Plan 0780 / R-297 / R-326 (E16s): the engine's `{station}` read
 * scope. The published station view (`station/<stationUid>/view`, R-326) is read-scoped by a new
 * `{station}` glob segment in app/permissions.mjs, resolved against the connection's OWN seat —
 * read at call time via seatStationUid(), never cached on the connection record.
 *
 *   node test/unit/0780-station-scope.test.mjs
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { createPermissions, DEFAULT_POLICY, DEFAULT_READ_POLICY } from '../../app/permissions.mjs';
import { makePluginsDir, stationManifest, connect, last, wait } from './_0514-fixtures.mjs';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Direct: the {station} segment lives in ONE helper, used by BOTH matchers ──────────────────

test('t0780-01 — readMatch: the default READ policy\'s {station} row admits only the matching seat; the gm reads every station', () => {
  const perms = createPermissions(DEFAULT_POLICY, DEFAULT_READ_POLICY);
  expect(perms.canRead({ role: 'participant', userId: 'u2', stationUid: 2 }, 'station/2/view') === true,
    'a participant seated at 2 reads station/2/view');
  expect(perms.canRead({ role: 'participant', userId: 'u7', stationUid: 7 }, 'station/2/view') === false,
    'a participant seated at 7 does NOT read station/2/view');
  expect(perms.canRead({ role: 'participant', userId: 'ghost' }, 'station/2/view') === false,
    'an actor with no stationUid field (no seat) reads nothing under station/');
  expect(perms.canRead({ role: 'participant', userId: 'ghost2', stationUid: null }, 'station/2/view') === false,
    'an explicit stationUid:null (no seat) reads nothing either');
  expect(perms.canRead({ role: 'gm', userId: 'g' }, 'station/2/view') === true, 'the gm reads station 2');
  expect(perms.canRead({ role: 'gm', userId: 'g' }, 'station/7/view') === true, 'the gm reads station 7 too');
});

test('t0780-02 — matchGlob: the SAME {station} token works in a write-side glob (both matchers share one helper)', () => {
  // DEFAULT_POLICY carries no {station} row at this level — nothing needs one yet (see THE
  // BOUNDARY) — so this proves matchGlob's own handling directly, with a throwaway policy, rather
  // than leaving the write-side branch unexercised by any test.
  const perms = createPermissions(
    [{ glob: 'demo/{station}', roles: ['participant'], verbs: ['set'] }],
    DEFAULT_READ_POLICY
  );
  expect(perms.can({ role: 'participant', userId: 'u', stationUid: 2 }, { path: 'demo/2', verb: 'set' }) === true,
    'matchGlob honours {station} exactly like readMatch does');
  expect(perms.can({ role: 'participant', userId: 'u', stationUid: 7 }, { path: 'demo/2', verb: 'set' }) === false,
    'a different stationUid is refused');
  expect(perms.can({ role: 'participant', userId: 'u' }, { path: 'demo/2', verb: 'set' }) === false,
    'no stationUid, no match');
});

// ── Live: a scratch manifest declaring uids 2 and 7, per GATE ──────────────────────────────────

const MANIFEST = stationManifest({
  name: 't0780spy', server: 'spy.mjs', stationDefaultUid: 2,
  stations: [
    { stationUid: 2, stationCode: 't0780-a', stationLabel: 'A', group: 'G', icon: 'A', color: '#111', maxOccupants: null, sortOrder: 1 },
    { stationUid: 7, stationCode: 't0780-b', stationLabel: 'B', group: 'G', icon: 'B', color: '#222', maxOccupants: null, sortOrder: 2 },
  ],
});

/*
 * A spy seat resolver (the 0522-p14 pattern). ⛔ `app/wire-actions.mjs`'s `hello` handler
 * (measured, ~line 154) calls `seatResolver.select()` UNCONDITIONALLY whenever stations are
 * active, seating every connecting client at the deployment DEFAULT uid when `hello` names no
 * station — there is no `hello` frame that leaves a real, converged connection seatless.
 * `'t0780-seatless'` is this fixture's OWN way of producing that condition anyway, entirely inside
 * this scratch resolver — not a new engine capability, and not something a real client can trigger.
 */
const SPY = `
export function register(ctx) {
  const seats = new Map();
  const known = new Set((ctx.stations && ctx.stations.list || []).map(function (s) { return s.stationUid; }));
  const dflt = ctx.stations && ctx.stations.defaultUid;
  ctx.provideSeatResolver({
    select: function (userId, uid) {
      if (userId === 't0780-seatless') return { uid: null };
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
  const dir = makePluginsDir({ t0780spy: { 'plugin.json': MANIFEST, 'spy.mjs': SPY } });
  const mods = mkdtempSync(join(tmpdir(), 'ap-0780-mod-'));
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

test('t0780-11 — a seat reads its OWN station key live and in snapshot; the other seat and a seatless connection read neither; a re-seat with no reconnect proves the read is never cached', async () => {
  const server = await boot();
  const url = server.url().replace('http', 'ws');
  let atTwo = null, atSeven = null, seatless = null;
  try {
    // Seed BEFORE anyone connects, so the SNAPSHOT half is exercised, not only the live diff.
    server.set('station/2/view', { text: 'STATION TWO v1' });
    server.set('station/7/view', { text: 'STATION SEVEN v1' });

    atTwo = await connect(WebSocket, url, { stationUID: 2, userName: 'Two' });
    atSeven = await connect(WebSocket, url, { stationUID: 7, userName: 'Seven' });
    seatless = await connect(WebSocket, url, { userId: 't0780-seatless', userName: 'Ghost' });

    const snapTwo = last(atTwo, 'snapshot');
    const snapSeven = last(atSeven, 'snapshot');
    const snapGhost = last(seatless, 'snapshot');

    expect(!!(snapTwo && snapTwo.state.station && snapTwo.state.station['2'] && snapTwo.state.station['2'].view
      && snapTwo.state.station['2'].view.text === 'STATION TWO v1'),
      'uid 2 sees its own station/2/view in its snapshot', JSON.stringify(snapTwo && snapTwo.state));
    expect(!(snapTwo.state.station && snapTwo.state.station['7']),
      'uid 2 does NOT see station/7/view in its snapshot');
    expect(!!(snapSeven && snapSeven.state.station && snapSeven.state.station['7'] && snapSeven.state.station['7'].view
      && snapSeven.state.station['7'].view.text === 'STATION SEVEN v1'),
      'uid 7 sees its own station/7/view in its snapshot');
    expect(!(snapSeven.state.station && snapSeven.state.station['2']),
      'uid 7 does NOT see station/2/view in its snapshot');
    expect(!(snapGhost && snapGhost.state.station),
      'the seatless connection sees NO station/ key at all in its snapshot', JSON.stringify(snapGhost && snapGhost.state));

    // The LIVE half: change both views after everyone has converged, and watch who hears what.
    atTwo.clear(); atSeven.clear(); seatless.clear();
    server.set('station/2/view', { text: 'STATION TWO v2' });
    server.set('station/7/view', { text: 'STATION SEVEN v2' });
    await wait(160);

    const diffsTwo = atTwo.frames.filter((f) => f.t === 'host' && f.msg && f.msg.diff);
    expect(diffsTwo.some((f) => f.msg.diff['station/2/view'] && f.msg.diff['station/2/view'].text === 'STATION TWO v2'),
      'uid 2 receives its OWN station key LIVE', JSON.stringify(diffsTwo));
    expect(!diffsTwo.some((f) => 'station/7/view' in f.msg.diff),
      'uid 2 receives NOTHING for station 7 live', JSON.stringify(diffsTwo));

    const diffsSeven = atSeven.frames.filter((f) => f.t === 'host' && f.msg && f.msg.diff);
    expect(diffsSeven.some((f) => f.msg.diff['station/7/view'] && f.msg.diff['station/7/view'].text === 'STATION SEVEN v2'),
      'uid 7 receives its OWN station key LIVE', JSON.stringify(diffsSeven));
    expect(!diffsSeven.some((f) => 'station/2/view' in f.msg.diff),
      'uid 7 receives NOTHING for station 2 live', JSON.stringify(diffsSeven));

    const ghostSawAnyStation = seatless.frames.some((f) => f.t === 'host' && f.msg && f.msg.diff
      && Object.keys(f.msg.diff).some((k) => k.startsWith('station/')));
    expect(!ghostSawAnyStation, 'the seatless connection receives NO station/ diff at all, live', JSON.stringify(seatless.frames));

    // GATE clause 3, PROVEN not just implemented: re-seat atTwo onto station 7 with NO reconnect,
    // then confirm it now receives station 7's live updates too — a stationUid captured ONCE at
    // hello (rather than read fresh via seatStationUid() at each call site) would never see this.
    atTwo.clear();
    atTwo.send({ t: 'station-select', stationUid: 7 });   // self-selection is ungated (0522 t37a)
    await wait(160);
    atTwo.clear();
    server.set('station/7/view', { text: 'STATION SEVEN v3 — after atTwo re-seated, no reconnect' });
    await wait(160);
    const diffsAfterReseat = atTwo.frames.filter((f) => f.t === 'host' && f.msg && f.msg.diff);
    expect(diffsAfterReseat.some((f) => f.msg.diff['station/7/view']
      && String(f.msg.diff['station/7/view'].text).includes('re-seated')),
      'after re-seating with NO reconnect, atTwo now reads station 7 live — proves the seat is read at call time, never cached',
      JSON.stringify(diffsAfterReseat));
  } finally {
    if (atTwo) atTwo.ws.close(); if (atSeven) atSeven.ws.close(); if (seatless) seatless.ws.close();
    await server.close();
  }
});
