/*
 * lib/durable-state.mjs — THE LIVE STATE SURVIVES A RESTART.  Plan 0720 RUN C (F18).
 * SERVER-SIDE ONLY (touches the filesystem). Nothing here reaches the browser.
 *
 * ── ⛔⛔ WHY THIS EXISTS, AND WHY IT IS NOT A FEATURE ────────────────────────────────────────
 *
 * `app/state.mjs` `createStore()` builds a plain object tree and nothing has ever written it
 * anywhere. The CI on this estate auto-deploys within ~60 s of a push and restarts the service.
 * ⇒ ONE PUSH DESTROYS A LIVE SESSION: every piece anyone has moved, the turn order, who has
 * acted this round, and every point of damage taken.
 *
 * ⚠ THE TRAP IS THE REFLEX. The stated principle for the board is *"a mistake is correctable
 *   while play runs"*, and the reflex for correcting one is **push a fix** — the exact act that
 *   destroys the session it was meant to rescue.
 *
 * ── ⭐ GENERIC, NOT PER-FEATURE. THIS IS THE WHOLE DESIGN. ───────────────────────────────────
 *
 * There is no board code here, no turn-order code, no damage code. It dumps a set of top-level
 * STORE PREFIXES leaf by leaf and writes them back leaf by leaf. Anything added under one of
 * those prefixes later is durable the day it is written, with no change to this file — which is
 * the difference between a mechanism and a list of features somebody has to remember to extend.
 *
 * ⛔ AND IT IS AN ALLOW LIST, NOT A DENY LIST, DELIBERATELY. A deny list persists every prefix
 *   that exists today AND every prefix added tomorrow, so the next volatile subtree somebody
 *   introduces becomes durable by default and comes back as ghosts after a restart. Measured
 *   here: a plugin on this estate declares a top-level `shipPresence` prefix — a map of who is
 *   LOOKING at what, live — and an obvious "persist everything a plugin declared readable"
 *   heuristic would have restored that map with nobody connected. An allow list fails safe.
 *
 * ── ⛔ WHAT IS NOT PERSISTED, AND WHY EACH OMISSION IS A DECISION ────────────────────────────
 *
 * 1. HOST BOOKKEEPING — any key beginning `_` (the leaf-lock map `<parent>/_locks/<leaf>`) and the
 *    record-lock field `<record>/lock`. ⛔ A LOCK IS A CLAIM BY A CONNECTED CLIENT. After a
 *    restart nobody holds anything, and a restored lock would hand a path to a person who is not
 *    in the room — refusing every later write by the person who IS, with no error and no owner to
 *    ask. `app/state.mjs` enforces locks now (0691), so this is not cosmetic: a stale lock is a
 *    field nobody can edit for the rest of the session.
 *
 * 2. `force` — `app/state.mjs` reads it off an op's VALUE to break a lock, and `set` CLONES THE
 *    VALUE INTO THE TREE. A record carrying `force:true` therefore brands itself with "somebody
 *    once forced this write" for the rest of the session, and every client carries it onward
 *    through read → drag → re-read. RUN B measured this. It is stripped on the way out AND on the
 *    way back in. ⛔ NEVER on a restore `set`. See `lockedAncestor` for where it IS used and why
 *    that use is safe.
 *
 * 3. ⛔⛔ EPHEMERALS — AND THIS ONE WAS MEASURED, NOT REASONED. `pointer` / `laser` ops return
 *    from `apply` before the op log, so they never reach `noteOp` and never SCHEDULE a write. It
 *    is tempting to stop there, and stopping there is wrong: `apply` runs the REDUCER FIRST and
 *    only then returns early, so **an ephemeral op really does mutate the tree**. `shared/pointer`
 *    lives under a persisted prefix, so the very next durable op dumps every connected viewer's
 *    cursor to disk — and a restart then restores a room full of cursors belonging to nobody.
 *    Measured on this branch: `POINTER ON DISK: shared/pointer/uz/x, shared/pointer/uz/y`.
 *    ⇒ The DUMP filters them out as well, in both directions.
 *
 *    ⛔ AND THE PREDICATE IS INJECTED, NOT COPIED. `app/state.mjs` `isEphemeral` is the one
 *    definition of what "ephemeral" means; a regex re-typed here would be a second one, and the
 *    day somebody adds a third ephemeral segment there this file would start persisting it in
 *    silence. `lib/` never imports from `app/` (the dependency runs one way, and `lib/` is partly
 *    browser-served), so the caller hands it in — and it is REQUIRED, because a default would be
 *    the silent-skip this note exists to prevent.
 *
 * ── ⛔ RESTORE OVERWRITES; IT DOES NOT DELETE ────────────────────────────────────────────────
 *
 * A key present in the live store and absent from the file is LEFT ALONE. At boot the only such
 * keys are the defaults a plugin just seeded, and deleting those would be a restore that
 * dismantles the deployment it is restoring into. ⛔ This is therefore NOT the authoritative-list
 * mechanism — `app/board-document.mjs` is, and it is a different job with a different contract
 * (omission DELETES). Generic dump for crash-safety; a defined serialiser for interchange.
 *
 * ── ⛔ THE DEBOUNCE HAS A MAXIMUM DELAY, NOT ONLY A QUIET PERIOD ─────────────────────────────
 *
 * A plain trailing debounce is reset by every change, so an UNBROKEN stream of changes starves
 * the write forever. On this system the unbroken stream is somebody dragging a piece across the
 * board — i.e. the failure lands during the busiest minute of the session, which is the minute
 * whose loss costs most. `maxMs` caps the age of the oldest unwritten change, so the write
 * happens on a schedule no burst can push back.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

/** The file, inside the resolved state directory. */
export const DURABLE_STATE_FILE = 'durable-state.json';

