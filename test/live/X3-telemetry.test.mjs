/*
 * X3 — telemetry sink: a stress run surfaces RTT + fan-out + denial counts via the
 * presenter_debug MCP tool; the sink is controller-read-only (S7).
 */
import { test, expect } from '../../harness/test.mjs';
import { toolMap, _server } from '../../mcp/tools.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function open(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on('message', (b) => { let m; try { m = JSON.parse(b.toString()); } catch { return; } inbox.push(m); if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', ts: m.ts })); });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws, inbox }); });
  });
}

test('X3 — presenter_debug surfaces RTT, fan-out, and denial counts', async () => {
  const T = toolMap();
  await T.presenter_start.handler({ port: 0 });
  const server = _server();
  const url = server.url().replace('http', 'ws');
  try {
    const a = await open(url, { userId: 'u1', role: 'participant' });
    const b = await open(url, { userId: 'u2', role: 'participant' });
    await wait(150);   // allow ping/pong RTT samples

    // A permitted op (broadcasts to 2 conns -> fan-out) and a denied op.
    a.ws.send(JSON.stringify({ t: 'op', path: 'polls/p1/votes/u1', verb: 'set', value: 'yes', opId: 't1' }));
    a.ws.send(JSON.stringify({ t: 'op', path: 'polls/p1/votes/u2', verb: 'set', value: 'no', opId: 't2' })); // denied (not self)
    await wait(200);

    const dbg = await T.presenter_debug.handler({ role: 'presenter' });
    const tm = dbg.telemetry;
    expect(!!tm, 'telemetry present for presenter', JSON.stringify(Object.keys(dbg)));
    expect(tm.ops.applied >= 1, 'applied count > 0', JSON.stringify(tm.ops));
    expect(tm.ops.denied >= 1, 'denied count > 0', JSON.stringify(tm.ops));
    expect(tm.fanoutSamples >= 1 && tm.avgFanout >= 1, 'fan-out measured', JSON.stringify({ f: tm.avgFanout, n: tm.fanoutSamples }));
    expect(tm.rtt.samples >= 1 && typeof tm.rtt.last === 'number', 'RTT sampled via ping/pong', JSON.stringify(tm.rtt));

    // Controller-only: a participant view gets no telemetry.
    const partView = await T.presenter_debug.handler({ role: 'participant' });
    expect(partView.telemetry === null, 'telemetry hidden from participants (S7)', JSON.stringify(partView.telemetry));

    a.ws.close(); b.ws.close();
  } finally { await T.presenter_stop.handler({}); }
});
