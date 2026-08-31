/*
 * Plan 0720 RUN C / C1 — ⛔⛔ A RESTART MUST NOT DESTROY THE SESSION.  (audit finding F18)
 *
 * ⛔ THE GATE, AND IT IS DELIBERATELY THREE THINGS AT ONCE. `app/state.mjs` is an in-memory object
 * tree, and the CI on this estate auto-deploys within ~60 s of a push and restarts the service. So
 * a push mid-session used to destroy every piece anyone had moved, the turn order, who had acted
 * this round, and every point of damage taken.
 *
 * ⛔⛔ A BOARD-ONLY GATE PASSES WHILE THE SESSION IS STILL LOST. That is the whole of F18: the
 * obvious test restores the pieces, goes green, and leaves the round counter, the acted flags and
 * the damage on the floor. Every restart assertion below therefore covers ALL THREE subtrees, and
 * `C1.9` fails outright if a later change narrows what is persisted.
 *
 * ⛔ NO MANUAL CAPTURE ANYWHERE IN THE RESTART PATH. `C1.1` polls the FILE — written by the
 * debounce, with nobody asking — and asserts it holds the values BEFORE the server is closed. A
 * capture that only happens when someone remembers is the same class of failure as a watcher that
 * only runs when the agent remembers to arm it.
 *
 * ⛔ THE DEBOUNCE HAS A CEILING (`C1.2`). A plain trailing debounce is reset by every change, so an
 * unbroken stream starves the write forever — and on this system the unbroken stream is somebody
 * dragging a piece, i.e. the failure lands during the busiest minute of the fight.
 *
 * ⚠ Every claim is read from `server.store`, from the FILE on disk, or from a CLIENT's delivered
 *   frames — never from a local variable this file also wrote.
 *
 * ⛔ DOMAIN-FREE FIXTURES (PSS t0531-01): this repo is public.
 */
import { test, expect, check } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { connect, poll, wait } from './_0720-band-b-client.mjs';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DURABLE_STATE_FILE } from '../../lib/durable-state.mjs';
import { makePluginsDir, withPlugins } from '../unit/_0514-fixtures.mjs';

const SYS = { userId: 'server', role: 'system' };

/* Three subtrees, one per half of the failure F18 describes. Neutral names throughout. */
const BOARD = 'shared/tactical/runc';        // pieces people drag
const ORDER = 'shared/sequence';             // round / turn / who has acted
const RIG = 'ships/runc-hull-1';             // machine state, incl. damage

const DIR = mkdtempSync(join(tmpdir(), 'ap-runc-state-'));
const FILE = join(DIR, DURABLE_STATE_FILE);

/* Small enough that the suite does not wait a real second; the RATIO is what the design needs. */
const FAST = { stateQuietMs: 40, stateMaxMs: 200 };

/** The document currently on disk, or null. Read from the FILE, never from the server. */
function onDisk() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return null; }
}
const leaf = (doc, p) => (doc && doc.leaves ? doc.leaves[p] : undefined);

let A = null;      // the server that plays the session
let B = null;      // the server that comes up after the "restart"

