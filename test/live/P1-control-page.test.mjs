/*
 * P1 — the /control page drives the SAME server API/store as the MCP tools: a
 * human presenter pushes a component + opens a poll; participants see the effect.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';
import { WebSocket } from 'ws';

// Plan 0529 P2: the content catalogue is control-credentialed and FAILS CLOSED, so a test
// that drives the GM panel must run a gated server and hand the page a token — exactly as a
// real deployment does. Nothing else about these tests changed.
const CTL_TOKEN = 'ap-test-control-token';

test('P1 — /control pushes a component + opens a poll (same store effect as MCP)', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const part = await connectUser(browser, server, { userId: 'u1', userName: 'U1' });
    const ctl = await browser.newPage();
    await ctl.goto(`${server.url()}/control?userId=gm&name=GM&token=${CTL_TOKEN}`, { waitUntil: 'domcontentloaded' });
    await ctl.waitForFunction(() => typeof window.__control === 'function');
    await until(() => server.presence().some((u) => u.role === 'presenter'), { label: 'presenter connected' });

    // ⚠ AMENDED BY PLAN 0522 P8.1 — the Ad-hoc push panel is a <details> now, CLOSED by default,
    // so its controls are not rendered until it is expanded. A human presenter must open it; so
    // must this test. NOTHING about what P1 asserts changed: the same two buttons are clicked and
    // every assertion below is preserved verbatim.
    await ctl.evaluate(() => { document.getElementById('adhoc-details').open = true; });
    await ctl.waitForSelector('#pc-push', { visible: true, timeout: 3000 });

    // Push a component from the control page.
    await ctl.click('#pc-push');
    const pf = await waitContentFrame(part);
    await until(async () => /Hello/.test(await pf.evaluate(() => document.body.textContent)), { label: 'participant sees pushed card', timeout: 5000 });
    expect(/Hello/.test(await pf.evaluate(() => document.body.textContent)), 'control page pushed a component to the participant');

    // Open a poll from the control page.
    await ctl.click('#op-open');
    await until(() => server.store.get('polls/p1/open') === true, { label: 'poll seeded in store', timeout: 5000 });
    expect(server.store.get('polls/p1/open') === true, 'control open_poll seeds the store like MCP');
    expect(server.getPoll('p1').spec.prompt === 'Ship it?', 'poll spec recorded', JSON.stringify(server.getPoll('p1').spec));
    // The poll replaced the card iframe — re-fetch the current content frame.
    await until(async () => { const f = contentFrame(part); if (!f) return false; const o = await f.$$eval('[data-value]', (e) => e.length).catch(() => 0); return o >= 2; }, { label: 'participant sees the poll choice', timeout: 5000 });
    const opts = await contentFrame(part).$$eval('[data-value]', (els) => els.map((e) => e.getAttribute('data-value')));
    expect(opts.includes('yes') && opts.includes('no'), 'participant sees the poll choice', JSON.stringify(opts));

    await ctl.close();
  } finally { await browser.close(); await server.close(); }
});

test('P1 — a non-presenter control message is ignored (S1/S2)', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const url = server.url().replace('http', 'ws');
  try {
    const ws = new WebSocket(url);
    await new Promise((res) => ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', userId: 'u1', role: 'participant' })); res(); }));
    await new Promise((r) => setTimeout(r, 120));
    ws.send(JSON.stringify({ t: 'control', action: 'open_poll', args: { promptId: 'hack', prompt: 'x', options: [{ label: 'a', value: 'a' }] } }));
    await new Promise((r) => setTimeout(r, 200));
    expect(server.store.get('polls/hack/open') === undefined, 'participant control message ignored');
    ws.close();
  } finally { await server.close(); }
});
