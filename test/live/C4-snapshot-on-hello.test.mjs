/*
 * C4 — on hello the server sends a role-filtered state snapshot; a (re)connecting
 * client converges to current state. Raw-ws delivery + browser client-applies.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch } from '../../harness/multi.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('C4 — a fresh client receives a snapshot carrying current state + version', async () => {
  const server = await createServer({ port: 0 });
  try {
    // Seed state authoritatively (as a controller) BEFORE the client connects.
    server.store.apply({ path: 'polls/p1/votes/u9', verb: 'set', value: 'yes' }, { userId: 'gm', role: 'presenter' });

    const url = server.url().replace('http', 'ws');
    const ws = new WebSocket(url);
    const inbox = [];
    await new Promise((res) => { ws.on('message', (b) => { try { inbox.push(JSON.parse(b.toString())); } catch {} }); ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', userId: 'late', role: 'participant' })); res(); }); });
    await wait(200);

    const snap = inbox.find((m) => m.t === 'snapshot');
    expect(!!snap, 'snapshot delivered on hello', JSON.stringify(inbox.map((m) => m.t)));
    expect(snap.state && snap.state.polls && snap.state.polls.p1.votes.u9 === 'yes', 'snapshot carries current state', JSON.stringify(snap.state));
    expect(snap.version === 1, 'snapshot carries the version', String(snap.version));
    ws.close();
  } finally { await server.close(); }
});

test('C4 — browser client applies the snapshot (overlay state inspector populated)', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    server.store.apply({ path: 'polls/p1/votes/u9', verb: 'set', value: 'yes' }, { userId: 'gm', role: 'presenter' });
    const page = await browser.newPage();
    await page.goto(`${server.url()}/?userId=late&role=participant&debug=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ap-debug', { timeout: 5000 });
    await wait(300);
    const val = await page.evaluate(() => window.__apDebug.get('polls/p1/votes/u9'));
    expect(val === 'yes', 'client applied the snapshot into its state view', String(val));
  } finally { await browser.close(); await server.close(); }
});