test('0720 RUN-C C1.0 — a durable server, a connected client, and a session in progress', async () => {
  A = await createServer({ port: 0, stateDir: DIR, ...FAST });
  check('the server says out loud that it IS durable, and where',
    A.durableState.configured === true && A.durableState.file === FILE, JSON.stringify(A.durableState.status()));

  const c = await connect(A.url(), { userId: 'ua', userName: 'A', role: 'participant' });

  // 1. pieces, authored then DRAGGED — ⚠ a fresh board's authored and current positions are
  //    identical, so a capture that read the wrong one would pass. The drag is the whole test.
  A.apply({ path: BOARD + '/p1', verb: 'set', value: { id: 'p1', label: 'One', px: 0.10, py: 0.10 } }, SYS);
  A.apply({ path: BOARD + '/p2', verb: 'set', value: { id: 'p2', label: 'Two', px: 0.20, py: 0.20 } }, SYS);
  c.op(BOARD + '/p1', 'set', { id: 'p1', label: 'One', px: 0.77, py: 0.33 });   // a real client drag
  // 2. the turn order and the acted flags
  A.apply({ path: ORDER + '/round', verb: 'set', value: 4 }, SYS);
  A.apply({ path: ORDER + '/turn', verb: 'set', value: 'p2' }, SYS);
  A.apply({ path: ORDER + '/acted/p1', verb: 'set', value: true }, SYS);
  // 3. the machine state
  A.apply({ path: RIG + '/damage/hull', verb: 'set', value: 6 }, SYS);
  A.apply({ path: RIG + '/damage/crits', verb: 'set', value: ['sensors', 'drive'] }, SYS);
  A.apply({ path: RIG + '/alert', verb: 'set', value: 'red' }, SYS);

  await poll(() => A.store.get(BOARD + '/p1').px === 0.77, 'the client drag to land');
  check('the drag is in the store, not just in the test', A.store.get(BOARD + '/p1').px === 0.77);
  c.close();
});

test('0720 RUN-C C1.1 — ⛔ THE FILE IS WRITTEN BY NOBODY: no capture call, and it holds all three subtrees', async () => {
  await poll(() => {
    const d = onDisk();
    return d && leaf(d, BOARD + '/p1/px') === 0.77;
  }, 'the debounced write to land with nothing asking for it');

  const doc = onDisk();
  check('⭐ the DRAGGED position is on disk — not the authored one', leaf(doc, BOARD + '/p1/px') === 0.77, JSON.stringify(leaf(doc, BOARD + '/p1/px')));
  check('…and the piece nobody touched is there too', leaf(doc, BOARD + '/p2/px') === 0.20);
  check('⭐ the ROUND and the TURN are on disk', leaf(doc, ORDER + '/round') === 4 && leaf(doc, ORDER + '/turn') === 'p2');
  check('⭐ the ACTED flag is on disk', leaf(doc, ORDER + '/acted/p1') === true);
  check('⭐ the DAMAGE is on disk — the half a board-only fix leaves behind', leaf(doc, RIG + '/damage/hull') === 6);
  check('…including an array, still an array', Array.isArray(leaf(doc, RIG + '/damage/crits')) && leaf(doc, RIG + '/damage/crits').length === 2);
  check('⛔ and this happened with the server still RUNNING — nothing here called flushSync or close',
    A.durableState.status().writes > 0, JSON.stringify(A.durableState.status()));
});

test('0720 RUN-C C1.2 — ⛔ THE DEBOUNCE HAS A CEILING: a continuous drag does not starve the write', async () => {
  /*
   * ⛔ THE BUG THIS EXISTS TO CATCH. A trailing debounce restarts its timer on every change, so a
   * stream of changes arriving faster than the quiet period NEVER fires. The stream is somebody
   * dragging a piece across the board — so a plain debounce loses exactly the minute it is most
   * expensive to lose. `maxMs` caps the age of the oldest unwritten change.
   *
   * The test drives changes every ~15 ms with a 40 ms quiet period, for longer than the 200 ms
   * ceiling, and asserts a write landed WHILE THE STREAM WAS STILL RUNNING.
   */
  const before = A.durableState.status().writes;
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < 500) {
    A.apply({ path: BOARD + '/p2', verb: 'set', value: { id: 'p2', label: 'Two', px: 0.3 + (n % 9) / 100, py: 0.4 } }, SYS);
    n++;
    await wait(15);                                        // ⚠ shorter than quietMs, on purpose
  }
  const during = A.durableState.status().writes;
  check('⭐ the write happened DURING the unbroken stream, not after it',
    during > before, `writes ${before} -> ${during} over ${n} changes in ${Date.now() - t0}ms`);
  check('…and more than once, so it is a cadence and not one lucky gap',
    during - before >= 2, `writes ${before} -> ${during}`);
});

