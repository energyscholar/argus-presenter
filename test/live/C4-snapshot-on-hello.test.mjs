/*
 * C4 — on hello the server sends a role-filtered state snapshot; a (re)connecting
 * client converges to current state. Raw-ws delivery + browser client-applies.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch } from '../../harness/multi.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('C4 — a fresh client receives a snapshot carrying current state + version', async () => {
  const server = await createServer({ port: 0 });
  try {
    /* ⛔ THE VERSION IS A DELTA, NOT THE LITERAL 3. An installed plugin legitimately seeds its own
       state at register, so the store does not open at zero on a real deployment — this assertion
       read `snap.version === 3` and failed with 14 on the machine the software actually runs on.
       What C4 is about is that THE SNAPSHOT CARRIES THE VERSION THE STORE IS AT, so measure the
       store and compare, rather than hard-coding a count of this test's own writes. */
    const openedAt = server.store.version();

    // Seed state authoritatively (as a controller) BEFORE the client connects:
    // a shared readable slice (spec), a PEER's vote (u9), and the joiner's OWN vote (late).
    server.store.apply({ path: 'polls/p1/spec', verb: 'set', value: { prompt: 'Ship it?' } }, { userId: 'gm', role: 'presenter' });
    server.store.apply({ path: 'polls/p1/votes/u9', verb: 'set', value: 'yes' }, { userId: 'gm', role: 'presenter' });
    server.store.apply({ path: 'polls/p1/votes/late', verb: 'set', value: 'no' }, { userId: 'gm', role: 'presenter' });

    const url = server.url().replace('http', 'ws');
    const ws = new WebSocket(url);
    const inbox = [];
    await new Promise((res) => { ws.on('message', (b) => { try { inbox.push(JSON.parse(b.toString())); } catch {} }); ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', userId: 'late', role: 'participant' })); res(); }); });
    await wait(200);

    const snap = inbox.find((m) => m.t === 'snapshot');
    expect(!!snap, 'snapshot delivered on hello', JSON.stringify(inbox.map((m) => m.t)));
    // Plan 0471 C3: the snapshot carries readable state (spec) + the joiner's OWN vote,
    // and REDACTS the peer's vote (u9) — ballot secrecy in the snapshot too.
    expect(snap.state && snap.state.polls && snap.state.polls.p1.spec && snap.state.polls.p1.spec.prompt === 'Ship it?', 'snapshot carries readable current state (spec)', JSON.stringify(snap.state));
    expect(snap.state.polls.p1.votes && snap.state.polls.p1.votes.late === 'no', 'snapshot carries the joiner\'s OWN vote', JSON.stringify(snap.state.polls.p1.votes));
    expect(!(snap.state.polls.p1.votes && 'u9' in snap.state.polls.p1.votes), 'snapshot REDACTS a peer\'s vote (C3)', JSON.stringify(snap.state.polls.p1.votes));
    /* ⚠ NOT `openedAt + 3` EITHER. The joiner's own hello can itself write: with a station plugin
       installed, connecting SEATS the user, and seating is a durable op — so between the baseline
       and the snapshot the store legitimately advanced by more than this test's three writes.
       The invariant C4 is named for is that the snapshot carries THE VERSION THE STORE IS AT;
       `>= openedAt + 3` keeps it from being vacuously true without pinning a count this test
       does not own. */
    expect(snap.version === server.store.version(),
      'snapshot carries the CURRENT store version',
      `snap=${snap.version} store=${server.store.version()}`);
    expect(snap.version >= openedAt + 3,
      'and it is at least the three writes this test made',
      `snap=${snap.version} openedAt=${openedAt}`);
    ws.close();
  } finally { await server.close(); }
});

test('C4 — browser client applies the snapshot (overlay state inspector populated)', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    // Plan 0471 C3: seed the JOINER'S OWN vote (readable to it) — a peer's would be redacted.
    server.store.apply({ path: 'polls/p1/votes/late', verb: 'set', value: 'yes' }, { userId: 'gm', role: 'presenter' });
    const page = await browser.newPage();
    await page.goto(`${server.url()}/?userId=late&role=participant&debug=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ap-debug', { timeout: 5000 });
    await wait(300);
    const val = await page.evaluate(() => window.__apDebug.get('polls/p1/votes/late'));
    expect(val === 'yes', 'client applied the snapshot into its state view', String(val));
  } finally { await browser.close(); await server.close(); }
});
