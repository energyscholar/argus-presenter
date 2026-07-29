/*
 * Plan 0514 PHASE 1 — the core station registry.
 *
 * Core owns the registry (it is DATA relayed from a plugin manifest) and owns NO occupancy. That
 * split is the plan's whole thesis (§13.2): if occupancy lived in a core map beside displayByUser,
 * "a module load must not clear stations" would be a discipline one careless .clear() away from
 * regressing. Living in the plugin, the display layer cannot reach it at all.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { buildStationRegistry } from '../../harness/plugins.mjs';
import { WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ROOT, makePluginsDir, withPlugins, stationManifest, wait, connect, last } from './_0514-fixtures.mjs';

/** Build a registry straight from manifest objects — the loader in isolation. */
function build(manifests) { return buildStationRegistry(manifests, {}); }
function throwsWith(fn, needle) {
  try { fn(); return { threw: false, msg: '' }; }
  catch (e) { const msg = String(e && e.message || e); return { threw: true, msg, matched: msg.toLowerCase().includes(needle) }; }
}

test('t0514-01 — a duplicate stationUid THROWS at load', () => {
  const m = stationManifest();
  m.stations[1].stationUid = 1;                       // collide with Alpha
  const r = throwsWith(() => build({ fixture: m }), 'duplicate stationuid');
  expect(r.threw && r.matched, 'load fails loudly on a duplicate uid', r.msg);
  // The sibling uniqueness rules fail the same way — silently drifting names is the failure mode
  // integer uids exist to prevent (naming canon §3).
  const dupCode = stationManifest(); dupCode.stations[1].stationCode = 'alpha';
  expect(throwsWith(() => build({ fixture: dupCode }), 'duplicate stationcode').matched, 'duplicate code throws');
  const dupLabel = stationManifest(); dupLabel.stations[1].stationLabel = 'Alpha';
  expect(throwsWith(() => build({ fixture: dupLabel }), 'duplicate stationlabel').matched, 'duplicate label throws');
  const badCode = stationManifest(); badCode.stations[1].stationCode = 'Beta Two';
  expect(throwsWith(() => build({ fixture: badCode }), 'stationcode must match').matched, 'a code outside [a-z0-9-] throws');
  const badMax = stationManifest(); badMax.stations[0].maxOccupants = 0;
  expect(throwsWith(() => build({ fixture: badMax }), 'maxoccupants').matched, 'maxOccupants 0 throws');
});

test('t0514-02 — a missing / unresolvable stationDefaultUid THROWS', () => {
  const missing = stationManifest(); delete missing.stationDefaultUid;
  expect(throwsWith(() => build({ fixture: missing }), 'stationdefaultuid').matched, 'absent default throws');
  const bogus = stationManifest({ stationDefaultUid: 99 });
  expect(throwsWith(() => build({ fixture: bogus }), 'stationdefaultuid').matched, 'a default that names no station throws');
  // This is "everyone connects as the default station" — if it does not resolve, EVERY failure
  // path in the plan has nowhere to land, so it must be impossible to start in that condition.
});

test('t0514-03 — a plugin with NO `stations` key loads clean and the registry is empty (teaching untouched)', async () => {
  const reg = build({ teaching: { name: 'teaching', requires: [], components: [] } });
  expect(reg.isEmpty(), 'empty registry');
  expect(reg.wire().length === 0 && reg.defaultUid === null, 'nothing to relay', JSON.stringify(reg.wire()));

  const dir = makePluginsDir({ teaching: { 'plugin.json': { name: 'teaching', requires: [], components: [], presets: {}, fieldSchemas: {} } } });
  await withPlugins(dir, async () => {
    const server = await createServer({ port: 0 });
    const url = server.url().replace('http', 'ws');
    try {
      const c = await connect(WebSocket, url, { userId: 'u1', userName: 'U' });
      const w = last(c, 'welcome');
      expect(w && w.stationRegistry === undefined && w.stationUid === undefined, 'the welcome is byte-unchanged for a station-free deployment', JSON.stringify(w));
      c.ws.close();
    } finally { await server.close(); }
  });
});

test('t0514-18 — TWO plugins declaring stations is a HARD ERROR', () => {
  const a = stationManifest({ name: 'a' });
  const b = stationManifest({ name: 'b' });
  const r = throwsWith(() => build({ a, b }), 'one deployment, one registry');
  expect(r.threw && r.matched, 'two registries is refused, not silently merged', r.msg);
  // Merging is a later question and must not be answered by accident.
});

test('t0514-04 / t0514-05 — station-select seats the CALLER only; an unknown uid lands on the default', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  const DEFAULT = server.stations().stationDefaultUid;
  try {
    const a = await connect(WebSocket, url, { userId: 'a', userName: 'A' });
    const b = await connect(WebSocket, url, { userId: 'b', userName: 'B' });
    a.clear(); b.clear();
    a.send({ t: 'station-select', stationUid: 4 }); await wait(160);

    const ack = last(a, 'station');
    expect(ack && ack.ok === true && ack.stationUid === 4, 'the caller is seated at 4', JSON.stringify(ack));
    expect(!!last(a, 'content'), 'and its screen was rendered to that caller');
    expect(!last(b, 'content') && !last(b, 'station'), 'and NOBODY else was rendered to', JSON.stringify(b.frames.map((f) => f.t)));
    const seats = server.stations().seats;
    expect(seats.find((s) => s.userId === 'a').stationUid === 4, 'the roster agrees', JSON.stringify(seats));

    // t0514-05 — an unknown uid is NOT an error and NOT a disconnect. §5's single failure rule.
    a.clear();
    a.send({ t: 'station-select', stationUid: 9999 }); await wait(160);
    const ack2 = last(a, 'station');
    expect(ack2 && ack2.ok === true && ack2.stationUid === DEFAULT, 'an unknown uid resolves to the default', JSON.stringify(ack2));
    expect(a.ws.readyState === 1, 'and the seat is still connected');
    a.ws.close(); b.ws.close();
  } finally { await server.close(); }
});

