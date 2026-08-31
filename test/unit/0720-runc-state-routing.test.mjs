/*
 * Plan 0720 RUN C / C2 — WHERE THE STATE FILE GOES, AND WHAT NEVER GOES INTO IT.
 *
 * ⛔ THE FINDING THIS FILE GUARDS (F17). The live deployment sets
 * `PRESENTER_DATA_DIR=/srv/argus/shared/state`, and the obvious implementation writes the state
 * file THERE. That puts it at the ROOT of the data tree — a second state location the estate's
 * routing table does not know about, invisible to every tool that asks the router where things
 * are. The table's row is `persist state → {dataRoot}/campaigns/{campaign}/state`, and `t2` below
 * asserts the routed answer BY CONTRAST with the literal one, because a test that only checks the
 * routed path would still pass if somebody appended the right suffix for the wrong reason.
 *
 * ⛔ Core cannot READ the table — it lives in another repository and is delivered by a plugin,
 * and this repo must run with no plugins at all (t0514-28). So the rows are FOLLOWED, and these
 * tests are what keeps the two readers in agreement.
 *
 * The second half covers the omissions: what a dump refuses to carry OUT, and what a restore
 * refuses to carry back IN. Both directions, because a hand-edited or older file is a real input.
 *
 * ⛔ DOMAIN-FREE FIXTURES (PSS t0531-01): this repo is public.
 */
import { test, expect, check } from '../../harness/test.mjs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  resolveStateDir, resolveStateFile, resolveStatePaths, normaliseStatePath,
  flattenSubtree, dumpState, restoreOps, lockedAncestor,
  DURABLE_STATE_FILE, DURABLE_STATE_FORMAT, DEFAULT_STATE_PATHS, UNDECLARED_CAMPAIGN, undeclaredStateReason,
  STATE_DIR_ENV, CAMPAIGN_DIR_ENV, DATA_DIR_ENV, CAMPAIGN_ID_ENV,
} from '../../lib/durable-state.mjs';
import { createStore, isEphemeral } from '../../app/state.mjs';

/* The routing table's own row, spelled once here so a reader can compare it to the assertions.
 *   @root  dataRoot  $PRESENTER_DATA_DIR  $HOME/.local/state/argus-presenter
 *   @route persist   campaign  {dataRoot}/campaigns/{campaign}
 *   @route persist   state     {dataRoot}/campaigns/{campaign}/state          */
const ROW = (dataRoot, campaign) => join(dataRoot, 'campaigns', campaign, 'state');

test('0720 RUN-C C2.1 — ⛔ the DATA ROOT ITSELF IS NEVER THE ANSWER: the row is followed down to campaigns/<c>/state', async () => {
  const env = { [DATA_DIR_ENV]: '/srv/argus/shared/state' };
  const r = resolveStateDir({ env });
  check('⛔ NOT the literal dataRoot — that is the unrouted second state location (F17)',
    r.stateDir !== '/srv/argus/shared/state', r.stateDir);
  check('⭐ it is the table\'s `persist state` row', r.stateDir === ROW('/srv/argus/shared/state', UNDECLARED_CAMPAIGN), r.stateDir);
  check('and the rung that decided is NAMED, so a deployment can see which knob spoke',
    r.stateDirSource === DATA_DIR_ENV, r.stateDirSource);
  check('the file sits inside that directory', resolveStateFile({ env }).stateFile === join(r.stateDir, DURABLE_STATE_FILE));
});

