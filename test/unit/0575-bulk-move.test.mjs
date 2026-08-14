/*
 * Plan 0575 PHASE 6 — THE BULK MOVE, WHICH IS A LOOP OVER PEOPLE.
 *
 * Bruce, 2026-08-13: "EVERYONE MOVES. The crew cannot be split — for now. ⛔ But the data model
 * must support per-person movement from day one: make sure our current data structure supports it
 * with this run. Bulk move is the only EXPOSED operation; it is implemented AS A LOOP OVER PEOPLE,
 * never as a ship-level flag."
 *
 * ⭐⭐ t0575-03 IS THE ASSERTION THAT MAKES THAT REAL: "assert by moving ONE person via the same
 * code path and finding the model intact." One tool, one path, and the bulk case is the loop's
 * default — so moving one person is not a second feature to write later and not a test-only back
 * door; it is this call with a one-element list.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';
import { loadShipPluginModule, SHIP_ID, SHIP_NS, wait, connect, withFleet, TWO_HULLS } from './_0514-fixtures.mjs';

const toolResult = async (server, name, args) => {
  const r = await server.callPluginTool(name, args);
  return r && Object.prototype.hasOwnProperty.call(r, 'result') ? r.result : r;
};

/** Seat three real websocket clients at three stations, so the crew is REAL and not injected. */
async function crewOf(server, rows) {
  const url = server.url().replace('http', 'ws');
  const conns = [];
  for (const [userId, uid] of rows) {
    const c = await connect(WebSocket, url, { userId, userName: userId });
    c.send({ t: 'station-select', stationUid: uid });
    await wait(160);
    conns.push(c);
  }
  return conns;
}

test('t0575-03 — ⭐⭐ MOVE ONE PERSON THROUGH THE SAME CODE PATH, AND FIND THE MODEL INTACT', async () => {
  await withFleet(TWO_HULLS, async () => {
  const server = await createServer({ port: 0 });
  let conns = [];
  try {
    if (!server.stations().stations.length) { expect(true, 'skipped — no station plugin'); return; }
    const mod = await loadShipPluginModule('ship-machine.mjs');
    /* ⭐ 0581 PHASE F — SHADOWED DELIBERATELY. The module-level SHIP_ID/SHIP_NS are read at import
       from whatever this DISK declares; inside a commissioned fleet the primary is the fixture's,
       and every assertion below means "the hull they started on" either way. */
    const fleet = mod.loadFleet();
    const SHIP_ID = fleet.primaryShipId, SHIP_NS = mod.shipNs(SHIP_ID);
    expect(fleet.ships.length >= 2, '⛔ two hulls are really commissioned — no silent skip below this line',
      JSON.stringify(fleet.ships.map((x) => x.shipId)));
    const other = fleet.ships.find((s) => s.shipId !== SHIP_ID);

    conns = await crewOf(server, [['crew-a', 5], ['crew-b', 5], ['crew-c', 6]]);
    const people = await loadShipPluginModule('people.mjs');
    for (const id of ['crew-a', 'crew-b', 'crew-c']) {
      expect(server.store.get(people.personPath(id)).placeId === SHIP_ID, `${id} starts aboard the primary`,
        JSON.stringify(server.store.get(people.personPath(id))));
    }

    /* ⭐⭐ ONE PERSON, THROUGH THE EXPOSED TOOL — not through a private helper and not through a
       test-only door. `personIds` is the same argument the bulk case leaves out. */
    const res = await toolResult(server, 'ship_move_crew', { toPlaceId: other.shipId, personIds: ['crew-b'] });
    expect(res && res.ok === true && res.moved.length === 1, 'exactly one person moved', JSON.stringify(res));
    expect(res.moved[0].personId === 'crew-b' && res.moved[0].to === other.shipId, 'and it is the one named', JSON.stringify(res.moved));

    // ── THE MODEL IS INTACT: each person carries their OWN placeId ─────────────────────────
    expect(server.store.get(people.personPath('crew-b')).placeId === other.shipId, 'the mover is on the other hull',
      JSON.stringify(server.store.get(people.personPath('crew-b'))));
    for (const id of ['crew-a', 'crew-c']) {
      expect(server.store.get(people.personPath(id)).placeId === SHIP_ID,
        `⭐ ${id} did NOT move — placeId is per PERSON, not a crew-level flag`,
        JSON.stringify(server.store.get(people.personPath(id))));
    }
    /* ⭐⭐ 0581 PHASE C — THIS ASSERTION IS INVERTED, AND DELIBERATELY. It read
       `stationUid === null` — "the mover lost their seat, a stationUid means nothing off the hull
       it belongs to". RULED BY BRUCE, 2026-08-14: that is right about a BEACH and wrong about
       ANOTHER SHIP. "A moved crew should all go to the SAME STATION THEY WERE ON, only on the NEW
       SHIP." The seat-is-dropped rule survives intact for a stationless place — t0575-05 asserts
       it, and t0575-03d below moves someone to a world and still expects null. */
    expect(server.store.get(people.personPath('crew-b')).stationUid === 5,
      '⭐ the mover KEEPS station 5 — on the destination hull (0581 C1)',
      JSON.stringify(server.store.get(people.personPath('crew-b'))));

    // ── and the OCCUPANCY PROJECTION followed on the ship they left ────────────────────────
    const at5 = server.store.get(`${SHIP_NS}/stations/5/occupants`) || [];
    expect(at5.includes('crew-a') && !at5.includes('crew-b'),
      '⛔⛔ NO GHOST: the station they left no longer lists them, though occupancy never saw the move',
      JSON.stringify(at5));
    expect(server.store.get(`${SHIP_NS}/seats/crew-b/stationUid`) === null,
      'and the reverse projection agrees', String(server.store.get(`${SHIP_NS}/seats/crew-b/stationUid`)));
    expect((server.store.get(`${SHIP_NS}/stations/6/occupants`) || []).includes('crew-c'),
      'while an untouched station is untouched', JSON.stringify(server.store.get(`${SHIP_NS}/stations/6/occupants`)));
  } finally { for (const c of conns) try { c.ws.close(); } catch {} await wait(200); await server.close(); }
  });
});