test('0720 RUN-C C1.3 — ⛔ SYSTEMCTL-RESTART EQUIVALENT: a NEW server on the same directory brings all three back', async () => {
  /* ⛔ The file is read BEFORE the close, so nothing below can be credited to a shutdown flush.
     A power cut does not call close(); this proves the session survives one that does not. */
  const beforeClose = onDisk();
  check('the disk already holds the session before anything shuts down',
    leaf(beforeClose, BOARD + '/p1/px') === 0.77 && leaf(beforeClose, ORDER + '/round') === 4 && leaf(beforeClose, RIG + '/damage/hull') === 6);

  await A.close();
  B = await createServer({ port: 0, stateDir: DIR, ...FAST });

  check('⭐ THE PIECES CAME BACK WHERE THEY WERE DRAGGED TO, not where they were authored',
    B.store.get(BOARD + '/p1').px === 0.77 && B.store.get(BOARD + '/p1').py === 0.33,
    JSON.stringify(B.store.get(BOARD + '/p1')));
  check('…with their labels intact', B.store.get(BOARD + '/p1').label === 'One' && B.store.get(BOARD + '/p2').label === 'Two');
  check('⭐ THE ROUND AND THE TURN CAME BACK', B.store.get(ORDER + '/round') === 4 && B.store.get(ORDER + '/turn') === 'p2');
  check('⭐ THE ACTED FLAG CAME BACK — without it the round restarts and somebody acts twice',
    B.store.get(ORDER + '/acted/p1') === true);
  check('⭐ THE DAMAGE CAME BACK', B.store.get(RIG + '/damage/hull') === 6 && B.store.get(RIG + '/alert') === 'red');
  check('…and the array is an array, not an object with numeric keys',
    Array.isArray(B.store.get(RIG + '/damage/crits')) && B.store.get(RIG + '/damage/crits')[1] === 'drive',
    JSON.stringify(B.store.get(RIG + '/damage/crits')));

  const fresh = await connect(B.url(), { userId: 'ub', userName: 'B', role: 'participant' });
  check('and a client joining the restarted server is handed the restored board in its snapshot',
    fresh.state(BOARD + '/p1/px') === 0.77, JSON.stringify(fresh.state(BOARD, {})));
  fresh.close();
});

test('0720 RUN-C C1.4 — ⛔ THE RESTORE BROADCASTS: a connected client is told, not left stale', async () => {
  /*
   * ⛔ THE FINDING. A restore through the raw `store.apply` rebuilds the server's tree perfectly
   * and sends NOTHING, so every connected client keeps rendering the pre-restore board with no way
   * to know it is wrong. At boot nobody is connected and the bug is invisible — which is exactly
   * why it has to be asserted here, on a restore performed with a client watching.
   */
  const c = await connect(B.url(), { userId: 'uc', userName: 'C', role: 'participant' });
  // Move a piece away from what the file says, so the restore has something to correct.
  B.apply({ path: BOARD + '/p1', verb: 'set', value: { id: 'p1', label: 'One', px: 0.01, py: 0.01 } }, SYS);
  await poll(() => c.state(BOARD + '/p1/px') === 0.01, 'the client to see the move');

  const before = c.diffFrames.length;
  const r = B.durableState.restore();
  check('the restore applied leaves', r.applied > 0, JSON.stringify(r));
  await poll(() => c.state(BOARD + '/p1/px') === 0.77, 'the client to be TOLD about the restore');
  check('⭐ the client received diff frames from the restore', c.diffFrames.length > before, `${before} -> ${c.diffFrames.length}`);
  check('⭐ and its own cache now agrees with the restored store',
    c.state(BOARD + '/p1/px') === 0.77 && B.store.get(BOARD + '/p1').px === 0.77);
  c.close();
});

