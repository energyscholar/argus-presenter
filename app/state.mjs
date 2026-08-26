/*
 * app/state.mjs — the core session STATE STORE (pure Node, no browser).
 * A path-addressed blackboard: nested null-proto objects, addressed like
 * 'polls/p1/votes/u2'. The server is the authoritative reducer over this tree.
 *
 * Built across Plan 0435 group B:
 *   B1 base: state tree + get(path) + _setPath   (+ S4 path sanitization)
 *   B2 reducers · B3 permissions · B4 apply · B5 op-log + snapshot · B6 idempotency
 *
 * SECURITY (S4, honored from B1): paths are sanitized — no __proto__ / prototype /
 * constructor / '.' / '..' segments; the tree uses null-proto objects so a
 * path-addressed write can never pollute Object.prototype.
 */

import { createPermissions, OVERRIDE_ROLES as OVERRIDE } from './permissions.mjs';

// Reserved keys that could pollute the prototype chain (S4).
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
// Value size cap (S6/S10) — reject oversized op payloads.
const MAX_VALUE_BYTES = 64 * 1024;

/** null-prototype object — the pollution-proof node type for the tree. */
function nobj() { return Object.create(null); }

/**
 * Ephemeral ops (X2): pointer / drag / laser — high-frequency, transient. They
 * update state (so get() reflects the latest) but are NOT logged, do NOT bump the
 * durable version, and are coalesced on broadcast by the server. Detected by a
 * 'pointer' or 'laser' path segment.
 */
export function isEphemeral(path) {
  return /(^|\/)(pointer|laser)(\/|$)/.test(String(path || ''));
}

/**
 * Validate + split a path into segments, or return null if unsafe/empty.
 * Rejects prototype-pollution keys and path traversal (S4).
 */
export function sanitizePath(path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  const segs = path.split('/').filter((s) => s.length);
  if (!segs.length) return null;
  for (const s of segs) { if (BAD_KEYS.has(s) || s === '.' || s === '..') return null; }
  return segs;
}

/** Structural op validation (S10): object, sanitizable path, known verb, bounded value. */
export function validOp(op) {
  if (!op || typeof op !== 'object') return false;
  if (typeof op.path !== 'string' || !sanitizePath(op.path)) return false;
  if (!isVerb(op.verb)) return false;
  if (op.value !== undefined) {
    try { if (JSON.stringify(op.value).length > MAX_VALUE_BYTES) return false; }
    catch { return false; }   // non-serialisable (e.g. circular) -> reject
  }
  return true;
}

// Bound on the retained op-log (B5) — enables replay/undo/audit without unbounded growth.
const OPLOG_MAX = 1000;
// Bound on remembered opIds for dedup (B6).
const SEEN_MAX = 4000;
// Plan 0471 L1: max items in a participant-writable id-keyed collection (chat, map/markers,
// crud/*/items). The rate limiter caps additions/sec; this caps TOTAL — evict oldest (FIFO).
const COLLECTION_MAX = 1000;

/*
 * Plan 0522 P16.2 — `onOp` is the DURABLE SINK SEAM. The oplog below is a bounded in-memory ring:
 * past OPLOG_MAX the oldest entry is shifted out, and at process exit the whole thing is freed.
 * That is why every "run one session and then measure" criterion in plans 0508/0514/0516 has been
 * unfalsifiable in practice — the evidence was gone before anyone came to read it. `onOp` receives
 * each DURABLE op exactly once, at the moment it is appended, and lib/session-log.mjs buffers it
 * to disk. Absent ⇒ nothing changes and nothing is written.
 */
