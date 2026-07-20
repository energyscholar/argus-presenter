/*
 * T-CHAT-FIRSTCLASS (Plan 0472, Phase 1). #ap-chat is ENABLED (when a listener is attached, as in
 * the wearable: Argus `ai` is the listener) and typed text flows into the UNIFIED INBOX attributed to
 * the sender's SERVER-AUTHORITATIVE connection identity — not an anonymous store op. The existing
 * chat store slice (P3 display, read-perm'd to controllers) is preserved (dual-write, D5).
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until } from '../../harness/multi.mjs';
import { WebSocket } from 'ws';

function openWs(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on('message', (b, bin) => { if (bin) return; try { inbox.push(JSON.parse(b.toString())); } catch {} });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws, inbox }); });
  });
}
const gotChatDiff = (inbox) => inbox.some((m) => m.t === 'host' && m.msg && m.msg.type === 'diff' && m.msg.diff && Object.keys(m.msg.diff).some((p) => p.indexOf('chat/') === 0 && m.msg.diff[p] && m.msg.diff[p].text === 'wearable hello'));

test('T-CHAT-FIRSTCLASS typed text lands in the inbox (server-attributed) AND still drives the chat display', async () => {
  const server = await createServer({ port: 0 });
  const wsUrl = server.url().replace('http', 'ws');
  const browser = await launch();
  try {
    // The wearable speaker types on the participant page.
    const part = await browser.newPage();
    await part.goto(`${server.url()}/?userId=u1&name=Bruce&role=participant`, { waitUntil: 'domcontentloaded' });
    await part.waitForFunction(() => window.__apChat && typeof window.__apChat.enabled === 'function');

    // Argus (ai) attaches -> a listener -> #ap-chat becomes ENABLED (the wearable orchestration case).
    const argus = await openWs(wsUrl, { userId: 'argus', role: 'ai' });
    await until(async () => (await part.evaluate(() => window.__apChat.enabled())) === true, { label: 'chat enabled (listener attached)', timeout: 5000 });
    expect((await part.evaluate(() => window.__apChat.enabled())) === true, '#ap-chat ENABLED once a listener (ai) is attached');

    // Type + send.
    await part.type('#ap-chat-input', 'wearable hello');
    await part.click('#ap-chat-send');

    // (1) FIRST-CLASS: it lands in the unified inbox, attributed to the connection identity (u1/Bruce).
    await until(() => server.getInbox(0).items.some((i) => i.kind === 'text'), { label: 'text item in inbox', timeout: 5000 });
    const item = server.getInbox(0).items.find((i) => i.kind === 'text');
    expect(!!item, 'a text item reached the inbox');
    expect(item.userId === 'u1' && item.userName === 'Bruce' && item.role === 'participant', 'inbox text attributed to the SERVER-AUTHORITATIVE identity', JSON.stringify(item));
    expect(item.text === 'wearable hello', 'inbox text carries what was typed', item.text);

    // (2) DUAL-WRITE: the chat store display still works (P3 preserved) — listener saw the diff, store holds it.
    await until(() => gotChatDiff(argus.inbox), { label: 'listener received chat display diff', timeout: 5000 });
    expect(gotChatDiff(argus.inbox), 'the listener still receives the chat display diff (dual-write)');
    const stored = Object.values(server.store.get('chat') || {}).some((c) => c && c.text === 'wearable hello');
    expect(stored, 'chat message still stored for display');

    argus.ws.close();
  } finally { await browser.close(); await server.close(); }
});
