/*
 * Plan 0575 PHASE 2 — THE PLACE REGISTRY.
 *
 * ⭐ "PLACES, of which ships are one kind" (Bruce, 2026-08-13). A ship is a place that has
 * stations; a world, an EVA point and a small craft are places that do not. Away parties,
 * boarding and spacewalks then need no new machinery — only new place RECORDS.
 *
 * ⛔ THIS PHASE HAS NO PAINTED SURFACE, and the brief forbids inventing one. Nothing renders a
 * place yet: phase 2 is data only, so it is verified at the STATE LAYER — the store, the
 * registry's own refusals, and the participant snapshot. The pixel arrives in phase 3, when a
 * person's placeId starts driving occupancy.
 *
 * ⛔ THE SHIP'S ID IS ASKED FOR, NEVER WRITTEN DOWN — this repo is PUBLIC and t0531-01 fails any
 * tracked file that spells a campaign value.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { existsSync } from 'fs';
import { join } from 'path';
import { REAL_PLUGINS, SHIP_ID, loadShipPluginModule } from './_0514-fixtures.mjs';

const havePlaces = existsSync(join(REAL_PLUGINS, 'starship-ops', 'places.mjs'));

/** A registry over a fake writer, so a test can read exactly what WOULD have been stored. */
async function bareRegistry() {
  const mod = await loadShipPluginModule('places.mjs');
  const written = new Map();
  const reg = mod.createPlaces({ write: (p, v) => written.set(p, v) });
  return { mod, reg, written };
}

test('t0575-05a — a WORLD and an EVA point are places; they have no hull and offer NO stations unless their record declares some', async () => {
  if (!havePlaces) { expect(false, 'places.mjs is installed (run tools/install-system-plugins.sh)'); return; }
  const { mod, reg, written } = await bareRegistry();
  /* ⛔ DECLARED TEST CHANGE (plan 0896, owner ruling 2026-10-08): the rule is no longer "a world never has
     stations" but "a world offers ONLY the stations its place record declares — none by default". A station is
     offered by a place, to a role; what never changes is that a non-ship place has no HULL. */
  const world = reg.register({ placeId: 'p-world', kind: 'world', label: 'A world' });
  const eva = reg.register({ placeId: 'p-eva', kind: 'eva', label: 'Outside' });
  const craft = reg.register({ placeId: 'p-craft', kind: 'craft', label: 'A small craft' });
  const declared = reg.register({ placeId: 'p-port', kind: 'world', label: 'A world with a desk', stations: ['desk-1'] });

  expect(world && world.kind === 'world' && world.hasHull === false && Array.isArray(world.offers) && world.offers.length === 0,
    'a world is a place, has no hull, and offers no stations by default', JSON.stringify(world));
  expect(eva && eva.kind === 'eva' && eva.hasHull === false && eva.offers.length === 0,
    'an EVA point is a place and offers no stations', JSON.stringify(eva));
  expect(craft && craft.hasHull === false && craft.offers.length === 0, 'nor does a small craft, by default', JSON.stringify(craft));
  expect(declared && declared.offers.length === 1 && declared.offers[0] === 'desk-1',
    'a world offers exactly the stations its record declares', JSON.stringify(declared));

  // ⭐ And a SHIP does — otherwise the assertions above would pass for a registry that simply
  //   never sets the flag, which is a test that can no longer fail.
  const ship = reg.register({ placeId: 'p-ship', kind: 'ship', label: 'A hull', hullClass: 'some-class' });
  expect(ship && ship.hasStations === true && ship.hasHull === true && ship.hullClass === 'some-class',
    'a ship is the kind that HAS a hull and stations, and carries its hull class', JSON.stringify(ship));

  // Each one landed at its own store path, under the single prefix the plugin allow-reads.
  expect(written.get(mod.placePath('p-world')) === world, 'the world was written to places/<placeId>',
    JSON.stringify([...written.keys()]));
  expect(mod.placePath('p-eva') === 'places/p-eva', 'and the path is `places/<placeId>`', mod.placePath('p-eva'));
});

