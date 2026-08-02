/*
 * Plan 0514 PHASE 2 — provisioning and identity (§5).
 *
 * This is what closes 0508 D3: an anon seat minted a NEW userId on every reload, orphaning both
 * its station and its spotlight grant. Identity now DERIVES FROM THE SEAT LINK — one rule, no
 * branch: userId = <stationCode>-<slug(userName)>, always. The earlier draft branched on
 * occupancy (bare code for single-occupancy stations); Bruce's ruling that any number of players
 * may occupy any station kills that branch, because the bare form then collides on EVERY station.
 * t0514-19b is the test that stops it being reintroduced.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer, slugForSeat } from '../../app/server.mjs';
import { WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ROOT, wait, connect, last } from './_0514-fixtures.mjs';

/**
 * Simulate what app/presenter.html sends for a given seat link. Kept in ONE place.
 * §5.1 (Bruce, S220): the SELECTOR is `?stationUID=<int>`. `?station=` is cosmetic and is never
 * read, so this helper does not even send it — a test that could smuggle it into the hello would
 * be testing a path the client no longer has.
 */
function seatLink({ stationUID = null, name = undefined, role = undefined } = {}) {
  // The client always sends the key (null when the link carries no usable uid) so the server
  // resolves a seat rather than falling through to the anonymous identity path.
  const hello = { stationUID: Number.isInteger(stationUID) ? stationUID : null };
  // The name param goes raw; empty ⇒ the server displays NAME UNKNOWN.
  hello.userName = name !== undefined ? name : '';
  if (role !== undefined) hello.role = role;
  return hello;
}

test('t0514-07 — ?stationUID=1&name=Wren ⇒ userId captain-wren, userName Wren', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const c = await connect(WebSocket, url, seatLink({ stationUID: 1, name: 'Wren' }));
    const w = last(c, 'welcome');
    expect(w.userId === 'captain-wren', 'userId derives from the link', w.userId);
    expect(w.userName === 'Wren', 'userName is the link name', w.userName);
    expect(w.stationUid === 1, 'and the seat is at the Captain uid', String(w.stationUid));
    c.ws.close();
  } finally { await server.close(); }
});

test('t0514-08 — ?stationUID=4 seats Sensors; empty / non-numeric / unknown / absent ALL seat the default', async () => {
  // §5.1, Bruce S220. A uid cannot be misspelled into a DIFFERENT station: it either resolves or
  // it does not. The string form this replaced silently seated an Observer for
  // `?station=damage-control`, because the code is `dc` — Bruce hit that in his own first draft
  // of a seat link, which is what prompted the ruling.
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  const DEFAULT = server.stations().stationDefaultUid;
  try {
    const good = await connect(WebSocket, url, seatLink({ stationUID: 4, name: 'Bex' }));
    expect(last(good, 'welcome').stationUid === 4, 'a valid uid resolves', String(last(good, 'welcome').stationUid));
    expect(last(good, 'welcome').userId === 'sensors-bex', 'and the userId uses the RESOLVED code', last(good, 'welcome').userId);

    // Everything the client can hand the server when the link is wrong. The client normalises an
    // empty or non-numeric `?stationUID=` to null before the hello, so `null` is what arrives.
    const cases = [
      ['empty ?stationUID=', { stationUID: null, userName: 'A' }],
      ['non-numeric ?stationUID=abc', { stationUID: null, userName: 'B' }],
      ['a non-integer that slipped through', { stationUID: 'abc', userName: 'C' }],
      ['a float', { stationUID: 4.5, userName: 'D' }],
      ['unknown uid 999', { stationUID: 999, userName: 'E' }],
      ['no usable param at all', { stationUID: null, userName: 'F' }],
    ];
    for (const [what, hello] of cases) {
      const c = await connect(WebSocket, url, hello);
      const w = last(c, 'welcome');
      expect(w.stationUid === DEFAULT, `${what} ⇒ the default station`, what + ' -> ' + String(w.stationUid));
      expect(c.ws.readyState === 1, `${what} is never an error and never a disconnect`);
      c.ws.close();
    }
    good.ws.close();
  } finally { await server.close(); }
});

