/*
 * S2 — control-plane server surface: registry discovery, OPSEC of the presence feed,
 * and module-beat delivery (per-target routing + promptId merge). Guards the v0.2.0 GM panel.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, until, wait } from '../../harness/multi.mjs';
import { WebSocket } from 'ws';

const helloAndCollect = (url, hello) => new Promise((res) => {
  const ws = new WebSocket(url); const presence = [];
  ws.on('message', (b) => { try { const m = JSON.parse(b); if (m.t === 'presence') presence.push(m.users); } catch {} });
  ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); res({ ws, presence }); });
});

test('OPSEC — a participant NEVER receives presence with IPs; a presenter does', async () => {
  const server = await createServer({ port: 0 });
  try {
    const url = server.url().replace('http', 'ws');
    const pres = await helloAndCollect(url, { userId: 'gm', role: 'presenter' });
    const part = await helloAndCollect(url, { userId: 'alice', role: 'participant' });
    await wait(300);
    expect(pres.presence.some((us) => us.some((u) => u.userId === 'alice' && u.ip)), 'presenter sees participant IPs', JSON.stringify(pres.presence.slice(-1)));
    expect(part.presence.length === 0, 'participant received NO presence frame (no IP leak)', 'frames=' + part.presence.length);
    pres.ws.close(); part.ws.close();
  } finally { await server.close(); }
});

test('delivery — showBeat routes by target and merges promptId into opts', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const alice = await connectUser(browser, server, { userId: 'alice', userName: 'Alice', role: 'participant' });
    const bob = await connectUser(browser, server, { userId: 'bob', userName: 'Bob', role: 'participant' });
    server.setModule({ title: 't', beats: [
      { id: 'hook', component: 'narration', target: 'alice', promptId: 'hook-a', opts: { speaker: 'x', text: 'for alice only', cta: 'ok' } },
      { id: 'pick', component: 'choice', promptId: 'the-pick', opts: { prompt: 'Q', options: [{ label: 'y', value: 'y' }, { label: 'n', value: 'n' }] } } ] });
    // beat 0: per-user narration to alice ONLY
    server.showBeat(0);
    await wait(300);
    const af = alice.frames().find((f) => f !== alice.mainFrame());
    const aText = af ? await af.evaluate(() => document.body.innerText) : '';
    const bobHasFrame = !!bob.frames().find((f) => f !== bob.mainFrame());
    expect(/for alice only/.test(aText), 'targeted beat reached alice', aText.slice(0, 40));
    expect(!bobHasFrame, 'targeted beat did NOT reach bob', 'bobHasFrame=' + bobHasFrame);
    // beat 1: choice to all — promptId must be present so answers can be collected
    server.showBeat(1);
    await until(async () => { const f = contentFrame(bob); if (!f) return false; return (await f.$$eval('[data-value]', (e) => e.length).catch(() => 0)) >= 2; }, { label: 'bob sees the choice', timeout: 5000 });
    const hasPid = await contentFrame(bob).evaluate(() => !!document.querySelector('[id*="the-pick"]'));
    expect(hasPid, 'promptId merged into delivered choice opts', 'hasPid=' + hasPid);
  } finally { await browser.close(); await server.close(); }
});

test('registry — /api/modules discovers + validates; path-traversal id is rejected', async () => {
  const server = await createServer({ port: 0 });
  try {
    const list = await (await fetch(server.url() + '/api/modules')).json();
    expect(Array.isArray(list) && list.some((m) => m.id === 'demo-welcome'), 'discovers demo module', JSON.stringify(list));
    const one = await (await fetch(server.url() + '/api/modules/demo-welcome')).json();
    expect(one.module && one.module.beats.length > 0 && !!one.validation, 'fetch one returns module+validation', JSON.stringify(one.validation));
    const bad = await fetch(server.url() + '/api/modules/' + encodeURIComponent('../server'));
    expect(bad.status === 404, 'path-traversal id rejected (404)', 'status=' + bad.status);
  } finally { await server.close(); }
});
