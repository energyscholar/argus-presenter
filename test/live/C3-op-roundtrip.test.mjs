/*
 * C3 — server op round-trip: a client sends {t:'op'}; the server applies it to the
 * core store and broadcasts a read-perm-filtered diff as {t:'host', type:'diff'}.
 * Uses a raw ws client (the browser relay is wired in C5).
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

function connect(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on('message', (b) => { try { inbox.push(JSON.parse(b.toString())); } catch {} });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws, inbox }); });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('C3 — permitted op applies and broadcasts a diff to clients', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await connect(url, { userId: 'u1', userName: 'Alice', role: 'participant' });
    const b = await connect(url, { userId: 'u2', userName: 'Bob', role: 'participant' });
    await wait(150);

    // u1 sets its OWN vote (permitted by the self rule).
    a.ws.send(JSON.stringify({ t: 'op', path: 'polls/p1/votes/u1', verb: 'set', value: 'yes', opId: 'c3-1' }));
    await wait(250);

    // Plan 0471 C3: a vote is PRIVATE (self-readable only). The sender sees its own vote diff;
    // a peer does NOT (default-DENY read). A SHARED op (map/markers) still broadcasts to peers.
    a.ws.send(JSON.stringify({ t: 'op', path: 'map/markers', verb: 'add', value: { id: 'mk1', px: 0.5, py: 0.5, name: 'Alice' }, opId: 'c3-shared' }));
    await wait(200);

    const diffOf = (inbox) => inbox.filter((m) => m.t === 'host' && m.msg && m.msg.type === 'diff').map((m) => m.msg.diff);
    const aDiffs = diffOf(a.inbox), bDiffs = diffOf(b.inbox);
    expect(aDiffs.some((d) => d['polls/p1/votes/u1'] === 'yes'), 'sender received its own vote diff', JSON.stringify(aDiffs));
    expect(!bDiffs.some((d) => 'polls/p1/votes/u1' in d), 'peer does NOT receive another\'s vote (C3 default-deny)', JSON.stringify(bDiffs));
    expect(bDiffs.some((d) => d['map/markers/mk1']), 'peer DOES receive a shared-surface diff (broadcast)', JSON.stringify(bDiffs));
    expect(server.store.get('polls/p1/votes/u1') === 'yes', 'server store updated');

    // A DENIED op (u1 tries to set u2's vote) produces no diff + no state change.
    const beforeVer = server.store.version();
    a.ws.send(JSON.stringify({ t: 'op', path: 'polls/p1/votes/u2', verb: 'set', value: 'no', opId: 'c3-2' }));
    await wait(200);
    expect(server.store.get('polls/p1/votes/u2') === undefined, 'denied op did not mutate');
    expect(server.store.version() === beforeVer, 'denied op did not bump version');

    a.ws.close(); b.ws.close();
  } finally { await server.close(); }
});
