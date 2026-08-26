/*
 * lib/session-store.mjs — Plan 0693 T1: A SIGN-IN THAT SURVIVES A RESTART.
 * SERVER-SIDE ONLY (touches the filesystem). Nothing here reaches the browser.
 *
 * ── WHY THIS EXISTS, MEASURED ───────────────────────────────────────────────────────────────
 * `app/identity.mjs` kept its OIDC sessions in `const sessions = new Map()` and nothing anywhere
 * wrote them down. jill auto-deploys on every push and every deploy restarts the presenter, so on
 * 2026-08-26 the box had 13 restarts, 10 deploys and ZERO sessions surviving one. The owner of the
 * deployment was signed out minutes after each sign-in, by his own pushes, and the Control page
 * then refused him outright. The client kept showing "signed in" because that state was client-side
 * and nothing told it otherwise (that half is T2).
 *
 * ── ⛔ A PERSISTED SESSION IS A CREDENTIAL AT REST (0696 F9) ────────────────────────────────
 * Writing sessions down turns a readable file into a durable impersonation primitive, so:
 *
 *   1. ⛔ THE SESSION ID IS NEVER STORED. The key on disk is sha256(sid) — the same one-way
 *      reduction a password file uses. A reader of this file learns that a session exists and
 *      whose it is; they CANNOT mint the cookie that opens it. "Store nothing replayable that a
 *      hash would do instead" is the rule, and this is the whole of it.
 *   2. Mode 0600, set at CREATE time on the temp file, so the window between `open` and `chmod`
 *      does not exist. Atomic temp+rename, so a crash mid-write leaves the old file, never half.
 *   3. It lands in the DECLARED STATE DIRECTORY, never the checkout — resolved by the caller the
 *      same way lib/session-log.mjs and the plugin state resolve theirs (env, then XDG state).
 *   4. ⛔ NOTHING FROM IT IS EVER LOGGED. No sid, no hash, no principal. The failure paths below
 *      report a COUNT and a category, never a value.
 *
 * ── ⛔ AN EXPIRED OR MALFORMED ENTRY IS DROPPED, NEVER REPAIRED ─────────────────────────────
 * There is deliberately no partial-recovery path. A restored session must be indistinguishable
 * from a live one or it is not a fix; anything that cannot be restored EXACTLY is discarded and
 * the person signs in again. A truncated file, a format this build does not know, an entry with a
 * bad key shape or a missing expiry: all of it reads as absent, and the server starts normally.
 *
 * ── IT DOES NOT GROW WITHOUT BOUND ──────────────────────────────────────────────────────────
 * Expiry is applied on load AND on read, and the store is capped: past `max`, the entries closest
 * to expiring are dropped first. An append-only credential file is a slow leak with a long fuse.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Bumped only if the on-disk shape changes; an unrecognised version reads as ABSENT, not as junk. */
export const SESSION_STORE_FORMAT = 1;

/** How many live sessions one deployment may persist. Bounded, because this file is a credential. */
export const SESSION_STORE_MAX = 200;

/**
 * The ONLY form a session id takes on disk: sha256, hex. ⛔ Never store, log or return the sid.
 * A hash cannot be presented as a cookie, so the file is not a replay primitive.
 */
export function sessionKey(sid) {
  return createHash('sha256').update(String(sid == null ? '' : sid)).digest('hex');
}

const isHexKey = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Parse a persisted document into `[ [key, { principal, exp }] … ]`, dropping everything that is
 * not exactly right. NEVER throws, and never returns a repaired entry.
 * Exported so the drop rules can be tested without touching a filesystem.
 */
export function parseSessionDoc(raw, now = Date.now()) {
  let doc;
  try { doc = JSON.parse(raw); } catch { return { entries: [], dropped: 0, readable: false }; }
  if (!isPlainObject(doc) || doc.format !== SESSION_STORE_FORMAT || !Array.isArray(doc.sessions)) {
    return { entries: [], dropped: 0, readable: false };
  }
  const entries = [];
  let dropped = 0;
  for (const e of doc.sessions) {
    if (!isPlainObject(e) || !isHexKey(e.k) || !Number.isFinite(e.exp) || !isPlainObject(e.principal)) { dropped++; continue; }
    if (e.exp <= now) { dropped++; continue; }                        // expired ⇒ dropped, never revived
    entries.push([e.k, { principal: e.principal, exp: e.exp }]);
  }
  return { entries, dropped, readable: true };
}

/**
 * A session store that MAY be file-backed.
 *
 * `file` null/absent ⇒ an in-memory store with the same shape and no I/O at all. Callers never
 * branch on whether persistence is configured; there is one object. (That is also what keeps the
 * whole test suite from writing a credential file: a bare `createServer()` configures no path.)
 *
 * `onWarn(event, detail)` is optional and receives CATEGORIES ONLY — never a key or a principal.
 */
