/*
 * Plan 0720 RUN B / B1 — `serialise` and `deserialise`, against the REAL store reducer.
 *
 * These are pure functions, so this is a unit test — but "pure" is the reason to be careful about
 * WHAT it is run against. The ops `deserialise` emits are only worth anything if `app/state.mjs`
 * accepts them, so every op here goes through a real `createStore()` rather than a local applier
 * this file also wrote. ⭐ That is what turns the round-trip into a statement about the SERVER.
 *
 * ⚠ WHAT THE ROUND-TRIP PROVES, AND IT IS ONE THING: SCHEMA DRIFT. A field added to one side and
 * forgotten on the other shows up immediately. It does NOT prove the whitelist (that is a browser
 * file this test never loads), it does not prove delete semantics, and it cannot prove the teleport
 * trap — `serialise` is handed a STORE and has nothing else to read, so reading the authored roster
 * is not a mistake it is able to make. The tests below assert each of those separately, by hand.
 *
 * ⛔ DOMAIN-FREE FIXTURES (PSS t0531-01): this repo is public. `flag`, `raider`, `scout-1` mean
 * nothing to anyone; `side` and `kind` are opaque strings to every layer that touches them.
 */
import { test, expect, check } from '../../harness/test.mjs';
import { createStore } from '../../app/state.mjs';
import {
  serialise, deserialise, boardPath, setTokenOp, removeTokenOp, setBoardPathOp,
  BOARD_PATH_KEY, DEFAULT_BOARD_PATH, BOARD_DOC_VERSION,
} from '../../app/board-document.mjs';

const SYS = { userId: 'test', role: 'system' };      // an OVERRIDE role — see app/permissions.mjs
const PATH = 'shared/tactical/runb';

/** Apply ops through the REAL reducer and hand back the store. The `applyAll` of the gate. */
function applyAll(ops, store = createStore()) {
  for (const op of ops) store.apply(op, SYS);
  return store;
}

const doc = (tokens, path = PATH) => ({ v: BOARD_DOC_VERSION, path, tokens });

test('0720 RUN-B B1.1 — ⭐ THE ROUND TRIP: serialise(applyAll(deserialise(d))) deep-equals d', () => {
  /* ⛔ Stated in this direction deliberately. `deserialise(serialise(x))` is not type-valid — one
     returns a document and the other returns ops — and the naive form would also compare a
     document against itself with no store in the middle, which is exactly the part under test. */
  const d = doc([
    { id: 'flag', label: 'Flag', side: 'blue', kind: 'hull', px: 0.5, py: 0.5, status: null, pin: true },
    { id: 'raider', label: 'Raider', side: 'red', kind: 'hull', px: 0.2, py: 0.8, size: 3, note: 'an eighth field' },
    { id: 'scout-1', label: 'Scout 1', side: 'blue', kind: 'small', px: 0.7, py: 0.3 },
  ]);
  const back = serialise(applyAll(deserialise(d)), { path: PATH });
  expect(JSON.stringify(back) === JSON.stringify(d), 'the document survives the store unchanged',
    JSON.stringify(back));
});

test('0720 RUN-B B1.2 — ⛔ the round trip carries fields this module has never heard of', () => {
  const d = doc([{ id: 'flag', px: 0.1, py: 0.1, launched: false, crew: { n: 4 }, tags: ['a', 'b'] }]);
  const back = serialise(applyAll(deserialise(d)), { path: PATH });
  const t = back.tokens[0];
  check('a nested object survives', JSON.stringify(t.crew) === '{"n":4}', JSON.stringify(t.crew));
  check('an array survives', JSON.stringify(t.tags) === '["a","b"]', JSON.stringify(t.tags));
  check('a false boolean survives as false, not as absent', t.launched === false, String(t.launched));
});

test('0720 RUN-B B1.3 — ⛔⛔ serialise reads LIVE state: a dragged piece captures where it IS', () => {
  /* ⭐ THE DRAG IS THE WHOLE TEST. On a fresh board the authored and current positions are
     identical, so a capture built from the wrong one PASSES and fails only in front of the table. */
  const authored = doc([
    { id: 'flag', label: 'Flag', px: 0.5, py: 0.5 },
    { id: 'raider', label: 'Raider', px: 0.2, py: 0.2 },
  ]);
  const store = applyAll(deserialise(authored));
  // somebody drags `raider` — one `set` on its own key, which is what the component emits on drop
  store.apply(setTokenOp(PATH, 'raider', { id: 'raider', label: 'Raider', px: 0.9, py: 0.1 }), SYS);

  const captured = serialise(store, { path: PATH });
  const raider = captured.tokens.find((t) => t.id === 'raider');
  check('the capture holds the DRAGGED position', raider.px === 0.9 && raider.py === 0.1, JSON.stringify(raider));
  check('⛔ and NOT the authored one', !(raider.px === 0.2 && raider.py === 0.2));

  /* ⇒ and therefore restoring the capture does not teleport it back. */
  const restored = serialise(applyAll(deserialise(captured), createStore()), { path: PATH });
  check('a restore puts it back where it was dragged to',
    restored.tokens.find((t) => t.id === 'raider').px === 0.9);
});