test('t0514-08b — the RETIRED string forms are inert: a cosmetic ?station= cannot move a seat', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  const DEFAULT = server.stations().stationDefaultUid;
  try {
    // `?station=` survives ONLY so a link reads sensibly to a human. Nothing parses it. This test
    // is what stops it quietly becoming load-bearing again.
    const withUid = await connect(WebSocket, url, { stationUID: 8, userName: 'Vic', station: 'anything-at-all' });
    expect(last(withUid, 'welcome').stationUid === 8, 'the uid decides, whatever the cosmetic string says', String(last(withUid, 'welcome').stationUid));
    expect(last(withUid, 'welcome').userId === 'dc-vic', 'and the userId comes from the resolved code', last(withUid, 'welcome').userId);

    // A label or code with NO uid resolves nothing — not the station it names, not an error.
    for (const s of ['dc', 'Damage Control', 'damage-control']) {
      const c = await connect(WebSocket, url, { stationUID: null, userName: 'X', station: s });
      expect(last(c, 'welcome').stationUid === DEFAULT, `"${s}" alone seats the default`, s + ' -> ' + String(last(c, 'welcome').stationUid));
      c.ws.close();
    }
    withUid.ws.close();
  } finally { await server.close(); }
});

test('t0514-09 — a missing name ⇒ NAME UNKNOWN, displayed literally, and a stable -anon seat', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const c = await connect(WebSocket, url, seatLink({ stationUID: 1 }));
    const w = last(c, 'welcome');
    expect(w.userName === 'NAME UNKNOWN', 'never blank', JSON.stringify(w.userName));
    expect(w.userId === 'captain-anon', 'and the slug degrades to anon', w.userId);
    c.ws.close();
  } finally { await server.close(); }
  // The slug rule itself, in isolation.
  expect(slugForSeat('') === 'anon' && slugForSeat('   ') === 'anon', 'empty ⇒ anon');
  expect(slugForSeat('Bex Orrow') === 'bex-orrow', 'spaces collapse to one dash', slugForSeat('Bex Orrow'));
  expect(slugForSeat('!!! Tamsin !!!') === 'tamsin', 'leading/trailing punctuation is trimmed', slugForSeat('!!! Tamsin !!!'));
  expect(slugForSeat('a'.repeat(40)).length === 24, 'capped at 24 chars', String(slugForSeat('a'.repeat(40)).length));
});

test('t0514-10 — reconnecting on the SAME LINK returns the same userId; station + spotlight survive (D3)', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const link = seatLink({ stationUID: 4, name: 'Bex Orrow' });
    const first = await connect(WebSocket, url, link);
    const id = last(first, 'welcome').userId;
    server.spotlight(id, true); await wait(120);
    first.ws.close(); await wait(200);

    const again = await connect(WebSocket, url, link);
    const w = last(again, 'welcome');
    expect(w.userId === id, 'SAME userId — this is the whole point', w.userId + ' vs ' + id);
    expect(w.stationUid === 4, 'and the same station', String(w.stationUid));
    // welcome.spotlightGranted is how the client restores its own Share control on reconnect
    // instead of losing it until the GM happens to re-grant (the 0508 D1 class of bug).
    expect(w.spotlightGranted === true, 'and the spotlight grant survived the round trip', JSON.stringify(w.spotlightGranted));
    again.ws.close();
  } finally { await server.close(); }
});

test('t0514-11 — ?role= means ONLY the privilege axis; the station alias is RETIRED', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  const DEFAULT = server.stations().stationDefaultUid;
  try {
    // §5.1 retires the `?role=<station>` fold. It was a shim for links in the wild, and nothing
    // is deployed — keeping it would preserve exactly the string hazard the ruling removes, and
    // it would leave two things called "role" one query parameter apart (naming canon §1/§6).
    expect(!/USER_ROLES/.test(readFileSync(join(ROOT, 'app', 'presenter.html'), 'utf8')),
      'the client no longer folds a non-userRole ?role= value into the station selector');

    const pres = await connect(WebSocket, url, { userId: 'p1', userName: 'P', role: 'presenter' });
    expect(last(pres, 'welcome').role === 'presenter', 'a real userRole still works', last(pres, 'welcome').role);
    // An unknown role is still downgraded to participant and logged (the 0482 identity seam) —
    // it is NOT reinterpreted as a station.
    const odd = await connect(WebSocket, url, { stationUID: 9, userName: 'Ada', role: 'Medic' });
    expect(last(odd, 'welcome').role === 'participant', 'an unknown role is downgraded, not treated as a station', last(odd, 'welcome').role);
    expect(last(odd, 'welcome').stationUid === 9, 'and the uid alone decides the seat', String(last(odd, 'welcome').stationUid));
    expect(DEFAULT !== 9, 'the assertion above is meaningful (9 is not the default)');
    pres.ws.close(); odd.ws.close();
  } finally { await server.close(); }
});

