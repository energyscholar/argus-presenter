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

import { createPermissions } from './permissions.mjs';

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

export function createStore({ permissions } = {}) {
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
        return { [p]: clone(value) };
      }
      case 'remove': {
        const id = typeof value === 'object' && value ? idOf(value) : value;
        if (id == null) return null;
        const p = path + '/' + id;
        _delPath(p);
        return { [p]: null };                        // null = removed
      }
      case 'lock': {
        const owner = (value && value.by) || actorId || null;
        _setPath(path + '/lock', owner);
        return { [path + '/lock']: owner };
      }
      case 'unlock': {
        _delPath(path + '/lock');
        return { [path + '/lock']: null };
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
    const diff = reduce(op, who.userId);
    if (!diff) return null;
    const by = who.userId || null;
    if (eph) return { diff, by, path: op.path, verb: op.verb, ephemeral: true };
    const version = ++_version;                          // B5 monotonic version (durable only)
    oplog.push({ version, by, role: who.role || null, ts: Date.now(), opId: op.opId != null ? op.opId : null, path: op.path, verb: op.verb, value: clone(op.value), diff });
    if (oplog.length > OPLOG_MAX) oplog.shift();
    if (op.opId != null) {                               // remember only successfully-applied opIds
      seenOps.add(op.opId); seenOrder.push(op.opId);
      if (seenOrder.length > SEEN_MAX) seenOps.delete(seenOrder.shift());
    }
    return { diff, by, path: op.path, verb: op.verb, version };
  }

  // ---- op-log + snapshot (B5, Memento) ----
  function version() { return _version; }
  /** Copy of the retained op-log (optionally only entries with version > since). */
  function oplogSince(since = 0) { return oplog.filter((e) => e.version > since).map((e) => clone(e)); }

  /** Recursively clone the tree, omitting any path this role may not READ (S7). */
  function filterNode(obj, prefix, role) {
    const out = {};
    for (const k of Object.keys(obj)) {
      const p = prefix ? prefix + '/' + k : k;
      if (!perms.canRead(role, p)) continue;
      const v = obj[k];
      out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? filterNode(v, p, role) : clone(v);
    }
    return out;
  }
  /** Memento: a role-filtered plain-object snapshot + the current version. */
  function snapshot(role) { return { version: _version, state: filterNode(state, '', role) }; }

  return { state, get, _setPath, _delPath, reduce, apply, perms, version, oplogSince, snapshot };
}

// --- helpers ---
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