/** Bumped only for a breaking change in the on-disk shape. An older/newer file is ignored, loudly. */
export const DURABLE_STATE_FORMAT = 1;

/*
 * ── ⛔ C2 — WHERE THE FILE GOES, AND WHY NOT THE OBVIOUS PLACE ───────────────────────────────
 *
 * The live deployment sets `PRESENTER_DATA_DIR=/srv/argus/shared/state`. Writing the file
 * literally THERE puts it at the ROOT of the data tree, which the estate's routing table
 * (`repertory/tools/pss/routes.tsv`) does not know about — a second state location, invisible to
 * every tool that asks the router where things are, and outside the invariant the router exists
 * to enforce.
 *
 * The table's row is:
 *     @route  persist  state     {dataRoot}/campaigns/{campaign}/state
 *     @route  persist  campaign  {dataRoot}/campaigns/{campaign}
 *     @root   dataRoot  $PRESENTER_DATA_DIR  $HOME/.local/state/argus-presenter
 *
 * ⭐ NOTE THE FALLBACK: the router's built-in `dataRoot` is `~/.local/state/argus-presenter`,
 *   which is the SAME directory this repo's own session log already defaults into. The two
 *   conventions already agree at the root; this resolver only follows the row down from there.
 *
 * ⛔ AND CORE CANNOT READ THE TABLE. `routes.tsv` lives in another repository and is delivered by
 *   a plugin; this repo ships no plugins and must run with none (`t0514-28`). So the rows are
 *   FOLLOWED here, not parsed — and every rung of the chain below lands on a path the router can
 *   `--unroute` back to `persist/state`, which is the property that matters.
 *
 *   1. `$PRESENTER_STATE_DIR`     — the directory named outright. A router-aware deployment sets
 *                                   this from `pss.py --ensure persist state`, and then nothing
 *                                   here is guessing at all.
 *   2. `$PRESENTER_CAMPAIGN_DIR`  — an existing, already-honoured declaration of the campaign
 *                                   root. `persist state` is `persist campaign` + `/state`, so
 *                                   this rung IS the table's row, offset by one segment.
 *   3. `$PRESENTER_DATA_DIR`      — the table's `dataRoot`; the rest of the row is spelled out.
 *   4. the built-in default       — `~/.local/state/argus-presenter`, the table's own fallback.
 *
 * ⚠ THE `{campaign}` SLOT IS THE ONE THING CORE CANNOT KNOW. It is a deployment's own name for
 *   its own data, so rungs 3 and 4 read `$PRESENTER_CAMPAIGN_ID` and fall back to `default`.
 *   ⛔ `default` IS A WARNING, NOT A NORMAL STATE: nothing declared a location, so two boxes on
 *   the same commit legitimately hold different state. `resolveStateDir` reports which rung won
 *   so a deployment can say so out loud instead of discovering it later.
 */