test('0720 RUN-C C2.2 — the four rungs, most specific first, each naming itself', async () => {
  const all = {
    [STATE_DIR_ENV]: '/named/outright',
    [CAMPAIGN_DIR_ENV]: '/a/campaigns/c1',
    [DATA_DIR_ENV]: '/data',
    [CAMPAIGN_ID_ENV]: 'c1',
  };
  check('1. an explicitly named state directory wins outright',
    resolveStateDir({ env: all }).stateDir === '/named/outright');

  const { [STATE_DIR_ENV]: _s, ...noState } = all;
  const r2 = resolveStateDir({ env: noState });
  check('2. a declared campaign root is the table\'s row offset by one segment (`persist state` = `persist campaign` + /state)',
    r2.stateDir === join('/a/campaigns/c1', 'state'), r2.stateDir);
  check('   …and says so', r2.stateDirSource === CAMPAIGN_DIR_ENV);

  const { [CAMPAIGN_DIR_ENV]: _c, ...noCampaignDir } = noState;
  const r3 = resolveStateDir({ env: noCampaignDir });
  check('3. dataRoot + the whole row, with the declared campaign slot',
    r3.stateDir === ROW('/data', 'c1'), r3.stateDir);
  check('   …and the campaign is reported, not swallowed', r3.campaign === 'c1');

  const r4 = resolveStateDir({ env: { HOME: '/home/x' } });
  check('4. the built-in default is the table\'s OWN fallback dataRoot (~/.local/state/argus-presenter)',
    r4.stateDir === ROW('/home/x/.local/state/argus-presenter', UNDECLARED_CAMPAIGN), r4.stateDir);
  check('   …flagged `built-in`, because "nobody declared where this lives" is a warning',
    r4.stateDirSource === 'built-in' && r4.campaign === UNDECLARED_CAMPAIGN);
  check('   …and XDG_STATE_HOME still moves it, as it does for the session log',
    resolveStateDir({ env: { HOME: '/home/x', XDG_STATE_HOME: '/xdg' } }).stateDir
      === ROW('/xdg/argus-presenter', UNDECLARED_CAMPAIGN));
  check('   …and with no HOME at all it still resolves rather than throwing',
    typeof resolveStateDir({ env: {} }).stateDir === 'string'
      && resolveStateDir({ env: {} }).stateDir.startsWith(homedir()));
});

test('0720 RUN-C C2.2b — ⛔⛔ "NOBODY DECLARED A LOCATION" MEANS WRITE NOTHING, NOT WRITE HERE', async () => {
  /*
   * ⛔⛔ THE BUG THIS EXISTS TO PREVENT WAS SHIPPED AND MEASURED ON THIS BRANCH, and it is the most
   * expensive thing this run produced. The built-in rung needs NO environment variable, so a launch
   * path that took `stateDir` unconditionally enabled persistence EVERYWHERE this code runs. Inside
   * the suite, every `presenter_start` then shared ONE file under the real `~/.local/state` and
   * restored each other's state — it took out two of RUN B's tests by handing one test the previous
   * test's board, and the file really did appear in the home directory:
   *     ~/.local/state/argus-presenter/campaigns/default/state/durable-state.json   21716 bytes
   * On the live box that same path is the DEPLOYMENT'S OWN STATE, so running the suite there would
   * have edited the session in progress.
   *
   * ⚠ Clearing the env in the harness did NOT fix it, and that is the lesson: the fallback needed no
   *   env var to fire. The fix has to be at the decision, not at the input.
   * ⭐ And it matches the estate's own doctrine (0718 D2): `default` is a WARNING, not a normal
   *   state. The right answer to "nobody said where this lives" is to say so and write nothing.
   */
  check('⛔ nothing declared ⇒ declared:false', resolveStateDir({ env: { HOME: '/home/x' } }).declared === false);
  check('…and it hands back a REASON a banner can print',
    /does NOT survive a restart/.test(undeclaredStateReason(resolveStateDir({ env: { HOME: '/home/x' } })) || ''));
  check('the routed path is still returned — a caller that has decided to persist needs somewhere routed',
    resolveStateDir({ env: { HOME: '/home/x' } }).stateDir.endsWith(join('campaigns', UNDECLARED_CAMPAIGN, 'state')));
  for (const [name, env] of [
    [DATA_DIR_ENV, { [DATA_DIR_ENV]: '/d' }],
    [CAMPAIGN_DIR_ENV, { [CAMPAIGN_DIR_ENV]: '/c' }],
    [STATE_DIR_ENV, { [STATE_DIR_ENV]: '/s' }],
  ]) {
    check(`⭐ ${name} IS a declaration`, resolveStateDir({ env }).declared === true, JSON.stringify(resolveStateDir({ env })));
    check(`   …and undeclaredStateReason says nothing about it`, undeclaredStateReason(resolveStateDir({ env })) === null);
  }

  /*
   * ⛔ AND BOTH LAUNCH PATHS MUST KEY OFF IT. A source assertion, deliberately: the failure was that
   * one call site took `.stateDir` without asking `.declared`, and no behavioural test in this repo
   * can observe presenter_start's effect on a real home directory without writing to one.
   */
  for (const f of ['../../mcp/tools.mjs', '../../app/server.mjs']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    check(`${f} never assigns stateDir from an undeclared resolve`,
      !/stateDir:\s*resolveStateDir\(\)\.stateDir|opts\.stateDir\s*=\s*resolveStateDir\(\)\.stateDir/.test(src), f);
    check(`${f} consults .declared`, /\.declared/.test(src), f);
  }
});

