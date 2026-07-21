/*
 * MSG — DISTRIBUTED INTEGRITY: client -> server -> client, state maintenance, checksums.
 *
 * Companion to MSG-interaction-roundtrip (which proves client -> server for every
 * answering component). This file proves the OTHER half: that a change made by one
 * client reaches the OTHER clients, that every instance converges on the SAME state,
 * and that a reconnecting client is restored to that same state.
 *
 * Grounded in the real permission table (app/permissions.mjs):
 *   WRITE  answers/*&#47;{self} · map/pointer/{self} · crud/*&#47;items · polls/*&#47;votes/{self}
 *   READ   restricted to controllers: gm/* · copresent/* · chat/*   (everything else: all roles)
 * So `answers` is self-scoped for WRITES but world-READABLE — a genuine cross-client channel.
 *
 * INVARIANTS ENCODED
 *   D1  a value written by client A is delivered to client B (client->server->client)
 *   D2  server and every client agree on a canonical digest of the shared subtree (checksum)
 *   D3  a client that drops and reconnects converges to that same digest (state maintenance)
 *   D4  controller-only slices (gm/*) are NOT delivered to participants (isolation holds)
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';

/* Canonical, order-independent serialisation — the "checksum". Compared as text so a
 * mismatch prints WHAT diverged, not just that something did. */
const digest = (v) => {
  const canon = (x) => {
    if (x === null || typeof x !== 'object') return x;
    if (Array.isArray(x)) return x.map(canon);
    return Object.keys(x).sort().reduce((o, k) => { o[k] = canon(x[k]); return o; }, {});
  };
  return JSON.stringify(canon(v ?? null));
};

/* Install a collector in a client's content frame. subscribeState's handler is
 * handler(path, value, msg) — capturing only the first arg records paths, not values.
 * We fold diffs into a per-client state object: that IS the state-machine-maintenance
 * invariant (each instance rebuilds the shared state from the diffs it is delivered). */
const collect = async (page) => {
  const f = contentFrame(page);
  await f.evaluate(() => {
    window.__state = {}; window.__pairs = [];
    const setPath = (obj, path, val) => {
      const ps = path.split('/'); let o = obj;
      for (let i = 0; i < ps.length - 1; i++) {
        if (o[ps[i]] == null || typeof o[ps[i]] !== 'object') o[ps[i]] = {};
        o = o[ps[i]];
      }
      if (val === null) delete o[ps[ps.length - 1]]; else o[ps[ps.length - 1]] = val;
    };
    window.Argus.subscribeState('', (path, value) => {
      window.__pairs.push([path, value]);
      setPath(window.__state, path, value);
    });
  });
};
const seen = async (page) => {
  const f = contentFrame(page);
  if (!f) return '';
  try { return await f.evaluate(() => JSON.stringify(window.__pairs || [])); } catch { return ''; }
};
/* The state THIS client rebuilt from the diffs it was delivered. */
const rebuilt = async (page) => {
  const f = contentFrame(page);
  if (!f) return null;
  try { return await f.evaluate(() => window.__state || null); } catch { return null; }
};
/* The presenter page's snapshot-seeded view (set on t==='snapshot', so it is the
 * right instrument for reconnect/resync assertions). */
const snapshotState = (page) =>
  page.evaluate(() => (window.__apDebug && window.__apDebug.dump && window.__apDebug.dump().state) || null);