export const STATE_DIR_ENV = 'PRESENTER_STATE_DIR';
export const CAMPAIGN_DIR_ENV = 'PRESENTER_CAMPAIGN_DIR';
export const DATA_DIR_ENV = 'PRESENTER_DATA_DIR';
export const CAMPAIGN_ID_ENV = 'PRESENTER_CAMPAIGN_ID';

/** ⛔ A warning, not a normal state — see above. */
export const UNDECLARED_CAMPAIGN = 'default';

/**
 * The top-level store prefixes that survive a restart, and the ONLY domain-shaped constant here.
 *
 * ⚠ `ships` is a STORE PREFIX, not a concept this repo understands: core has no idea what lives
 *   under it and never reads it back. It is here because damage is play state and losing it is
 *   the half of the failure a board-only fix leaves behind — a gate that passes while the session
 *   is still lost. Overridable per deployment (`$PRESENTER_STATE_PATHS`, or the `statePaths`
 *   option) so a deployment with other durable prefixes is not obliged to patch core.
 */
export const DEFAULT_STATE_PATHS = Object.freeze(['shared', 'ships']);
export const STATE_PATHS_ENV = 'PRESENTER_STATE_PATHS';

/** Debounce: write once the changes go quiet, and NEVER later than `maxMs` after the first one. */
export const DURABLE_STATE_DEFAULTS = Object.freeze({ quietMs: 750, maxMs: 5000 });

const trimmed = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;

/** True for a key that belongs to the host's bookkeeping and never to the session's state. */
export function isHostKey(k) { return typeof k === 'string' && k.charAt(0) === '_'; }

/** True for a record FIELD the dump must never carry out or back in. See omissions 1 and 2 above. */
export function isHostField(k) { return k === 'lock' || k === 'force'; }

/** A single top-level prefix, or null if it is not one. ⛔ No slashes: these address whole subtrees. */
export function normaliseStatePath(p) {
  const s = trimmed(p);
  if (!s || s.includes('/')) return null;
  if (isHostKey(s) || s === '.' || s === '..' || s === '__proto__' || s === 'prototype' || s === 'constructor') return null;
  return s;
}

/** The configured prefix list: explicit > env > built-in default. Always at least one entry. */
export function resolveStatePaths({ statePaths = null, env = process.env } = {}) {
  const raw = Array.isArray(statePaths) && statePaths.length
    ? statePaths
    : (trimmed(env[STATE_PATHS_ENV]) || '').split(',');
  const out = [];
  for (const p of raw) { const n = normaliseStatePath(p); if (n && !out.includes(n)) out.push(n); }
  return out.length ? out : DEFAULT_STATE_PATHS.slice();
}

/**
 * Where this deployment's durable state lives, WHICH RUNG SAID SO, and — the load-bearing part —
 * whether ANYTHING ACTUALLY SAID IT.
 * → { stateDir, stateDirSource, campaign, declared }
 *
 * ⛔⛔ `declared:false` MEANS "DO NOT PERSIST", NOT "PERSIST HERE", AND THAT DISTINCTION IS THE
 * WHOLE REASON THIS FLAG EXISTS. The built-in rung needs NO environment variable, so a launch path
 * that just took `stateDir` unconditionally would enable persistence on every machine that runs
 * this code — including inside the test suite, where hundreds of servers would then share ONE file
 * under the real `~/.local/state`, restoring each other's state. That is not hypothetical: it was
 * shipped and measured on this branch, and it took out two of RUN B's tests by handing one test the
 * previous test's board. On the live box the same file is the DEPLOYMENT'S OWN STATE, so running
 * the suite there would have edited the session that was in progress.
 *
 * ⚠ AND IT MATCHES THE ESTATE'S OWN DOCTRINE (0718 D2): `default` is a WARNING, not a normal
 *   state — nothing declared a location, so two boxes on the same commit legitimately hold
 *   different state. The right response to "nobody said where this lives" is to say so and write
 *   nothing, not to invent an answer.
 *
 * The built-in path is still RETURNED, because it is the routing table's own fallback and a caller
 * that has decided to persist anyway needs somewhere routed to put it. It is just never the reason
 * to start.
 *
 * ⚠ Never throws: a resolver that can refuse to let the server start is worse than none.
 */