test('0720 RUN-C C2.3 — the persisted prefix list is an ALLOW list, and a bad entry cannot widen it', async () => {
  check('the built-in default covers the board AND the machine state (a board-only gate leaves the session lost)',
    DEFAULT_STATE_PATHS.includes('shared') && DEFAULT_STATE_PATHS.includes('ships'), JSON.stringify(DEFAULT_STATE_PATHS));
  check('an explicit list wins', JSON.stringify(resolveStatePaths({ statePaths: ['alpha'] })) === '["alpha"]');
  check('the env form is comma-separated and de-duplicated',
    JSON.stringify(resolveStatePaths({ statePaths: null, env: { PRESENTER_STATE_PATHS: 'a, b ,a' } })) === '["a","b"]');
  check('⛔ a nested path is NOT a top-level prefix and is refused', normaliseStatePath('shared/tactical') === null);
  check('⛔ nor is a host key, which would make `_locks` a persisted subtree', normaliseStatePath('_locks') === null);
  check('⛔ nor a traversal or a prototype key', normaliseStatePath('..') === null && normaliseStatePath('__proto__') === null);
  check('an all-garbage list falls back to the default rather than persisting NOTHING in silence',
    JSON.stringify(resolveStatePaths({ statePaths: ['..', '_x'] })) === JSON.stringify(DEFAULT_STATE_PATHS));
});

test('0720 RUN-C C2.4 — ⛔ the dump refuses to carry host bookkeeping OUT', async () => {
  const tree = {
    tokens: {
      a: { id: 'a', px: 0.5, lock: 'ann', force: true },
      b: { id: 'b', px: 0.1 },
      _locks: { px: 'ann' },
    },
    empty: {},
    list: [1, 2, 3],
    n: null,
  };
  const flat = flattenSubtree(tree, 'shared', {}, isEphemeral);
  const keys = Object.keys(flat);
  check('⛔ no record lock — a restored lock owns a path for somebody who is not connected',
    !keys.some((k) => k.endsWith('/lock')), JSON.stringify(keys));
  check('⛔ no `force` — `set` clones the value into the tree and it would brand the record forever',
    !keys.some((k) => k.endsWith('/force')), JSON.stringify(keys));
  check('⛔ no `_`-prefixed host map', !keys.some((k) => k.includes('_locks')), JSON.stringify(keys));
  check('the real leaves survive', flat['shared/tokens/a/px'] === 0.5 && flat['shared/tokens/b/id'] === 'b');
  check('⚠ an ARRAY is a leaf, not a subtree — descending would rebuild it as an object with numeric keys',
    Array.isArray(flat['shared/list']) && flat['shared/list'].length === 3, JSON.stringify(flat['shared/list']));
  check('an emptied collection survives as empty rather than vanishing', JSON.stringify(flat['shared/empty']) === '{}');
  check('null is a value, not an absence', 'shared/n' in flat && flat['shared/n'] === null);
});

test('0720 RUN-C C2.5 — ⛔ and the RESTORE refuses to carry it back IN (a file is an input, and files get hand-edited)', async () => {
  const doc = {
    v: DURABLE_STATE_FORMAT,
    leaves: {
      'shared/t/a/px': 0.5,
      'shared/t/a/lock': 'ann',          // an older build, or a hand edit
      'shared/t/a/force': true,
      'shared/t/_locks/px': 'ann',
      'polls/p1/results': { evil: 1 },   // outside the declared prefixes entirely
      'ships/h1/damage/hull': 4,
    },
  };
  const ops = restoreOps(doc, ['shared', 'ships'], isEphemeral);
  const paths = ops.map((o) => o.path);
  check('⛔ nothing outside a declared prefix is written, whatever the file says',
    !paths.some((p) => p.startsWith('polls')), JSON.stringify(paths));
  check('⛔ no lock, no force, no host map comes back',
    !paths.some((p) => /(^|\/)(lock|force|_locks)(\/|$)/.test(p)), JSON.stringify(paths));
  check('the real leaves do', paths.includes('shared/t/a/px') && paths.includes('ships/h1/damage/hull'));
  check('every op is a `set` — one leaf, one write', ops.every((o) => o.verb === 'set'));
  check('and none of them carries a `force` flag in its VALUE',
    ops.every((o) => !(o.value && typeof o.value === 'object' && 'force' in o.value)));
});