test('0720 RUN-B B1.4 — ⛔ a LOCK is not a piece: `_locks` and `lock` never reach the document', () => {
  /* Participants hold `lock`/`unlock` on `shared/**`. A record lock writes `<id>/lock`; a leaf lock
     writes `<collection>/_locks/<leaf>`. A generic subtree dump hands both back as tokens. */
  const store = applyAll(deserialise(doc([{ id: 'flag', px: 0.5, py: 0.5 }])));
  store.apply({ path: PATH + '/flag', verb: 'lock', value: { by: 'ann' } }, { userId: 'ann', role: 'system' });
  store.apply({ path: PATH + '/scout-1', verb: 'set', value: { id: 'scout-1', label: 'Scout 1', px: 0.3, py: 0.3 } }, SYS);
  /* ⚠ The leaf must EXIST first. `lock` on an absent path treats it as a RECORD and writes
     `<path>/lock` — so locking a field a record does not carry yet produces a nested object, not a
     `_locks` entry. That is the store's behaviour, not this module's, and it is worth knowing. */
  store.apply({ path: PATH + '/scout-1/label', verb: 'lock', value: { by: 'ann' } }, { userId: 'ann', role: 'system' });

  // the locks really are in the store — otherwise this test proves nothing
  check('a record lock is present in the raw collection', store.get(PATH + '/flag/lock') === 'ann');
  check('a leaf lock is present in the raw collection',
    store.get(PATH + '/scout-1/_locks/label') === 'ann', JSON.stringify(store.get(PATH + '/scout-1/_locks')));

  const d = serialise(store, { path: PATH });
  check('no token is named `_locks`', !d.tokens.some((t) => t.id === '_locks'), JSON.stringify(d.tokens.map((t) => t.id)));
  check('⛔ and no token CARRIES a `lock` field', !d.tokens.some((t) => 'lock' in t), JSON.stringify(d.tokens));
  check('⛔ nor a `_locks` field', !d.tokens.some((t) => '_locks' in t), JSON.stringify(d.tokens));
  check('the pieces themselves are still there', d.tokens.length === 2, String(d.tokens.length));
});

test('0720 RUN-B B1.5 — ⛔ a hand-edited document cannot INJECT a lock on the way in', () => {
  const ops = deserialise(doc([{ id: 'flag', px: 0.5, py: 0.5, lock: 'mallory', _locks: { px: 'mallory' } }]));
  const store = applyAll(ops);
  check('the `lock` field was dropped before it reached the store',
    store.get(PATH + '/flag/lock') === undefined, JSON.stringify(store.get(PATH + '/flag')));
  check('and so was the `_locks` map', store.get(PATH + '/flag/_locks') === undefined);
  check('⇒ nothing is locked, so the next writer is not refused',
    store.lockOwnerFor(PATH + '/flag') === null, String(store.lockOwnerFor(PATH + '/flag')));
});

test('0720 RUN-B B1.6 — ⭐ THE LIST IS AUTHORITATIVE: omission DELETES, and never by `clear`', () => {
  const store = applyAll(deserialise(doc([
    { id: 'flag', px: 0.5, py: 0.5 }, { id: 'raider', px: 0.2, py: 0.2 }, { id: 'scout-1', px: 0.7, py: 0.7 },
  ])));
  const current = store.get(PATH);
  const shorter = doc([{ id: 'flag', px: 0.5, py: 0.5 }]);

  const ops = deserialise(shorter, { current });
  check('⛔ NOT ONE `clear` op — it broadcasts a blank board as its own diff',
    !ops.some((o) => o.verb === 'clear'), JSON.stringify(ops.map((o) => o.verb)));
  const removes = ops.filter((o) => o.verb === 'remove');
  check('two removals, one per omitted id', removes.length === 2, JSON.stringify(removes));
  check('⛔ each removal names the COLLECTION and carries the id as its VALUE',
    removes.every((o) => o.path === PATH && typeof o.value === 'string'), JSON.stringify(removes));

  applyAll(ops, store);
  check('the omitted pieces are GONE from the store', store.get(PATH + '/raider') === undefined);
  check('…and the one that stayed is still there', !!store.get(PATH + '/flag'));
  check('the document agrees', serialise(store, { path: PATH }).tokens.length === 1);
});