export function resolveStateDir({ env = process.env } = {}) {
  const campaign = normaliseStatePath(env[CAMPAIGN_ID_ENV]) || UNDECLARED_CAMPAIGN;
  const named = trimmed(env[STATE_DIR_ENV]);
  if (named) return { stateDir: resolve(named), stateDirSource: STATE_DIR_ENV, campaign: null, declared: true };
  const campaignDir = trimmed(env[CAMPAIGN_DIR_ENV]);
  if (campaignDir) return { stateDir: resolve(campaignDir, 'state'), stateDirSource: CAMPAIGN_DIR_ENV, campaign: null, declared: true };
  const dataDir = trimmed(env[DATA_DIR_ENV]);
  const dataRoot = dataDir
    ? resolve(dataDir)
    : join(trimmed(env.XDG_STATE_HOME) || join(trimmed(env.HOME) || homedir(), '.local', 'state'), 'argus-presenter');
  return {
    stateDir: join(dataRoot, 'campaigns', campaign, 'state'),
    stateDirSource: dataDir ? DATA_DIR_ENV : 'built-in',
    campaign,
    declared: !!dataDir,
  };
}

/** The one-line reason a deployment is NOT durable, or null when it is. For a startup banner. */
export function undeclaredStateReason(t) {
  if (!t || t.declared) return null;
  return `no state directory declared — the live session does NOT survive a restart. Set $${DATA_DIR_ENV} (the routing table's dataRoot), $${CAMPAIGN_DIR_ENV}, or $${STATE_DIR_ENV}.`;
}

/** The full path to the state file this deployment would use. */
export function resolveStateFile({ env = process.env } = {}) {
  const r = resolveStateDir({ env });
  return { ...r, stateFile: join(r.stateDir, DURABLE_STATE_FILE) };
}

/*
 * ── THE DUMP ────────────────────────────────────────────────────────────────────────────────
 * A LEAF is anything that is not a plain object: a scalar, an array, null. An EMPTY plain object
 * is also a leaf, so a collection somebody emptied comes back empty rather than absent.
 * ⚠ Arrays are leaves on purpose. Descending into one would emit `list/0`, `list/1`… and the
 *   store would rebuild it as an OBJECT with numeric keys — the same value, a different type, and
 *   every `.map` on the client silently gone.
 */
function isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

/** ⛔ The one predicate, always supplied by the caller. See omission 3. */
function requireEphemeralPredicate(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError(
      'durable-state needs `isEphemeralPath` — pass `isEphemeral` from app/state.mjs.\n'
      + '   Without it, pointer and laser positions are dumped to disk and restored after a\n'
      + '   restart as cursors belonging to nobody. There is deliberately no default: a copied\n'
      + '   regex here would silently diverge from the store\'s own definition.');
  }
  return fn;
}

/**
 * Flatten one subtree into `{ 'a/b/c': leaf }`, skipping host keys, host fields and ephemerals.
 * Exported for the tests: this is where every omission decision is actually enforced.
 */
export function flattenSubtree(root, prefix, out = {}, isEphemeralPath = null) {
  const eph = requireEphemeralPredicate(isEphemeralPath);
  /* ⛔ ONE GUARD, AT THE TOP, AND IT IS DELIBERATELY THE ONLY ONE. An earlier draft ALSO checked
     each child before recursing — and the falsifiability sweep proved that check dead: breaking it
     turned nothing red, because every recursion re-enters here and is caught anyway. Two guards for
     one rule is worse than one: the redundant copy reads as load-bearing, so the next reader keeps
     it in step for no reason, and a sweep that removes it reports a passing gate. */
  if (eph(prefix)) return out;                                // omission 3 — a cursor is not state
  if (!isPlainObject(root)) { if (root !== undefined) out[prefix] = root; return out; }
  const keys = Object.keys(root);
  if (!keys.length) { out[prefix] = {}; return out; }
  let emitted = 0;
  for (const k of keys) {
    if (isHostKey(k) || isHostField(k)) continue;             // omissions 1 and 2 — never carried
    emitted++;
    flattenSubtree(root[k], prefix + '/' + k, out, eph);
  }
  /* ⚠ A record whose ONLY keys were host bookkeeping is an empty record, not a missing one:
     emit the empty object so the shape survives instead of the path vanishing. */
  if (!emitted) out[prefix] = {};
  return out;
}

