/*
 * Plan 0522 P3 — ONE PERSON, ONE ROSTER ROW.
 *
 * `presence()` (and the control roster it feeds) projected SOCKETS, not people. A seat-linked
 * player's identity is DERIVED — userId = <stationCode>-<slug(userName)> — so it survives a
 * reload on purpose; the cost was that a reload before the old socket is reaped put the same
 * person on the GM's roster twice.
 *
 * ⚠ The naive dedupe is a WORSE bug than the duplicate row. Because the id is derived from the
 * link and the typed name, TWO DIFFERENT PEOPLE on one seat link typing one name get the SAME
 * userId — and a silent collapse then deletes a real human from the roster (I4). So the contract
 * under test is COLLAPSE **AND** DECLARE: one row, carrying a connection count and a contested
 * marker. Never a count of 1 while two sockets are live.
 *
 *   t04 — two sockets, one userId → ONE row.
 *   t05 — two LIVE sockets sharing a userId → one row with a contested marker and count 2,
 *         on the wire roster the GM actually reads, not only in presence().
 *   t06 — a stale socket reaped → the marker clears.
 *
 * Server-side only: presence() and pushPresence() are core functions, no browser involved, so
 * this sits in the unit tier alongside auth-role.test.mjs (which drives the server the same way).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(pred, { timeout = 4000, every = 50, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return true;
    if (Date.now() - t0 > timeout) throw new Error('timeout waiting for ' + label);
    await wait(every);
  }
}

/** Open a socket, send `hello`, keep every frame it receives. */
async function open(server, frame) {
  const ws = new WebSocket(server.url().replace('http', 'ws'));
  const frames = [];
  ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) {} });
  await new Promise((res, rej) => { ws.on('error', rej); ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', ...frame })); res(); }); });
  await wait(150);
  return { ws, frames, roster: () => { const f = frames.filter((x) => x.t === 'presence'); return f.length ? f[f.length - 1].users : null; } };
}

// The shape a seat link mints: <stationCode>-<slug(userName)>. Two clients reaching this same
// string is the whole point of the derivation — a reload, or two people, cannot be told apart
// by the id alone.
const SEAT = 'ops-participant-b';

test('0522 t04 — two sockets on one derived userId collapse to ONE roster row', async () => {
  const server = await createServer({ port: 0 });
  let a, b;
  try {
    a = await open(server, { userId: SEAT, userName: 'Participant B' });
    b = await open(server, { userId: SEAT, userName: 'Participant B' });   // reload before the old socket is reaped
    await until(() => server.presence().length === 1, { label: 'presence collapses to one row' })
      .catch(() => {});
    const rows = server.presence();
    const mine = rows.filter((u) => u.userId === SEAT);
    expect('one row for one userId, not one per socket', mine.length === 1, 'rows=' + JSON.stringify(rows));
    expect('the row is that person (identity preserved through the collapse)',
      mine.length === 1 && mine[0].userName === 'Participant B' && mine[0].role === 'participant',
      JSON.stringify(mine[0]));
    // The per-socket view is NOT destroyed — it moves to the debug surface, one entry per socket.
    const conns = server.debugDump('presenter').connections.filter((c) => c.userId === SEAT);
    expect('both sockets are still individually accounted for in debugDump.connections',
      conns.length === 2, JSON.stringify(conns));
  } finally { if (a) a.ws.close(); if (b) b.ws.close(); await server.close(); }
});

test('0522 t05 — two LIVE sockets on one userId → one row, contested, count 2', async () => {
  const server = await createServer({ port: 0 });
  let gm, a, b;
  try {
    gm = await open(server, { userId: 'gm1', userName: 'GM', role: 'presenter' });
    a = await open(server, { userId: SEAT, userName: 'Participant B' });
    b = await open(server, { userId: SEAT, userName: 'Participant B' });
    await until(() => (server.presence().find((u) => u.userId === SEAT) || {}).conns === 2,
      { label: 'presence reports both live sockets' }).catch(() => {});

    const row = server.presence().find((u) => u.userId === SEAT);
    expect('presence keeps exactly one row for the contested seat',
      server.presence().filter((u) => u.userId === SEAT).length === 1, JSON.stringify(server.presence()));
    expect('the row reports 2 connections — NEVER 1 while two sockets are live',
      row && row.conns === 2, JSON.stringify(row));
    expect('the row is flagged contested', row && row.contested === true, JSON.stringify(row));

    // The GM's ACTUAL roster is the `presence` frame pushed to control roles. The marker has to
    // be there, or the collapse is invisible on the only surface a human reads.
    await until(() => { const r = gm.roster(); return !!(r && (r.find((u) => u.userId === SEAT) || {}).conns === 2); },
      { label: 'control roster carries the contested seat' }).catch(() => {});
    const roster = gm.roster();
    const seats = (roster || []).filter((u) => u.userId === SEAT);
    expect('the control roster shows one row for the seat', seats.length === 1, JSON.stringify(roster));
    expect('the control roster row carries count 2 and the contested flag',
      seats.length === 1 && seats[0].conns === 2 && seats[0].contested === true, JSON.stringify(seats[0]));
    expect('both socketIds survive on the row, so two people can still be told apart (I4)',
      seats.length === 1 && Array.isArray(seats[0].socketIds) && seats[0].socketIds.length === 2,
      JSON.stringify(seats[0] && seats[0].socketIds));
    // The GM's own uncontested row must not gain a false marker.
    const gmRow = (roster || []).find((u) => u.userId === 'gm1');
    expect('an uncontested row reports 1 connection and no marker',
      gmRow && gmRow.conns === 1 && gmRow.contested === false, JSON.stringify(gmRow));
  } finally { if (a) a.ws.close(); if (b) b.ws.close(); if (gm) gm.ws.close(); await server.close(); }
});

test('0522 t06 — the stale socket is reaped → the contested marker clears', async () => {
  const server = await createServer({ port: 0 });
  let gm, a, b;
  try {
    gm = await open(server, { userId: 'gm1', userName: 'GM', role: 'presenter' });
    a = await open(server, { userId: SEAT, userName: 'Participant B' });
    b = await open(server, { userId: SEAT, userName: 'Participant B' });
    await until(() => (server.presence().find((u) => u.userId === SEAT) || {}).conns === 2,
      { label: 'contested first' }).catch(() => {});
    expect('precondition: the seat is contested by 2 sockets',
      (server.presence().find((u) => u.userId === SEAT) || {}).conns === 2,
      JSON.stringify(server.presence().find((u) => u.userId === SEAT)));

    a.ws.close();   // the stale client goes away; the server reaps it on close
    await until(() => (server.presence().find((u) => u.userId === SEAT) || {}).conns === 1,
      { label: 'presence drops back to one connection' }).catch(() => {});

    const row = server.presence().find((u) => u.userId === SEAT);
    expect('the person is still on the roster after the reap', !!row, JSON.stringify(server.presence()));
    expect('connection count falls back to 1', row && row.conns === 1, JSON.stringify(row));
    expect('the contested marker clears', row && row.contested === false, JSON.stringify(row));
    const seat = (gm.roster() || []).find((u) => u.userId === SEAT);
    expect('the control roster clears the marker too', seat && seat.conns === 1 && seat.contested === false,
      JSON.stringify(seat));
  } finally { if (b) b.ws.close(); if (gm) gm.ws.close(); await server.close(); }
});
