/*
 * Plan 0687 R4 — ⛔ REPLAY READS PAST THE EVICTION BOUNDARY, AND EVERY DISCARD IS COUNTED (G6, G10).
 *
 * The in-memory ring holds 500. Replay-from-ack must read THROUGH that boundary rather than
 * quietly stopping at it — and where it genuinely cannot (no durable room), the loss must be a
 * number the agent can read, not an absence it has to infer.
 *
 * ⭐ The honest shape of this is two branches, and BOTH are tested:
 *   - durable room  ⇒ the unacked entry is spilled BEFORE it is forgotten, and it comes back.
 *   - ephemeral room ⇒ it is gone, and `unrecoverableDiscards` says exactly how many.
 * A phase that only tested the first would be claiming a guarantee the ephemeral room never had.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { SPILL_FILE } from '../../lib/cursor-store.mjs';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const RING = 500;
const scratch = () => mkdtempSync(join(tmpdir(), 'ap-0687r4-'));
const say = (s, text) => s._emitInboxForTest({ kind: 'voice', userId: 'bruce', userName: 'Bruce', role: 'presenter', text });

test('0687 R4 — ⛔ a DURABLE room replays a turn that fell out of the ring unacked', async () => {
  const dir = scratch();
  const s = await createServer({ port: 0, cursorDir: dir });
  try {
    s.pvsStart({ consumer: 'argusmon' });
    say(s, 'the first thing he said');            // seq 1 — never acked
    for (let i = 0; i < RING + 20; i++) say(s, 'filler-' + i);   // push it off the end
    const stats = s.deliveryStats();
    expect(stats.ring.size === RING, 'the ring is at its cap', String(stats.ring.size));
    expect(stats.ring.oldestSeq > 1, 'and seq 1 is NO LONGER IN IT', String(stats.ring.oldestSeq));
    expect(stats.evictedUnackedCount > 0, 'the eviction of unacked entries was counted', String(stats.evictedUnackedCount));
    expect(stats.spilledCount > 0, 'and they were spilled BEFORE being forgotten (durability precedes eviction)', String(stats.spilledCount));
    expect(stats.unrecoverableDiscards === 0, '⛔ so NOTHING was actually lost', String(stats.unrecoverableDiscards));
    expect(existsSync(join(dir, SPILL_FILE)), 'the spill file exists', join(dir, SPILL_FILE));

    const b = s.pvsBacklog({ consumer: 'argusmon', limit: 1000 });
    expect(b.items.length && b.items[0].seq === 1, 'the backlog starts at seq 1 — BEFORE the ring does', String(b.items[0] && b.items[0].seq));
    expect(b.items[0].text === 'the first thing he said', '⛔ AND IT IS THE TURN, VERBATIM, READ PAST THE BOUNDARY', b.items[0].text);
    expect(b.recoveredFromSpill > 0, 'the read says how much came from the spill', String(b.recoveredFromSpill));
    expect(b.missed === 0, 'and reports no gap, because there is none', String(b.missed));
  } finally { await s.close(); }
});

test('0687 R4 — ⛔ an EPHEMERAL room LOSES it, and says how many, in a number', async () => {
  const s = await createServer({ port: 0 });   // no cursorDir — nowhere durable to spill
  try {
    s.pvsStart({ consumer: 'argusmon' });
    say(s, 'the first thing he said');
    for (let i = 0; i < RING + 20; i++) say(s, 'filler-' + i);
    const stats = s.deliveryStats();
    expect(stats.evictedUnackedCount > 0, 'unacked entries were evicted', String(stats.evictedUnackedCount));
    expect(stats.spilledCount === 0, 'none could be spilled — the room is ephemeral', String(stats.spilledCount));
    expect(stats.unrecoverableDiscards === stats.evictedUnackedCount,
      '⛔ every one of them is counted as an UNRECOVERABLE discard, not swallowed',
      stats.unrecoverableDiscards + ' of ' + stats.evictedUnackedCount);
    const b = s.pvsBacklog({ consumer: 'argusmon', limit: 1000 });
    expect(b.missed > 0, 'and the read STATES the gap rather than starting quietly at the ring', String(b.missed));
    expect(typeof b.missedMarker === 'string' && b.missedMarker.includes('missed'), 'with a human-visible marker', b.missedMarker);
  } finally { await s.close(); }
});

test('0687 R4 — an eviction NOBODY is waiting on is counted, and is not a discard', async () => {
  const s = await createServer({ port: 0 });
  try {
    // No PVS consumer at all ⇒ minAcked() is null ⇒ nothing is anybody's backlog.
    for (let i = 0; i < RING + 10; i++) say(s, 'filler-' + i);
    const stats = s.deliveryStats();
    expect(stats.evictedCount >= 10, 'evictions are counted even with no consumer', String(stats.evictedCount));
    expect(stats.evictedUnackedCount === 0 && stats.unrecoverableDiscards === 0,
      '⛔ but they are NOT reported as lost turns — nobody was owed them',
      JSON.stringify({ u: stats.evictedUnackedCount, d: stats.unrecoverableDiscards }));
  } finally { await s.close(); }
});

test('0687 R4 — an acked entry stops being retained: the spill COMPACTS', async () => {
  const dir = scratch();
  const s = await createServer({ port: 0, cursorDir: dir });
  try {
    s.pvsStart({ consumer: 'argusmon' });
    for (let i = 0; i < RING + 50; i++) say(s, 'filler-' + i);
    const path = join(dir, SPILL_FILE);
    const before = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).length;
    expect(before > 0, 'the spill holds the unacked overflow', String(before));
    // The real agent flow: READ the backlog, then ack. A bare ack means "everything you handed
    // me", and the read is what handed it over — so no seq is needed and none is guessed at.
    s.pvsBacklog({ consumer: 'argusmon', limit: 1000 });
    s.pvsAck({ consumer: 'argusmon' });
    const after = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).length : 0;
    expect(after === 0, '⛔ once everybody has acked past them, the spilled entries are dropped', before + ' -> ' + after);
    expect(s.pvsBacklog({ consumer: 'argusmon' }).count === 0, 'and the backlog is empty');
  } finally { await s.close(); }
});

test('0687 R4 — the spill survives a RESTART: replay reads past the boundary AND past the process', async () => {
  const dir = scratch();
  const a = await createServer({ port: 0, cursorDir: dir });
  try {
    a.pvsStart({ consumer: 'argusmon' });
    say(a, 'said before everything else');
    for (let i = 0; i < RING + 20; i++) say(a, 'filler-' + i);
  } finally { await a.close(); }

  const b = await createServer({ port: 0, cursorDir: dir });
  try {
    b.pvsStart({ consumer: 'argusmon' });
    const back = b.pvsBacklog({ consumer: 'argusmon', limit: 1000 });
    expect(back.count > 0, 'there is still a backlog after the restart', String(back.count));
    expect(back.items[0].text === 'said before everything else',
      '⛔ and the FIRST unacked turn is the one that fell out of a ring that no longer exists', back.items[0].text);
  } finally { await b.close(); }
});
