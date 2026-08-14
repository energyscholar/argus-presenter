/*
 * Plan 0575 PHASE 4 — SEAT AUTHORITY, PLACE-AWARE.
 *
 * ⛔⛔ THE ONE PHASE WHERE A BUG IS A *SECURITY* BUG (§8 anneal log). Everywhere else in this plan
 * a mistake is a wrong pixel. Here a mistake lets somebody move a ship they are not on, and it
 * does it QUIETLY, BY SUCCEEDING — which is the only failure mode in this codebase that a
 * screenshot cannot catch.
 *
 * §3: "Today 'occupies the Gunner station' is unambiguous; with two ships it is not, and the guard
 * would silently authorise the wrong hull."
 *
 * ⛔ These tests use INVENTED hull ids. The real one is asked for, never written down (t0531-01).
 */
import { test, expect } from '../../harness/test.mjs';
import { existsSync } from 'fs';
import { join } from 'path';
import { REAL_PLUGINS, loadShipPluginModule } from './_0514-fixtures.mjs';

const haveGuard = existsSync(join(REAL_PLUGINS, 'starship-ops', 'seat-authority.mjs'));

/* Two hulls, each with a Gunner station at the SAME uid — which is the whole trap. A uid is only
   unique within a place, so "is this person at station 5?" is true for the gunner of either. */
const GUNNER_UID = 5;
const CAPTAIN_UID = 1;
const STATIONS = {
  [CAPTAIN_UID]: { stationUid: CAPTAIN_UID, stationCode: 'captain', stationLabel: 'Captain' },
  [GUNNER_UID]: { stationUid: GUNNER_UID, stationCode: 'gunner', stationLabel: 'Gunner' },
};
const ORDERS = {
  captain: [{ event: 'battle-stations' }, { event: 'stand-down' }],
  gunner: [{ event: 'fire' }],
};

/** A guard over a real people registry, for the hull named `shipId`. */
async function guardFor(shipId, crew) {
  const [peopleMod, authMod] = await Promise.all([
    loadShipPluginModule('people.mjs'),
    loadShipPluginModule('seat-authority.mjs'),
  ]);
  const people = peopleMod.createPeople({ write: () => {}, placeHasStations: (id) => String(id).startsWith('hull-') });
  for (const [personId, placeId, stationUid] of crew) {
    people.upsert({ personId, placeId });
    if (stationUid != null) people.seat(personId, stationUid);
  }
  const auth = authMod.createSeatAuthority({
    people,
    shipId,
    stationOf: (uid) => STATIONS[uid] || null,
    ordersFor: (st) => (st ? (ORDERS[st.stationCode] || []) : []),
  });
  return { auth, people, REFUSAL: authMod.REFUSAL };
}

test('t0575-04 — ⛔⛔ THE GUNNER OF SHIP A IS REFUSED A GUNNER ACTION ON SHIP B', async () => {
  if (!haveGuard) { expect(false, 'seat-authority.mjs is installed (run tools/install-system-plugins.sh)'); return; }
  // Ship A's machine. Its gunner and ship B's gunner sit at the SAME station uid.
  const { auth, REFUSAL } = await guardFor('hull-a', [
    ['gunner-a', 'hull-a', GUNNER_UID],
    ['gunner-b', 'hull-b', GUNNER_UID],
  ]);

  // ── the control: on his own hull, A's gunner may fire. Without this the test proves nothing —
  //    a guard that refuses everything would pass the assertion below.
  const own = auth.check('gunner-a', 'fire', 'hull-a');
  expect(own.ok === true, "A's gunner may fire on A", JSON.stringify(own));
  expect(auth.check('gunner-a', 'fire').ok === true,
    'and with no ship named at all — the common case, meaning "the ship I am on"', JSON.stringify(auth.check('gunner-a', 'fire')));

  // ── ⛔⛔ THE TEST. Same person, same station uid, same event, DIFFERENT HULL.
  const other = auth.check('gunner-a', 'fire', 'hull-b');
  expect(other.ok === false, '⛔⛔ REFUSED: he is not aboard that ship', JSON.stringify(other));
  expect(other.reason === REFUSAL.NOT_YOUR_SHIP, 'and the reason NAMES the ship, not the seat', JSON.stringify(other));

  // ── and the converse: B's gunner gets nothing from A's machine, however he asks.
  for (const addressed of [null, 'hull-a', 'hull-b']) {
    const v = auth.check('gunner-b', 'fire', addressed);
    expect(v.ok === false, `B's gunner is refused by A's machine (addressed: ${addressed})`, JSON.stringify(v));
  }
  expect(auth.check('gunner-b', 'fire', 'hull-b').reason === REFUSAL.NOT_ABOARD,
    "⭐ …and the reason says WHY: this machine commands one hull, and it is not B's",
    JSON.stringify(auth.check('gunner-b', 'fire', 'hull-b')));
});

