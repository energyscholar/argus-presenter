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
import { existsSync, readFileSync } from 'fs';
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

/*
 * ⭐⭐ 0581 PHASE C — A MOVED CREW KEEPS THE STATION IT WAS ON.
 *
 * RULED BY BRUCE, 2026-08-14: *"A moved crew should all go to the SAME STATION THEY WERE ON, only
 * on the NEW SHIP."* Fallback, in his words: *"if station doesn't exist then you seat them as
 * OBSERVER station. That's what Observer is for: it's a catch-all for 'you're on the ship but not
 * seated at a station'."* Confirmed for the station-FULL case too — never bump, never refuse.
 *
 * ⛔ THE REGISTRY IS READ FROM THE SHIPPED MANIFEST, not written out here. `stationDefaultUid` and
 * every `maxOccupants` come from the deployment's own plugin.json, so this test cannot pass because
 * a fixture agreed with a hardcoded 13 — and a deployment that renumbered its stations would still
 * be tested against ITS numbering. ⛔ The uid is never spelled in an assertion below.
 */
const MANIFEST = (() => {
  try { return JSON.parse(readFileSync(join(REAL_PLUGINS, 'starship-ops', 'plugin.json'), 'utf8')); }
  catch { return null; }
})();

async function crewWithRegistry(withStations = ['hull-a', 'hull-b']) {
  const mod = await loadShipPluginModule('people.mjs');
  const written = new Map();
  const list = (MANIFEST && MANIFEST.stations) || [];
  const people = mod.createPeople({
    write: (p, v) => written.set(p, v),
    placeHasStations: (id) => withStations.includes(id),
    stationsAt: (id) => (withStations.includes(id) ? list : []),
    stationDefaultUid: () => (MANIFEST ? MANIFEST.stationDefaultUid : null),
  });
  return { mod, people, written, list, defaultUid: MANIFEST && MANIFEST.stationDefaultUid };
}

/** The first station in the manifest with the given capacity, so nothing below names a uid. */
const stationWithCap = (list, cap) => list.find((s) => s.maxOccupants === cap) || null;

test('t0581-C1 — ⭐⭐ A MOVED PERSON KEEPS THEIR stationUid ON THE DESTINATION HULL', async () => {
  if (!havePeople || !MANIFEST) { expect(false, 'people.mjs and the station manifest are installed'); return; }
  const { people, list, defaultUid } = await crewWithRegistry();
  // A station with room for more than one, so this test is about KEEPING and not about capacity.
  const roomy = list.find((s) => s.maxOccupants === null || s.maxOccupants > 1);
  expect(!!roomy, 'the manifest declares a station with room for more than one', JSON.stringify(list.map((s) => s.maxOccupants)));
  if (!roomy) return;

  people.upsert({ personId: 'p1', placeId: 'hull-a' });
  people.seat('p1', roomy.stationUid);
  expect(people.stationUidOf('p1') === roomy.stationUid, 'seated on hull-a', String(people.stationUidOf('p1')));

  const moved = people.moveTo('p1', 'hull-b');
  expect(moved && moved.placeId === 'hull-b', 'they are on the other hull', JSON.stringify(moved));
  expect(moved.stationUid === roomy.stationUid,
    '⭐⭐ THE SAME STATION, ON THE NEW SHIP — not null, and not the default',
    `${roomy.stationUid} -> ${moved.stationUid}`);
  expect(moved.stationUid !== defaultUid || roomy.stationUid === defaultUid,
    '⛔ and this is a real result, not the Observer fallback dressed up as one',
    `kept=${moved.stationUid} default=${defaultUid}`);
  expect(people.occupantsOf('hull-a', roomy.stationUid).length === 0,
    'the station they left no longer lists them', JSON.stringify(people.occupantsOf('hull-a', roomy.stationUid)));
  expect(people.occupantsOf('hull-b', roomy.stationUid).includes('p1'),
    'and the destination hull does', JSON.stringify(people.occupantsOf('hull-b', roomy.stationUid)));
});

test('t0581-C2 — the destination HAS NO SUCH STATION ⇒ Observer, read from the manifest', async () => {
  if (!havePeople || !MANIFEST) { expect(false, 'people.mjs and the station manifest are installed'); return; }
  const mod = await loadShipPluginModule('people.mjs');
  const list = MANIFEST.stations || [];
  const roomy = list.find((s) => s.maxOccupants === null || s.maxOccupants > 1);
  /* hull-b is a hull with a REDUCED station list — the person's station is simply not on it. This
     is a different case from "a beach has no stations at all" (t0575-05), and it is the one Bruce's
     Observer ruling is about. */
  const people = mod.createPeople({
    write: () => {},
    placeHasStations: (id) => ['hull-a', 'hull-b'].includes(id),
    stationsAt: (id) => (id === 'hull-a' ? list : list.filter((s) => s.stationUid !== roomy.stationUid)),
    stationDefaultUid: () => MANIFEST.stationDefaultUid,
  });
  people.upsert({ personId: 'p1', placeId: 'hull-a' });
  people.seat('p1', roomy.stationUid);
  const moved = people.moveTo('p1', 'hull-b');
  expect(moved.stationUid === MANIFEST.stationDefaultUid,
    '⭐ seated at the DECLARED DEFAULT — the catch-all, asked for by name',
    `${moved.stationUid} vs stationDefaultUid ${MANIFEST.stationDefaultUid}`);
  expect(moved.stationUid !== null, '⛔ NOT null — they are on the ship, just not at a station', String(moved.stationUid));
});

test('t0581-C3 — the destination station is FULL ⇒ Observer. ⛔ Never bump, never refuse', async () => {
  if (!havePeople || !MANIFEST) { expect(false, 'people.mjs and the station manifest are installed'); return; }
  const { people, list, defaultUid } = await crewWithRegistry();
  const single = stationWithCap(list, 1);          // the manifest's own one-seat stations
  expect(!!single, 'the manifest declares a station with maxOccupants: 1', JSON.stringify(list.map((s) => s.maxOccupants)));
  if (!single) return;

  // Someone is ALREADY in that chair on the destination hull.
  people.upsert({ personId: 'sitting', placeId: 'hull-b' });
  people.seat('sitting', single.stationUid);
  people.upsert({ personId: 'arriving', placeId: 'hull-a' });
  people.seat('arriving', single.stationUid);

  const moved = people.moveTo('arriving', 'hull-b');
  expect(moved !== null, '⛔ THE MOVE IS NOT REFUSED — they are on the ship either way', JSON.stringify(moved));
  expect(moved.placeId === 'hull-b', 'and they really did arrive', JSON.stringify(moved));
  expect(moved.stationUid === defaultUid, '⭐ the arriving person goes to Observer', String(moved.stationUid));
  expect(people.stationUidOf('sitting') === single.stationUid,
    '⛔⛔ AND THE PERSON ALREADY IN THE CHAIR WAS NOT BUMPED', String(people.stationUidOf('sitting')));
  expect(people.occupantsOf('hull-b', single.stationUid).length === 1,
    'the capped station still holds exactly one', JSON.stringify(people.occupantsOf('hull-b', single.stationUid)));

  /* ⭐ AND THE OUTCOME DOES NOT DEPEND ON ITERATION ORDER, which is what makes a bulk move safe:
     a second arrival for the same chair gets the same answer as the first. */
  people.upsert({ personId: 'arriving2', placeId: 'hull-a' });
  people.seat('arriving2', single.stationUid);
  const m2 = people.moveTo('arriving2', 'hull-b');
  expect(m2.stationUid === defaultUid, 'the next one in the loop gets the same answer', String(m2.stationUid));
});

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