/**
 * Read the live store and produce the document that goes on disk.
 * @param {{get:(p:string)=>any}} store
 * @param {string[]} paths  top-level prefixes
 * @param {(p:string)=>boolean} isEphemeralPath  ⛔ required — `isEphemeral` from app/state.mjs
 */
export function dumpState(store, paths, isEphemeralPath = null) {
  const eph = requireEphemeralPredicate(isEphemeralPath);
  const leaves = {};
  for (const p of paths) {
    const sub = store.get(p);
    if (sub === undefined) continue;
    flattenSubtree(sub, p, leaves, eph);
  }
  return { v: DURABLE_STATE_FORMAT, savedAt: new Date().toISOString(), paths: paths.slice(), leaves };
}

/**
 * Turn a document back into ops, in file order. One `set` per leaf.
 * ⛔ Every op is re-filtered on the way IN as well as on the way out: a file hand-edited (or
 *   written by an older build) to carry `lock` or `force` must not be able to reintroduce either.
 */
export function restoreOps(doc, paths, isEphemeralPath = null) {
  const eph = requireEphemeralPredicate(isEphemeralPath);
  const allowed = new Set(paths);
  const ops = [];
  const leaves = doc && isPlainObject(doc.leaves) ? doc.leaves : {};
  for (const path of Object.keys(leaves)) {
    const segs = String(path).split('/').filter(Boolean);
    if (!segs.length || !allowed.has(segs[0])) continue;        // ⛔ never write outside the declared prefixes
    if (segs.some((s) => isHostKey(s) || isHostField(s))) continue;
    const p = segs.join('/');
    if (eph(p)) continue;                                       // ⛔ a file written by an older build may carry them
    ops.push({ path: p, verb: 'set', value: leaves[path] });
  }
  return ops;
}

/*
 * ── ⛔⛔ HOW A RESTORE GETS PAST A LOCK, AND THE ONE MEASUREMENT THAT SETTLES IT ─────────────
 *
 * The rule inherited from RUN B is "break locks with `unlock`, never with `{force:true}`", and
 * taken literally IT DOES NOT WORK. Measured against `app/state.mjs` on this branch:
 *
 *     apply({path:'shared/t/a', verb:'unlock'}, {userId:'server', role:'system'})   →  null
 *
 * The lock check in `apply` runs BEFORE the reducer and covers EVERY verb, `unlock` included. So
 * a plain `unlock` by anyone who is not the holder is refused exactly like a write, the restore
 * silently skips that record, and the board comes back with a hole in it.
 *
 * ⭐ THE DISTINCTION THAT ACTUALLY MATTERS IS NOT `unlock` vs `force` — IT IS WHICH VERB CLONES
 *   ITS VALUE INTO THE TREE.
 *     `set`    clones `op.value` into the tree  ⇒ `{force:true}` becomes a permanent record field.
 *     `unlock` never reads `op.value` at all    ⇒ `{force:true}` is consumed by the guard in
 *                                                 `apply` and stored NOWHERE.
 *   Measured: after `unlock` + `{force:true}` as `system`, the record is `{"id":"a","x":1}` —
 *   no `force` key, no residue, and the following `set` succeeds.
 *
 * ⇒ The lock is broken with `unlock` + `{force:true}`; the restore `set` that follows carries no
 *   `force` and never will. RUN B's rule survives intact — it just names the wrong half of the
 *   mechanism, and a Generator following it to the letter would have shipped a restore that
 *   quietly drops every locked record.
 *
 * ⚠ Breaking the lock is the right call HERE and would not be elsewhere: this runs at boot, when
 *   the holder is a userId from a process that no longer exists and nobody can release it.
 */

