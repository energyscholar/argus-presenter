/*
 * T-TURN-COALESCE (Plan 0473, P2). Fragments -> TURNS. A speaker's CONSECUTIVE inbox items (voice OR
 * typed text) are grouped into a TURN by a per-speaker SETTLING WINDOW read from the ACTIVE PROFILE
 * (api.profile().settlingMs; here overridden at session start for deterministic timing). A new item
 * from the SAME identity within the window EXTENDS the turn (shared turnId); a gap > settlingMs, or a
 * DIFFERENT speaker, CLOSES the turn (fires `turnComplete`) and opens a new one.
 *
 *   (a) two utterances from ONE speaker within settlingMs -> ONE turn (shared turnId); turnComplete
 *       fires ONCE after the window.
 *   (b) a gap > settlingMs -> a SECOND turn.
 *   (c) interleaved items from TWO speakers -> separate turns (NEVER merged across identities).
 *   (d) `turnComplete` is DISTINCT from `final`: a segment is final:true while its turn is still open
 *       (turnComplete:false) — 0472 hygiene, the two must not be conflated.
 *
 * Deterministic timing: `settlingMs` is threaded through the active profile via createServer (a
 * tuning/test override of the knob, NOT a code branch) so the engine still reads it from api.profile().
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws'));
    const msgs = [];
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('message', (d, b) => { if (b) return; let m; try { m = JSON.parse(d.toString()); } catch (e) { return; } msgs.push(m); if (m.t === 'welcome') resolve({ ws, msgs }); });
  });
}
async function until(pred, label, { timeout = 5000 } = {}) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(30); } throw new Error('timeout ' + label); }
const chat = (c, text, id) => c.ws.send(JSON.stringify({ t: 'chat', text, id }));

// (a) + (d): consecutive same-speaker items coalesce into ONE turn; final != turnComplete.
test('T-TURN-COALESCE (a)+(d): same-speaker items coalesce; turnComplete distinct from final', async () => {
  const s = await createServer({ port: 0, settlingMs: 300 });
  try {
    const turns = [];
    s.on('turnComplete', (t) => turns.push(t));
    const c = await client(s.url(), { userId: 'u1', userName: 'Bruce', role: 'participant' });

    // first fragment
    chat(c, 'part one', 'm1');
    await until(() => s.getInbox(0).items.length >= 1, 'first item lands');
    const first = s.getInbox(0).items[s.getInbox(0).items.length - 1];
    // (d): the SEGMENT is final, but the TURN is still open — the two are DISTINCT signals.
    expect('typed item is final:true (segment-final)', first.final === true, String(first.final));
    expect('turn OPEN mid-turn ⇒ turnComplete:false (final != turnComplete)', first.turnComplete === false, String(first.turnComplete));
    expect('no turnComplete signal yet (window has not settled)', turns.length === 0, String(turns.length));
    expect('first item carries a turnId', typeof first.turnId === 'string' && first.turnId.length > 0, String(first.turnId));
    const turnId = first.turnId;

    // second fragment from the SAME speaker, WITHIN the settling window (sent immediately)
    chat(c, 'part two', 'm2');
    await until(() => s.getInbox(0).items.length >= 2, 'second item lands');
    const second = s.getInbox(0).items[s.getInbox(0).items.length - 1];
    expect('both fragments share ONE turnId (coalesced)', second.turnId === turnId, second.turnId + ' vs ' + turnId);
    expect('still no turnComplete before the window settles', turns.length === 0, String(turns.length));

    // let the settling window elapse
    await until(() => turns.length >= 1, 'turnComplete fires after settling');
    await wait(200);   // guard: NO second turnComplete sneaks in for a coalesced turn
    expect('turnComplete fires EXACTLY once for the coalesced turn', turns.length === 1, String(turns.length));
    expect('the turnComplete carries the shared turnId', turns[0].turnId === turnId, String(turns[0].turnId));
    expect('turnComplete counts BOTH fragments', turns[0].count === 2, String(turns[0].count));
    expect('turnComplete attributed to the speaker', turns[0].userId === 'u1', String(turns[0].userId));
    const done = s.getInbox(0).items;
    expect('both ring items marked turnComplete after settle', done.every((i) => i.turnComplete === true), JSON.stringify(done.map((i) => i.turnComplete)));
    c.ws.close();
  } finally { await s.close(); }
});

// (b): a gap greater than the settling window starts a SECOND turn.
test('T-TURN-COALESCE (b): a gap > settlingMs starts a SECOND turn', async () => {
  const s = await createServer({ port: 0, settlingMs: 200 });
  try {
    const turns = [];
    s.on('turnComplete', (t) => turns.push(t));
    const c = await client(s.url(), { userId: 'u1', userName: 'Bruce', role: 'participant' });

    chat(c, 'first turn', 'g1');
    await until(() => turns.length >= 1, 'first turn settles after the gap');

    // a NEW utterance only AFTER the window has already closed
    chat(c, 'second turn', 'g2');
    await until(() => turns.length >= 2, 'second turn settles');

    const items = s.getInbox(0).items;
    expect('two items total', items.length === 2, String(items.length));
    expect('the two items are in DIFFERENT turns (gap split)', items[0].turnId !== items[1].turnId, items[0].turnId + ' / ' + items[1].turnId);
    expect('two distinct turnComplete signals', turns.length === 2 && turns[0].turnId !== turns[1].turnId, JSON.stringify(turns.map((t) => t.turnId)));
    expect('each settled turn holds ONE item', turns.every((t) => t.count === 1), JSON.stringify(turns.map((t) => t.count)));
    c.ws.close();
  } finally { await s.close(); }
});

// (c): interleaved items from two speakers -> separate turns, never merged across identities.
test('T-TURN-COALESCE (c): interleaved speakers never merge into one turn', async () => {
  const s = await createServer({ port: 0, settlingMs: 300 });
  try {
    const turns = [];
    s.on('turnComplete', (t) => turns.push(t));
    const a = await client(s.url(), { userId: 'uA', userName: 'Alice', role: 'participant' });
    const b = await client(s.url(), { userId: 'uB', userName: 'Bob', role: 'participant' });

    chat(a, 'Alice speaks', 'a1');
    await until(() => s.getInbox(0).items.length >= 1, 'Alice item lands');
    // Bob speaks WITHIN Alice's settling window ⇒ her turn must close on speaker-change, his opens fresh.
    chat(b, 'Bob interjects', 'b1');
    await until(() => s.getInbox(0).items.length >= 2, 'Bob item lands');

    const items = s.getInbox(0).items;
    const ia = items.find((i) => i.userId === 'uA');
    const ib = items.find((i) => i.userId === 'uB');
    expect('Alice and Bob items are in SEPARATE turns', ia.turnId !== ib.turnId, ia.turnId + ' / ' + ib.turnId);

    // Alice's turn closed the moment Bob spoke (speaker-change) — before her own window elapsed.
    await until(() => turns.some((t) => t.userId === 'uA'), 'Alice turn closed on speaker change');
    expect('Alice turn is attributed to uA and matches her item', turns.find((t) => t.userId === 'uA').turnId === ia.turnId, '');
    // Bob's turn settles on its own window.
    await until(() => turns.some((t) => t.userId === 'uB'), 'Bob turn settles');
    await wait(150);
    expect('NO turn merges two identities', turns.every((t) => t.userId === 'uA' || t.userId === 'uB') && turns.every((t) => t.count === 1), JSON.stringify(turns.map((t) => ({ u: t.userId, n: t.count }))));
    expect('exactly two turns — one per speaker', turns.length === 2, String(turns.length));
    a.ws.close(); b.ws.close();
  } finally { await s.close(); }
});
