/*
 * Plan 0473 P8 — HUMAN DIGEST FACE + DUAL-CONSUMER SYMMETRY.
 *
 * The human (Bruce) consumes the SAME server-maintained WORKING SET the AI (Argus) consumes via
 * presenter_situation — but as an ergonomic, BOUNDED, glanceable DIGEST in app/control.html, NOT the
 * raw transcript firehose: room-at-a-glance (display/beat, open polls + live tallies, roster), the
 * PRIORITIZED work queue with ONE-CLICK resolve/claim, and the recent turns / rolling summary at a
 * glance. It reads over a NEW HTTP surface (GET /api/situation) that is the SAME api.situation the MCP
 * tool calls, and a one-click resolve/claim POSTs to /api/work → the SAME api.resolveWork/claimWork the
 * MCP tools use. So the two faces are ONE working set: owner/status prevent double-handling.
 *
 *   T-HUMAN-DIGEST   control.html renders a BOUNDED digest (room-at-a-glance + prioritized queue +
 *                    one-click resolve/claim), NOT the raw stream; a click resolves an item.
 *   T-DUAL-CONSUMER  after a human resolves/claims via the digest (HTTP), the AI's presenter_situation()
 *                    reflects it — and vice-versa (AI claim → the human GET sees it). ONE shared queue.
 *
 * settlingMs:0 ⇒ each chat settles into its own completed turn ⇒ a deterministic 1 chat ⇒ 1 work item.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, until } from '../../harness/multi.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function wsClient(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws'));
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('message', (d, b) => { if (b) return; let m; try { m = JSON.parse(d.toString()); } catch (e) { return; } if (m.t === 'welcome') resolve({ ws }); });
  });
}
async function poll(pred, label, { timeout = 6000 } = {}) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(30); } throw new Error('timeout ' + label); }
const chat = (c, text, id) => c.ws.send(JSON.stringify({ t: 'chat', text, id }));

// T-HUMAN-DIGEST: the presenter's control page renders the working set as a bounded, glanceable digest
// with one-click resolve — driven headless.
test('T-HUMAN-DIGEST: control.html renders a bounded digest (room + prioritized queue + one-click resolve)', async () => {
  const s = await createServer({ port: 0, settlingMs: 0 });
  const browser = await launch();
  try {
    // Room state: a shown beat + an open poll with a live vote, plus a participant + a directed question.
    const part = await wsClient(s.url(), { userId: 'u1', userName: 'Bruce', role: 'participant' });
    s.setModule({ title: 'Demo', beats: [{ component: 'display', opts: { text: 'hello' } }, { component: 'display', opts: { text: 'two' } }] });
    s.showBeat(0);
    s.openPoll({ promptId: 'p1', prompt: 'Ship it?', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }], target: 'participant' });
    part.ws.send(JSON.stringify({ t: 'result', msg: { type: 'answer', promptId: 'p1', value: 'yes' } }));
    chat(part, 'should we look at this together?', 'q1');
    await poll(() => s.workItems().some((w) => /look at this/.test(w.text)), 'question became a work item');
    const item = s.workItems().find((w) => /look at this/.test(w.text));

    // Open the CONTROL page (presenter face) and force one digest refresh.
    const ctl = await browser.newPage();
    ctl.on('pageerror', (e) => console.log('PAGEERR digest', e.message));
    await ctl.goto(`${s.url()}/control?userId=gm&name=GM`, { waitUntil: 'domcontentloaded' });
    await ctl.waitForFunction(() => window.__digest && typeof window.__digest.refresh === 'function', { timeout: 5000 });
    await ctl.evaluate(() => window.__digest.refresh());
    await ctl.waitForFunction(() => window.__digest.last() && window.__digest.last().situation, { timeout: 5000 });

    // The digest SECTIONS render from the situation data (room-at-a-glance).
    const room = await ctl.evaluate(() => ({
      section: !!document.querySelector('#dg-section'),
      profile: (document.querySelector('#dg-profile') || {}).textContent || '',
      roomText: (document.querySelector('#dg-room') || {}).textContent || '',
      queueRows: document.querySelectorAll('#dg-queue [data-work-id]').length,
    }));
    expect('digest section present in control.html', room.section, JSON.stringify(room));
    expect('room-at-a-glance shows the active profile (wearable)', /wearable/.test(room.profile), room.profile);
    expect('room-at-a-glance shows beat/display + the open poll', /Demo/.test(room.roomText) && /Ship it\?/.test(room.roomText), room.roomText.slice(0, 200));

    // The PRIORITIZED queue shows the directed question with a one-click resolve control (NOT the firehose).
    const q = await ctl.evaluate((id) => {
      const row = document.querySelector('#dg-queue [data-work-id="' + id + '"]');
      return row ? { text: row.textContent, hasResolve: !!row.querySelector('[data-work-resolve]'), hasClaim: !!row.querySelector('[data-work-claim]') } : null;
    }, item.id);
    expect('the directed question is rendered in the digest queue', q && /look at this/.test(q.text), JSON.stringify(q));
    expect('the queue row carries a one-click RESOLVE control', q && q.hasResolve, JSON.stringify(q));
    expect('the queue row carries a one-click CLAIM control', q && q.hasClaim, JSON.stringify(q));

    // It is a BOUNDED digest, not the raw stream: recentTurns is the bounded window, not full history.
    const bounded = await ctl.evaluate(() => { const l = window.__digest.last(); return { bounded: l.bounded === true, recent: (l.recentTurns || []).length }; });
    expect('digest is the BOUNDED working set (not the raw firehose)', bounded.bounded && bounded.recent <= 20, JSON.stringify(bounded));

    // ONE CLICK resolves the item — through the SAME shared api.resolveWork (via /api/work).
    await ctl.click('#dg-queue [data-work-id="' + item.id + '"] [data-work-resolve]');
    await poll(() => { const it = s.workItem(item.id); return it && it.status === 'resolved'; }, 'server marks the item resolved after the click');
    expect('one-click resolve moved the item to resolved (server-tracked)', s.workItem(item.id).status === 'resolved', JSON.stringify(s.workItem(item.id)));
    expect('resolved item left the actionable queue', !s.workItems().some((w) => w.id === item.id), JSON.stringify(s.workItems()));

    // The human face reflects the resolution (the row is gone after the digest refreshes).
    await ctl.evaluate(() => window.__digest.refresh());
    await poll(async () => (await ctl.evaluate((id) => !document.querySelector('#dg-queue [data-work-id="' + id + '"]'), item.id)), 'digest row disappears after resolve');
    const gone = await ctl.evaluate((id) => !document.querySelector('#dg-queue [data-work-id="' + id + '"]'), item.id);
    expect('the resolved item disappeared from the human digest', gone, 'row still present');

    part.ws.close();
    await ctl.close();
  } finally { await browser.close(); await s.close(); }
});

// T-DUAL-CONSUMER: the human digest (HTTP) and the AI situation (api) are ONE working set — a resolve/
// claim on either face is reflected on the other; owner/status prevent double-handling.
test('T-DUAL-CONSUMER: human digest (HTTP) + AI situation (api) share one queue — resolve/claim reflected both ways', async () => {
  const s = await createServer({ port: 0, settlingMs: 0 });
  try {
    const c = await wsClient(s.url(), { userId: 'u1', userName: 'Bruce', role: 'participant' });

    // --- Human resolves via the digest's HTTP surface → the AI's presenter_situation reflects it. ---
    chat(c, 'can you review this section?', 'r1');
    await poll(() => s.workItems().some((w) => /review this/.test(w.text)), 'item1 derived');
    const item1 = s.workItems().find((w) => /review this/.test(w.text));

    // The human GET /api/situation is the SAME working set the AI would read.
    const humanView = await (await fetch(s.url() + '/api/situation?c=human')).json();
    expect('human GET /api/situation returns the bounded working set with the queue', humanView.bounded === true && (humanView.queue || []).some((w) => w.id === item1.id), JSON.stringify((humanView.queue || []).map((w) => w.id)));

    // Human ONE-CLICK resolve → POST /api/work {op:'resolve'} → the SAME api.resolveWork the MCP uses.
    const rr = await (await fetch(s.url() + '/api/work', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: item1.id, op: 'resolve', note: 'human handled' }) })).json();
    expect('POST /api/work resolve reports status resolved', rr.item && rr.item.status === 'resolved', JSON.stringify(rr));

    // The AI face (api.situation, a DIFFERENT consumer) reflects the human resolve — one shared queue.
    const aiAfterResolve = s.situation({ consumerId: 'ai' });
    expect('AI presenter_situation() no longer shows the human-resolved item', !(aiAfterResolve.queue || []).some((w) => w.id === item1.id), JSON.stringify(aiAfterResolve.queue));
    expect('server tracks the human resolve (status + note)', s.workItem(item1.id).status === 'resolved' && s.workItem(item1.id).note === 'human handled', JSON.stringify(s.workItem(item1.id)));

    // --- Vice-versa: the AI claims via the api → the human GET /api/situation sees it claimed. ---
    chat(c, 'is the budget figure right?', 'r2');
    await poll(() => s.workItems().some((w) => /budget figure/.test(w.text)), 'item2 derived');
    const item2 = s.workItems().find((w) => /budget figure/.test(w.text));
    s.claimWork(item2.id, { owner: 'argus' });   // AI (MCP) claims

    const humanAfterClaim = await (await fetch(s.url() + '/api/situation?c=human')).json();
    const inHuman = (humanAfterClaim.queue || []).find((w) => w.id === item2.id);
    expect('the human digest sees the AI-claimed item with its owner (no double-handling)', inHuman && inHuman.status === 'claimed' && inHuman.owner === 'argus', JSON.stringify(inHuman));

    // --- And a human CLAIM via HTTP is visible to the AI face too. ---
    chat(c, 'should we cut chapter three?', 'r3');
    await poll(() => s.workItems().some((w) => /chapter three/.test(w.text)), 'item3 derived');
    const item3 = s.workItems().find((w) => /chapter three/.test(w.text));
    const cr = await (await fetch(s.url() + '/api/work', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: item3.id, op: 'claim', owner: 'bruce' }) })).json();
    expect('POST /api/work claim sets owner=bruce (server-tracked)', cr.item && cr.item.status === 'claimed' && cr.item.owner === 'bruce', JSON.stringify(cr));
    const aiSeesClaim = s.situation({ consumerId: 'ai' }).queue.find((w) => w.id === item3.id);
    expect('the AI face sees the human-claimed item + owner', aiSeesClaim && aiSeesClaim.status === 'claimed' && aiSeesClaim.owner === 'bruce', JSON.stringify(aiSeesClaim));

    c.ws.close();
  } finally { await s.close(); }
});
