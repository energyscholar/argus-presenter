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

    /*
     * ⛔ BASELINE, NOT ZERO. This test used to assert `version() === 0`, and that absolute was
     * never the invariant — the invariant is that an EPHEMERAL OP CHANGES NOTHING DURABLE, which
     * is a DELTA of zero. The two coincided only on a deployment with no plugins installed: a
     * plugin legitimately seeds its state at register (starship-ops publishes ship/<region> so a
     * mounting component has something to read), so the store opens at version 13 and every
     * absolute assertion here failed on the very machine the software runs on.
     *
     * ⇒ Sample first, assert the difference. The test now holds on ANY deployment, and it gets
     *   STRICTLY STRONGER: an ephemeral op that logged would still be caught, and it no longer
     *   passes for the accidental reason that nothing else had written yet.
     */
    const base = { v: server.store.version(), ops: server.store.oplogSince(0).length };

    for (let i = 0; i < 100; i++) a.ws.send(JSON.stringify({ t: 'op', path: 'map/pointer/u1', verb: 'set', value: { px: i / 100, py: 0.5 }, opId: 'e' + i }));
    await wait(300);   // allow coalesced flushes

    expect(server.store.oplogSince(0).length - base.ops === 0, 'ephemeral ops NOT logged', String(server.store.oplogSince(0).length - base.ops));
    expect(server.store.version() - base.v === 0, 'ephemeral ops did not bump the durable version', String(server.store.version() - base.v));
    expect(server.store.get('map/pointer/u1') != null, 'state reflects the latest pointer');

    const dc = diffCount(peer.inbox);
    expect(dc >= 1 && dc <= 6, 'coalesced: bounded broadcast count for 100 ops (got ' + dc + ')', String(dc));
    const lp = lastPointer(peer.inbox);
    expect(lp && Math.abs(lp.px - 0.99) < 1e-9, 'peer converged to the latest pointer (0.99)', JSON.stringify(lp));

    // A durable op still logs + versions.
    a.ws.send(JSON.stringify({ t: 'op', path: 'polls/p/votes/u1', verb: 'set', value: 'yes', opId: 'd1' }));
    await wait(150);
    expect(server.store.version() - base.v === 1 && server.store.oplogSince(0).length - base.ops === 1,
      'durable op logged + versioned (exactly one, measured from the baseline)',
      `Δversion=${server.store.version() - base.v} Δops=${server.store.oplogSince(0).length - base.ops}`);

    a.ws.close(); peer.ws.close();
  } finally { await server.close(); }
});
