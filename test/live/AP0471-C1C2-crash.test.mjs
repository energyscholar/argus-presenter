/*
 * Plan 0471 C1/C2 — crash guards. A socket-level error (frame > MAX_PAYLOAD) and a
 * `null` JSON frame must NOT terminate the process. After each hostile frame, a fresh
 * client must still connect and get a welcome (proves the server is still UP).
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connectAndHello(url, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { maxPayload: 4 * 1024 * 1024 });
    let welcomed = false;
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('message', (buf) => {
      try { const m = JSON.parse(buf.toString()); if (m && m.t === 'welcome') { welcomed = true; resolve({ ws, welcome: m }); } } catch {}
    });
    ws.on('error', () => {});
    setTimeout(() => { if (!welcomed) reject(new Error('no welcome — server may be down')); }, 2000);
  });
}

function sendRaw(url, payload) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { maxPayload: 4 * 1024 * 1024 });
    ws.on('error', () => {});
    ws.on('open', () => { try { ws.send(payload); } catch {} setTimeout(() => { try { ws.close(); } catch {}; resolve(); }, 150); });
  });
}

test('C1 — a >256KB frame does NOT kill the server; other clients keep working', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const survivor = await connectAndHello(url, { userId: 'keep', role: 'participant' });
    // Oversize frame (>256KB MAX_PAYLOAD) → ws emits socket 'error' (1009). Must be caught, not fatal.
    await sendRaw(url, JSON.stringify({ t: 'op', path: 'chat', verb: 'add', value: 'A'.repeat(300 * 1024) }));
    await wait(200);
    // Process still alive → a fresh client still gets a welcome, and the survivor is still counted.
    const fresh = await connectAndHello(url, { userId: 'after-oversize', role: 'participant' });
    expect(fresh.welcome.t === 'welcome', 'server still accepts new clients after oversize frame');
    expect(server.presence().length >= 1, 'survivor connection still tracked', 'presence=' + server.presence().length);
    survivor.ws.close(); fresh.ws.close();
  } finally { await server.close(); }
});

test('C2 — a bare `null` frame does NOT kill the server', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    await sendRaw(url, 'null');           // JSON.parse('null') === null → null.t would throw pre-fix
    await sendRaw(url, '42');             // primitive frames also inert
    await sendRaw(url, '"x"');
    await wait(200);
    const fresh = await connectAndHello(url, { userId: 'after-null', role: 'participant' });
    expect(fresh.welcome.t === 'welcome', 'server still accepts new clients after null/primitive frames');
    fresh.ws.close();
  } finally { await server.close(); }
});
