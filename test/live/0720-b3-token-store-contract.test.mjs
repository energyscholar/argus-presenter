/*
 * Plan 0720 B3 — THE TOKEN STORE CONTRACT, PROVEN WITH NO COMPONENT.
 *
 * Plan gate: *"⛔ No component. N headless clients write N keys; assert `server.store`; run 4×."*
 *
 * The design under test is ONE STORE KEY PER TOKEN — `shared/tactical/tokens/<id>` — so that two
 * people dragging two tokens at the same instant cannot lose a write. This file proves the
 * contract itself, before any pixel exists to drag:
 *
 *   1. the PERMISSION is real, read out of the live server's own policy, not assumed;
 *   2. N clients writing N keys in the same tick ⇒ EVERY key survives in `server.store` — 4×,
 *      because ⭐ a race that resolves favourably is not a pass;
 *   3. ⭐ the NEGATIVE: the collection-level pattern this design REJECTS — several writers
 *      appending to ONE key — does lose writes, on the same server, over the same wire, with the
 *      same clients. That contrast is what makes per-key a finding rather than a preference.
 *
 * ⚠ Every claim is asserted against `server.store.get(...)` or the live `server.store.perms`,
 * never against a local variable this test also wrote. A token that moves in a client's cache but
 * never reaches the store is not shared — it is decorative.
 *
 * ⛔ DOMAIN-FREE FIXTURES (PSS t0531-01): this repo is public. The behaviour is domain-free, so
 * the names were never load-bearing.
 */
import { test, expect, check } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { DEFAULT_POLICY, DEFAULT_READ_POLICY } from '../../app/permissions.mjs';
import { connect, poll, wait } from './_0720-band-b-client.mjs';

const TOKENS = 'shared/tactical/tokens';     // the per-key design
const ONEKEY = 'shared/tactical/tokenlist';  // the rejected collection-level design
const N = 8;                                 // simultaneous writers
const ROUNDS = 4;                            // ⭐ the plan's "run 4×"

let server, url;
const clients = [];

test('0720 B3.0 — server boots and the headless writers connect', async () => {
  server = await createServer({ port: 0 });
  url = server.url();
  for (let i = 0; i < N; i++) {
    clients.push(await connect(url, { userId: 'w' + i, userName: 'Writer ' + i, role: 'participant' }));
  }
  check(`${N} participant clients connected and converged`, clients.length === N, `got ${clients.length}`);
  check('each got exactly one initial snapshot frame',
    clients.every((c) => c.snapshots.length === 1),
    clients.map((c) => c.snapshots.length).join(','));
});

test('0720 B3.1 — the PERMISSION is real: `shared/**` grants the write, `shared` grants the read', () => {
  const perms = server.store.perms;
  const actor = { role: 'participant', userId: 'w0' };

  // WRITE — read out of the live policy the running server is using.
  check('a participant may `set` a token key', perms.can(actor, { path: TOKENS + '/tok-1', verb: 'set' }) === true);
  check('…and `merge` one', perms.can(actor, { path: TOKENS + '/tok-1', verb: 'merge' }) === true);
  check('…and a DEEPER leaf under it (the `**` glob is depth-free)',
    perms.can(actor, { path: TOKENS + '/tok-1/pos/x', verb: 'set' }) === true);
  // ⛔ THE PREFIX IS WHAT GRANTS IT. The same path without `shared/` is default-DENY.
  check('⛔ the SAME path outside the `shared/` prefix is denied',
    perms.can(actor, { path: 'tactical/tokens/tok-1', verb: 'set' }) === false);

  // READ — `shared` is a PREFIX rule, so every descendant is world-readable.
  for (const role of ['participant', 'gm', 'presenter']) {
    check(`${role} may READ a token key`, perms.canRead({ role, userId: 'w9' }, TOKENS + '/tok-1') === true);
  }
  check('a peer\'s private slice is NOT readable (the contrast that proves the read test bites)',
    perms.canRead(actor, 'private/w1/hand') === false);

  // And the rules are the ones the file documents, not a coincidence of some other glob.
  expect(DEFAULT_POLICY.some((r) => r.glob === 'shared/**' && r.roles.includes('participant')),
    'app/permissions.mjs carries the `shared/**` participant write rule',
    JSON.stringify(DEFAULT_POLICY.map((r) => r.glob)));
  expect(DEFAULT_READ_POLICY.some((r) => r.glob === 'shared' && r.roles.length >= 4),
    'app/permissions.mjs carries the world-readable `shared` prefix read rule');

  /* ⚠ RECORDED, NOT FIXED — the contract this proves is CONCURRENCY, not ownership.
     `shared/**` lets ANY participant set ANY key, so per-key protects a simultaneous drag; it
     does not stop a deliberate overwrite of someone else's token. If ownership is ever wanted,
     it needs a lock or a `{self}` glob, and this line is where that decision starts. */
  check('⚠ a participant may also write ANOTHER participant\'s token key (per-key ≠ ownership)',
    perms.can({ role: 'participant', userId: 'w7' }, { path: TOKENS + '/tok-owned-by-w0', verb: 'set' }) === true);
});

