/*
 * Plan 0687 R2 — ⛔ AN ACK IS AN AGENT ACT (G5).
 *
 * ⭐ This is not a hypothetical about a future demo guest. Argus's own listener had this defect on
 * 2026-08-25: it polled a surface whose SERVER-HELD cursor advanced when the response was SERVED,
 * so a transfer truncated mid-JSON acked turns nobody read. Twice. Nothing was lost, by luck.
 *
 * The rule: the delivery layer may advance `sent` — the socket got bytes — and may NEVER advance
 * `acked`. Only the consumer, calling api.pvsAck, says it has read anything. Everything below is a
 * POSITIVE observation: a turn that COMES BACK, never "nothing happened, so it works".
 *
 * ⚠ Each of the three headline claims is followed by its NON-VACUITY check, which performs the
 * forbidden act through the legitimate surface (an ack at the moment of serving / of frame receipt)
 * and shows the claim's own assertion then goes the other way. A guard you have only seen pass is
 * untested.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s, text) => s._emitInboxForTest({ kind: 'voice', userId: 'bruce', userName: 'Bruce', role: 'presenter', text });
const texts = (items) => items.map((i) => i.text).join(' | ');

function openSub(s, consumer = 'argusmon') {
  const ws = new WebSocket(s.url().replace('http', 'ws'));
  const frames = [];
  ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) {} });
  return new Promise((res) => ws.on('open', () => { ws.send(JSON.stringify({ t: 'pvs_subscribe', consumer })); res({ ws, frames }); }));
}

// ── 1. THE AT-MOST-ONCE TEST ───────────────────────────────────────────────────────────────
// Turns are SERVED to the consumer and the response is then lost (the truncation). No ack was
// sent. A re-attach must bring the same turns back.
test('0687 R2 — a SERVED-but-unacked turn is REDELIVERED on re-attach, not lost', async () => {
  const s = await createServer({ port: 0 });
  try {
    s.pvsStart({ consumer: 'argusmon' });
    say(s, 'the transfer that got cut off');
    const served = await s.situation({ consumerId: 'pvs:argusmon' });      // handed over…
    expect(served.newSinceLastRead.count === 1, 'the turn was served once', String(served.newSinceLastRead.count));
    // …and the response never arrived. Nothing acked. The watcher dies and a new one arms.
    const rearm = s.pvsStart({ consumer: 'argusmon' });
    expect(rearm.resumeCursor === 0, 'the re-arm resumes from the ACKED position, which never moved', String(rearm.resumeCursor));
    expect(rearm.sentCursor > rearm.resumeCursor, 'and `sent` is visibly ahead of it — the two are distinct facts',
      rearm.sentCursor + ' > ' + rearm.resumeCursor);
    const again = s.pvsBacklog({ consumer: 'argusmon' });
    expect(again.count === 1 && again.items[0].text === 'the transfer that got cut off',
      '⛔ THE TURN CAME BACK', texts(again.items));
  } finally { await s.close(); }
});

test('0687 R2 (non-vacuity) — make SERVING ack, and the redelivery claim goes the other way', async () => {
  const s = await createServer({ port: 0 });
  try {
    s.pvsStart({ consumer: 'argusmon' });
    say(s, 'the transfer that got cut off');
    await s.situation({ consumerId: 'pvs:argusmon' });
    s.pvsAck({ consumer: 'argusmon' });   // ← THE FORBIDDEN ACT, done at the moment of serving
    const rearm = s.pvsStart({ consumer: 'argusmon' });
    expect(rearm.resumeCursor > 0, 'with serving acking, the resume position IS at live', String(rearm.resumeCursor));
    expect(s.pvsBacklog({ consumer: 'argusmon' }).count === 0,
      '⛔ and the turn is GONE — which is exactly the at-most-once failure the rule forbids');
  } finally { await s.close(); }
});

// ── 2. READ WITHOUT ACKING ─────────────────────────────────────────────────────────────────
test('0687 R2 — a consumer can READ the backlog repeatedly without acking anything', async () => {
  const s = await createServer({ port: 0 });
  try {
    s.pvsStart({ consumer: 'argusmon' });
    say(s, 'alpha'); say(s, 'beta');
    await s.situation({ consumerId: 'pvs:argusmon' });   // ⭐ the turns are SERVED first — a read, not a reading
    const first = s.pvsBacklog({ consumer: 'argusmon' });
    const second = s.pvsBacklog({ consumer: 'argusmon' });
    expect(first.count === 2 && second.count === 2, 'both reads returned BOTH turns', first.count + ' / ' + second.count);
    expect(texts(first.items) === texts(second.items), 'byte for byte the same turns', texts(second.items));
    expect(second.acked === 0, '⛔ and `acked` did not move — which is the whole rule', String(second.acked));
    expect(second.sent === first.sent && first.sent === first.liveCursor,
      'the read DID hand the turns over, so `sent` sits at the head and stays there', JSON.stringify({ first: first.sent, second: second.sent }));
  } finally { await s.close(); }
});

test('0687 R2 — an explicit ack, and ONLY an explicit ack, retires the turns', async () => {
  const s = await createServer({ port: 0 });
  try {
    s.pvsStart({ consumer: 'argusmon' });
    say(s, 'alpha'); say(s, 'beta');
    const before = s.pvsBacklog({ consumer: 'argusmon' });
    const ack = s.pvsAck({ consumer: 'argusmon', seq: before.liveCursor });
    expect(ack.ok && ack.acked === before.liveCursor, 'the ack landed at the live head', JSON.stringify(ack));
    expect(s.pvsBacklog({ consumer: 'argusmon' }).count === 0, 'the backlog is now empty');
    say(s, 'gamma');
    const after = s.pvsBacklog({ consumer: 'argusmon' });
    expect(after.count === 1 && after.items[0].text === 'gamma', 'and the NEXT turn is the only thing outstanding', texts(after.items));
  } finally { await s.close(); }
});

test('0687 R2 — an ack cannot walk backwards, and cannot run ahead of what exists', async () => {
  const s = await createServer({ port: 0 });
  try {
    s.pvsStart({ consumer: 'argusmon' });
    say(s, 'one'); say(s, 'two'); say(s, 'three');
    const live = s.pvsState().liveCursor;
    s.pvsAck({ consumer: 'argusmon', seq: live });
    const back = s.pvsAck({ consumer: 'argusmon', seq: 1 });
    expect(back.acked === live, 'a late/duplicate lower ack is a no-op, never a rewind', String(back.acked));
    const ahead = s.pvsAck({ consumer: 'argusmon', seq: live + 10_000 });
    expect(ahead.acked === live, 'an ack past the live head is clamped — it can never ack the unborn', String(ahead.acked));
  } finally { await s.close(); }
});

// ── 3. THE TRUNCATION, OVER THE REAL SOCKET ────────────────────────────────────────────────
// The ws path is the one that actually carries Bruce's speech. A frame RECEIVED is not a turn READ.
test('0687 R2 — a ws turn FRAME advances `sent` and NOT `acked` (a frame is not a reading)', async () => {
  const s = await createServer({ port: 0 });
  let ws;
  try {
    s.pvsStart({ consumer: 'argusmon' });
    const sub = await openSub(s, 'argusmon'); ws = sub.ws;
    await wait(120);
    say(s, 'spoken over the socket');
    for (let i = 0; i < 30 && !sub.frames.some((f) => f.t === 'turn'); i++) await wait(15);
    expect(sub.frames.some((f) => f.t === 'turn'), 'the turn frame arrived', JSON.stringify(sub.frames.map((f) => f.t)));
    const st = s.pvsState();
    expect(st.deliveredCursor > 0, '`sent` moved — bytes left the process', String(st.deliveredCursor));
    expect(st.ackedCursor === 0, '⛔ `acked` did NOT move — nothing said it had read them', String(st.ackedCursor));
  } finally { try { ws && ws.close(); } catch (e) {} await s.close(); }
});

test('0687 R2 — the socket dies before the agent acks; the SAME turn replays on re-subscribe', async () => {
  const s = await createServer({ port: 0 });
  let a, b;
  try {
    s.pvsStart({ consumer: 'argusmon' });
    const sub1 = await openSub(s, 'argusmon'); a = sub1.ws;
    await wait(120);
    say(s, 'cut off mid-json');
    for (let i = 0; i < 30 && !sub1.frames.some((f) => f.t === 'turn'); i++) await wait(15);
    expect(sub1.frames.some((f) => f.t === 'turn' && f.text === 'cut off mid-json'), 'the first watcher saw it');
    a.close(); await wait(120);                                   // died without acking
    const sub2 = await openSub(s, 'argusmon'); b = sub2.ws;       // a new watcher attaches
    for (let i = 0; i < 40 && !sub2.frames.some((f) => f.t === 'turn'); i++) await wait(15);
    const replayed = sub2.frames.find((f) => f.t === 'turn');
    expect(replayed && replayed.text === 'cut off mid-json',
      '⛔ THE TURN WAS REDELIVERED to the new watcher', JSON.stringify(sub2.frames.map((f) => f.t + ':' + (f.text || ''))));
    const sub = sub2.frames.find((f) => f.t === 'pvs_subscribed');
    expect(sub && sub.resumeCursor === 0 && sub.sentCursor > 0,
      'and the subscribe frame states both positions, resuming from the ACKED one', JSON.stringify(sub));
  } finally { try { a && a.close(); } catch (e) {} try { b && b.close(); } catch (e) {} await s.close(); }
});

test('0687 R2 (non-vacuity) — ack on frame receipt, and the re-subscribe replay disappears', async () => {
  const s = await createServer({ port: 0 });
  let a, b;
  try {
    s.pvsStart({ consumer: 'argusmon' });
    const sub1 = await openSub(s, 'argusmon'); a = sub1.ws;
    await wait(120);
    say(s, 'cut off mid-json');
    for (let i = 0; i < 30 && !sub1.frames.some((f) => f.t === 'turn'); i++) await wait(15);
    s.pvsAck({ consumer: 'argusmon' });   // ← THE FORBIDDEN ACT, done on frame receipt
    a.close(); await wait(120);
    const sub2 = await openSub(s, 'argusmon'); b = sub2.ws;
    await wait(200);
    expect(!sub2.frames.some((f) => f.t === 'turn'),
      '⛔ nothing replays — the turn is unrecoverable, which is what acking on receipt buys you',
      JSON.stringify(sub2.frames.map((f) => f.t)));
  } finally { try { a && a.close(); } catch (e) {} try { b && b.close(); } catch (e) {} await s.close(); }
});

test('0687 R2 — pvsStop drops the record, so a later ack has nothing to lie about', async () => {
  const s = await createServer({ port: 0 });
  try {
    s.pvsStart({ consumer: 'argusmon' });
    say(s, 'a turn');
    s.pvsAck({ consumer: 'argusmon' });
    s.pvsStop();
    expect(s.pvsState().open === false, 'the PVS is closed');
    expect(s.pvsAck({ consumer: null }).reason === 'no-pvs-consumer', 'an ack with no consumer is refused BY NAME, not silently accepted');
    expect(s.pvsBacklog({ consumer: null }).reason === 'no-pvs-consumer', 'and so is a backlog read');
  } finally { await s.close(); }
});