test('t0575-04b — ⭐ THE PLACE CHECK RUNS BEFORE THE SEAT CHECK, and the ORDER is the whole guard', async () => {
  if (!haveGuard) { expect(false, 'seat-authority.mjs is installed'); return; }
  /* ⛔ THE SUBTLE FAILURE THIS FORBIDS. Ask "are you at the Gunner station?" first and the answer
     is YES for the gunner of any hull — the order is granted before anyone thinks to ask which
     ship. The refusal reason is the only way to tell the two orderings apart from outside, which
     is exactly why the guard returns one. */
  const { auth, REFUSAL } = await guardFor('hull-a', [['gunner-b', 'hull-b', GUNNER_UID]]);
  const v = auth.check('gunner-b', 'fire', 'hull-b');
  expect(v.reason === REFUSAL.NOT_ABOARD,
    'a seat-first guard would have said not-your-seat (or said ok); a place-first guard says not-aboard',
    JSON.stringify(v));
  expect(v.reason !== REFUSAL.NOT_YOUR_SEAT, '⛔ and it is NOT reported as a seat problem', JSON.stringify(v));
});

test('t0575-04c — the ORIGINAL rule still holds: the wrong seat on the RIGHT ship is refused', async () => {
  if (!haveGuard) { expect(false, 'seat-authority.mjs is installed'); return; }
  const { auth, REFUSAL } = await guardFor('hull-a', [
    ['cap', 'hull-a', CAPTAIN_UID],
    ['gun', 'hull-a', GUNNER_UID],
    ['loiterer', 'hull-a', null],
  ]);
  expect(auth.check('cap', 'battle-stations').ok === true, 'the Captain may order battle stations');
  const gun = auth.check('gun', 'battle-stations');
  expect(gun.ok === false && gun.reason === REFUSAL.NOT_YOUR_SEAT, 'the Gunner may not', JSON.stringify(gun));
  expect(/Gunner/.test(gun.message), '⭐ and the refusal is IN WORDS, naming his own seat', gun.message);
  const loit = auth.check('loiterer', 'battle-stations');
  expect(loit.ok === false && loit.reason === REFUSAL.NOT_YOUR_SEAT, 'someone in no seat may not', JSON.stringify(loit));
  expect(/not seated/.test(loit.message), 'and is told so', loit.message);
});

test('t0575-04d — a person the ship has never seen, and other nonsense, are ANSWERS not crashes', async () => {
  if (!haveGuard) { expect(false, 'seat-authority.mjs is installed'); return; }
  const { auth, REFUSAL } = await guardFor('hull-a', [['cap', 'hull-a', CAPTAIN_UID]]);
  const ghost = auth.check('never-aboard', 'battle-stations');
  expect(ghost.ok === false && ghost.reason === REFUSAL.UNKNOWN_PERSON, 'an unknown actor is refused', JSON.stringify(ghost));
  expect(auth.check('cap', 'scuttle-the-whole-thing').ok === false, 'an event no seat owns is refused');
  /* ⭐ I EXPECTED THE OPPOSITE HERE AND THE GUARD IS RIGHT. An empty string is not "no ship
     addressed" — it is a ship id that matches nothing, and a guard whose job is authority must
     FAIL CLOSED on input it cannot make sense of. Only `undefined`/`null`, which is what a
     component that names no ship actually sends, means "the ship I am on". */
  const blank = auth.check('cap', 'battle-stations', '');
  expect(blank.ok === false && blank.reason === REFUSAL.NOT_YOUR_SHIP,
    '⛔ an EMPTY addressed ship FAILS CLOSED — it matches no hull, so it is not a match',
    JSON.stringify(blank));
  expect(auth.check('cap', 'battle-stations', undefined).ok === true,
    'while an ABSENT one means "the ship I am on" — the only permissive case, and it is explicit',
    JSON.stringify(auth.check('cap', 'battle-stations', undefined)));
  for (const evil of [{}, [], 42, true]) {
    const v = auth.check('cap', 'battle-stations', evil);
    expect(v.ok === false && v.reason === REFUSAL.NOT_YOUR_SHIP,
      `a non-string addressed ship is refused, never coerced into a match: ${JSON.stringify(evil)}`, JSON.stringify(v));
  }
});

test('t0575-04e — ⛔ THE GUARD FOLLOWS THE PERSON: leave the ship, lose the authority', async () => {
  if (!haveGuard) { expect(false, 'seat-authority.mjs is installed'); return; }
  const { auth, people, REFUSAL } = await guardFor('hull-a', [['cap', 'hull-a', CAPTAIN_UID]]);
  expect(auth.check('cap', 'battle-stations').ok === true, 'aboard and in the chair');
  /* ⭐ P3 made this one write. The Captain steps onto a world; his seat is dropped by the person
     model, and his authority goes with it — WITHOUT the guard knowing anything happened. */
  people.moveTo('cap', 'a-beach');
  const v = auth.check('cap', 'battle-stations');
  expect(v.ok === false, '⛔ he cannot order battle stations from a beach', JSON.stringify(v));
  expect(v.reason === REFUSAL.NOT_ABOARD, 'and the reason is that he is not aboard', JSON.stringify(v));
  people.moveTo('cap', 'hull-a');
  expect(auth.check('cap', 'battle-stations').ok === false,
    '⛔ and coming back aboard is not enough — he has to sit down again',
    JSON.stringify(auth.check('cap', 'battle-stations')));
  people.seat('cap', CAPTAIN_UID);
  expect(auth.check('cap', 'battle-stations').ok === true, '⭐ back in the chair, back in command');
});
