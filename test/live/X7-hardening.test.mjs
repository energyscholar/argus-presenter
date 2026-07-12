/*
 * X7 — structural security hardening at the SERVER boundary (S3/S4/S5/S6/S10):
 * default-deny, prototype-pollution guard, conn-namespaced opId (no cross-user
 * suppression), oversized + malformed reject — and the server stays responsive.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on('message', (b) => { try { inbox.push(JSON.parse(b.toString())); } catch {} });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws, inbox }); });
  });
}
const send = (c, m) => c.ws.send(JSON.stringify(m));
const diffs = (inbox) => inbox.filter((m) => m.t === 'host' && m.msg && m.msg.type === 'diff').map((m) => m.msg.diff);

test('X7 — proto pollution / default-deny / oversized / malformed all rejected; server responsive', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await connect(url, { userId: 'u1', role: 'participant' });
    await wait(120);

    // S4: prototype-pollution attempt.
    send(a, { t: 'op', path: '__proto__/polluted', verb: 'set', value: true, opId: 'p1' });
    // S3: default-deny on an ungated path.
    send(a, { t: 'op', path: 'admin/secret', verb: 'set', value: 1, opId: 'p2' });
    // S6/S10: oversized value.
    send(a, { t: 'op', path: 'polls/p1/votes/u1', verb: 'set', value: 'x'.repeat(200 * 1024), opId: 'p3' });
    // S10: malformed (unknown verb / missing path).
    send(a, { t: 'op', path: 'polls/p1/votes/u1', verb: 'frobnicate', value: 1, opId: 'p4' });
    send(a, { t: 'op', verb: 'set', value: 1, opId: 'p5' });
    await wait(250);

    expect(({}).polluted === undefined, 'Object.prototype not polluted');
    expect(server.store.get('admin/secret') === undefined, 'default-deny path not written');
    expect(server.store.version() === 0, 'no invalid op mutated state', String(server.store.version()));
    expect(diffs(a.inbox).length === 0, 'no diffs broadcast for rejected ops', JSON.stringify(diffs(a.inbox)));

    // Server still responsive: a valid op now applies.
    send(a, { t: 'op', path: 'polls/p1/votes/u1', verb: 'set', value: 'yes', opId: 'ok' });
    await wait(200);
    expect(server.store.get('polls/p1/votes/u1') === 'yes', 'valid op works after attacks (server responsive)');
    a.ws.close();
  } finally { await server.close(); }
});

test('X7 — S5: conn-namespaced opId — a reused client opId cannot suppress a peer', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await connect(url, { userId: 'u1', role: 'participant' });
    const b = await connect(url, { userId: 'u2', role: 'participant' });
    await wait(120);
    // BOTH use the SAME client opId 'dup'. Server namespaces by conn -> both apply.
    send(a, { t: 'op', path: 'polls/p1/votes/u1', verb: 'set', value: 'yes', opId: 'dup' });
    send(b, { t: 'op', path: 'polls/p1/votes/u2', verb: 'set', value: 'no', opId: 'dup' });
    await wait(250);
    expect(server.store.get('polls/p1/votes/u1') === 'yes', 'u1 op applied');
    expect(server.store.get('polls/p1/votes/u2') === 'no', 'u2 op NOT suppressed by the shared opId (S5)');
    a.ws.close(); b.ws.close();
  } finally { await server.close(); }
});
