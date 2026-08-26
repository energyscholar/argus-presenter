/*
 * Plan 0692 T2 — ⭐ A RENAME MOVES A LABEL. IT MUST NOT MOVE THE KEY.
 *
 * ⭐ Bruce, 2026-08-26, correcting the spec mid-flight:
 *   "IDENTITY is one thing, current NAME is another matter. On one login I might name myself 'Bob'
 *    and on another 'Conan' and that's fine. My IDENTITY to the server should remain consistent
 *    where possible."
 *
 * `userId` is the KEY — seats, locks, private slices and presence rows are all keyed on it.
 * `userName` is the LABEL a human reads. This file pins the seam between them ON THE WIRE, where
 * a raw socket can reach it and a browser is not needed to see the truth.
 *
 * ⛔ AC5 IS THE ONE THAT MATTERS: take a lock, rename, and the lock is STILL YOURS. A rename that
 *   re-derived the id would look exactly like a success — a new label, a happy page — and would
 *   leave a lock held by a userId that will never connect again. Nothing else in the suite would
 *   have noticed.
 *
 * ⛔ F3 — ON A SEAT LINK THE NAME *IS* THE KEY (userId = <stationCode>-<slug(userName)>, pinned by
 *   t79), so renaming there would be exactly the identity change forbidden above. It is refused
 *   SERVER-SIDE, not merely hidden in the page: a rule enforced only in the client is a rule a raw
 *   socket does not have.
 *
 * ⛔ F2 — THE RENAME IS NOT AN `op`. It is how an unnamed visitor becomes named, so it can never
 *   sit behind the write-gate that unnamed visitors are subject to. Tested here by renaming from a
 *   connection that arrived with no name at all.
 */
import { test, check, expect } from '../../harness/test.mjs';
import { createServer, slugForSeat } from '../../app/server.mjs';
import { WebSocket } from 'ws';
import { makePluginsDir, withPlugins, stationManifest, connect, last } from './_0514-fixtures.mjs';
import { mintCapability } from '../../lib/capability.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Re-read the presence row for a userId (presence is the roster everybody else reads). */
const row = (server, userId) => server.presence().find((p) => p.userId === userId) || null;

test('0692 AC5/AC6 — a rename keeps the userId, the seat and the LOCK, and the last name stands', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  const conns = [];
  try {
    const UID = 'u-abcd1234';
    const LOCK_PATH = 'shared/0692/desk';
    const c = await connect(WebSocket, url, { userId: UID, userName: 'Bob' });
    conns.push(c);
    expect(last(c, 'welcome').userId === UID, 'the connection is seated under the id it asked for', last(c, 'welcome').userId);

    // ── Take a lock. `shared/**` is the participant-writable collaborative slice (0691). ───────
    c.send({ t: 'op', path: LOCK_PATH, verb: 'lock', opId: UID + ':lock' });
    await wait(120);
    expect(server.store.lockOwnerFor(LOCK_PATH) === UID, 'the lock is held by this userId', String(server.store.lockOwnerFor(LOCK_PATH)));

    // ── RENAME. One field moves. ──────────────────────────────────────────────────────────────
    c.send({ t: 'rename', userName: 'Conan' });
    await wait(120);
    const r1 = last(c, 'renamed');
    check('the server acknowledges the rename', !!r1, JSON.stringify(r1 || null));
    check('...and the acknowledgement carries the UNCHANGED userId', r1 && r1.userId === UID, r1 && r1.userId);
    check('...and the new name', r1 && r1.userName === 'Conan', r1 && r1.userName);

    // ⛔ THE ASSERTION THIS FILE EXISTS FOR.
    check('⛔ AC5 — the LOCK IS STILL HELD BY THE SAME userId after the rename',
      server.store.lockOwnerFor(LOCK_PATH) === UID, String(server.store.lockOwnerFor(LOCK_PATH)));
    const p = row(server, UID);
    check('⛔ AC5 — and the roster row is the SAME person, relabelled, not a second one',
      !!p && p.userName === 'Conan', JSON.stringify(server.presence().map((x) => [x.userId, x.userName])));
    check('⛔ AC5 — exactly ONE roster row: a rename did not mint a second identity',
      server.presence().filter((x) => x.userId === UID).length === 1,
      JSON.stringify(server.presence().map((x) => x.userId)));
    check('⛔ AC5 — and NO row appeared under a name-derived id (the forbidden `userId = slug(name)`)',
      !server.presence().some((x) => x.userId === 'conan' || x.userId === slugForSeat('Conan')),
      JSON.stringify(server.presence().map((x) => x.userId)));

    // ── AC6 — twice in a session, and the last one stands. ────────────────────────────────────
    c.send({ t: 'rename', userName: 'Ferdinand' });
    await wait(120);
    check('AC6 — a second rename in the same session works', row(server, UID) && row(server, UID).userName === 'Ferdinand',
      JSON.stringify(row(server, UID)));
    check('AC6 — and the key still has not moved', server.store.lockOwnerFor(LOCK_PATH) === UID,
      String(server.store.lockOwnerFor(LOCK_PATH)));

    // A blank is not a name: the old one stands rather than the roster going empty.
    c.send({ t: 'rename', userName: '   ' });
    await wait(100);
    check('a blank rename is ignored, not applied', row(server, UID) && row(server, UID).userName === 'Ferdinand',
      JSON.stringify(row(server, UID)));
  } finally {
    for (const c of conns) { try { c.ws.close(); } catch (e) {} }
    await server.close();
  }
});

