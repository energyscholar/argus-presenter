/*
 * 0751-declare-ownership.test.mjs — Plan 0751 / R-254 / R-326 (E12f): the server enforces who may
 * write a station's declaration. shared/combat/declare/<stationCode> gains a seat-keyed write
 * rule on the engine's {station} segment (R-326, E16s) — no second token — widened to compare
 * against EITHER actor.stationUid or actor.stationCode, because this path family is CODE-keyed
 * while station/<uid>/view (E16s) is UID-keyed (MEASURED, see this plan's own CONTEXT).
 *
 *   node test/unit/0751-declare-ownership.test.mjs
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { createStore } from '../../app/state.mjs';
import { createPermissions, DEFAULT_POLICY, DEFAULT_READ_POLICY } from '../../app/permissions.mjs';
import { makePluginsDir, stationManifest, connect, last, wait } from './_0514-fixtures.mjs';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Direct: matchesStationSegment/matchGlob's dual comparison and the except exclusion ─────────

test('t0751-01 — matchesStationSegment: {station} matches EITHER stationUid or stationCode; neither present, no match', () => {
  const perms = createPermissions([{ glob: 'demo/{station}', roles: ['participant'], verbs: ['set'] }], DEFAULT_READ_POLICY);
  expect(perms.can({ role: 'participant', userId: 'u', stationUid: 5 }, { path: 'demo/5', verb: 'set' }) === true,
    'a numeric-uid actor matches the uid form');
  expect(perms.can({ role: 'participant', userId: 'u', stationCode: 'gunner' }, { path: 'demo/gunner', verb: 'set' }) === true,
    'a code-only actor matches the code form');
  expect(perms.can({ role: 'participant', userId: 'u', stationUid: 5, stationCode: 'gunner' }, { path: 'demo/gunner', verb: 'set' }) === true,
    'an actor carrying both still matches on the code form when the path is code-shaped');
  expect(perms.can({ role: 'participant', userId: 'u', stationUid: 5, stationCode: 'gunner' }, { path: 'demo/sensors', verb: 'set' }) === false,
    'a mismatched code is refused even though a uid is present');
  expect(perms.can({ role: 'participant', userId: 'u' }, { path: 'demo/gunner', verb: 'set' }) === false,
    'neither field present, no match');
});

test('t0751-02 — matchGlob: except excludes a prefix from an otherwise-matching wide grant', () => {
  const perms = createPermissions([
    { glob: 'shared/**', roles: ['participant'], verbs: ['set', 'clear'], except: ['shared/combat/declare'] },
    { glob: 'shared/combat/declare/{station}', roles: ['participant'], verbs: ['set'] },
  ], DEFAULT_READ_POLICY);
  expect(perms.can({ role: 'participant', userId: 'u', stationCode: 'gunner' }, { path: 'shared/combat/declare/gunner', verb: 'set' }) === true,
    'the narrower row still authorises the matching seat');
  expect(perms.can({ role: 'participant', userId: 'u', stationCode: 'sensors' }, { path: 'shared/combat/declare/gunner', verb: 'set' }) === false,
    'shared/** no longer covers this path, and the narrower row refuses a mismatched seat');
  expect(perms.can({ role: 'participant', userId: 'u' }, { path: 'shared/combat/declare', verb: 'clear' }) === false,
    'the collection path itself is excluded from shared/** and matches no other row: default-denied');
  expect(perms.can({ role: 'participant', userId: 'u' }, { path: 'shared/map/pointer', verb: 'set' }) === true,
    'the exclusion is scoped: an unrelated shared/** path is untouched');
});

// ── store.apply(): the three MEASURED breaches, by name, and the legitimate write ────────────────

const NS = 'shared/combat';
const DECLARE = `${NS}/declare`;
const gunner = { userId: 'gunner-alice', role: 'participant', stationUid: 5, stationCode: 'gunner' };
const sensors = { userId: 'sensors-bob', role: 'participant', stationUid: 4, stationCode: 'sensors' };
const observer = { userId: 'observer-carol', role: 'participant', stationUid: 13, stationCode: 'observer' };
const engineer = { userId: 'engineer-dan', role: 'participant', stationUid: 7, stationCode: 'engineer' };
const gm = { userId: 'ref-1', role: 'gm' };   // no seat fields at all — NOT an OVERRIDE_ROLE
const system = { userId: 'combat-initiative', role: 'system' };   // OVERRIDE_ROLE

test('t0751-03 — a legitimate write by the seated player still lands', () => {
  const store = createStore({});
  const res = store.apply({ path: `${DECLARE}/gunner`, verb: 'set', value: { text: 'Fire!', at: 1 } }, gunner);
  expect(!!(res && res.diff), 'the Gunner writing its OWN declare key is accepted');
  expect(store.get(`${DECLARE}/gunner`).text === 'Fire!', 'the value landed');
});

test('t0751-04 — one station cannot write another station\'s key (R-254 breach 1, MEASURED 09-06)', () => {
  const store = createStore({});
  store.apply({ path: `${DECLARE}/gunner`, verb: 'set', value: { text: 'Fire!', at: 1 } }, gunner);
  const res = store.apply({ path: `${DECLARE}/gunner`, verb: 'set', value: { text: 'SENSORS wrote the gunner key', at: 2 } }, sensors);
  expect(res === null, "Sensors writing the Gunner's declare key is REFUSED");
  expect(store.get(`${DECLARE}/gunner`).text === 'Fire!', "the Gunner's own value is unchanged");
});

test('t0751-05 — a participant cannot clear the whole declare collection (R-254 breach 2, MEASURED)', () => {
  const store = createStore({});
  store.apply({ path: `${DECLARE}/gunner`, verb: 'set', value: { text: 'Fire!', at: 1 } }, gunner);
  store.apply({ path: `${DECLARE}/sensors`, verb: 'set', value: { text: 'Lock!', at: 1 } }, sensors);
  const res = store.apply({ path: DECLARE, verb: 'clear', value: null }, engineer);
  expect(res === null, 'a participant clearing the whole declare collection is REFUSED');
  expect(Object.keys(store.get(DECLARE) || {}).length === 2, 'both declarations still stand');
});

test('t0751-06 — an off-seat console cannot write for a station it does not hold (R-254 breach 3, MEASURED)', () => {
  const store = createStore({});
  const res = store.apply({ path: `${DECLARE}/sensors`, verb: 'set', value: { text: 'declared from the Observer console', at: 1 } }, observer);
  expect(res === null, "Observer (uid 13) writing Sensors' declare key is REFUSED");
  expect(store.get(`${DECLARE}/sensors`) === undefined, 'nothing was written');
});

test('t0751-07 — NO GM exception (R-254)', () => {
  const store = createStore({});
  const res = store.apply({ path: `${DECLARE}/gunner`, verb: 'set', value: { text: 'gm wrote it', at: 1 } }, gm);
  expect(res === null, 'a gm-role actor with no seat is refused the same as any mismatched participant');
});

test('t0751-08 — OVERRIDE_ROLES (presenter/ai/system) are unchanged: still write anywhere', () => {
  const store = createStore({});
  const res = store.apply({ path: `${DECLARE}/gunner`, verb: 'set', value: { text: 'system wrote it', at: 1 } }, system);
  expect(!!(res && res.diff), 'a system-role actor still writes any declare key, exactly as before');
});

// ── Live: over the real wire, proving server.mjs actually attaches the two fields ────────────────

const MANIFEST = stationManifest({
  name: 't0751spy', server: 'spy.mjs', stationDefaultUid: 5,
  stations: [
    { stationUid: 4, stationCode: 'sensors', stationLabel: 'Sensors', group: 'G', icon: 'S', color: '#111', maxOccupants: null, sortOrder: 1 },
    { stationUid: 5, stationCode: 'gunner', stationLabel: 'Gunner', group: 'G', icon: 'Gu', color: '#222', maxOccupants: null, sortOrder: 2 },
    { stationUid: 13, stationCode: 'observer', stationLabel: 'Observer', group: 'G', icon: 'O', color: '#333', maxOccupants: null, sortOrder: 3 },
  ],
});

/* A SPY seat resolver — the 0522-p14 / E16s pattern: the base fixture manifest declares no server
 * module and therefore no seat resolver, so a `stationUID` hello would seat nobody without one. */
