/*
 * Plan 0473, P4 — WORK QUEUE (the judgment items in the working set).
 *
 * Work items are DERIVED from completed TURNS (P2) by a CHEAP rule (no ML): a settled turn becomes a
 * work item, PRIORITIZED by whether it is a question/request. Minimal heuristic: isQuestion = trimmed
 * text ends with "?". The active profile's queuePolicy is honoured (a DATA knob, never a name fork):
 *   - queuePolicy.enqueue = 'all'       ⇒ EVERY directed turn is a work item (wearable: solo, all
 *                                          turns are directed — questions rank ABOVE ambient chatter)
 *   - queuePolicy.enqueue = 'questions' ⇒ only question/request turns become work items (multi-user)
 *   - queuePolicy.maxPending            ⇒ the queue is BOUNDED (drops lowest-priority/oldest first)
 *   - queuePolicy.ttlMs                 ⇒ stale PENDING items AGE OUT after this TTL (never unbounded)
 * maxPending + ttlMs are test-injectable via createServer({queueMaxPending, queueTtlMs}) — a tuning
 * override THREADED THROUGH the profile knob (like settlingMs), NOT a code hack.
 *
 * Item shape: { id, turnId, userId, userName, text, priority, status:'pending'|'claimed'|'resolved',
 *               owner?, createdTs, age }. The SERVER tracks status/owner; the consuming agent holds
 *               NOTHING. Tools: presenter_claim / presenter_resolve / presenter_defer (all CORE).
 *
 *   T-WORK-QUEUE-PRIORITY  a directed question surfaces AHEAD of ambient chatter; heavy ambient never
 *                          crowds the question out of a bounded queue.
 *   T-RESOLVE              presenter_resolve(id) moves the item OUT of pending (status resolved); it no
 *                          longer appears in situation().queue; the server tracks the status.
 *   T-CLAIM-AGING          presenter_claim(id) sets owner + status=claimed (server-tracked); a stale
 *                          PENDING item ages out after its (injected, short) TTL; a CLAIMED item does not.
 *
 * settlingMs:0 ⇒ each item settles into its OWN completed turn (deterministic 1 item ⇒ 1 turn ⇒ 1 work item).
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
async function until(pred, label, { timeout = 5000 } = {}) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(20); } throw new Error('timeout ' + label); }
const chat = (c, text, id) => c.ws.send(JSON.stringify({ t: 'chat', text, id }));

// T-WORK-QUEUE-PRIORITY: a directed question ranks ahead of ambient; heavy ambient never evicts it.
test('T-WORK-QUEUE-PRIORITY: directed question surfaces AHEAD of ambient; heavy ambient never crowds it out', async () => {
  // enqueue='all' (wearable) so ambient chatter DOES enter the queue (as low priority) and can compete;
  // a generous bound so we can observe ORDERING before we stress the bound.
  const s = await createServer({ port: 0, settlingMs: 0, queueMaxPending: 5 });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'Bruce', role: 'participant' });

    // heavy ambient chatter (statements — no trailing '?')
    for (let i = 0; i < 4; i++) chat(c, 'ambient statement number ' + i, 'amb' + i);
    // one directed QUESTION
    chat(c, 'should we ship it now?', 'q1');
    await until(() => s.workItems().some((w) => /ship it/.test(w.text)), 'question enqueued');
    await until(() => s.getInbox(0).items.length >= 5, 'all 5 turns landed');

    const q0 = s.workItems();
    // The question is at the FRONT (highest priority), ahead of ambient chatter.
    expect('queue[0] is the directed question', /ship it/.test(q0[0].text), JSON.stringify(q0.map((w) => w.text)));
    const question = q0[0];
    const ambient = q0.find((w) => /ambient/.test(w.text));
    expect('the question outranks ambient (higher priority)', ambient && question.priority > ambient.priority, JSON.stringify({ q: question.priority, a: ambient && ambient.priority }));
    expect('item shape: id/turnId/userId/status/createdTs/age present', typeof question.id === 'string' && typeof question.turnId === 'string' && question.userId === 'u1' && question.status === 'pending' && typeof question.createdTs === 'number' && typeof question.age === 'number', JSON.stringify(question));

    // NOW flood with far more ambient than the bound (maxPending 5) — the bounded queue must SHED
    // low-priority ambient, never the high-priority question.
    for (let i = 0; i < 30; i++) chat(c, 'flood chatter ' + i, 'flood' + i);
    await until(() => s.getInbox(0).cursor >= 35, 'flood ingested');

    const q1 = s.workItems();
    expect('queue stays BOUNDED under a flood (<= maxPending)', q1.length <= 5, String(q1.length));
    expect('the question SURVIVES the flood (never crowded out)', q1.some((w) => /ship it/.test(w.text)), JSON.stringify(q1.map((w) => w.text)));
    expect('the question is STILL at the front (top priority)', /ship it/.test(q1[0].text), JSON.stringify(q1.map((w) => w.text)));
    // situation().queue carries the same prioritized, bounded queue.
    const sit = s.situation({ consumerId: 'wq' });
    expect('situation().queue is the bounded prioritized queue', Array.isArray(sit.queue) && sit.queue.length <= 5 && /ship it/.test(sit.queue[0].text), JSON.stringify((sit.queue || []).map((w) => w.text)));
    c.ws.close();
  } finally { await s.close(); }
});

// T-RESOLVE: resolve moves an item out of pending; server tracks the resolved status; agent holds nothing.
test('T-RESOLVE: presenter_resolve moves the item OUT of pending (server-tracked); gone from situation().queue', async () => {
  const s = await createServer({ port: 0, settlingMs: 0, queueMaxPending: 5 });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'Bruce', role: 'participant' });
    chat(c, 'can you look at this for me?', 'r1');
    await until(() => s.workItems().length >= 1, 'work item derived');

    const item = s.workItems()[0];
    expect('starts pending', item.status === 'pending', item.status);

    const r = s.resolveWork(item.id, { note: 'handled it' });
    expect('resolveWork reports status resolved', r && r.status === 'resolved', JSON.stringify(r));

    // It no longer appears as pending in the queue / situation.
    expect('no longer in the pending workItems()', !s.workItems().some((w) => w.id === item.id), JSON.stringify(s.workItems()));
    const sit = s.situation({ consumerId: 'rs' });
    expect('no longer in situation().queue', !(sit.queue || []).some((w) => w.id === item.id), JSON.stringify(sit.queue));

    // The SERVER tracks the resolved status + note (the agent holds nothing).
    const tracked = s.workItem(item.id);
    expect('server still tracks the item as resolved', tracked && tracked.status === 'resolved', JSON.stringify(tracked));
    expect('server tracks the resolve note', tracked && tracked.note === 'handled it', JSON.stringify(tracked && tracked.note));
    c.ws.close();
  } finally { await s.close(); }
});

// T-CLAIM-AGING: claim sets server-tracked owner/status; stale pending ages out after its TTL; claimed does not.
test('T-CLAIM-AGING: presenter_claim sets owner/status (server-tracked); stale PENDING ages out after TTL, CLAIMED survives', async () => {
  // --- claim: server-tracked owner + status ---
  const s = await createServer({ port: 0, settlingMs: 0, queueMaxPending: 5 });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'Bruce', role: 'participant' });
    chat(c, 'are you ready to begin?', 'c1');
    await until(() => s.workItems().length >= 1, 'work item derived');
    const item = s.workItems()[0];

    const r = s.claimWork(item.id, { owner: 'argus' });
    expect('claimWork sets status=claimed', r && r.status === 'claimed', JSON.stringify(r));
    expect('claimWork sets owner', r && r.owner === 'argus', JSON.stringify(r));
    // server-tracked (the agent holds nothing): re-read from the server.
    const tracked = s.workItem(item.id);
    expect('server tracks status=claimed', tracked && tracked.status === 'claimed', JSON.stringify(tracked));
    expect('server tracks owner=argus', tracked && tracked.owner === 'argus', JSON.stringify(tracked));
    // a claimed item is still visible in the queue with its owner (so a peer consumer won't double-handle).
    const sit = s.situation({ consumerId: 'cl' });
    const inQ = (sit.queue || []).find((w) => w.id === item.id);
    expect('claimed item visible in queue with owner (no double-handle)', inQ && inQ.status === 'claimed' && inQ.owner === 'argus', JSON.stringify(inQ));
    c.ws.close();
  } finally { await s.close(); }

  // --- aging: a SHORT injected TTL, threaded through createServer/profile (not a hack) ---
  const s2 = await createServer({ port: 0, settlingMs: 0, queueMaxPending: 10, queueTtlMs: 120 });
  try {
    const c2 = await client(s2.url(), { userId: 'u2', userName: 'Ann', role: 'participant' });
    chat(c2, 'a stale pending statement', 'p1');   // ambient, stays pending (unclaimed)
    chat(c2, 'this one gets claimed', 'p2');
    await until(() => s2.workItems().length >= 2, 'two items pending');
    const claimed = s2.workItems().find((w) => /gets claimed/.test(w.text));
    s2.claimWork(claimed.id, { owner: 'argus' });   // claimed items are being handled ⇒ exempt from pending-TTL

    await wait(200);   // > TTL (120ms): the PENDING item must age out; the CLAIMED item must not
    const after = s2.situation({ consumerId: 'age' });
    expect('stale PENDING item aged out of the queue', !(after.queue || []).some((w) => /stale pending/.test(w.text)), JSON.stringify((after.queue || []).map((w) => w.text)));
    expect('CLAIMED item survives past the pending-TTL', (after.queue || []).some((w) => w.id === claimed.id && w.status === 'claimed'), JSON.stringify(after.queue));
    c2.ws.close();
  } finally { await s2.close(); }
});
