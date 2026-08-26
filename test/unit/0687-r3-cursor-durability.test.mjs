/*
 * Plan 0687 R3 — ⛔ DURABILITY PRECEDES EVICTION, AND IT DOES NOT ASK ABOUT RECORDING (G10, RT-6).
 *
 * The demo room is `record:"none"`. There is no ledger to recover from. If replay needed a
 * transcript on disk, replay would work only in the rooms that were also keeping people's words —
 * which is precisely backwards: recording is a policy about content the humans consented to, a
 * cursor is a policy about whether the agent lost a turn.
 *
 * So the delivery layer keeps its own small per-room file and never asks. These tests restart a
 * server with transcript persistence OFF (the default — nothing is being recorded) and show the
 * ack position still there.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { createCursorStore, CURSOR_FILE } from '../../lib/cursor-store.mjs';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const scratch = () => mkdtempSync(join(tmpdir(), 'ap-0687-'));
const say = (s, text) => s._emitInboxForTest({ kind: 'voice', userId: 'bruce', userName: 'Bruce', role: 'presenter', text });

test('0687 R3 — ⛔ the ack position SURVIVES A RESTART in a room that records NOTHING', async () => {
  const dir = scratch();
  expect(!/^(1|true|yes|on)$/i.test(process.env.PRESENTER_TRANSCRIPT_PERSIST || ''),
    'this test runs with transcript persistence OFF — nothing is being recorded');
  let acked = 0;
  const a = await createServer({ port: 0, cursorDir: dir });
  try {
    a.pvsStart({ consumer: 'argusmon' });
    say(a, 'one'); say(a, 'two'); say(a, 'three');
    acked = a.pvsAck({ consumer: 'argusmon', seq: 2 }).acked;
    expect(acked === 2, 'acked through turn two', String(acked));
  } finally { await a.close(); }

  expect(existsSync(join(dir, CURSOR_FILE)), 'a cursor file was written', join(dir, CURSOR_FILE));
  expect(!existsSync(join(dir, 'transcripts.jsonl')), '⛔ and NO transcript was written — durability did not smuggle recording in');

  const b = await createServer({ port: 0, cursorDir: dir });
  try {
    const st = b.pvsState();
    expect(st.open === false, 'the PVS itself does not survive (the ring is gone) — only the POSITION does');
    const rearm = b.pvsStart({ consumer: 'argusmon' });
    expect(rearm.resumeCursor === 2, '⛔ THE ACK POSITION SURVIVED THE RESTART', String(rearm.resumeCursor));
    expect(rearm.durable === true, 'and the server says out loud that it is durable', String(rearm.durable));
  } finally { await b.close(); }
});

test('0687 R3 — the seq counter resumes above the high-water, so a persisted ack cannot swallow new turns', async () => {
  const dir = scratch();
  const a = await createServer({ port: 0, cursorDir: dir });
  try {
    a.pvsStart({ consumer: 'argusmon' });
    say(a, 'one'); say(a, 'two'); say(a, 'three');
    a.pvsAck({ consumer: 'argusmon' });          // acked through 3
  } finally { await a.close(); }

  const b = await createServer({ port: 0, cursorDir: dir });
  try {
    b.pvsStart({ consumer: 'argusmon' });
    const fresh = say(b, 'spoken after the restart');
    expect(fresh.seq > 3, 'the new turn got a seq ABOVE the persisted high-water', String(fresh.seq));
    const backlog = b.pvsBacklog({ consumer: 'argusmon' });
    expect(backlog.count === 1 && backlog.items[0].text === 'spoken after the restart',
      '⛔ so the restored ack names OLD turns and does not eat the new one', JSON.stringify(backlog.items.map((i) => i.text)));
  } finally { await b.close(); }
});

test('0687 R3 — with no cursorDir the layer is EPHEMERAL, and says so rather than pretending', async () => {
  const s = await createServer({ port: 0 });
  try {
    const start = s.pvsStart({ consumer: 'argusmon' });
    expect(start.durable === false, 'pvsStart states durable:false', String(start.durable));
    expect(s.pvsState().durable === false, 'and so does pvsState', String(s.pvsState().durable));
    expect(s.deliveryStats().durable === false, 'and so does the discard ledger', String(s.deliveryStats().durable));
  } finally { await s.close(); }
});

test('0687 R3 — the file is written atomically, 0600, and a CORRUPT one reads as ABSENT (never a guess)', async () => {
  const dir = scratch();
  const a = await createServer({ port: 0, cursorDir: dir });
  try { a.pvsStart({ consumer: 'argusmon' }); say(a, 'x'); a.pvsAck({ consumer: 'argusmon' }); } finally { await a.close(); }
  const path = join(dir, CURSOR_FILE);
  expect((statSync(path).mode & 0o777) === 0o600, 'the cursor file is 0600', (statSync(path).mode & 0o777).toString(8));
  expect(!existsSync(path + '.tmp'), 'no temp file is left behind — temp+rename completed');

  writeFileSync(path, '{"v":1,"cursors":{"deliv');   // a torn / hand-mangled file
  const b = await createServer({ port: 0, cursorDir: dir });
  try {
    const rearm = b.pvsStart({ consumer: 'argusmon' });
    expect(rearm.resumeCursor === 0, 'an unreadable cursor file reads as ABSENT, not as a guessed position', String(rearm.resumeCursor));
  } finally { await b.close(); }

  writeFileSync(path, JSON.stringify({ v: 99, cursors: { delivery: { 'pvs:argusmon': { sent: 40, acked: 40 } } }, inboxSeq: 40 }));
  const c = await createServer({ port: 0, cursorDir: dir });
  try {
    expect(c.pvsStart({ consumer: 'argusmon' }).resumeCursor === 0, 'an UNKNOWN FORMAT version is refused too, by version, not by hope');
  } finally { await c.close(); }
});

test('0687 R3 — an inert store is inert, and an unwritable one is COUNTED rather than thrown', async () => {
  const inert = createCursorStore({ dir: null });
  expect(inert.configured === false, 'no dir ⇒ not configured');
  expect(inert.load().present === false && inert.save({ cursors: {}, inboxSeq: 1 }) === false, 'and every operation is a quiet, stated no-op');
  expect(inert.spill({ seq: 1 }) === false, 'a spill into an inert store returns FALSE — the caller must count the discard');

  const blocker = join(scratch(), 'i-am-a-file');
  writeFileSync(blocker, 'not a directory');
  const bad = createCursorStore({ dir: join(blocker, 'nested') });   // a FILE cannot be a parent directory
  expect(bad.save({ cursors: {}, inboxSeq: 1 }) === false, 'an unwritable directory returns false rather than throwing');
  expect(bad.stats().writeFailures === 1, 'and the failure is COUNTED', String(bad.stats().writeFailures));
});