const SPY = `
export function register(ctx) {
  const seats = new Map();
  const known = new Set((ctx.stations && ctx.stations.list || []).map(function (s) { return s.stationUid; }));
  const dflt = ctx.stations && ctx.stations.defaultUid;
  ctx.provideSeatResolver({
    select: function (userId, uid) {
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
  const dir = makePluginsDir({ t0751spy: { 'plugin.json': MANIFEST, 'spy.mjs': SPY } });
  // §ANNEAL E precedent (0522-p14, 0780): point PRESENTER_MODULES_DIR at a throwaway dir too —
  // left unset, createServer scans AND WATCHES the repo's real modules/, the one directory with
  // no version history. Nothing here loads a module, but the plan's own boot() omitted this; the
  // two cited precedents both set it, so this test follows them rather than the plan's literal text.
  const mods = mkdtempSync(join(tmpdir(), 'ap-0751-mod-'));
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

test('t0751-11 — end to end over the real wire: handleOp attaches stationUid+stationCode, all three MEASURED breaches refuse, a legitimate write lands', async () => {
  const server = await boot();
  const url = server.url().replace('http', 'ws');
  let gunnerC = null, sensorsC = null, observerC = null;
  try {
    gunnerC = await connect(WebSocket, url, { stationUID: 5, userName: 'Gunner' });
    sensorsC = await connect(WebSocket, url, { stationUID: 4, userName: 'Sensors' });
    observerC = await connect(WebSocket, url, { stationUID: 13, userName: 'Observer' });

    gunnerC.send({ t: 'op', path: 'shared/combat/declare/gunner', verb: 'set', value: { text: 'Fire!', at: 1 } });
    await wait(160);
    expect(server.store.get('shared/combat/declare/gunner')?.text === 'Fire!',
      'the seated Gunner writing its OWN declare key lands');

    sensorsC.send({ t: 'op', path: 'shared/combat/declare/gunner', verb: 'set', value: { text: 'SENSORS wrote the gunner key', at: 2 } });
    await wait(160);
    expect(server.store.get('shared/combat/declare/gunner')?.text === 'Fire!',
      "Sensors writing the Gunner's declare key is REFUSED over the real wire — the Gunner's value is unchanged");

    server.store.apply({ path: 'shared/combat/declare/sensors', verb: 'set', value: { text: 'Lock!', at: 1 } }, { userId: 'seed', role: 'system' });
    observerC.send({ t: 'op', path: 'shared/combat/declare/sensors', verb: 'set', value: { text: 'declared from the Observer console', at: 1 } });
    await wait(160);
    expect(server.store.get('shared/combat/declare/sensors')?.text === 'Lock!',
      'the Observer console writing for a station it does not hold is REFUSED over the real wire');

    const before = Object.keys(server.store.get('shared/combat/declare') || {}).length;
    sensorsC.send({ t: 'op', path: 'shared/combat/declare', verb: 'clear', value: null });
    await wait(160);
    const after = Object.keys(server.store.get('shared/combat/declare') || {}).length;
    expect(before === after && after > 0,
      'a participant clearing the whole declare collection is REFUSED over the real wire', `before=${before} after=${after}`);
  } finally {
    if (gunnerC) gunnerC.ws.close(); if (sensorsC) sensorsC.ws.close(); if (observerC) observerC.ws.close();
    await server.close();
  }
});