test('0720 RUN-C C2.5b — ⛔⛔ AN EPHEMERAL MUTATES THE TREE, so the DUMP has to drop it too', async () => {
  /*
   * ⛔ THE MEASURED TRAP. `app/state.mjs` `apply` runs the REDUCER and only then returns early for
   * a pointer/laser op — so the op never reaches the op log (and never schedules a write) but the
   * value IS in the tree. `shared/pointer` sits under a persisted prefix, so the next durable op
   * dumps every connected viewer's cursor, and a restart restores a room full of cursors belonging
   * to nobody. Measured before this filter existed:
   *     POINTER ON DISK: shared/pointer/uz/x, shared/pointer/uz/y
   */
  const store = createStore();
  const SYS = { userId: 'server', role: 'system' };
  const r = store.apply({ path: 'shared/pointer/uz', verb: 'set', value: { x: 0.1, y: 0.2 } }, SYS);
  check('the op IS flagged ephemeral…', r && r.ephemeral === true);
  check('…and yet the value is really in the tree — this is the half that surprises',
    store.get('shared/pointer/uz/x') === 0.1, JSON.stringify(store.get('shared/pointer')));

  store.apply({ path: 'shared/keep', verb: 'set', value: 1 }, SYS);
  const doc = dumpState(store, ['shared'], isEphemeral);
  check('⭐ NO CURSOR ON DISK', !Object.keys(doc.leaves).some((k) => k.includes('pointer')), JSON.stringify(Object.keys(doc.leaves)));
  check('…and the durable neighbour is still there, so this is a filter and not a blanket refusal', doc.leaves['shared/keep'] === 1);
  check('⛔ and a file written by an older build cannot smuggle one back in',
    restoreOps({ v: DURABLE_STATE_FORMAT, leaves: { 'shared/pointer/uz/x': 0.1, 'shared/laser/uz': 1, 'shared/keep': 1 } }, ['shared'], isEphemeral)
      .map((o) => o.path).join(',') === 'shared/keep');
});