test('t0514-06 — NO stationCode appears in any wire frame', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    // Codes as authored, straight from the manifest — the thing that must not escape.
    const man = JSON.parse(readFileSync(join(ROOT, 'plugins', 'starship-ops', 'plugin.json'), 'utf8'));
    const codes = (man.stations || []).map((s) => s.stationCode);
    expect(codes.length > 0, 'the fixture deployment actually declares codes');

    const c = await connect(WebSocket, url, { userId: 'zz-watcher', userName: 'Watcher' });
    c.send({ t: 'station-select', stationUid: 5 }); await wait(160);
    for (const f of c.frames) {
      // `content` frames are assembled artwork/HTML, not the station protocol; the rule is about
      // the protocol's own identifiers.
      if (f.t === 'content') continue;
      const json = JSON.stringify(f);
      expect(!/"stationCode"/.test(json), 'no stationCode FIELD on the wire', json.slice(0, 200));
      for (const code of codes) {
        expect(!new RegExp('"' + code + '"').test(json), `the code "${code}" never appears as a wire value`, json.slice(0, 300));
      }
    }
    // And the relayed registry itself carries labels + uids only.
    const reg = last(c, 'welcome').stationRegistry;
    expect(reg.every((r) => r.stationCode === undefined), 'the relayed registry has no codes', JSON.stringify(reg[0]));
    c.ws.close();
  } finally { await server.close(); }
});

test('t0514-38 — joining a station WRITES OCCUPANCY TO THE MACHINE, both indexes agreeing', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await connect(WebSocket, url, { userId: 'crewman', userName: 'Crewman' });
    a.send({ t: 'station-select', stationUid: 6 }); await wait(160);
    const occupants = server.store.get('ship/stations/6/occupants');
    expect(Array.isArray(occupants) && occupants.includes('crewman'), 'the forward index holds the seat', JSON.stringify(occupants));
    expect(server.store.get('ship/seats/crewman/stationUid') === 6, 'the reverse index agrees', String(server.store.get('ship/seats/crewman/stationUid')));
    // Moving station must leave no ghost behind in the previous one.
    a.send({ t: 'station-select', stationUid: 7 }); await wait(160);
    expect(!(server.store.get('ship/stations/6/occupants') || []).includes('crewman'), 'the old station released the seat', JSON.stringify(server.store.get('ship/stations/6/occupants')));
    expect((server.store.get('ship/stations/7/occupants') || []).includes('crewman'), 'the new station holds it');
    a.ws.close();
  } finally { await server.close(); }
});

test('t0514-39 — CORE holds no seat→station store; it asks the plugin and forgets', () => {
  const src = readFileSync(join(ROOT, 'app', 'server.mjs'), 'utf8');
  // The draft this test exists to prevent put a `stationByUser` map next to displayByUser. It
  // reads correctly in isolation and quietly re-creates the very lifetime bug §13.1 documents.
  for (const banned of ['stationByUser', 'stationsByUser', 'seatStations', 'stationOccupants', 'occupantsByStation']) {
    expect(src.indexOf(banned) === -1, `core must not declare ${banned}`, banned);
  }
  // Line-scoped (never \s*, which crosses newlines and matches the next comment block).
  const mapAsStation = src.split('\n').filter((l) => /new Map\(\)/.test(l) && /station/i.test(l));
  expect(mapAsStation.length === 0, 'no Map introduced as station storage', JSON.stringify(mapAsStation));
  // Positive side: the ONLY way core learns a seat's station is by asking.
  expect(/seatResolver\.get\(/.test(src), 'core reads occupancy through the resolver');
  // And a connection record never caches one.
  expect(!/c\.stationUid\s*=/.test(src), 'the connection record never caches a stationUid');
});

test('t0514-43 — disconnect calls release() and the seat LEAVES occupants', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await connect(WebSocket, url, { userId: 'leaver', userName: 'Leaver' });
    a.send({ t: 'station-select', stationUid: 9 }); await wait(160);
    expect((server.store.get('ship/stations/9/occupants') || []).includes('leaver'), 'seated');
    a.ws.close(); await wait(220);
    expect(!(server.store.get('ship/stations/9/occupants') || []).includes('leaver'),
      'gone after disconnect — without release() the roster drifts within one session',
      JSON.stringify(server.store.get('ship/stations/9/occupants')));
    expect(server.store.get('ship/seats/leaver/stationUid') === null, 'and the reverse index is cleared');
  } finally { await server.close(); }
});

test('t0514-43b — one PERSON on two sockets is not released until the LAST one goes', async () => {
  // Plan 0482 A4: a person may hold several sockets (phone + laptop, or a reconnect race).
  // Releasing on the first close would empty their station while they are still sitting at it.
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await connect(WebSocket, url, { userId: 'twinned', userName: 'Twinned' });
    const b = await connect(WebSocket, url, { userId: 'twinned', userName: 'Twinned' });
    a.send({ t: 'station-select', stationUid: 11 }); await wait(160);
    a.ws.close(); await wait(220);
    expect((server.store.get('ship/stations/11/occupants') || []).includes('twinned'), 'still seated while a socket remains',
      JSON.stringify(server.store.get('ship/stations/11/occupants')));
    b.ws.close(); await wait(220);
    expect(!(server.store.get('ship/stations/11/occupants') || []).includes('twinned'), 'released when the last socket goes');
  } finally { await server.close(); }
});
