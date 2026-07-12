/*
 * X6 — a flooding client is throttled (excess durable ops dropped + warn) while the
 * server stays responsive to other clients.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function open(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on('message', (b) => { try { inbox.push(JSON.parse(b.toString())); } catch {} });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws, inbox }); });
  });
}

test('X6 — durable-op flood is throttled; server stays responsive', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const flood = await open(url, { userId: 'u1', role: 'presenter' });  // presenter can write anywhere
    const other = await open(url, { userId: 'u2', role: 'participant' });
    await wait(120);

    // Flood 300 durable ops in one window (distinct paths so they'd all log if not capped).
    for (let i = 0; i < 300; i++) flood.ws.send(JSON.stringify({ t: 'op', path: 'k/n' + i, verb: 'set', value: i, opId: 'f' + i }));
    await wait(300);

    const v = server.store.version();
    expect(v > 0 && v <= 60, 'flood throttled near the per-sec cap (version=' + v + ')', String(v));

    // Server still responsive: another client's op applies.
    other.ws.send(JSON.stringify({ t: 'op', path: 'polls/p/votes/u2', verb: 'set', value: 'yes', opId: 'ok' }));
    await wait(200);
    expect(server.store.get('polls/p/votes/u2') === 'yes', 'other client served during the flood');

    // A rate-limit warning was recorded (visible to presenter).
    const warned = server.debugDump('presenter').opLog.some((e) => e.tag === 'rl');
    expect(warned, 'a throttle warning was logged');

    flood.ws.close(); other.ws.close();
  } finally { await server.close(); }
});