test('0720 RUN-C C2.5c — ⛔ THE PREDICATE IS REQUIRED: there is no default to silently diverge from', async () => {
  /*
   * `lib/` never imports from `app/` (one-way dependency, and `lib/` is partly browser-served), so
   * the store's own `isEphemeral` is handed IN. A built-in default here would be a second
   * definition of "ephemeral" that stops agreeing the day somebody adds a third segment — and it
   * would stop agreeing SILENTLY, by persisting something. So there is none, and the omission is
   * loud.
   */
  let threw = null;
  try { dumpState(createStore(), ['shared']); } catch (e) { threw = e; }
  check('dumpState without it throws', threw instanceof TypeError, String(threw));
  check('…and the message says what to pass', /isEphemeralPath/.test(String(threw && threw.message)));
  const src = readFileSync(new URL('../../lib/durable-state.mjs', import.meta.url), 'utf8');
  check('⛔ and the module still does not reach into app/ to get it',
    !/from\s+'\.\.\/app\//.test(src), 'lib/durable-state.mjs imports from app/');
});

test('0720 RUN-C C2.6 — a round trip through the store reproduces the tree', async () => {
  const store = createStore();
  const SYS = { userId: 'server', role: 'system' };
  store.apply({ path: 'shared/t/a', verb: 'set', value: { id: 'a', px: 0.11, tags: ['x', 'y'] } }, SYS);
  store.apply({ path: 'shared/round', verb: 'set', value: 3 }, SYS);
  store.apply({ path: 'ships/h1/damage/hull', verb: 'set', value: 7 }, SYS);
  store.apply({ path: 'presence/nobody', verb: 'set', value: 1 }, SYS);     // NOT a declared prefix
  const doc = dumpState(store, ['shared', 'ships'], isEphemeral);
  check('the document names its format and its prefixes', doc.v === DURABLE_STATE_FORMAT && doc.paths.length === 2);
  check('⛔ an undeclared prefix is simply not in it',
    !Object.keys(doc.leaves).some((k) => k.startsWith('presence')), JSON.stringify(Object.keys(doc.leaves)));

  const fresh = createStore();
  for (const op of restoreOps(doc, ['shared', 'ships'], isEphemeral)) fresh.apply(op, SYS);
  check('the record came back whole', JSON.stringify(fresh.get('shared/t/a')) === JSON.stringify({ id: 'a', px: 0.11, tags: ['x', 'y'] }),
    JSON.stringify(fresh.get('shared/t/a')));
  check('…the array is still an array, not an object with numeric keys', Array.isArray(fresh.get('shared/t/a/tags')));
  check('the scalar came back', fresh.get('shared/round') === 3);
  check('and so did the machine state', fresh.get('ships/h1/damage/hull') === 7);
});

test('0720 RUN-C C2.7 — ⛔⛔ `unlock` ALONE CANNOT BREAK A LOCK, AND THE BRIEF SAID IT COULD', async () => {
  /*
   * The inherited rule is "break a lock with `unlock`, never `{force:true}`". Taken literally it
   * does not work: the lock check in `app/state.mjs` `apply` runs BEFORE the reducer and covers
   * every verb, `unlock` included. A Generator following it to the letter ships a restore that
   * silently skips every locked record. What actually matters is which verb CLONES its value into
   * the tree — `set` does, `unlock` does not — so `unlock` + `{force:true}` breaks the lock and
   * stores nothing.
   */
  const store = createStore();
  const SYS = { userId: 'server', role: 'system' };
  const ANN = { userId: 'ann', role: 'participant' };
  store.apply({ path: 'shared/t/a', verb: 'set', value: { id: 'a', px: 0.5 } }, ANN);
  store.apply({ path: 'shared/t/a', verb: 'lock' }, ANN);

  check('a system write under someone else\'s lock is refused',
    store.apply({ path: 'shared/t/a/px', verb: 'set', value: 0.9 }, SYS) === null);
  check('⛔ AND SO IS A PLAIN `unlock` — this is the claim that was wrong',
    store.apply({ path: 'shared/t/a', verb: 'unlock' }, SYS) === null);
  check('   …the lock is still held', store.lockOwnerFor('shared/t/a') === 'ann');

  check('`lockedAncestor` finds WHERE to unlock (lockOwnerFor only answers WHO)',
    lockedAncestor(store, 'shared/t/a/px') === 'shared/t/a', lockedAncestor(store, 'shared/t/a/px'));
  const u = store.apply({ path: 'shared/t/a', verb: 'unlock', value: { force: true } }, SYS);
  check('⭐ `unlock` + {force:true} DOES break it', u && u.diff && u.diff['shared/t/a/lock'] === null, JSON.stringify(u));
  check('…and stores NOTHING: no `force` key was cloned into the record',
    !('force' in store.get('shared/t/a')), JSON.stringify(store.get('shared/t/a')));
  check('…so the restore write now lands', store.apply({ path: 'shared/t/a/px', verb: 'set', value: 0.9 }, SYS) !== null);
  check('…and the record is clean', JSON.stringify(store.get('shared/t/a')) === JSON.stringify({ id: 'a', px: 0.9 }),
    JSON.stringify(store.get('shared/t/a')));
});

test('0720 RUN-C C2.8 — a LEAF lock lives in a sibling map, and lockedAncestor points at the leaf', async () => {
  const store = createStore();
  const ANN = { userId: 'ann', role: 'participant' };
  store.apply({ path: 'shared/t/b', verb: 'set', value: { id: 'b', name: 'K' } }, ANN);
  store.apply({ path: 'shared/t/b/name', verb: 'lock' }, ANN);
  check('the lock is at <parent>/_locks/<leaf>, not on the value', store.get('shared/t/b/_locks/name') === 'ann');
  check('the value is untouched (0691: locking a scalar used to destroy it)', store.get('shared/t/b/name') === 'K');
  check('lockedAncestor names the LEAF, which is what `unlock` expects',
    lockedAncestor(store, 'shared/t/b/name') === 'shared/t/b/name', lockedAncestor(store, 'shared/t/b/name'));
  check('and a sibling leaf is not blocked by it', lockedAncestor(store, 'shared/t/b/id') === null);
});