test('t0575-05b — a non-ship place cannot acquire a hull, a hull class or undeclared stations, whatever the file said', async () => {
  if (!havePlaces) { expect(false, 'places.mjs is installed'); return; }
  const { reg } = await bareRegistry();
  /* The deployment file is hand-edited. The failure guarded against is not a crash — it is a
     BEACH that quietly grows stations, which phase 4's seat authority would then honour.
     ⛔ DECLARED TEST CHANGE (plan 0896, owner ruling 2026-10-08): a `hasStations: true` in the input still buys
     nothing — what a world offers is only its DECLARED station list (none here), and it never gains a hull. */
  const w = reg.register({ placeId: 'p-beach', kind: 'world', label: 'A beach', hullClass: 'battleship', hasStations: true, hasHull: true });
  expect(w && w.hasHull === false && Array.isArray(w.offers) && w.offers.length === 0,
    'a world offers only declared stations (none) and has no hull, whatever the input claimed', JSON.stringify(w));
  expect(w && w.hullClass === null, 'and a world has no hull class', JSON.stringify(w));
});

test('t0575-05c — a malformed place declaration is REFUSED and writes nothing', async () => {
  if (!havePlaces) { expect(false, 'places.mjs is installed'); return; }
  const { reg, written } = await bareRegistry();
  const bad = [
    null, undefined, 'a string', 42,
    { kind: 'world' },                                  // no placeId
    { placeId: '   ', kind: 'world' },                  // blank placeId
    { placeId: 'p-x' },                                 // no kind
    { placeId: 'p-x', kind: 'moon' },                   // a kind nobody declared
    { placeId: 'p-x', kind: 'SHIP' },                   // and the match is exact, not fuzzy
  ];
  for (const raw of bad) {
    const got = reg.register(raw);          // called ONCE — a second call would hide a first write
    expect(got === null, 'refused: ' + JSON.stringify(raw), JSON.stringify(got));
  }
  expect(written.size === 0, 'and NOTHING was written for any of them', JSON.stringify([...written.keys()]));
  expect(reg.ids().length === 0, 'the registry is still empty', JSON.stringify(reg.ids()));
});

test('t0575-05d — the COMMISSIONED SHIP is a place, filed under its own shipId', async () => {
  const server = await createServer({ port: 0 });
  try {
    if (!server.stations().stations.length) { expect(true, 'skipped — no station plugin on this deployment'); return; }
    const mod = await loadShipPluginModule('places.mjs');
    const rec = server.store.get(mod.placePath(SHIP_ID));
    expect(rec && rec.kind === 'ship', 'the hull is registered as a place of kind ship', JSON.stringify(rec));
    /* ⭐⭐ ONE NAME, NOT TWO. A ship's placeId IS its shipId — the same ruling identity.shipId
       already carries. If these two ever diverge, every phase after this one is pointing at a
       hull that does not exist. */
    expect(rec && rec.placeId === SHIP_ID, 'placeId IS shipId — one name, never two', JSON.stringify(rec));
    const identity = server.store.get(`ships/${SHIP_ID}/identity`);
    expect(identity && identity.shipId === rec.placeId,
      'and it agrees with the identity record it was built from', JSON.stringify([identity, rec]));
    expect(rec.hasStations === true, 'a ship has stations', JSON.stringify(rec));
    expect(rec.label === (identity && identity.name), 'its label is the commissioned name (no second source)',
      JSON.stringify([rec.label, identity && identity.name]));
  } finally { await server.close(); }
});

test('t0575-05e — a PARTICIPANT can READ the place registry (read is default-DENY)', async () => {
  const server = await createServer({ port: 0 });
  try {
    if (!server.stations().stations.length) { expect(true, 'skipped — no station plugin'); return; }
    const mod = await loadShipPluginModule('places.mjs');
    const actor = { role: 'participant', userId: 'u1' };
    /* Plan 0471 C3 made reads default-DENY, and the failure mode is a component that renders
       BLANK and looks like a bug rather than a denial. The grant travels with the data, in the
       same phase, so phase 3 cannot inherit an unreadable registry. */
    expect(server.store.perms.canRead(actor, mod.placePath(SHIP_ID)), 'a participant may READ places/<placeId>');
    const snap = server.store.snapshot(actor);
    expect(snap.state.places && snap.state.places[SHIP_ID] && snap.state.places[SHIP_ID].kind === 'ship',
      'and it reaches the participant SNAPSHOT — not blank', JSON.stringify(snap.state.places));
  } finally { await server.close(); }
});
