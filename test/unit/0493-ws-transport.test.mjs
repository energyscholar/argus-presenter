/*
 * Plan 0493 Phase D — ws transport (Monitor({ws})) for PVS delivery (§9).
 *
 * A read-only transcript subscriber: a spoken turn lands at ASR latency (no up-to-3 s poll wait, S12),
 * the subscriber is NOT a participant (absent from the roster, no floor weight, cannot send ops), it
 * shares the namespaced delivery cursor (R1/R2), and the watch ENDS when the socket closes — after
 * which the /api/situation poll fallback still delivers. Every claim is a POSITIVE observation.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s, text, role = 'presenter') =>
  s._emitInboxForTest({ kind: 'voice', userId: role === 'presenter' ? 'bruce' : 'p1', userName: role === 'presenter' ? 'Bruce' : 'Player', role, text });

function openSub(s, consumer = 'argusmon') {
  const ws = new WebSocket(s.url().replace('http', 'ws'));
  const frames = [];
  ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) {} });
  return new Promise((res) => ws.on('open', () => { ws.send(JSON.stringify({ t: 'pvs_subscribe', consumer })); res({ ws, frames }); }));
}

// S12 — a spoken turn arrives over ws promptly (no poll wait); the subscriber is not a participant.
test('0493 S12: a turn lands over ws at ASR latency; subscriber is not a participant', async () => {
  const s = await createServer({ port: 0 });
  let ws;
  try {
    s.pvsStart({ consumer: 'argusmon' });
    const sub = await openSub(s, 'argusmon'); ws = sub.ws;
    await wait(120);
    expect(sub.frames.some((f) => f.t === 'pvs_subscribed'), 'subscribe acknowledged', JSON.stringify(sub.frames.map((f) => f.t)));
    expect(s.getPvsSubscriberCount() === 1, 'one live subscriber', String(s.getPvsSubscriberCount()));
    expect(s.attendance({ viewerRole: 'ai' }).roster.length === 0, 'subscriber is ABSENT from the roster (not a participant)', String(s.attendance({ viewerRole: 'ai' }).roster.length));

    const t0 = Date.now();
    say(s, 'ring the bell now');
    // poll for the turn frame; it must arrive fast (well under the 3 s poll interval)
    for (let i = 0; i < 20 && !sub.frames.some((f) => f.t === 'turn'); i++) await wait(15);
    const turn = sub.frames.find((f) => f.t === 'turn');
    expect(turn, 'a turn frame arrived over ws', JSON.stringify(sub.frames.map((f) => f.t)));
    expect(turn.text === 'ring the bell now', 'the turn text is correct', turn && turn.text);
    expect(turn.mode === 'presenter', 'the turn carries the comms mode', turn && turn.mode);
    expect(Date.now() - t0 < 1000, 'delivered without a multi-second poll wait', String(Date.now() - t0));
  } finally { try { ws && ws.close(); } catch (e) {} await s.close(); }
});

// R1 over ws — a turn spoken BEFORE the subscriber connects is replayed from the shared cursor.
test('0493 D: ws subscribe replays the unread backlog from the shared cursor (R1)', async () => {
  const s = await createServer({ port: 0 });
  let ws;
  try {
    s.pvsStart({ consumer: 'argusmon' });   // baseline at 0
    say(s, 'spoken before connect');
    const sub = await openSub(s, 'argusmon'); ws = sub.ws;
    await wait(150);
    const turn = sub.frames.find((f) => f.t === 'turn');
    expect(turn && turn.text === 'spoken before connect', 'the pre-connect turn replays on subscribe', turn && turn.text);
  } finally { try { ws && ws.close(); } catch (e) {} await s.close(); }
});

// S12 (teardown) — closing the socket ends the watch; the poll fallback then delivers the next turn.
test('0493 S12: socket close ends the watch; the poll fallback continues from the cursor', async () => {
  const s = await createServer({ port: 0 });
  let ws;
  try {
    s.pvsStart({ consumer: 'argusmon' });
    const sub = await openSub(s, 'argusmon'); ws = sub.ws;
    await wait(100);
    say(s, 'while subscribed'); await wait(80);
    expect(sub.frames.some((f) => f.t === 'turn' && f.text === 'while subscribed'), 'delivered while subscribed', 'ok');
    const before = sub.frames.filter((f) => f.t === 'turn').length;
    ws.close(); await wait(120);
    expect(s.getPvsSubscriberCount() === 0, 'the watch ended on socket close', String(s.getPvsSubscriberCount()));
    say(s, 'after close');   // spoken after the ws is gone
    await wait(80);
    const after = sub.frames.filter((f) => f.t === 'turn').length;
    expect(after === before, 'no turn was delivered to the dead socket', before + ' -> ' + after);
    // the poll fallback (shared cursor) picks up the post-close turn — delivery is not lost
    const poll = await s.situation({ consumerId: 'pvs:argusmon' });
    expect(poll.newSinceLastRead.turns.map((t) => t.text).join(' ').includes('after close'),
      'the poll fallback delivers the post-close turn from the shared cursor', JSON.stringify(poll.newSinceLastRead.turns.map((t) => t.text)));
  } finally { try { ws && ws.close(); } catch (e) {} await s.close(); }
});

// A subscriber cannot act as a participant — an op frame from it is ignored (no roster, no store effect).
test('0493 D: a subscriber cannot send ops (read-only)', async () => {
  const s = await createServer({ port: 0 });
  let ws;
  try {
    s.pvsStart({ consumer: 'argusmon' });
    const sub = await openSub(s, 'argusmon'); ws = sub.ws;
    await wait(100);
    ws.send(JSON.stringify({ t: 'op', path: 'chat', verb: 'add', value: { id: 'x', text: 'hi', name: 'sub' } }));
    ws.send(JSON.stringify({ t: 'hello', userId: 'sneaky', role: 'presenter' }));   // cannot re-become a participant
    await wait(120);
    expect(s.attendance({ viewerRole: 'ai' }).roster.length === 0, 'no roster entry appeared for the subscriber', String(s.attendance({ viewerRole: 'ai' }).roster.length));
    expect(s.getPvsSubscriberCount() === 1, 'still exactly one subscriber (its frames were ignored)', String(s.getPvsSubscriberCount()));
  } finally { try { ws && ws.close(); } catch (e) {} await s.close(); }
});