/**
 * The path of the nearest ancestor (or the path itself) carrying a lock, or null.
 * ⚠ Mirrors `store.lockOwnerFor`, which answers WHO but not WHERE — and it is the WHERE that has
 *   to be unlocked.
 */
export function lockedAncestor(store, path) {
  const parts = String(path).split('/').filter(Boolean);
  for (let n = parts.length; n > 0; n--) {
    const base = parts.slice(0, n).join('/');
    if (parts[n - 1] === 'lock' || parts.includes('_locks')) continue;
    if (typeof store.get(base + '/lock') === 'string' && store.get(base + '/lock')) return base;
    const head = parts.slice(0, n - 1);
    const leafLock = (head.length ? head.join('/') + '/' : '') + '_locks/' + parts[n - 1];
    if (typeof store.get(leafLock) === 'string' && store.get(leafLock)) return base;
  }
  return null;
}

/**
 * @param {object} o
 * @param {string|null} o.dir      the state directory. ⛔ null/'' ⇒ an INERT store that writes
 *                                 nothing and restores nothing. That is the LIBRARY default: the
 *                                 suite stands up hundreds of servers and none of them may read
 *                                 or write a human's real state. A deployment configures it.
 * @param {{get:Function}} o.store the live store, read for the dump.
 * @param {Function} o.apply       ⛔ THE BROADCASTING apply (`serverApply`), never `store.apply`.
 *                                 A restore that does not broadcast leaves every connected client
 *                                 showing the pre-restore board with no way to know.
 * @param {string[]} [o.paths]
 * @param {number} [o.quietMs] @param {number} [o.maxMs]
 * @param {{warn:Function,info:Function}} [o.log]
 */