test('t0575-03b — ⭐ AND THE BULK CASE IS THE SAME CALL WITH THE LIST LEFT OUT', async () => {
  await withFleet(TWO_HULLS, async () => {
  const server = await createServer({ port: 0 });
  let conns = [];
  try {
    if (!server.stations().stations.length) { expect(true, 'skipped — no station plugin'); return; }
    const mod = await loadShipPluginModule('ship-machine.mjs');
    const people = await loadShipPluginModule('people.mjs');
    /* ⭐ 0581 PHASE F — SHADOWED DELIBERATELY. The module-level SHIP_ID/SHIP_NS are read at import
       from whatever this DISK declares; inside a commissioned fleet the primary is the fixture's,
       and every assertion below means "the hull they started on" either way. */
    const fleet = mod.loadFleet();
    const SHIP_ID = fleet.primaryShipId, SHIP_NS = mod.shipNs(SHIP_ID);
    expect(fleet.ships.length >= 2, '⛔ two hulls are really commissioned — no silent skip below this line',
      JSON.stringify(fleet.ships.map((x) => x.shipId)));
    const other = fleet.ships.find((s) => s.shipId !== SHIP_ID);

    conns = await crewOf(server, [['all-a', 1], ['all-b', 5], ['all-c', 5]]);
    const res = await toolResult(server, 'ship_move_crew', { toPlaceId: other.shipId });
    expect(res.ok === true && res.moved.length === 3, 'EVERYONE moved — Bruce’s ruling', JSON.stringify(res));
    for (const id of ['all-a', 'all-b', 'all-c']) {
      expect(server.store.get(people.personPath(id)).placeId === other.shipId, `${id} is on the other hull`,
        JSON.stringify(server.store.get(people.personPath(id))));
    }
    /* ⛔ AND NOT ONE OF THEM IS STILL LISTED WHERE THEY WERE. This is the assertion a ship-level
       flag would have passed by accident and a hand-patched occupancy list would have failed. */
    for (const uid of [1, 5]) {
      expect(((server.store.get(`${SHIP_NS}/stations/${uid}/occupants`)) || []).length === 0,
        `station ${uid} on the ship they left is EMPTY`, JSON.stringify(server.store.get(`${SHIP_NS}/stations/${uid}/occupants`)));
    }
    // Idempotent: moving them again is a no-op that SAYS it is one, rather than churning.
    const again = await toolResult(server, 'ship_move_crew', { toPlaceId: other.shipId, fromPlaceId: other.shipId });
    expect(again.moved.length === 0 && again.refused.length === 3, 'a second move reports "already-there", it does not churn',
      JSON.stringify(again));
    expect(again.refused.every((r) => r.reason === 'already-there'), 'and says why for each', JSON.stringify(again.refused));
  } finally { for (const c of conns) try { c.ws.close(); } catch {} await wait(200); await server.close(); }
  });
});