test('MSG-D — cross-client propagation, digest agreement, reconnect convergence, isolation', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    let alice = await connectUser(browser, server, { userId: 'alice', userName: 'Alice' });
    let bob = await connectUser(browser, server, { userId: 'bob', userName: 'Bob' });
    await until(() => {
      const ids = server.presence().map((u) => u.userId);
      return ids.includes('alice') && ids.includes('bob');
    }, { label: 'alice and bob connected' });

    // Give both a content frame (the Argus bridge lives there).
    server.pushComponent('all', 'card', { title: 'link' });
    await waitContentFrame(alice); await waitContentFrame(bob);
    await collect(alice); await collect(bob);

    // ---- D1: client -> server -> client, on a SHARED path ------------------
    // NB (S209): an earlier version wrote to `answers/` and asserted bob SAW it. That passed only
    // because answers were world-readable — a PRIVACY LEAK that Plan 0471 deliberately closed
    // (permissions.mjs: `answers` is now roles:['gm']). Asserting the old behaviour would have
    // pressured a Generator into RE-OPENING the hole. Use `crud`, which is genuinely shared.
    await contentFrame(alice).evaluate(() =>
      window.Argus.op('crud/board/items', 'add', { id: 'a1', from: 'alice', n: 41 }));
    await until(() => server.store.get('crud/board/items') !== undefined,
      { label: "alice's shared write reached the server" });
    await until(async () => /41/.test(await seen(bob)),
      { timeout: 5000, label: "bob was DELIVERED alice's shared write" });

    const bobSaw = await seen(bob);
    expect('D1 client->server->client on a shared path', /41/.test(bobSaw), bobSaw.slice(0, 160));

    // D1b — the PRIVACY half: a private write must NOT cross to a peer.
    await contentFrame(alice).evaluate(() => window.Argus.answer('secret', { pin: 8675309 }));
    await until(() => server.store.get('answers/secret/alice') !== undefined,
      { label: "alice's private answer reached the server" });
    await new Promise((r) => setTimeout(r, 600));
    const bobAfter = await seen(bob);
    expect('D1b a peer answer is NOT disclosed to another participant (INV-SEC-1)',
      !/8675309/.test(bobAfter), bobAfter.slice(0, 160));

    // ---- D2: checksum agreement (server vs every client) --------------------
    const srvAnswers = server.store.get('crud');
    const aState = await rebuilt(alice);
    const bState = await rebuilt(bob);
    const srvD = digest(srvAnswers);
    const aD = digest(aState && aState.crud);
    const bD = digest(bState && bState.crud);
    expect('D2 alice digest matches server', aD === srvD, `client=${aD} server=${srvD}`);
    expect('D2 bob digest matches server', bD === srvD, `client=${bD} server=${srvD}`);

    // ---- D3: reconnect convergence (state-machine maintenance) --------------
    await bob.close();                       // bob drops
    await contentFrame(alice).evaluate(() =>
      window.Argus.op('crud/board/items', 'add', { id: 'a2', from: 'alice', n: 7 }));
    await until(() => JSON.stringify(server.store.get('crud/board/items') || '').includes('a2'),
      { label: 'shared state advanced while bob was away' });

    // NB: reconnect with debug=1. dbgLog() early-returns unless DEBUG, so
    // __apDebug.dump().state is INERT without it (app/presenter.html:194,210).
    bob = await browser.newPage();
    await bob.goto(`${server.url()}/?userId=bob&name=Bob&role=participant&debug=1`,
      { waitUntil: 'domcontentloaded' });
    await until(() => server.presence().some((u) => u.userId === 'bob'), { label: 'bob reconnected' });
    // Resync arrives as a fresh SNAPSHOT on hello -> read the snapshot-seeded view.
    await until(async () => {
      const s = await snapshotState(bob);
      return JSON.stringify((s && s.crud) || '').includes('a2');
    }, { timeout: 8000, label: 'bob resynced the state he missed' });

    const bAfter = digest(((await snapshotState(bob)) || {}).crud);
    const srvAfter = digest(server.store.get('crud'));
    expect('D3 reconnected client converges to the server digest',
      bAfter === srvAfter, `client=${bAfter} server=${srvAfter}`);

    // ---- D4: controller-only slices are not delivered to participants -------
    server.pushComponent('all', 'card', { title: 'iso' });   // keep frames alive
    const gmVisibleToParticipant = await (async () => {
      const s = await snapshotState(bob);          // bob is a participant
      return !!(s && s.gm);
    })();
    expect('D4 participant is not delivered gm/* slices', gmVisibleToParticipant === false,
      gmVisibleToParticipant ? 'LEAK: participant holds gm state' : 'no gm slice on participant');

    // Version must be a monotone, defined integer at the end of all this.
    const v = server.store.version ? server.store.version() : null;
    expect('state version is a positive integer', Number.isInteger(v) && v > 0, String(v));
  } finally { await browser.close(); await server.close(); }
});