export function createDurableState({ dir = null, store = null, apply = null, paths = null, isEphemeralPath = null, quietMs, maxMs, log = null } = {}) {
  const eph = requireEphemeralPredicate(isEphemeralPath);
  const configured = !!(dir && String(dir).trim());
  const root = configured ? String(dir) : null;
  const file = configured ? join(root, DURABLE_STATE_FILE) : null;
  const tmp = configured ? file + '.tmp' : null;
  const statePaths = Array.isArray(paths) && paths.length ? paths.slice() : DEFAULT_STATE_PATHS.slice();
  const QUIET = Number.isFinite(quietMs) ? Math.max(0, quietMs) : DURABLE_STATE_DEFAULTS.quietMs;
  const MAX = Number.isFinite(maxMs) ? Math.max(0, maxMs) : DURABLE_STATE_DEFAULTS.maxMs;
  const warn = (ev, d) => { if (log && log.warn) log.warn('durable-state', ev, d); };
  const info = (ev, d) => { if (log && log.info) log.info('durable-state', ev, d); };

  const stats = { writes: 0, failures: 0, restoredLeaves: 0, locksBroken: 0, skipped: 0, lastWriteAt: null };
  let timer = null;
  let firstPendingAt = null;
  let closed = false;

  /** Does this op's path fall inside a persisted prefix? */
  function watched(path) {
    const head = String(path || '').split('/').filter(Boolean)[0];
    return !!head && statePaths.includes(head);
  }

  /**
   * ⭐ THE DEBOUNCE, AND ITS CEILING. `firstPendingAt` is the age of the OLDEST unwritten change;
   * the next fire is never scheduled beyond `MAX` past it. A continuous drag therefore writes
   * every `MAX`, instead of never.
   */
  function schedule() {
    if (!configured || closed) return;
    const now = Date.now();
    if (firstPendingAt == null) firstPendingAt = now;
    const remaining = Math.max(0, MAX - (now - firstPendingAt));
    const delay = Math.min(QUIET, remaining);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, delay);
    timer.unref?.();                  // ⛔ never keep the process alive for a save
  }

  /** Called for every durable op. Ephemerals never reach here (see omission 3). */
  function noteOp(entry) {
    if (!configured || closed) return;
    if (!entry || !watched(entry.path)) return;
    schedule();
  }

  /**
   * Write the whole document, atomically. ⛔ Every failure path ends in a counter, never a throw:
   * five people are waiting, and the instrument that protects the session must not stop it.
   */
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    firstPendingAt = null;
    if (!configured || closed || !store) return false;
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify(dumpState(store, statePaths, eph)), { mode: 0o600 });
      renameSync(tmp, file);          // atomic: a reader sees the old file or the new one, never half
      stats.writes++; stats.lastWriteAt = Date.now();
      return true;
    } catch (e) {
      stats.failures++;
      warn('write-failed', { file, err: String((e && e.message) || e) });
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* nothing more to do about it */ }
      return false;
    }
  }

  /**
   * ⭐ RESTORE — leaf by leaf, through the BROADCASTING apply, as `system`.
   * ⛔ A locked path is cleared FIRST, with `unlock` + `{force:true}` — the one verb that does not
   *   clone its value into the tree. The restore `set` itself never carries `force`. See the
   *   measurement above `lockedAncestor`.
   */
  function restore() {
    const out = { present: false, applied: 0, skipped: 0, locksBroken: 0, error: null };
    if (!configured || !store || typeof apply !== 'function') return out;
    let doc = null;
    try {
      if (!existsSync(file)) return out;
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      out.error = String((e && e.message) || e);
      warn('unreadable', { file, err: out.error });
      return out;
    }
    out.present = true;
    if (!doc || doc.v !== DURABLE_STATE_FORMAT) {
      /* ⛔ LOUD, AND STILL NOT FATAL. A file this build cannot read is left exactly where it is:
         overwriting it would destroy the only copy of a session somebody may still want. */
      out.error = `unrecognised format ${doc && doc.v}, expected ${DURABLE_STATE_FORMAT}`;
      warn('format-mismatch', { file, got: doc && doc.v, expected: DURABLE_STATE_FORMAT });
      return out;
    }
    const actor = { userId: 'server', role: 'system' };
    for (const op of restoreOps(doc, statePaths, eph)) {
      const held = lockedAncestor(store, op.path);
      if (held) { apply({ path: held, verb: 'unlock', value: { force: true } }, actor); out.locksBroken++; }
      const res = apply(op, actor);
      if (res && res.diff) out.applied++; else out.skipped++;
    }
    stats.restoredLeaves += out.applied;
    stats.locksBroken += out.locksBroken;
    stats.skipped += out.skipped;
    info('restored', { file, applied: out.applied, skipped: out.skipped, locksBroken: out.locksBroken });
    /* ⛔ A PARTIAL RESTORE IS THE FAILURE MODE THAT LOOKS LIKE SUCCESS. Every op that was refused
       is a leaf the session lost, and the boot line above would otherwise read as a clean recovery
       with a smaller number in it. A refusal here means a permission or a lock the break did not
       reach — worth a warning, never worth stopping the boot. */
    if (out.skipped) warn('partial-restore', { file, applied: out.applied, skipped: out.skipped });
    return out;
  }

  return {
    configured,
    dir: root,
    file,
    paths: statePaths.slice(),
    quietMs: QUIET,
    maxMs: MAX,
    noteOp,
    restore,
    /** Write NOW, cancelling any pending debounce. Used by `close()` and by an explicit capture. */
    flushSync: flush,
    /** True while a write is owed — the property the max-delay test asserts against. */
    get pending() { return timer != null; },
    status: () => ({ configured, dir: root, file, paths: statePaths.slice(), quietMs: QUIET, maxMs: MAX, ...stats }),
    close() { const owed = timer != null; if (owed) flush(); closed = true; if (timer) { clearTimeout(timer); timer = null; } return owed; },
  };
}

/** F2s (0738, R-169). Wraps `durable.flushSync()`: forces the debounced dump to happen NOW, so a caller
 *  that must know the journal holds a change before it proceeds (a REST write gate, round-advance,
 *  SAVE) does not wait for quietMs/maxMs. Returns whatever flushSync returns: true on a completed
 *  write, false when the handle is unconfigured or the write failed. */
export function settleJournal(durable) {
  return (durable && typeof durable.flushSync === 'function') ? durable.flushSync() : false;
}