test('t0575-03c — ⛔ AN UNKNOWN DESTINATION IS REFUSED, and nobody moves', async () => {
  const server = await createServer({ port: 0 });
  let conns = [];
  try {
    if (!server.stations().stations.length) { expect(true, 'skipped — no station plugin'); return; }
    const people = await loadShipPluginModule('people.mjs');
    conns = await crewOf(server, [['stay-put', 5]]);
    /* Moving a crew to a place that does not exist is how you LOSE one: every person would hold a
       placeId nothing answers to, they would be seatable nowhere, and every screen would look
       completely normal. The place registry is the whole reason this can be checked. */
    const res = await toolResult(server, 'ship_move_crew', { toPlaceId: 'nowhere-at-all' });
    expect(res.ok === false && res.reason === 'no-such-place', 'refused, and it says why', JSON.stringify(res));
    expect(Array.isArray(res.places) && res.places.length >= 1, 'and lists the places it does know', JSON.stringify(res.places));
    expect(server.store.get(people.personPath('stay-put')).placeId === SHIP_ID, '⛔ and NOBODY moved',
      JSON.stringify(server.store.get(people.personPath('stay-put'))));
    expect((server.store.get(`${SHIP_NS}/stations/5/occupants`) || []).includes('stay-put'),
      'their station still holds them', JSON.stringify(server.store.get(`${SHIP_NS}/stations/5/occupants`)));
  } finally { for (const c of conns) try { c.ws.close(); } catch {} await wait(200); await server.close(); }
});

test('t0575-03d — ⭐ A PLACE WITHOUT STATIONS IS A VALID DESTINATION (this is the away party)', async () => {
  await withFleet(TWO_HULLS, async () => {
  const server = await createServer({ port: 0 });
  let conns = [];
  try {
    if (!server.stations().stations.length) { expect(true, 'skipped — no station plugin'); return; }
    const placesMod = await loadShipPluginModule('places.mjs');
    const people = await loadShipPluginModule('people.mjs');
    /* ⭐ §2: "away parties, boarding and spacewalks need NO new machinery, only new place records."
       If this deployment declares no non-ship place, that is a DATA gap, not a code gap — and the
       test says which, rather than passing quietly. */
    const nonShip = Object.values(server.store.get(placesMod.PLACES) || {}).find((p) => p && p.hasStations === false);
    /* ⛔ 0581 PHASE F — this used to `return` with `expect(true, '…reported')` when the deployment
       declared no non-ship place, and it DID exactly that on this box. The fixture fleet declares
       one, so the away party is exercised or this FAILS. */
    expect(!!nonShip, '⛔ the fixture fleet declares a non-ship place — no silent skip below this line',
      JSON.stringify(Object.values(server.store.get(placesMod.PLACES) || {}).map((x) => x && x.placeId)));
    if (!nonShip) return;
    const mod = await loadShipPluginModule('ship-machine.mjs');
    const SHIP_NS = mod.shipNs(mod.loadFleet().primaryShipId);
    conns = await crewOf(server, [['lander', 5]]);
    const res = await toolResult(server, 'ship_move_crew', { toPlaceId: nonShip.placeId, personIds: ['lander'] });
    expect(res.ok === true && res.moved.length === 1, 'the away party lands', JSON.stringify(res));
    const rec = server.store.get(people.personPath('lander'));
    expect(rec.placeId === nonShip.placeId && rec.stationUid === null,
      'they are on the world, and they hold no station', JSON.stringify(rec));
    expect(!((server.store.get(`${SHIP_NS}/stations/5/occupants`) || []).includes('lander')),
      'and the ship no longer lists them', JSON.stringify(server.store.get(`${SHIP_NS}/stations/5/occupants`)));
  } finally { for (const c of conns) try { c.ws.close(); } catch {} await wait(200); await server.close(); }
  });
});
