/*
 * T-INBOX-LONGPOLL (Plan 0472, Phase 1). presenter_inbox({since, waitMs}) returns IMMEDIATELY if
 * seq>since exists; else BLOCKS server-side until the next item is emitted (returns in << waitMs when
 * an item arrives mid-wait) OR returns empty at the waitMs timeout. ONE server-side waiter per
 * pending call; cleaned up on resolve/timeout/close (no leak). (Fails today: no long-poll.)
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws'));
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('message', (d, b) => { if (b) return; let m; try { m = JSON.parse(d.toString()); } catch (e) { return; } if (m.t === 'welcome') resolve({ ws }); });
  });
}

test('T-INBOX-LONGPOLL immediate-if-ready / blocks-then-wakes / timeout-empty / no waiter leak', async () => {
  const s = await createServer({ port: 0 });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'Bruce', role: 'participant' });

    // (A) immediate return when something is already newer than `since`
    c.ws.send(JSON.stringify({ t: 'chat', text: 'seed', id: 's1' }));
    await wait(120);
    const cur = s.getInbox(0).cursor;
    const t0a = Date.now();
    const immediate = await s.getInbox(0, 5000);   // since=0, an item exists -> must NOT block
    expect('ready poll returns immediately (<200ms)', Date.now() - t0a < 200, 'took ' + (Date.now() - t0a));
    expect('ready poll returns the seeded item', immediate.items.length >= 1, JSON.stringify(immediate));
    expect('no waiter registered for an immediate return', s.getInboxWaiters() === 0, 'waiters=' + s.getInboxWaiters());

    // (B) blocks when nothing is newer, then WAKES when an item arrives mid-wait
    const t0b = Date.now();
    const p = s.getInbox(cur, 3000);               // since=cursor -> nothing yet -> blocks
    await wait(80);
    expect('exactly one waiter registered while blocked', s.getInboxWaiters() === 1, 'waiters=' + s.getInboxWaiters());
    setTimeout(() => c.ws.send(JSON.stringify({ t: 'chat', text: 'arrived', id: 'a1' })), 100);
    const woke = await p;
    const dt = Date.now() - t0b;
    expect('woke well before the 3000ms budget (<1500ms)', dt < 1500, 'took ' + dt);
    expect('woke with the newly-arrived item', woke.items.length === 1 && woke.items[0].text === 'arrived', JSON.stringify(woke));
    expect('waiter cleaned up after wake (no leak)', s.getInboxWaiters() === 0, 'waiters=' + s.getInboxWaiters());

    // (C) timeout returns empty; waiter cleaned up
    const cur2 = s.getInbox(0).cursor;
    const t0c = Date.now();
    const empty = await s.getInbox(cur2, 200);     // nothing arrives -> resolves empty at ~200ms
    const dtc = Date.now() - t0c;
    expect('timeout waited ~the budget (>=180ms)', dtc >= 180, 'took ' + dtc);
    expect('timeout returned empty items', empty.items.length === 0, JSON.stringify(empty));
    expect('timeout cursor is the current cursor', empty.cursor === cur2, `cursor=${empty.cursor}`);
    expect('waiter cleaned up after timeout (no leak)', s.getInboxWaiters() === 0, 'waiters=' + s.getInboxWaiters());

    // (D) a second emit while no waiter is pending does not throw / double-resolve
    c.ws.send(JSON.stringify({ t: 'chat', text: 'after', id: 'f1' }));
    await wait(80);
    expect('still no leaked waiters after a later emit', s.getInboxWaiters() === 0, 'waiters=' + s.getInboxWaiters());

    c.ws.close();
  } finally { await s.close(); }
});

test('T-INBOX-LONGPOLL a pending waiter is drained (resolved) on server close (no dangling wait)', async () => {
  const s = await createServer({ port: 0 });
  const cur = s.getInbox(0).cursor;
  const p = s.getInbox(cur, 5000);          // block; nothing will arrive
  await wait(80);
  expect('one waiter pending before close', s.getInboxWaiters() === 1, 'waiters=' + s.getInboxWaiters());
  await s.close();                           // close MUST drain the waiter (resolve), not hang
  const drained = await p;                   // this must resolve, not hang the test
  expect('waiter resolved on close', Array.isArray(drained.items), JSON.stringify(drained));
});
