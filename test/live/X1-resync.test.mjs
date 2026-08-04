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
    // Plan 0537 P1.3 — the store does NOT boot at version 0. createServer() seeds its own slices,
    // so a fresh server is already at v8 today and any absolute number here is a hostage to the
    // next slice anyone adds. This test asserted `version()===3` after seeding and DIED ON ITS
    // FIRST ASSERTION, so the resync behaviour it exists to guard was never once exercised.
    // Everything below is now RELATIVE to the boot version.
    const base = server.store.version();

    // Seed 3 ops before anyone connects. Plan 0471 C3: use the ALL-readable 'crud' surface
    // so a participant actually receives the replayed diffs (default-deny hides unlisted paths).
    for (const v of ['a', 'b', 'c']) server.store.apply({ path: 'crud/' + v, verb: 'set', value: v }, gm);
    expect(server.store.version() === base + 3, 'version=base+3 after seed', `base=${base} now=${server.store.version()}`);

    // Fresh connect -> a FULL SNAPSHOT, carrying the version the store had when it was sent.
    // ⚠ Not `base+3`: accepting a hello is itself a WRITE (presence), so the store advances by a
    // couple of ops between the seed above and the snapshot below. That is the server's business,
    // not this test's — the claim under guard is "a fresh client gets a snapshot, and the snapshot
    // is stamped with the version it actually represents", so the version is read from the store
    // rather than predicted. Weakening this to "some snapshot arrived" is NOT the same claim.
    const c1 = await open(url, { userId: 'u1', role: 'participant', lastVersion: 0 });
    await wait(150);
    const snap1 = c1.inbox.find((m) => m.t === 'snapshot');
    const vAtSnap1 = server.store.version();
    expect(snap1 && snap1.version === vAtSnap1, 'fresh connect got a full snapshot stamped at the live version',
      `snapshot=${JSON.stringify(snap1 && snap1.version)} store=${vAtSnap1}`);
    expect(vAtSnap1 >= base + 3, 'the snapshot is at or past the seeded version', `${vAtSnap1} vs ${base + 3}`);
    c1.ws.close();
    await wait(150);

    // 2 more ops happen while u1 is away. `away` is READ, not predicted, for the same reason:
    // closing a socket also writes presence.
    server.store.apply({ path: 'crud/d', verb: 'set', value: 'd' }, gm);
    server.store.apply({ path: 'crud/e', verb: 'set', value: 'e' }, gm);
    const away = server.store.version();
    expect(away >= vAtSnap1 + 2, 'the 2 away-ops advanced the store past the snapshot', `${away} vs ${vAtSnap1}`);

    // Reconnect reporting lastVersion=`away-2` -> resync of exactly the ops after it, NO snapshot.
    const resumeFrom = away - 2;
    const c2 = await open(url, { userId: 'u1', role: 'participant', lastVersion: resumeFrom });
    await wait(250);
    const vAtResync = server.store.version();
    const resync = c2.inbox.find((m) => m.t === 'resync');
    const gotSnapshot = c2.inbox.some((m) => m.t === 'snapshot');
    const diffVers = c2.inbox.filter((m) => m.t === 'host' && m.msg && m.msg.type === 'diff').map((m) => m.msg.version);
    const expected = []; for (let v = resumeFrom + 1; v <= vAtResync; v++) expected.push(v);
    expect(resync && resync.from === resumeFrom && resync.to === vAtResync, 'resync spans exactly the gap',
      `${JSON.stringify(resync)} store=${vAtResync}`);
    expect(gotSnapshot === false, 'NO full snapshot on replayable reconnect');
    // ⛓ The "no double diffs" half of this test's own headline. It is asserted over the WHOLE
    // inbox on purpose: a version delivered twice is the defect whether the duplicate came from
    // the replay or from a broadcast racing it, and a client that applied one op twice cannot
    // tell the difference either. ⛔ Do NOT narrow this to "unique within the resync" — that
    // would be altering the test to fit the code.
    expect(JSON.stringify(diffVers) === JSON.stringify(expected),
      'exactly the missed ops, each delivered ONCE (no missed, no double)',
      `got=${JSON.stringify(diffVers)} expected=${JSON.stringify(expected)}`);
    c2.ws.close();
  } finally { await server.close(); }
});