test('0692 F2 — an UNNAMED visitor can name themselves: identity does not travel on the gated path', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  const conns = [];
  try {
    const UID = 'u-nameless1';
    // ⛔ What an unnamed visitor's page now sends: a userId and NO userName at all.
    const c = await connect(WebSocket, url, { userId: UID });
    conns.push(c);
    const w = last(c, 'welcome');
    check('an unnamed hello is accepted (the stage is never blocked)', !!w && w.userId === UID, JSON.stringify(w || null));
    // The anonymous path answers `userName: m.userName || userId` — a PLACEHOLDER, not a name.
    check('...and the server hands back a placeholder, not the literal `Guest`', w && w.userName !== 'Guest', w && w.userName);

    c.send({ t: 'rename', userName: 'Newly Named' });
    await wait(120);
    check('⛔ F2 — setting a name WHILE UNNAMED succeeds; the gate cannot deadlock',
      row(server, UID) && row(server, UID).userName === 'Newly Named', JSON.stringify(row(server, UID)));
    check('...and it did not mint a new identity on the way', row(server, UID).userId === UID, row(server, UID).userId);
  } finally {
    for (const c of conns) { try { c.ws.close(); } catch (e) {} }
    await server.close();
  }
});

test('0692 AC10/T6 — two people may share a name; the uids are what tell them apart', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  const conns = [];
  try {
    const A = 'u-aaaa1111', B = 'u-bbbb2222';
    const ca = await connect(WebSocket, url, { userId: A, userName: 'Bruce' });
    const cb = await connect(WebSocket, url, { userId: B, userName: 'Bruce' });
    conns.push(ca, cb);
    await wait(120);
    const rowsFor = (n) => server.presence().filter((p) => p.userName === n);
    check('⛔ T6 — BOTH keep the name; a duplicate is never refused', rowsFor('Bruce').length === 2,
      JSON.stringify(server.presence().map((p) => [p.userId, p.userName])));
    check('⛔ T6 — and neither stored value was MUTATED into `Bruce (2)`',
      rowsFor('Bruce').every((p) => p.userName === 'Bruce'), JSON.stringify(rowsFor('Bruce')));
    check('AC10 — their uids differ, which is the thing that actually distinguishes them',
      rowsFor('Bruce')[0].userId !== rowsFor('Bruce')[1].userId, JSON.stringify(rowsFor('Bruce').map((p) => p.userId)));

    // And a rename INTO an existing name is equally allowed.
    const cc = await connect(WebSocket, url, { userId: 'u-cccc3333', userName: 'Someone Else' });
    conns.push(cc);
    cc.send({ t: 'rename', userName: 'Bruce' });
    await wait(120);
    check('T6 — renaming INTO a name somebody else holds is allowed too', rowsFor('Bruce').length === 3,
      JSON.stringify(server.presence().map((p) => [p.userId, p.userName])));
  } finally {
    for (const c of conns) { try { c.ws.close(); } catch (e) {} }
    await server.close();
  }
});

