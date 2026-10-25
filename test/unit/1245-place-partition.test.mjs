/*
 * Plan 1245 P1 — the station registry is a registry of SEATS. domain:"place" rows are validated
 * like any row, then partitioned into `places`; they never reach list/byUid/get/wire().
 */
import { test, expect } from '../../harness/test.mjs';
import { buildStationRegistry } from '../../harness/plugins.mjs';

function manifest(withPlaces = true) {
  const stations = [
    { stationUid: 1, stationCode: 'alpha', stationLabel: 'Alpha' },
    { stationUid: 2, stationCode: 'beta', stationLabel: 'Beta' },
  ];
  if (withPlaces) {
    stations.push({ stationUid: 31, stationCode: 'lounge', stationLabel: 'Lounge', domain: 'place' });
    stations.push({ stationUid: 30, stationCode: 'wc', stationLabel: 'WC', domain: 'place' });
  }
  return { stations, stationDefaultUid: 1 };
}
const build = (m) => buildStationRegistry({ fixture: m }, {});

test('PP-1 — list and byUid hold exactly the seat rows', () => {
  const r = build(manifest());
  expect(r.list.length === 2, 'list has 2 seats', r.list.length);
  expect(r.get(1) && r.get(2), 'seats resolve');
  expect(r.get(30) === null && r.get(31) === null, 'place uids do not resolve as seats');
});

test('PP-2 — places holds the place rows, sorted like list', () => {
  const r = build(manifest());
  expect(Array.isArray(r.places) && r.places.length === 2, 'places has 2 rows');
  expect(r.places.map((p) => p.stationUid).join() === '30,31', 'sorted by sortOrder/uid', r.places.map((p) => p.stationUid).join());
  expect(r.places[0].stationCode === 'wc' && r.places[0].stationLabel === 'WC', 'carries code and label');
});

test('PP-3 — a place row still takes part in duplicate checks', () => {
  const dupCode = manifest(); dupCode.stations[2].stationCode = 'alpha';
  let threw = false; try { build(dupCode); } catch (e) { threw = /duplicate stationcode/i.test(e.message); }
  expect(threw, 'place code duplicating a seat code throws');
  const dupUid = manifest(); dupUid.stations[3].stationUid = 1;
  threw = false; try { build(dupUid); } catch (e) { threw = /duplicate stationuid/i.test(e.message); }
  expect(threw, 'place uid duplicating a seat uid throws');
  const dupLabel = manifest(); dupLabel.stations[2].stationLabel = 'Beta';
  threw = false; try { build(dupLabel); } catch (e) { threw = /duplicate stationlabel/i.test(e.message); }
  expect(threw, 'place label duplicating a seat label throws');
});

test('PP-4 — wire() contains no place uid', () => {
  const w = build(manifest()).wire();
  expect(w.length === 2 && !w.some((s) => s.stationUid === 30 || s.stationUid === 31), 'no place uid on the wire', JSON.stringify(w));
});

test('PP-5 — a manifest without place rows gives the same registry as before', () => {
  const r = build(manifest(false));
  const seatsOnly = build(manifest(true));
  expect(JSON.stringify(r.list) === JSON.stringify(seatsOnly.list), 'list identical with/without places');
  expect(JSON.stringify(r.wire()) === JSON.stringify(seatsOnly.wire()), 'wire identical with/without places');
  expect(Array.isArray(r.places) && r.places.length === 0, 'no places');
  expect(r.list.length === 2 && r.defaultUid === 1, 'unchanged shape');
});
