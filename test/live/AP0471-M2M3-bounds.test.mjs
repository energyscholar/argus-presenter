/*
 * Plan 0471 M2/M3 — memory bounds (INV-MEM-1).
 *  M2: attacker-chosen ackIds no longer grow the `acks` map (unknown ackId dropped);
 *      only an outstanding chime accepts an ack; distinct chimed ackIds are FIFO-capped.
 *  M3: `lastResults` is bounded to LAST_RESULTS_MAX promptIds; a >64KB value is rejected.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function open(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { maxPayload: 4 * 1024 * 1024 });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve(ws); });
  });
}

test('M2 — unknown ackIds are dropped; only an outstanding chime accepts an ack; chimes are capped', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const ws = await open(url, { userId: 'atk', role: 'participant' });
    await wait(120);
    // 2000 attacker acks with distinct, unrequested ackIds → map must NOT grow.
    for (let i = 0; i < 2000; i++) ws.send(JSON.stringify({ t: 'ack', ackId: 'atk-' + i }));
    await wait(400);
    expect(server._acks.size === 0, 'unknown ackIds create no entries (was unbounded growth)', 'size=' + server._acks.size);

    // A legitimate flow: chime creates the ackId, then the client acks it → recorded.
    server.chime({ requireAck: true, ackId: 'ready', target: 'all' });
    await wait(80);
    ws.send(JSON.stringify({ t: 'ack', ackId: 'ready' }));
    await wait(150);
    expect(server.getAck('ready').count === 1, 'a real ack to an outstanding chime is recorded', JSON.stringify(server.getAck('ready')));

    // Many distinct chimed ackIds → the map is FIFO-capped (<= 256).
    for (let i = 0; i < 600; i++) server.chime({ requireAck: true, ackId: 'c-' + i });
    expect(server._acks.size <= 256, 'chimed ackIds are bounded (FIFO evict)', 'size=' + server._acks.size);

    ws.close();
  } finally { await server.close(); }
});

test('M3 — lastResults is bounded and a >64KB value is rejected', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const ws = await open(url, { userId: 'u', role: 'participant' });
    await wait(120);
    // 1200 distinct promptIds via 'continue' (bypasses the poll shim / store) → LRU-capped at 500.
    for (let i = 0; i < 1200; i++) ws.send(JSON.stringify({ t: 'result', msg: { type: 'continue', promptId: 'p' + i, value: 'x' } }));
    await wait(600);
    const n = Object.keys(server._lastResults).length;
    expect(n <= 500, 'lastResults bounded to LAST_RESULTS_MAX promptIds', 'count=' + n);

    // A 200KB value is over the 64KB cap → not stored.
    ws.send(JSON.stringify({ t: 'result', msg: { type: 'continue', promptId: 'big', value: 'A'.repeat(200 * 1024) } }));
    await wait(200);
    expect(server._lastResults['big'] === undefined, 'oversized value rejected (64KB cap on this path)', JSON.stringify(Object.keys(server._lastResults).includes('big')));

    ws.close();
  } finally { await server.close(); }
});