test('0720 B3.2 — ⭐ N CLIENTS, N KEYS, SAME TICK: every key survives. Run 4×', async () => {
  const survived = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const ids = clients.map((c, i) => `r${round}-t${i}`);
    /* ⛔ ONE SYNCHRONOUS LOOP — no await between the sends, so the frames are genuinely in flight
       together and the server interleaves them. An `await` per send would serialise the very race
       this test exists to run. */
    clients.forEach((c, i) => c.op(`${TOKENS}/${ids[i]}`, 'set', { id: ids[i], by: c.userId, x: i * 10, y: round }));

    await poll(() => {
      const coll = server.store.get(TOKENS) || {};
      return ids.every((id) => coll[id] !== undefined);
    }, `round ${round}: all ${N} token keys in the store`);

    const coll = server.store.get(TOKENS) || {};
    let ok = 0;
    for (let i = 0; i < N; i++) {
      const t = coll[ids[i]];
      if (t && t.by === clients[i].userId && t.x === i * 10 && t.y === round) ok++;
    }
    survived.push(ok);
    check(`round ${round}: ${ok}/${N} simultaneous per-key writes survived intact in server.store`,
      ok === N, JSON.stringify(coll));
  }

  // The store's final word: every key from every round is still there. 4 × 8 = 32.
  const coll = server.store.get(TOKENS) || {};
  const total = Object.keys(coll).length;
  check(`after ${ROUNDS} rounds the store holds ${total} token keys (expected ${ROUNDS * N})`,
    total === ROUNDS * N, Object.keys(coll).sort().join(','));
  expect(survived.every((s) => s === N),
    `⭐ all ${ROUNDS} concurrent rounds were lossless — not one favourable resolution`,
    `per-round survivors: ${survived.join(',')}`);
});

test('0720 B3.3 — ⭐ THE NEGATIVE: several writers appending to ONE key DO lose writes', async () => {
  /*
   * This is the pattern the per-key design rejects, and the one `note()` in the initiative plugin
   * uses safely ONLY because the server is its sole writer (plan 0720 red-team R5 → B8).
   *
   * Each client builds its write from ITS OWN CACHE — the array it last saw on the wire — exactly
   * as a component would. Nothing here forces the collision: the clients all hold the same array
   * because no diff has reached them yet, and that is the whole hazard. Read-modify-write on a
   * shared key is lossy by construction, and it is lossy SILENTLY: every one of these ops is
   * accepted, applied and acknowledged.
   */
  const lost = [];
  for (let round = 1; round <= ROUNDS; round++) {
    clients[0].op(ONEKEY, 'set', []);                                  // reset the collection
    await poll(() => clients.every((c) => Array.isArray(c.state(ONEKEY)) && c.state(ONEKEY).length === 0),
      `round ${round}: every client's cache shows the empty list`);

    // Same synchronous tick again — each appends to the array IT HOLDS.
    clients.forEach((c, i) => {
      const prev = c.state(ONEKEY, []);
      c.op(ONEKEY, 'set', [...prev, { id: `r${round}-e${i}`, by: c.userId }]);
    });

    await poll(() => {
      const arr = server.store.get(ONEKEY);
      return Array.isArray(arr) && arr.length >= 1;
    }, `round ${round}: the list settled`);
    await wait(80);                                                    // let every op land before reading

    const arr = server.store.get(ONEKEY) || [];
    lost.push(N - arr.length);
    check(`round ${round}: ${arr.length}/${N} appends survived — ${N - arr.length} LOST, silently`,
      arr.length < N, JSON.stringify(arr));
  }

  expect(lost.every((l) => l > 0),
    `⭐ every one of the ${ROUNDS} collection-level rounds lost writes`,
    `lost per round: ${lost.join(',')}`);

  /* ⇒ THE CONTRAST, on one server, one wire, the same ${N} clients:
   *      per key      — 8/8 survive, 4 rounds out of 4
   *      one key      — 1/8 survives, 4 rounds out of 4
   * That is why `shared/tactical/tokens/<id>` is a finding and not a preference. */
  const perKey = Object.keys(server.store.get(TOKENS) || {}).length;
  check(`⭐ CONTRAST: ${perKey} per-key writes retained vs ${N - lost[lost.length - 1]} of ${N} on one key`,
    perKey === ROUNDS * N && lost[lost.length - 1] > 0);
});

test('0720 B3.4 — a token MOVE is a per-key write too: merge touches one key, not the collection', async () => {
  const id = 'r1-t0';
  const before = server.store.get(`${TOKENS}/${id}`);
  clients[3].op(`${TOKENS}/${id}`, 'merge', { x: 999 });
  await poll(() => (server.store.get(`${TOKENS}/${id}`) || {}).x === 999, 'the merge landed');
  const after = server.store.get(`${TOKENS}/${id}`);
  check('the moved token has its new x', after.x === 999, JSON.stringify(after));
  check('…and keeps the fields it was not asked to change', after.id === before.id && after.by === before.by,
    JSON.stringify(after));
  check('…and no sibling token was disturbed',
    Object.keys(server.store.get(TOKENS) || {}).length === ROUNDS * N);
});

test('0720 B3.9 — teardown', async () => {
  for (const c of clients) c.close();
  await server.close();
  expect(true, 'server closed');
});