test('0720 RUN-C C1.5 — ⛔ A LOCK NEVER REACHES THE DISK, AND ONE IN THE WAY IS BROKEN WITHOUT BRANDING THE RECORD', async () => {
  const c = await connect(B.url(), { userId: 'ann', userName: 'Ann', role: 'participant' });
  c.op(BOARD + '/p2', 'lock', null);
  await poll(() => B.store.lockOwnerFor(BOARD + '/p2') === 'ann', 'the lock to be taken');

  B.durableState.flushSync();
  const doc = onDisk();
  check('⛔ no lock on disk — a restored lock hands a path to somebody who is not in the room',
    !Object.keys(doc.leaves).some((k) => k.endsWith('/lock') || k.includes('_locks')),
    JSON.stringify(Object.keys(doc.leaves).filter((k) => k.includes('lock'))));

  /* Now restore INTO the live lock. The write must land, and the record must come out clean. */
  const r = B.durableState.restore();
  check('the lock was in the way and was broken', r.locksBroken >= 1, JSON.stringify(r));
  check('…so the restore write actually landed', B.store.get(BOARD + '/p2').label === 'Two');
  check('⛔⛔ AND THE RECORD CARRIES NO `force` — `set` clones its value into the tree, and a forced'
    + ' write would brand this piece for the rest of the session',
    !('force' in B.store.get(BOARD + '/p2')), JSON.stringify(B.store.get(BOARD + '/p2')));
  check('…and no `lock` either', !('lock' in B.store.get(BOARD + '/p2')), JSON.stringify(B.store.get(BOARD + '/p2')));
  c.close();
});

test('0720 RUN-C C1.6 — ⛔⛔ AN EPHEMERAL IS NOT STATE, AND IT IS IN THE TREE ANYWAY', async () => {
  /*
   * ⛔ TWO SEPARATE CLAIMS, AND THE SECOND ONE IS THE ONE THAT BIT. A pointer op returns from
   * `apply` before the op log, so it schedules NO write — that much is free. But `apply` runs the
   * REDUCER FIRST, so the cursor really is in the tree, under a persisted prefix; the very next
   * durable op would carry every viewer's cursor to disk and a restart would restore a room full
   * of them. Measured on this branch before the filter existed:
   *     POINTER ON DISK: shared/pointer/uz/x, shared/pointer/uz/y
   *
   * ⚠ Settle first. The previous test's restore legitimately owes a write, and counting from a
   *   dirty start would blame the pointer stream for somebody else's op.
   */
  B.durableState.flushSync();
  check('the baseline is clean — nothing owed before the stream starts', B.durableState.pending === false);
  for (let i = 0; i < 20; i++) B.apply({ path: 'shared/pointer/uz', verb: 'set', value: { x: i / 20, y: 0.5 } }, SYS);
  check('⭐ 20 pointer ops schedule NO write', B.durableState.pending === false);
  check('…and yet the cursor IS in the live tree — this is the half that surprises',
    B.store.get('shared/pointer/uz/y') === 0.5, JSON.stringify(B.store.get('shared/pointer')));

  /* Now force a dump the way a real durable op would, and look at what actually landed. */
  B.apply({ path: ORDER + '/round', verb: 'set', value: 5 }, SYS);
  B.durableState.flushSync();
  const doc = onDisk();
  check('⭐⭐ NO CURSOR ON DISK', !Object.keys(doc.leaves).some((k) => k.includes('pointer')),
    JSON.stringify(Object.keys(doc.leaves).filter((k) => k.includes('pointer'))));
  check('…and the durable neighbour written in the same breath IS on disk, so this is a filter and not a stalled dump',
    leaf(doc, ORDER + '/round') === 5);
});

test('0720 RUN-C C1.7 — ⛔ RESTORE OVERWRITES, IT DOES NOT DELETE', async () => {
  /*
   * A key present in the live store and absent from the file is LEFT ALONE. At boot the only such
   * keys are the defaults a plugin has just seeded, and deleting those would be a restore that
   * dismantles the deployment it restores into.
   * ⛔ This is therefore NOT the authoritative-list mechanism — `app/board-document.mjs` is, and
   *   its contract is the opposite one (omission DELETES). Different jobs, different files.
   */
  B.apply({ path: BOARD + '/seeded-after-the-capture', verb: 'set', value: { id: 'seeded-after-the-capture', px: 0.5 } }, SYS);
  const doc = onDisk();
  check('the capture on disk predates it', !(BOARD + '/seeded-after-the-capture/px' in doc.leaves));
  B.durableState.restore();
  check('⭐ the un-captured key survives the restore', !!B.store.get(BOARD + '/seeded-after-the-capture'));
});

