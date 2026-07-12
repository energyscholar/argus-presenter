/*
 * P3 — bottom chat input: DISABLED with no listener; ENABLED + delivered when a
 * listener (presenter/ai) is attached; visible only to listeners (read-perm).
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until } from '../../harness/multi.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function openWs(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on('message', (b) => { try { inbox.push(JSON.parse(b.toString())); } catch {} });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws, inbox }); });
  });
}
const gotChat = (inbox) => inbox.some((m) => m.t === 'host' && m.msg && m.msg.type === 'diff' && m.msg.diff && Object.keys(m.msg.diff).some((p) => p.indexOf('chat/') === 0 && m.msg.diff[p] && m.msg.diff[p].text === 'hello team'));

test('P3 — chat disabled with no listener, enabled + delivered when a listener attaches; not to non-listeners', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  const browser = await launch();
  try {
    // A browser participant (the chat bar lives on the participant page).
    const part = await browser.newPage();
    await part.goto(`${server.url()}/?userId=u1&name=U1&role=participant`, { waitUntil: 'domcontentloaded' });
    await part.waitForFunction(() => window.__apChat && typeof window.__apChat.enabled === 'function');
    await until(async () => (await part.evaluate(() => window.__apChat.enabled())) === false, { label: 'chat disabled (no listener)', timeout: 5000 });
    expect((await part.evaluate(() => window.__apChat.enabled())) === false, 'chat DISABLED with no listener');

    // A second participant (raw ws) — a non-listener — should NOT receive chat.
    const other = await openWs(url, { userId: 'u2', role: 'participant' });
    // Attach a LISTENER (presenter).
    const listener = await openWs(url, { userId: 'gm', role: 'presenter' });
    await until(async () => (await part.evaluate(() => window.__apChat.enabled())) === true, { label: 'chat enabled (listener attached)', timeout: 5000 });
    expect((await part.evaluate(() => window.__apChat.enabled())) === true, 'chat ENABLED when a listener is present');

    // Participant sends a chat message.
    await part.type('#ap-chat-input', 'hello team');
    await part.click('#ap-chat-send');

    await until(() => gotChat(listener.inbox), { label: 'listener received chat', timeout: 5000 });
    expect(gotChat(listener.inbox), 'the listener received the chat message');
    const stored = Object.values(server.store.get('chat') || {}).some((c) => c && c.text === 'hello team');
    expect(stored, 'chat message stored');
    expect(!gotChat(other.inbox), 'a non-listener participant did NOT receive the chat (read-perm)', JSON.stringify(other.inbox.filter((m) => m.t === 'host')));

    other.ws.close(); listener.ws.close();
  } finally { await browser.close(); await server.close(); }
});
