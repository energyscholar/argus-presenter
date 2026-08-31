/*
 * Plan 0720 RUN B / B2 — THE DELTA WRITE, AND THE RACE IT EXISTS TO LOSE.
 *
 * ⭐⭐ THE GATE A SEQUENTIAL TEST CANNOT PASS. Two connected clients: one DRAGS a piece while the
 * other ADDS one. Assert the drag survives. A board that is rebuilt whole on every add cannot pass
 * this — it reads the collection, and by the time it writes back, the drag it read is stale; the
 * dragged piece jumps home in front of everyone and nothing anywhere reports an error. A per-key
 * delta cannot touch a piece it does not name, so the race disappears rather than being tested for.
 *
 * ⛔ AND THE NEGATIVE CONTROL IS THE POINT. B2.3 performs the whole-board rewrite deliberately, on
 * the same server, over the same wire, with the same two clients — and the drag is lost. Without
 * that contrast this file would only prove that nothing happened to go wrong on this run.
 * → [[feedback-a-race-that-resolves-favourably-is-not-a-pass]]
 *
 * ⛔ `clear` IS NEVER USED. B2.4 shows why with the store's own diff: `clear` broadcasts
 * `{path:{}}`, so every connected client is told the board is empty. This test watches a real
 * client's cache go blank.
 *
 * ⚠ Every claim is read from `server.store` or from a CLIENT's delivered frames — never from a
 * local variable this file also wrote.
 *
 * ⛔ DOMAIN-FREE FIXTURES (PSS t0531-01): this repo is public.
 */
import { test, expect, check } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { connect, poll } from './_0720-band-b-client.mjs';
import {
  serialise, deserialise, setTokenOp, removeTokenOp,
} from '../../app/board-document.mjs';

const PATH = 'shared/tactical/runb-delta';
const SYS = { userId: 'server', role: 'system' };

let server, url, A, B;

test('0720 RUN-B B2.0 — a server, two connected clients, and an authored board', async () => {
  server = await createServer({ port: 0 });
  url = server.url();
  const ops = deserialise({
    path: PATH,
    tokens: [
      { id: 'flag', label: 'Flag', px: 0.50, py: 0.50 },
      { id: 'scout-1', label: 'Scout 1', px: 0.20, py: 0.20 },
      { id: 'scout-2', label: 'Scout 2', px: 0.80, py: 0.80 },
    ],
  });
  for (const op of ops) server.apply(op, SYS);

  A = await connect(url, { userId: 'ua', userName: 'A', role: 'participant' });
  B = await connect(url, { userId: 'ub', userName: 'B', role: 'participant' });
  check('both clients converged on a snapshot', A.snapshots.length === 1 && B.snapshots.length === 1);
  check('and both were seeded with the whole board',
    Object.keys(A.state(PATH, {})).length === 3 && Object.keys(B.state(PATH, {})).length === 3,
    JSON.stringify(Object.keys(A.state(PATH, {}))));
});

test('0720 RUN-B B2.1 — ⭐ ONE DRAGS WHILE THE OTHER ADDS: the drag SURVIVES', async () => {
  /* ⛔ ONE SYNCHRONOUS BURST — no await between the two sends, so they are genuinely in flight
     together. An await here would serialise exactly the race this test exists to run. */
  A.op(PATH + '/scout-1', 'set', { id: 'scout-1', label: 'Scout 1', px: 0.95, py: 0.05 });   // the drag
  const add = setTokenOp(PATH, 'raider', { id: 'raider', label: 'Raider', px: 0.10, py: 0.90 });
  B.op(add.path, add.verb, add.value);                                                       // the add

  await poll(() => server.store.get(PATH + '/raider') && server.store.get(PATH + '/scout-1').px === 0.95,
    'both writes to land');

  const dragged = server.store.get(PATH + '/scout-1');
  check('⭐ THE DRAG SURVIVED THE ADD', dragged.px === 0.95 && dragged.py === 0.05, JSON.stringify(dragged));
  check('…and the added piece is there too', !!server.store.get(PATH + '/raider'));
  check('nothing else moved',
    server.store.get(PATH + '/scout-2').px === 0.80 && server.store.get(PATH + '/flag').px === 0.50);

  /* The other client must SEE it, or it is decorative. */
  await poll(() => B.state(PATH + '/scout-1/px', null) === 0.95, "B's cache to catch up");
  check('the peer sees the dragged position', B.state(PATH + '/scout-1/px', null) === 0.95);
  check('the peer sees the added piece', !!B.state(PATH + '/raider', null));
});

