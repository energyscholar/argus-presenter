/*
 * Plan 0894 F1 — a station row of domain `place` is NOT A SEAT.
 *
 * A plugin's station rows may include rows a PLACE offers to a ROLE (a lounge, a customs desk). Another
 * client serves those; the presenter seats nobody at one. The registry still VALIDATES them (a uid, code or
 * label collision with a seat stays a load error), but they never enter the seat list, never resolve by uid,
 * never reach the wire, and can never be the deployment default.
 */
import { test, expect } from '../../harness/test.mjs';
import { buildStationRegistry } from '../../harness/plugins.mjs';
import { stationManifest } from './_0514-fixtures.mjs';

const PLACE = { stationUid: 3, stationCode: 'lobby', stationLabel: 'Lobby', group: 'Place', domain: 'place', maxOccupants: null, sortOrder: 3 };
const withPlace = (row = PLACE, over = {}) => {
  const m = stationManifest(over);
  m.stations.push({ ...row });
  return m;
};
function throwsWith(fn, needle) {
  try { fn(); return { threw: false, msg: '' }; }
  catch (e) { const msg = String(e && e.message || e); return { threw: true, msg, matched: msg.toLowerCase().includes(needle) }; }
}

test('t0894-f1-01 — a place row is not in the seat list, does not resolve by uid, and never reaches the wire', () => {
  const reg = buildStationRegistry({ fixture: withPlace() }, {});
  expect(reg.list.length === 2, 'the seat list holds only the two seats', reg.list.map((s) => s.stationCode));
  expect(reg.get(3) === null, 'a place uid resolves to nothing (the caller falls back to the default)', reg.get(3));
  expect(!reg.wire().some((s) => s.stationUid === 3), 'the place row never reaches a client', reg.wire());
});

test('t0894-f1-02 — a place row is still VALIDATED: a collision with a seat is a load error', () => {
  const dupUid = throwsWith(() => buildStationRegistry({ fixture: withPlace({ ...PLACE, stationUid: 1 }) }, {}), 'duplicate stationuid');
  expect(dupUid.matched, 'a place row reusing a seat uid throws', dupUid.msg);
  const dupCode = throwsWith(() => buildStationRegistry({ fixture: withPlace({ ...PLACE, stationCode: 'alpha' }) }, {}), 'duplicate stationcode');
  expect(dupCode.matched, 'a place row reusing a seat code throws', dupCode.msg);
});

test('t0894-f1-03 — a place row can never be the deployment default seat', () => {
  const r = throwsWith(() => buildStationRegistry({ fixture: withPlace(PLACE, { stationDefaultUid: 3 }) }, {}), 'stationdefaultuid');
  expect(r.matched, 'a default naming a place row does not resolve to a seat', r.msg);
});