test('0720 RUN-B B1.7 — ⛔⛔ THE NO-OP REMOVE: the obvious shape deletes NOTHING, and says so nowhere', () => {
  /* This is the trap `removeTokenOp` exists to close, asserted so nobody re-derives it live. */
  const store = applyAll(deserialise(doc([{ id: 'raider', px: 0.2, py: 0.2 }])));

  const wrong = store.apply({ path: PATH + '/raider', verb: 'remove', value: null }, SYS);
  check('the WRONG shape returns null — no error, and it reads like a refusal only if you look',
    wrong === null, JSON.stringify(wrong));
  check('⛔ and the token is STILL THERE', store.get(PATH + '/raider') !== undefined);

  const right = store.apply(removeTokenOp(PATH, 'raider'), SYS);
  check('the RIGHT shape applies', right && right.diff, JSON.stringify(right));
  check('⇒ and the token is gone', store.get(PATH + '/raider') === undefined);
  check('the diff marks the removal with null at the item path',
    right.diff[PATH + '/raider'] === null, JSON.stringify(right.diff));
});

test('0720 RUN-B B1.8 — the id comes from the KEY, and an id-less entry is dropped, not guessed', () => {
  const ops = deserialise(doc([
    { id: 'flag', px: 0.1 }, { px: 0.2, label: 'nameless' }, { id: '', px: 0.3 }, { id: 'a/b', px: 0.4 },
    { id: '_locks', px: 0.5 }, { id: 'flag', px: 0.9, label: 'duplicate' },
  ]));
  check('one op, for the one usable id', ops.length === 1, JSON.stringify(ops.map((o) => o.path)));
  check('and it is the FIRST `flag`, not the duplicate', ops[0].value.px === 0.1, JSON.stringify(ops[0].value));

  /* And a record whose own `id` disagrees with its key: the key wins, because the key is what
     every removal, every subscription tail and every diff is addressed by. */
  const store = createStore();
  store.apply({ path: PATH + '/scout-1', verb: 'set', value: { id: 'WRONG', px: 0.5 } }, SYS);
  check('serialise reports the KEY as the id', serialise(store, { path: PATH }).tokens[0].id === 'scout-1');
});

test('0720 RUN-B B1.9 — an empty or absent collection serialises to an empty board, not a throw', () => {
  const store = createStore();
  const d = serialise(store, { path: PATH });
  check('shape is intact', d.v === BOARD_DOC_VERSION && d.path === PATH && Array.isArray(d.tokens));
  check('and it is empty', d.tokens.length === 0);
  check('an empty document produces no ops when there is nothing to remove',
    deserialise(d).length === 0);
});

test('0720 RUN-B B1.10 — ⛔ serialise refuses a roster: it takes a STORE, and only a store', () => {
  /* Rule 1, asserted rather than merely commented. Handing it an array of authored tokens — the
     mistake that causes the mid-fight teleport — cannot silently succeed. */
  let threw = false;
  try { serialise([{ id: 'flag', px: 0.5, py: 0.5 }]); } catch { threw = true; }
  check('an authored roster is refused', threw);
  threw = false;
  try { serialise({ tokens: [{ id: 'flag' }] }); } catch { threw = true; }
  check('so is a document', threw);
});

test('0720 RUN-B B3.0 — the board path is a STORE KEY with a default (the mid-session escape hatch)', () => {
  const store = createStore();
  check('unset ⇒ the default', boardPath(store) === DEFAULT_BOARD_PATH, boardPath(store));
  check('unset ⇒ a caller-supplied default wins over the built-in one',
    boardPath(store, PATH) === PATH, boardPath(store, PATH));

  store.apply(setBoardPathOp('shared/tactical/round2'), SYS);
  check('set ⇒ the store key wins', boardPath(store) === 'shared/tactical/round2', boardPath(store));
  check('…even over a caller default', boardPath(store, PATH) === 'shared/tactical/round2');
  check('the op writes the declared key', store.get(BOARD_PATH_KEY) === 'shared/tactical/round2');

  /* Junk in the key must not re-point the board at a path the store will silently refuse. */
  store.apply({ path: BOARD_PATH_KEY, verb: 'set', value: '../../etc' }, SYS);
  check('a traversal path falls back to the default rather than being handed on',
    boardPath(store) === DEFAULT_BOARD_PATH, boardPath(store));
  store.apply({ path: BOARD_PATH_KEY, verb: 'set', value: 42 }, SYS);
  check('so does a non-string', boardPath(store) === DEFAULT_BOARD_PATH, boardPath(store));

  let threw = false;
  try { setBoardPathOp('  '); } catch { threw = true; }
  check('and a caller cannot BUILD an op that sets an unusable path', threw);
});

test('0720 RUN-B B1.11 — serialise defaults to the board path the store itself declares', () => {
  const store = createStore();
  store.apply(setTokenOp('shared/tactical/round2', 'flag', { id: 'flag', px: 0.4, py: 0.4 }), SYS);
  check('with the key unset, the default collection is read (and is empty)',
    serialise(store).tokens.length === 0);
  store.apply(setBoardPathOp('shared/tactical/round2'), SYS);
  const d = serialise(store);
  check('with the key set, the SAME call reads the new collection', d.tokens.length === 1, JSON.stringify(d));
  check('and the document records which path it came from', d.path === 'shared/tactical/round2', d.path);
});