test('0692 F3 — a SEAT-DERIVED identity refuses to be renamed, server-side', async () => {
  const dir = makePluginsDir({ fixture: { 'plugin.json': stationManifest() } });
  await withPlugins(dir, async () => {
    const server = await createServer({ port: 0 });
    const url = server.url().replace('http', 'ws');
    const conns = [];
    try {
      const DERIVED = 'alpha-' + slugForSeat('Bex Orrow');
      const c = await connect(WebSocket, url, { stationUID: 1, userName: 'Bex Orrow' });
      conns.push(c);
      expect(last(c, 'welcome').userId === DERIVED, 'the seat link derived its id (t79 rule, untouched)', last(c, 'welcome').userId);

      c.send({ t: 'rename', userName: 'Somebody Else' });
      await wait(140);
      const r = last(c, 'renamed');
      check('⛔ F3 — the rename is REFUSED and says why', r && r.refused === 'seat-link', JSON.stringify(r || null));
      check('⛔ F3 — the userId did not move', r && r.userId === DERIVED, r && r.userId);
      check('⛔ F3 — and the roster still shows the SEAT identity, not the typed one',
        server.presence().some((p) => p.userId === DERIVED && p.userName === 'Bex Orrow'),
        JSON.stringify(server.presence().map((p) => [p.userId, p.userName])));
      check('⛔ F3 — no second row appeared for the name that was refused',
        !server.presence().some((p) => p.userName === 'Somebody Else'),
        JSON.stringify(server.presence().map((p) => p.userName)));
    } finally {
      for (const c of conns) { try { c.ws.close(); } catch (e) {} }
      await server.close();
    }
  });
});

test('0692 — a rename never reaches the seat-link derivation (t79 stays true either side of it)', async () => {
  /* ⛓ The negative that keeps the two halves separated. A plain connection renames as often as it
   * likes; a seat link on the SAME server still derives, still discards ?userId=, and is unaffected
   * by anything the renamers did. If the rename path ever started re-deriving, this is where the
   * two behaviours would collide. */
  const dir = makePluginsDir({ fixture: { 'plugin.json': stationManifest() } });
  await withPlugins(dir, async () => {
    const server = await createServer({ port: 0 });
    const url = server.url().replace('http', 'ws');
    const conns = [];
    try {
      const plain = await connect(WebSocket, url, { userId: 'u-plain0001', userName: 'First' });
      conns.push(plain);
      plain.send({ t: 'rename', userName: 'Second' });
      await wait(120);
      const seat = await connect(WebSocket, url, { stationUID: 1, userId: 'ignored-by-design', userName: 'Second' });
      conns.push(seat);
      const w = last(seat, 'welcome');
      check('the seat link still DERIVES', w && w.userId === 'alpha-' + slugForSeat('Second'), w && w.userId);
      check('...and still DISCARDS the caller\'s ?userId=', w && w.userId !== 'ignored-by-design', w && w.userId);
      check('...while the renamer is still their own, separate identity',
        server.presence().some((p) => p.userId === 'u-plain0001' && p.userName === 'Second'),
        JSON.stringify(server.presence().map((p) => [p.userId, p.userName])));
    } finally {
      for (const c of conns) { try { c.ws.close(); } catch (e) {} }
      await server.close();
    }
  });
});

test('0692 — a CAPABILITY GUEST may not rename over the name its signed token carries', async () => {
  /* ⛔ 0472 P4's rule, restated by the rename path: a guest's identity and scope come from the
   * token, and the client cannot widen either. The page hides the control; this is the socket a
   * page is not required to be. */
  const SECRET = 'cap-secret-0692-unit';
  const server = await createServer({ port: 0, capSecret: SECRET });
  const url = server.url().replace('http', 'ws');
  const conns = [];
  try {
    const cap = mintCapability({ v: 1, sid: 'g-unit', role: 'participant', scope: ['speak', 'type'],
      name: 'Token Named', exp: Math.floor(Date.now() / 1000) + 600, nonce: 'n-0692-unit' }, SECRET);
    const c = await connect(WebSocket, url, { cap, userId: 'client-claimed', userName: 'Client Claimed' });
    conns.push(c);
    const w = last(c, 'welcome');
    expect(w && w.guest === true, 'the capability was accepted as a guest', JSON.stringify(w || null));
    expect(w.userName === 'Token Named', 'and the TOKEN named it, not the client', w.userName);

    c.send({ t: 'rename', userName: 'Self Promoted' });
    await wait(140);
    const r = last(c, 'renamed');
    check('the rename is refused, and says why', r && r.refused === 'guest', JSON.stringify(r || null));
    check('the token\'s name still stands on the roster',
      server.presence().some((p) => p.userName === 'Token Named'),
      JSON.stringify(server.presence().map((p) => p.userName)));
    check('and no row carries the name the client tried to claim',
      !server.presence().some((p) => p.userName === 'Self Promoted'),
      JSON.stringify(server.presence().map((p) => p.userName)));
  } finally {
    for (const c of conns) { try { c.ws.close(); } catch (e) {} }
    await server.close();
  }
});
