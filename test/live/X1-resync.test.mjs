/*
 * X1 — versioned state + reconnect resync. A reconnecting client that reports its
 * lastVersion receives ONLY the ops it missed (no full snapshot, no double diffs);
 * a fresh client gets a full snapshot.
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
const gm = { userId: 'gm', role: 'presenter' };

test('X1 — fresh connect gets a full snapshot; reconnect replays only missed ops', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    // Seed 3 ops before anyone connects.
    for (const v of ['a', 'b', 'c']) server.store.apply({ path: 'k/' + v, verb: 'set', value: v }, gm);
    expect(server.store.version() === 3, 'version=3 after seed');

    // Fresh connect -> full snapshot at v3.
    const c1 = await open(url, { userId: 'u1', role: 'participant', lastVersion: 0 });
    await wait(150);
    const snap1 = c1.inbox.find((m) => m.t === 'snapshot');
    expect(snap1 && snap1.version === 3, 'fresh connect got full snapshot @ v3', JSON.stringify(snap1 && snap1.version));
    c1.ws.close();

    // 2 more ops happen while u1 is away -> v5.
    server.store.apply({ path: 'k/d', verb: 'set', value: 'd' }, gm);
    server.store.apply({ path: 'k/e', verb: 'set', value: 'e' }, gm);
    expect(server.store.version() === 5, 'version=5 while away');

    // Reconnect reporting lastVersion=3 -> resync of exactly ops 4 and 5, NO snapshot.
    const c2 = await open(url, { userId: 'u1', role: 'participant', lastVersion: 3 });
    await wait(200);
    const resync = c2.inbox.find((m) => m.t === 'resync');
    const gotSnapshot = c2.inbox.some((m) => m.t === 'snapshot');
    const diffVers = c2.inbox.filter((m) => m.t === 'host' && m.msg && m.msg.type === 'diff').map((m) => m.msg.version);
    expect(resync && resync.from === 3 && resync.to === 5, 'resync from 3 to 5', JSON.stringify(resync));
    expect(gotSnapshot === false, 'NO full snapshot on replayable reconnect');
    expect(JSON.stringify(diffVers) === JSON.stringify([4, 5]), 'exactly the missed ops 4,5 (no missed/double)', JSON.stringify(diffVers));
    c2.ws.close();
  } finally { await server.close(); }
});