test('0720 RUN-B B2.2 — an add is ONE op and a remove is ONE op; neither touches a neighbour', async () => {
  const before = server.store.version();
  const rm = removeTokenOp(PATH, 'scout-2');
  A.op(rm.path, rm.verb, rm.value);
  await poll(() => server.store.get(PATH + '/scout-2') === undefined, 'the removal to land');

  /* ⛔ THE KEY IS GONE, not set to null. `remove` calls `_delPath`; the null is the WIRE DIFF only
     (a rule was once built on the opposite belief). So the id must be absent from the collection's
     own key list, which is what a late joiner's snapshot is built from. */
  check('the piece is gone from the STORE, not merely nulled',
    !Object.keys(server.store.get(PATH)).includes('scout-2'),
    JSON.stringify(Object.keys(server.store.get(PATH))));
  check('exactly one durable version was consumed', server.store.version() === before + 1,
    `${before} -> ${server.store.version()}`);

  await poll(() => B.state(PATH + '/scout-2', null) === null || B.state(PATH + '/scout-2', undefined) === undefined,
    "B to drop it");
  check("the peer dropped it from its own cache", B.state(PATH + '/scout-2', null) === null);
  check('and the DRAGGED piece is still where it was put',
    server.store.get(PATH + '/scout-1').px === 0.95);
});

test('0720 RUN-B B2.3 — ⛔ THE NEGATIVE CONTROL: a WHOLE-BOARD rewrite reverts the live drag', async () => {
  /* This is the implementation the plan rejects, run here so the gate above is known to be able to
     go red. A GM adds one piece by capturing the board, appending, and writing it all back. */
  const captured = serialise(server.store, { path: PATH });          // read...
  A.op(PATH + '/scout-1', 'set', { id: 'scout-1', label: 'Scout 1', px: 0.33, py: 0.66 });  // ...a drag lands...
  await poll(() => server.store.get(PATH + '/scout-1').px === 0.33, 'the drag to land');

  captured.tokens.push({ id: 'raider-2', label: 'Raider 2', px: 0.4, py: 0.4 });
  for (const op of deserialise(captured, { current: server.store.get(PATH) })) server.apply(op, SYS);

  const after = server.store.get(PATH + '/scout-1');
  check('⛔ the whole-board write REVERTED the drag — silently, with every op accepted',
    after.px === 0.95, JSON.stringify(after));
  check('…and the add it was doing did land, which is what makes it look like it worked',
    !!server.store.get(PATH + '/raider-2'));

  /* ⇒ and now the delta form, on the same board, in the same condition. */
  A.op(PATH + '/scout-1', 'set', { id: 'scout-1', label: 'Scout 1', px: 0.33, py: 0.66 });
  await poll(() => server.store.get(PATH + '/scout-1').px === 0.33, 'the drag to land again');
  const add = setTokenOp(PATH, 'raider-3', { id: 'raider-3', label: 'Raider 3', px: 0.6, py: 0.6 });
  server.apply(add, SYS);
  check('⭐ the DELTA add left the drag alone', server.store.get(PATH + '/scout-1').px === 0.33,
    JSON.stringify(server.store.get(PATH + '/scout-1')));
  check('and still added the piece', !!server.store.get(PATH + '/raider-3'));
});

test('0720 RUN-B B2.4 — ⛔ WHY NEVER `clear`: it broadcasts a BLANK BOARD as its own diff', async () => {
  const seen = B.diffPaths.length;
  server.apply({ path: PATH, verb: 'clear' }, SYS);
  await poll(() => B.diffPaths.length > seen, "the clear's diff to reach B");

  const frame = B.diffPaths.slice(seen).find((d) => d.path === PATH);
  check('the wire carried the COLLECTION path itself...', !!frame, JSON.stringify(B.diffPaths.slice(seen)));
  check('...set to an empty object — every client is told the board is empty',
    frame && JSON.stringify(frame.value) === '{}', JSON.stringify(frame && frame.value));
  check("⛔ and the peer's board really did go blank",
    Object.keys(B.state(PATH, {})).length === 0, JSON.stringify(B.state(PATH, {})));

  /* ⇒ a drop landing in the window between that frame and the re-writes is written against an
     empty board, and re-appears as a token nobody put back. `deserialise` emits no `clear`, ever. */
  const ops = deserialise({ path: PATH, tokens: [{ id: 'flag', px: 0.5, py: 0.5 }] },
    { current: { flag: {}, ghost: {} } });
  check('deserialise emits set/remove and nothing else',
    ops.every((o) => o.verb === 'set' || o.verb === 'remove'), JSON.stringify(ops.map((o) => o.verb)));
});

test('0720 RUN-B B2.9 — teardown', async () => {
  A.close(); B.close();
  await server.close();
  expect(true, 'closed');
});