test('0720 RUN-C C1.8 — ⛔ UNCONFIGURED ⇒ INERT, and it says so rather than skipping in silence', async () => {
  const bare = await createServer({ port: 0 });
  try {
    check('a bare createServer() is not durable — this is what keeps the suite out of real state',
      bare.durableState.configured === false, JSON.stringify(bare.durableState.status()));
    check('…and has no file at all', bare.durableState.file === null);
    bare.apply({ path: BOARD + '/x', verb: 'set', value: { id: 'x' } }, SYS);
    bare.durableState.flushSync();
    check('a flush on an inert store writes nothing and throws nothing', bare.durableState.status().writes === 0);
  } finally { await bare.close(); }
});

test('0720 RUN-C C1.9 — ⛔ THE THREE SUBTREES ARE THE CONTRACT: narrowing what is persisted must go RED', async () => {
  /*
   * F18 in one assertion. A future change that persists only the board would pass every other test
   * in this file that reads the board — and would leave the session lost. So the prefix list is
   * asserted directly, by the two things the gate names.
   */
  const paths = B.durableState.paths;
  check('the collaborative surface is persisted (board + turn order live under it)', paths.includes('shared'), JSON.stringify(paths));
  check('⛔ AND the machine state is too — damage is the half a board-only gate abandons', paths.includes('ships'), JSON.stringify(paths));

  const doc = onDisk();
  const heads = new Set(Object.keys(doc.leaves).map((k) => k.split('/')[0]));
  check('the file itself carries both, not merely the config', heads.has('shared') && heads.has('ships'), JSON.stringify([...heads]));
});

test('0720 RUN-C C1.10 — ⛔ THE RESTORE IS THE LAST WRITE: a plugin\'s opening defaults do NOT overwrite the session', async () => {
  /*
   * ⛔ AN ORDERING BUG THAT REPORTS SUCCESS. A plugin writes its opening defaults during
   * `register`. Restore before that, and the defaults land on top: the restore applies every leaf,
   * counts them, logs a clean boot — and the board is back at its opening layout anyway. Nothing
   * anywhere is an error. Last write wins, so the restore has to BE the last write.
   *
   * The fixture plugin seeds one value under a persisted prefix, so the two writers are in direct
   * competition and only the order decides.
   */
  const SEED = 'shared/runc-order/who';
  const dir = makePluginsDir({
    'runc-seed': {
      'plugin.json': { name: 'runc-seed', requires: [], components: [], presets: {}, fieldSchemas: {}, server: 'server.mjs' },
      'server.mjs': `export function register(ctx) { ctx.store.apply({ path: '${SEED}', verb: 'set', value: 'plugin-default' }); }\n`,
    },
  });
  const d2 = mkdtempSync(join(tmpdir(), 'ap-runc-order-'));
  await withPlugins(dir, async () => {
    const one = await createServer({ port: 0, stateDir: d2, ...FAST });
    check('the plugin seeded its default', one.store.get(SEED) === 'plugin-default');
    one.apply({ path: SEED, verb: 'set', value: 'what-happened-in-play' }, SYS);   // the session moves on
    await poll(() => existsSync(join(d2, DURABLE_STATE_FILE)), 'the capture to land');
    one.durableState.flushSync();
    await one.close();

    const two = await createServer({ port: 0, stateDir: d2, ...FAST });
    check('⭐ THE SESSION WON, NOT THE PLUGIN DEFAULT — the restore ran after register',
      two.store.get(SEED) === 'what-happened-in-play', JSON.stringify(two.store.get(SEED)));
    await two.close();
  });
  try { rmSync(d2, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }
});

test('0720 RUN-C C1.Z — teardown', async () => {
  if (B) await B.close();
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* a scratch dir */ }
  check('the scratch state directory is gone', !existsSync(FILE));
});
