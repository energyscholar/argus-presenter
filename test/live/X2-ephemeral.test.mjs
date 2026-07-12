/*
 * X2 — ephemeral (pointer) ops: NOT logged (0 op-log growth, no version bump) and
 * coalesced on broadcast (a 100-op burst yields a bounded number of diffs). Durable
 * ops still log + version.
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
const diffCount = (inbox) => inbox.filter((m) => m.t === 'host' && m.msg && m.msg.type === 'diff').length;
const lastPointer = (inbox) => {
  const ds = inbox.filter((m) => m.t === 'host' && m.msg && m.msg.type === 'diff' && m.msg.diff['map/pointer/u1']);
  return ds.length ? ds[ds.length - 1].msg.diff['map/pointer/u1'] : null;
};

test('X2 — 100 pointer ops: 0 op-log growth, no version bump, bounded broadcast', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await open(url, { userId: 'u1', role: 'participant' });
    const peer = await open(url, { userId: 'u2', role: 'participant' });
    await wait(120);

    for (let i = 0; i < 100; i++) a.ws.send(JSON.stringify({ t: 'op', path: 'map/pointer/u1', verb: 'set', value: { px: i / 100, py: 0.5 }, opId: 'e' + i }));
    await wait(300);   // allow coalesced flushes

    expect(server.store.oplogSince(0).length === 0, 'ephemeral ops NOT logged', String(server.store.oplogSince(0).length));
    expect(server.store.version() === 0, 'ephemeral ops did not bump the durable version', String(server.store.version()));
    expect(server.store.get('map/pointer/u1') != null, 'state reflects the latest pointer');

    const dc = diffCount(peer.inbox);
    expect(dc >= 1 && dc <= 6, 'coalesced: bounded broadcast count for 100 ops (got ' + dc + ')', String(dc));
    const lp = lastPointer(peer.inbox);
    expect(lp && Math.abs(lp.px - 0.99) < 1e-9, 'peer converged to the latest pointer (0.99)', JSON.stringify(lp));

    // A durable op still logs + versions.
    a.ws.send(JSON.stringify({ t: 'op', path: 'polls/p/votes/u1', verb: 'set', value: 'yes', opId: 'd1' }));
    await wait(150);
    expect(server.store.version() === 1 && server.store.oplogSince(0).length === 1, 'durable op logged + versioned', String(server.store.version()));

    a.ws.close(); peer.ws.close();
  } finally { await server.close(); }
});
