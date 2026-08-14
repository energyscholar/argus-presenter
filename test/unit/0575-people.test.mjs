/*
 * Plan 0575 PHASE 3 — THE PERSON MODEL, and the inversion of occupancy.
 *
 * ⭐⭐ `person.placeId` IS THE WHOLE FEATURE (§3). Ship-switching, away parties, EVA and
 * planetside are all "a person's placeId changed" — ONE FIELD, FOUR FEATURES.
 *
 * ⭐⭐ AND OCCUPANCY IS NOW DERIVED. It used to be two hand-synced Maps whose header CLAIMED to be
 * derived. The tests below assert the difference the hard way: they change a PERSON and then look
 * at the station, without ever touching an occupants list.
 *
 * ⛔ NO NEW PAINTED SURFACE (brief §4 names 2, 3 and 7). Nothing new renders. What phase 3 changes
 * is the machinery UNDER the seat path that 0565 already paints end to end, and that live test is
 * run unchanged — so the pixel is re-proved rather than invented.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';
import { existsSync } from 'fs';
import { join } from 'path';
import { REAL_PLUGINS, SHIP_ID, SHIP_NS, loadShipPluginModule, wait, connect } from './_0514-fixtures.mjs';

const havePeople = existsSync(join(REAL_PLUGINS, 'starship-ops', 'people.mjs'));

/** A people registry over a fake writer, with a declared set of places that HAVE stations. */
async function bareCrew(withStations = ['hull-a']) {
  const mod = await loadShipPluginModule('people.mjs');
  const written = new Map();
  const people = mod.createPeople({
    write: (p, v) => written.set(p, v),
    placeHasStations: (id) => withStations.includes(id),
  });
  return { mod, people, written };
}

test('t0575-05 — ⭐ A PERSON ON A WORLD OR AN EVA POINT HOLDS NO stationUid, AND NOTHING BREAKS', async () => {
  if (!havePeople) { expect(false, 'people.mjs is installed (run tools/install-system-plugins.sh)'); return; }
  const { people } = await bareCrew(['hull-a']);

  people.upsert({ personId: 'p1', name: 'One', placeId: 'hull-a' });
  expect(people.seat('p1', 5), 'seated at a station on a place that HAS stations', JSON.stringify(people.get('p1')));
  expect(people.stationUidOf('p1') === 5, 'and the seat took', String(people.stationUidOf('p1')));
  expect(people.occupantsOf('hull-a', 5).includes('p1'), 'the station lists them', JSON.stringify(people.occupantsOf('hull-a', 5)));

  // ── the move that is the whole plan ────────────────────────────────────────────────────────
  const moved = people.moveTo('p1', 'a-world');
  expect(moved && moved.placeId === 'a-world', 'the person moved', JSON.stringify(moved));
  expect(moved.stationUid === null,
    '⛔ and their seat is GONE — a stationUid is meaningless off the hull it belongs to', String(moved.stationUid));
  expect(people.occupantsOf('hull-a', 5).length === 0,
    '⭐⭐ the station they left no longer lists them — WITHOUT anyone updating an occupants list',
    JSON.stringify(people.occupantsOf('hull-a', 5)));

  // ── and nothing breaks: every query still answers, in words, about someone on a beach ──────
  expect(people.stationUidOf('p1') === null, 'stationUidOf answers null, not undefined and not a throw');
  expect(people.placeIdOf('p1') === 'a-world', 'placeIdOf answers the world');
  expect(JSON.stringify(people.occupancyOf('a-world')) === '{}', 'a world has no occupancy map at all',
    JSON.stringify(people.occupancyOf('a-world')));
  expect(people.at('a-world').length === 1, 'but the person is unmistakably THERE', JSON.stringify(people.at('a-world')));
  expect(people.seat('p1', 5) === null, '⛔ and they cannot be seated while they are on it', JSON.stringify(people.get('p1')));
  expect(people.stationUidOf('p1') === null, 'the refused seat left no residue', String(people.stationUidOf('p1')));

  // ── an EVA point behaves identically, which is the point of "places, of which ships are one" ─
  people.upsert({ personId: 'p2', name: 'Two', placeId: 'hull-a' });
  people.seat('p2', 5);
  people.moveTo('p2', 'outside');
  expect(people.stationUidOf('p2') === null, 'EVA is the same rule, not a special case', String(people.stationUidOf('p2')));
});