test('t0514-19 — two Gunner links with different names get DISTINCT userIds and neither displaces the other', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const m = await connect(WebSocket, url, seatLink({ stationUID: 5, name: 'Tamsin' }));
    const a = await connect(WebSocket, url, seatLink({ stationUID: 5, name: 'Anemone' }));
    expect(last(m, 'welcome').userId === 'gunner-tamsin', 'first gunner', last(m, 'welcome').userId);
    expect(last(a, 'welcome').userId === 'gunner-anemone', 'second gunner', last(a, 'welcome').userId);
    // t0514-40 — and BOTH are in the same occupants list. Multiplicity works because occupancy is
    // extended state keyed by uid, not a vacant|occupied region per station.
    const occ = server.store.get('ship/stations/5/occupants') || [];
    expect(occ.includes('gunner-tamsin') && occ.includes('gunner-anemone'), 't0514-40 — both appear in the SAME occupants list', JSON.stringify(occ));
    m.ws.close(); a.ws.close();
  } finally { await server.close(); }
});

test('t0514-19b — two CAPTAIN links with different names likewise (the single-occupancy branch is GONE)', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const j = await connect(WebSocket, url, seatLink({ stationUID: 1, name: 'Wren' }));
    const k = await connect(WebSocket, url, seatLink({ stationUID: 1, name: 'Kira' }));
    expect(last(j, 'welcome').userId === 'captain-wren' && last(k, 'welcome').userId === 'captain-kira',
      'distinct seats at a maxOccupants:1 station', last(j, 'welcome').userId + ' / ' + last(k, 'welcome').userId);
    // Under the killed branch BOTH would have been the bare code `captain` and would have silently
    // displaced each other. That is why this test is written for Captain specifically.
    expect(last(j, 'welcome').userId !== last(k, 'welcome').userId, 'no collision on a single-occupancy station');
    j.ws.close(); k.ws.close();
  } finally { await server.close(); }
});

test('t0514-41 — maxOccupants is RECORDED AND DELIBERATELY NOT ENFORCED', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const cap = server.stations().stations.find((s) => s.stationUid === 1);
    expect(cap.maxOccupants === 1, 'the cap is carried forward from the role manifest', String(cap.maxOccupants));
    const conns = [];
    for (const n of ['One', 'Two', 'Three', 'Four', 'Five']) conns.push(await connect(WebSocket, url, seatLink({ stationUID: 1, name: n })));
    await wait(120);
    const occ = server.store.get('ship/stations/1/occupants') || [];
    // Bruce: "its fine if multiple users land on a single station. Later we may restrict this but
    // not yet." This test exists so nobody "finishes" the feature by quietly switching it on —
    // enforcement is later a guard over occupants, not a schema change.
    expect(occ.length === 5, 'five seats occupy a maxOccupants:1 station', JSON.stringify(occ));
    for (const c of conns) c.ws.close();
  } finally { await server.close(); }
});

test('t0514-44 — a bad ?stationUID= derives its userId from the RESOLVED station, not the raw param', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const c = await connect(WebSocket, url, seatLink({ stationUID: 999, name: 'Les' }));
    const w = last(c, 'welcome');
    expect(w.userId === 'observer-les', 'observer-les, never a seat named after an unresolvable uid', w.userId);
    expect(w.stationUid === server.stations().stationDefaultUid, 'and it is seated at the default');
    // A raw param would also let a mistyped link mint an identity for a station that does not
    // exist — a seat nothing could ever address.
    expect(!/999/.test(w.userId), 'the raw param does not leak into identity', w.userId);
    c.ws.close();
  } finally { await server.close(); }
});