export function createStore({ permissions, onOp = null } = {}) {
  const perms = permissions || createPermissions();
  const state = nobj();
  const oplog = [];        // bounded, in-order applied ops (B5)
  let _version = 0;        // monotonic (B5 / X1 resync)
  const seenOps = new Set();   // opId dedup (B6) — a re-delivered op is a no-op
  const seenOrder = [];        // bounded FIFO of seen opIds

  /** Read the value at a path, or undefined. Never throws on a bad path. */
  function get(path) {
    const segs = sanitizePath(path);
    if (!segs) return undefined;
    let o = state;
    for (const s of segs) {
      if (o == null || typeof o !== 'object') return undefined;
      o = o[s];
    }
    return o;
  }

  /**
   * Low-level write: create intermediate null-proto nodes and set the leaf.
   * Returns true on success, false if the path is unsafe (S4 reject).
   */
  function _setPath(path, value) {
    const segs = sanitizePath(path);
    if (!segs) return false;
    let o = state;
    for (let i = 0; i < segs.length - 1; i++) {
      const k = segs[i];
      if (typeof o[k] !== 'object' || o[k] === null) o[k] = nobj();
      o = o[k];
    }
    o[segs[segs.length - 1]] = value;
    return true;
  }

  /** Delete the leaf at a path. Returns true if it existed and was removed. */
  function _delPath(path) {
    const segs = sanitizePath(path);
    if (!segs) return false;
    let o = state;
    for (let i = 0; i < segs.length - 1; i++) {
      const k = segs[i];
      if (typeof o[k] !== 'object' || o[k] === null) return false;
      o = o[k];
    }
    const leaf = segs[segs.length - 1];
    if (!(leaf in o)) return false;
    delete o[leaf];
    return true;
  }

  /**
   * Per-verb REDUCER (B2). Applies one op to the tree and returns a DIFF
   * ({ path: newValue }, with null marking a removal) or null if nothing valid.
   * All verbs are ORDER-INVARIANT / IDEMPOTENT:
   *   set/merge  — last-write-wins per path
   *   add/remove — id-keyed collections (add same id = one; remove twice = gone)
   *   lock/unlock — set/clear an item's lock owner
   *   clear      — reset a subtree to empty (terminal)
   * `actorId` stamps lock ownership; `by` stamping of writes happens in apply (B4).
   */
  function reduce(op, actorId) {
    if (!op || typeof op !== 'object') return null;
    const { path, verb } = op;
    const value = op.value;
    const segs = sanitizePath(path);
    if (!segs) return null;

    switch (verb) {
      case 'set': {
        _setPath(path, clone(value));
        return { [path]: clone(value) };
      }
      case 'merge': {
        let cur = get(path);
        if (typeof cur !== 'object' || cur === null) { cur = nobj(); _setPath(path, cur); }
        for (const k of Object.keys(value || {})) { if (BAD_KEYS.has(k)) continue; cur[k] = clone(value[k]); }
        return { [path]: clone(cur) };
      }
      case 'add': {
        const id = idOf(value);
        if (id == null) return null;               // add requires an id-bearing item
        const p = path + '/' + id;
        _setPath(p, clone(value));
        // Plan 0471 L1: cap the collection's TOTAL size — evict oldest (FIFO by insertion order).
        // The diff carries the evictions (null = removed) so clients drop them too.
        const coll = get(path);
        if (coll && typeof coll === 'object' && !Array.isArray(coll)) {
          const keys = Object.keys(coll);
          if (keys.length > COLLECTION_MAX) {
            const diff = { [p]: clone(value) };
            for (let i = 0; i < keys.length - COLLECTION_MAX; i++) {
              if (keys[i] === id) continue;        // never evict the just-added item
              delete coll[keys[i]]; diff[path + '/' + keys[i]] = null;
            }
            return diff;
          }
        }
        return { [p]: clone(value) };
      }
      case 'remove': {
        const id = typeof value === 'object' && value ? idOf(value) : value;
        if (id == null) return null;
        const p = path + '/' + id;
        _delPath(p);
        return { [p]: null };                        // null = removed
      }
      /*
       * ⛔⛔ LOCKING A SCALAR USED TO DESTROY IT.
       *
       * The lock owner is written as a CHILD of the locked path — `<path>/lock`. That is fine for a
       * record: `items/3` is an object, and it gains a `lock` key beside its other fields. Applied
       * to a LEAF it is a catastrophe: `shared/rec/name` holding the string "Kestrel" became the
       * object {lock:"ann"} and **the value was gone**. Worse, the next legitimate write by the
       * holder replaced the object with a string again, silently dropping the lock — so the field
       * ended up both corrupted AND unlocked, with no error at any point.
       *
       * That made per-field locking unusable, which is the case that actually matters: two crew
       * editing different fields of one record is the normal situation, not the exotic one.
       *
       * ⇒ A lock on a leaf lives OUT of the value tree, in a sibling map `<parent>/_locks/<leaf>`.
       *   A lock on a record keeps `<path>/lock` exactly as before, so every existing caller,
       *   test and UI (crud reads `item.lock`) is byte-for-byte unaffected.
       */
      case 'lock': {
        const owner = (value && value.by) || actorId || null;
        const cur = get(path);
        const isRecord = cur === undefined || (cur && typeof cur === 'object' && !Array.isArray(cur));
        if (isRecord) { _setPath(path + '/lock', owner); return { [path + '/lock']: owner }; }
        const lp = leafLockPath(path);
        _setPath(lp, owner);
        return { [lp]: owner };
      }
      case 'unlock': {
        const cur = get(path);
        const isRecord = cur === undefined || (cur && typeof cur === 'object' && !Array.isArray(cur));
        if (isRecord && get(path + '/lock') !== undefined) { _delPath(path + '/lock'); return { [path + '/lock']: null }; }
        const lp = leafLockPath(path);
        _delPath(lp);
        return { [lp]: null };
      }
      case 'clear': {
        _setPath(path, nobj());
        return { [path]: {} };
      }
      default:
        return null;                                // unknown verb (B4 default-deny handles too)
    }
  }

  /**
   * apply(op, actor) — the authoritative pipeline (B4):
   *   validate (S10) → permission (S3) → reduce → stamp `by` → return the diff.
   * Returns { diff, by, path, verb } on success, or null (malformed / denied /
   * no-op). Identity is taken from the ACTOR (server-authoritative, S1) — never
   * from the op payload.
   */
  function apply(op, actor) {
    if (!validOp(op)) return null;                       // S10 malformed reject
    const eph = isEphemeral(op.path);                    // X2 — ephemeral: no log, no version, no dedup
    if (!eph && op.opId != null && seenOps.has(op.opId)) return { duplicate: true, opId: op.opId }; // B6 dedup
    const who = actor || { role: 'participant', userId: null };
    if (!perms.can(who, op)) return null;                // S3 permission
    /*
     * ⭐⭐ Plan 0691 — THE LOCK IS NOW ENFORCED. It was not.
     *
     * `lock` has always written `<path>/lock = ownerId`, and NOTHING anywhere read it back. Every
     * write verb ignored it completely, so two people editing the same field both succeeded and
     * the later one silently won. The lock was a label on a door with no bolt behind it: an app
     * could show a padlock, honestly believe it held, and lose a crew member's edit anyway.
     *
     * A write is refused if the target — or any ancestor of it — carries a lock held by SOMEONE
     * ELSE. Refusal returns null, the same contract every other denial uses, so no caller changes.
     *
     * ⚠ `{ force: true }` breaks a lock deliberately, and is available only to override roles
     *   (presenter/ai/system). A GM must be able to recover a field abandoned mid-edit by someone
     *   who closed their laptop — but it has to be an ACT, not a silent side effect of being GM.
     *   Without it a controller is bound by another user's lock exactly like anyone else.
     */
    const lockHolder = lockOwnerFor(op.path);
    if (lockHolder && lockHolder !== who.userId) {
      const forcing = op.value && op.value.force === true && OVERRIDE.has(who.role);
      if (!forcing) return null;
    }
    const diff = reduce(op, who.userId);
    if (!diff) return null;
    const by = who.userId || null;
    if (eph) return { diff, by, path: op.path, verb: op.verb, ephemeral: true };
    const version = ++_version;                          // B5 monotonic version (durable only)
    oplog.push({ version, by, role: who.role || null, ts: Date.now(), opId: op.opId != null ? op.opId : null, path: op.path, verb: op.verb, value: clone(op.value), diff });
    // P16.2: hand the entry to the durable sink BEFORE the ring can shift it out. Wrapped,
    // because the sink is instrumentation: a broken or full log must degrade the RECORD of the
    // session, never the session. Nothing thrown here may reach the caller applying the op.
    if (onOp) { try { onOp(oplog[oplog.length - 1]); } catch { /* the log is not allowed to break play */ } }
    if (oplog.length > OPLOG_MAX) oplog.shift();
    if (op.opId != null) {                               // remember only successfully-applied opIds
      seenOps.add(op.opId); seenOrder.push(op.opId);
      if (seenOrder.length > SEEN_MAX) seenOps.delete(seenOrder.shift());
    }
    return { diff, by, path: op.path, verb: op.verb, version };
  }

  /**
   * The lock owner governing `path`: the lock ON it, else the nearest ancestor's lock.
   * An ancestor lock covers its whole subtree — locking a record protects all of its fields,
   * which is what a caller locking `ship/systems/drive` means and expects.
   * Returns an ownerId, or null when nothing on the chain is locked.
   */
  function lockOwnerFor(path) {
    const parts = String(path).split('/').filter(Boolean);
    for (let n = parts.length; n > 0; n--) {
      const base = parts.slice(0, n).join('/');
      if (base.endsWith('/lock') || base === 'lock') continue;   // the lock field itself is not locked
      if (parts[n - 1] === '_locks' || parts.includes('_locks')) continue;   // the lock map is not lockable
      const rec = get(base + '/lock');                            // record-style lock
      if (typeof rec === 'string' && rec) return rec;
      const leaf = get(leafLockPath(base));                       // leaf-style lock
      if (typeof leaf === 'string' && leaf) return leaf;
    }
    return null;
  }

  // ---- op-log + snapshot (B5, Memento) ----
  function version() { return _version; }
  /** Copy of the retained op-log (optionally only entries with version > since). */
  function oplogSince(since = 0) { return oplog.filter((e) => e.version > since).map((e) => clone(e)); }

  /** Recursively clone the tree, omitting any path this actor may not READ (S7).
   *  Plan 0471 C3: `actor`={role,userId}. Under default-DENY a DENIED container must be
   *  DESCENDED (not pruned) so allowed descendants beneath it still reach the snapshot. */
  function filterNode(obj, prefix, actor) {
    const out = {};
    for (const k of Object.keys(obj)) {
      const p = prefix ? prefix + '/' + k : k; const v = obj[k];
      if (perms.canRead(actor, p)) { out[k] = clone(v); }                 // allowed (leaf or prefix) → whole subtree
      else if (v && typeof v === 'object' && !Array.isArray(v)) {         // denied here → descend for allowed descendants
        const sub = filterNode(v, p, actor); if (Object.keys(sub).length) out[k] = sub;
      }                                                                    // denied leaf → drop
    }
    return out;
  }
  /** Memento: an actor-filtered plain-object snapshot + the current version. */
  function snapshot(actor) { return { version: _version, state: filterNode(state, '', actor) }; }

  return { state, get, _setPath, _delPath, reduce, apply, perms, version, oplogSince, snapshot, lockOwnerFor };
}

// --- helpers ---
/** Where a LEAF's lock lives: a sibling map, so the value itself is never overwritten. */
function leafLockPath(path) {
  const parts = String(path).split('/').filter(Boolean);
  const leaf = parts.pop();
  return (parts.length ? parts.join('/') + '/' : '') + '_locks/' + leaf;
}

const VERBS = new Set(['set', 'merge', 'add', 'remove', 'lock', 'unlock', 'clear']);
export function isVerb(v) { return VERBS.has(v); }

function idOf(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v.id != null ? String(v.id) : null;
  return String(v);
}

/** JSON-safe deep clone (values in the tree are JSON-serialisable). */
function clone(v) {
  if (v == null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v));
}