export function createSessionStore({ file = null, now = () => Date.now(), max = SESSION_STORE_MAX, onWarn = null } = {}) {
  const path = (typeof file === 'string' && file.trim()) ? file.trim() : null;
  const sessions = new Map();      // sha256(sid) -> { principal, exp }
  let loadedCount = 0, droppedCount = 0;

  const warn = (event, detail) => { if (typeof onWarn === 'function') { try { onWarn(event, detail); } catch { /* a warning must never take the server down */ } } };

  /** Drop everything that has expired. Returns how many went. */
  function sweep() {
    const t = now();
    let n = 0;
    for (const [k, v] of sessions) if (!v || !(v.exp > t)) { sessions.delete(k); n++; }
    return n;
  }

  /** ⛔ Cap the store by dropping the sessions CLOSEST TO EXPIRING first. */
  function trim() {
    if (sessions.size <= max) return 0;
    const byExp = [...sessions.entries()].sort((a, b) => a[1].exp - b[1].exp);
    let n = 0;
    while (sessions.size > max && byExp.length) { sessions.delete(byExp.shift()[0]); n++; }
    return n;
  }

  /**
   * Write the whole store. Returns true on success, false on ANY failure — and NEVER throws: a
   * full or read-only disk must not take a live session down, and the honest consequence of a
   * failed write is that the next boot asks the person to sign in again.
   */
  function persist() {
    if (!path) return false;
    const tmp = `${path}.tmp`;
    const doc = {
      format: SESSION_STORE_FORMAT,
      savedAt: now(),
      sessions: [...sessions.entries()].map(([k, v]) => ({ k, exp: v.exp, principal: v.principal })),
    };
    try {
      mkdirSync(dirname(path), { recursive: true });
      /* ⛔ 0600 AT CREATE TIME. writeFileSync's `mode` applies only when the file is created, so a
       *   pre-existing file keeps its own mode — hence the rm first: the temp file is ours, always
       *   new, and always 0600 before a single byte of a principal is in it. */
      try { rmSync(tmp, { force: true }); } catch { /* absent is the normal case */ }
      writeFileSync(tmp, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, path);       // atomic within one directory: a reader sees old or new, never half
      return true;
    } catch (e) {
      try { rmSync(tmp, { force: true }); } catch {}
      warn('session-store-write-failed', { path: !!path });   // ⛔ category only — never the path's contents
      return false;
    }
  }

  /** Load at construction. Absent file ⇒ an empty store and a normal start; that is not an error. */
  function load() {
    if (!path) return;
    let raw;
    try { raw = readFileSync(path, 'utf8'); }
    catch { return; }                                     // never written yet, or unreadable ⇒ start empty
    const { entries, dropped, readable } = parseSessionDoc(raw, now());
    for (const [k, v] of entries) sessions.set(k, v);
    loadedCount = entries.length;
    droppedCount = dropped;
    if (!readable) warn('session-store-unreadable', {});                       // ⛔ counts, never contents
    else if (dropped) warn('session-store-entries-dropped', { dropped });
    trim();
  }
  load();

  return {
    /** Whether this store writes anything down at all. */
    get persistent() { return !!path; },
    /** Live session count (after expiry). Never the ids. */
    get size() { sweep(); return sessions.size; },
    /** Diagnostics for the startup line: COUNTS ONLY. */
    stats() { return { persistent: !!path, loaded: loadedCount, droppedAtLoad: droppedCount, size: sessions.size }; },

    /** The record for a session id, or null. Expired ⇒ dropped here and persisted. */
    get(sid) {
      const k = sessionKey(sid);
      const s = sessions.get(k);
      if (!s) return null;
      if (!(s.exp > now())) { sessions.delete(k); persist(); return null; }
      return s;
    },
    /** True iff a session id maps to an entry that HAS EXPIRED (the re-auth prompt reads this). */
    expired(sid) {
      const s = sessions.get(sessionKey(sid));
      return !!(s && !(s.exp > now()));
    },
    /** Mint: record a session and write the store. */
    set(sid, record) {
      sweep();
      sessions.set(sessionKey(sid), { principal: record.principal, exp: record.exp });
      trim();
      persist();
    },
    /** Revoke: forget a session and write the store. */
    delete(sid) {
      const k = sessionKey(sid);
      const had = sessions.delete(k);
      if (had) persist();
      return had;
    },
    /** Test-only observability. ⛔ Keys are HASHES; there is no way back to a cookie from here. */
    _map: sessions,
  };
}