test('t0575-03p — ⭐⭐ OCCUPANCY IS DERIVED: change a PERSON, and the station follows', async () => {
  if (!havePeople) { expect(false, 'people.mjs is installed'); return; }
  const { people } = await bareCrew(['hull-a']);
  for (const id of ['a', 'b', 'c']) people.upsert({ personId: id, placeId: 'hull-a' });
  people.seat('a', 5); people.seat('b', 5); people.seat('c', 5);
  expect(people.occupantsOf('hull-a', 5).length === 3, 'three at one station (multiplicity works)',
    JSON.stringify(people.occupantsOf('hull-a', 5)));

  /* ⛔ THE OLD FAILURE THIS FORBIDS: two maps kept in step by hand, where any path that updated one
     and returned early left a ghost nobody could explain. There is nothing to keep in step now —
     the ONLY write below is to a person, and the station's answer changes because of it. */
  people.moveTo('b', 'a-world');
  const at5 = people.occupantsOf('hull-a', 5);
  expect(at5.length === 2 && !at5.includes('b'), 'the mover left, and nothing was patched to make it so', JSON.stringify(at5));
  expect(at5[0] === 'a' && at5[1] === 'c', 'and the remaining order is stable (insertion order)', JSON.stringify(at5));

  people.unseat('a');
  expect(people.occupantsOf('hull-a', 5).length === 1, 'unseating is the same one write');
  expect(people.placeIdOf('a') === 'hull-a',
    '⛔ and unseating did NOT delete the person — a disconnect is not a disappearance', String(people.placeIdOf('a')));

  people.moveTo('b', 'hull-a');
  expect(people.stationUidOf('b') === null,
    '⛔ coming BACK aboard does not restore the old seat — they must sit down again', String(people.stationUidOf('b')));
});

test('t0575-03q — a person is refused a seat on a place with no stations, and the refusal is REPORTED', async () => {
  if (!havePeople) { expect(false, 'people.mjs is installed'); return; }
  const { people } = await bareCrew(['hull-a']);
  people.upsert({ personId: 'beachgoer', placeId: 'a-beach', stationUid: 5 });
  expect(people.stationUidOf('beachgoer') === null,
    '⛔ even an UPSERT that supplies a stationUid cannot smuggle one onto a beach', String(people.stationUidOf('beachgoer')));
  expect(people.seat('beachgoer', 5) === null, 'and seat() answers null rather than doing nothing quietly');
  expect(people.upsert({ personId: '  ' }) === null, 'a blank personId is refused');
  expect(people.upsert(null) === null && people.upsert('x') === null, 'and so is a non-record');
  expect(people.moveTo('nobody', 'hull-a') === null, 'moving someone who does not exist is null, never a crash');
  expect(people.seat('nobody', 1) === null, 'and so is seating them');
});

test('t0575-03r — the LIVE seat path writes a PERSON, and both store projections agree with it', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    if (!server.stations().stations.length) { expect(true, 'skipped — no station plugin'); return; }
    const mod = await loadShipPluginModule('people.mjs');
    const c = await connect(WebSocket, url, { userId: 'person-probe', userName: 'Person Probe' });
    c.send({ t: 'station-select', stationUid: 6 }); await wait(160);

    const rec = server.store.get(mod.personPath('person-probe'));
    expect(rec && rec.personId === 'person-probe', 'the seat created a PERSON record', JSON.stringify(rec));
    /* ⭐ ONE NAME, NOT TWO: core hands the resolver a userId and THAT is the personId. */
    expect(rec.placeId === SHIP_ID, 'filed at the ship, by the ship’s own id', JSON.stringify(rec));
    expect(rec.homePlaceId === SHIP_ID, 'and that is their home place until something says otherwise', JSON.stringify(rec));
    expect(rec.stationUid === 6, 'carrying the seat they took', String(rec.stationUid));

    // The two published paths are PROJECTIONS of the record above — same fact, two shapes.
    expect((server.store.get(`${SHIP_NS}/stations/6/occupants`) || []).includes('person-probe'),
      'the forward projection agrees', JSON.stringify(server.store.get(`${SHIP_NS}/stations/6/occupants`)));
    expect(server.store.get(`${SHIP_NS}/seats/person-probe/stationUid`) === 6,
      'the reverse projection agrees', String(server.store.get(`${SHIP_NS}/seats/person-probe/stationUid`)));

    // A participant may read the people, or a phase-6 roster would render blank and look broken.
    const actor = { role: 'participant', userId: 'u1' };
    expect(server.store.perms.canRead(actor, mod.personPath('person-probe')), 'a participant may READ people/<personId>');
    const snap = server.store.snapshot(actor);
    expect(snap.state.people && snap.state.people['person-probe'],
      'and the person reaches the participant SNAPSHOT — not blank', JSON.stringify(snap.state.people));

    c.ws.close(); await wait(220);
    const after = server.store.get(mod.personPath('person-probe'));
    expect(after && after.stationUid === null, 'a disconnect empties the seat', JSON.stringify(after));
    expect(after && after.placeId === SHIP_ID,
      '⛔ but the person is still ABOARD — "who is on this ship" is not "who is connected"', JSON.stringify(after));
  } finally { await server.close(); }
});
