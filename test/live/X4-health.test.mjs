/*
 * X4 — presenter_health: green when live; a silent (hung) connection shows stale
 * within N seconds; reports throughput + sizes.
 */
import { test, expect } from '../../harness/test.mjs';
import { toolMap, _server } from '../../mcp/tools.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function open(url, hello, { pong = true } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('message', (b) => { let m; try { m = JSON.parse(b.toString()); } catch { return; } if (pong && m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', ts: m.ts })); });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws }); });
  });
}

test('X4 — health green when live; reports throughput and sizes', async () => {
  const T = toolMap();
  await T.presenter_start.handler({ port: 0 });
  const server = _server();
  const url = server.url().replace('http', 'ws');
  try {
    const a = await open(url, { userId: 'u1', role: 'participant' });
    await wait(120);
    a.ws.send(JSON.stringify({ t: 'op', path: 'polls/p/votes/u1', verb: 'set', value: 'yes', opId: 'h1' }));
    await wait(150);
    const h = await T.presenter_health.handler({ staleMs: 10000 });
    expect(h.status === 'green', 'health green with a live client', JSON.stringify(h));
    expect(h.opsApplied >= 1, 'throughput counted', String(h.opsApplied));
    expect(h.stateVersion === 1 && h.opLogSize === 1, 'state + op-log sizes reported', JSON.stringify({ v: h.stateVersion, l: h.opLogSize }));
    expect(h.connections.length === 1 && h.connections[0].stale === false, 'live connection not stale');
    a.ws.close();
  } finally { await T.presenter_stop.handler({}); }
});

test('X4 — a silent connection shows stale within N s', async () => {
  const T = toolMap();
  await T.presenter_start.handler({ port: 0 });
  const server = _server();
  const url = server.url().replace('http', 'ws');
  try {
    const silent = await open(url, { userId: 'q', role: 'participant' }, { pong: false });
    await wait(120);
    // Immediately: not stale under a 10s threshold.
    expect((await T.presenter_health.handler({ staleMs: 10000 })).status === 'green', 'not stale yet');
    // Wait past a short staleness threshold with no client activity.
    await wait(500);
    const h = await T.presenter_health.handler({ staleMs: 300 });
    expect(h.status === 'degraded', 'health degraded when a connection goes stale', JSON.stringify(h.status));
    expect(h.connections.some((c) => c.stale === true), 'the silent connection is marked stale', JSON.stringify(h.connections));
    silent.ws.close();
  } finally { await T.presenter_stop.handler({}); }
});
