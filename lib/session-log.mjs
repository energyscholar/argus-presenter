/*
 * lib/session-log.mjs — THE DURABLE SESSION LOG (Plan 0522 P16.2, R3/R6).
 * SERVER-SIDE ONLY (touches the filesystem). Nothing here reaches the browser.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
 * `app/state.mjs` keeps `const oplog = []` — a bounded IN-MEMORY ring (OPLOG_MAX = 1000, oldest
 * shifted out when full). Nothing in this repo has ever written it anywhere. When the process
 * exits, the session's whole record goes with it.
 *
 * That is not a tidiness complaint. Every "run one session and then measure" acceptance criterion
 * in plans 0508 / 0514 / 0516 has been UNFALSIFIABLE IN PRACTICE — including 0516's own claim that
 * no instrumentation was needed — because by the time anyone came to measure, the evidence had
 * already been freed. The S17 session (2026-07-28) is the worked example: its process had exited
 * before planning began, so Tuesday's evidence is unrecoverable. Not lost to a bug. Lost because
 * the only copy was in RAM.
 *
 * ── WHAT IT GUARANTEES, AND WHAT IT REFUSES TO ──────────────────────────────────────────────
 * 1. WRITES NEVER BLOCK THE LIVE SESSION. `append()` does no I/O: it pushes a line into a bounded
 *    buffer and returns. Flushes are asynchronous, one in flight at a time, on an UNREF'd timer.
 *    A slow disk, a full disk, or a read-only directory DEGRADES THE LOG and never the session —
 *    every failure path here ends in a counter, never in a throw. Five players are waiting; the
 *    instrument that watches the session must not be able to stop it.
 * 2. THE LOG LANDS OUTSIDE ANY REPOSITORY. The default is XDG state
 *    (`${XDG_STATE_HOME:-~/.local/state}/argus-presenter/logs`). A directory inside the checkout
 *    is REFUSED outright — see `isInsideRepoCheckout`. The PATH is the mechanism; a .gitignore
 *    entry would only be a seatbelt, and this repo already has one directory (`modules/`) whose
 *    entire safety story is a gitignore rule and a naming convention.
 * 3. IT DOES NOT GROW WITHOUT BOUND. Three independent caps: bytes per part (rotate), parts per
 *    session (drop oldest), and session logs retained in the directory (pruned at open). Total
 *    bytes on disk are therefore bounded by maxSessions × maxParts × maxBytes.
 *
 * ── ⚠ THE READ IS ROLE-GATED, AND THAT IS A RULING, NOT AN IMPLEMENTATION DETAIL ────────────
 * The log carries the session transcript — chat ops are participants' own words (server.mjs
 * routes `t:'chat'` through `store.apply` as an op on `chat`). Bruce's first call was "no need to
 * protect the log". Shown that an ungated endpoint on a publicly-reachable host makes THIRD
 * PARTIES' speech world-readable to anyone holding the url, he ruled ROLE-GATED (R6). The people
 * whose words these are were not in the room when that was decided; the reasoning is recorded
 * here so it outlives the decision. The gate lives in app/server.mjs (`/api/session-log`) and
 * reuses the existing control credential — no second auth scheme was added.
 *
 * ── ⚠ ENABLEMENT: OFF FOR A BARE createServer(), ON FOR A DEPLOYMENT ─────────────────────────
 * A library call with no log directory configured writes NOTHING. The deployment paths — the CLI
 * self-run in app/server.mjs and `presenter_start` in mcp/tools.mjs — resolve the directory from
 * lib/deployment-config.mjs and pass it in, so a REAL session logs by default. This mirrors the
 * rule already in force one screen away in server.mjs for credentials ("createServer() from tests
 * stays ungated unless a credential is passed"), and it is what keeps 475 existing tests from
 * writing into a human's actual ~/.local/state.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { loadDeploymentConfig, REPO_ROOT } from './deployment-config.mjs';

/** The deployment-config key this phase adds. Documented in presenter-config.example.json. */
export const SESSION_LOG_DIR_KEY = 'sessionLogDir';

/** The env override, checked before the config file (SCREAMING_SNAKE per docs/naming-canon.md §4). */
export const SESSION_LOG_DIR_ENV = 'PRESENTER_SESSION_LOG_DIR';

/**
 * The three caps and the flush cadence. All overridable per log, all bounded by default.
 *  maxBytes        bytes per part file before it rotates
 *  maxParts        parts retained for ONE session; the oldest is unlinked on rotation
 *  maxSessions     session logs retained in the directory; the oldest are pruned at open
 *  flushMs         how long a line may sit in the buffer before it is written
 *  bufferMaxBytes  memory ceiling for the buffer — a stuck disk must not grow the heap either
 */
export const SESSION_LOG_DEFAULTS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxParts: 4,
  maxSessions: 50,
  flushMs: 250,
  bufferMaxBytes: 1024 * 1024,
});

/** Consecutive write failures after which the log gives up rather than retry forever. */
const FAILURE_LIMIT = 3;

const trimmed = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;

/** `session-<stamp>-<rand>.p<n>.jsonl` — stamp first, so lexicographic order IS chronological. */
const PART_RE = /^(session-[0-9A-Za-z_-]+)\.p(\d+)\.jsonl$/;

const partFile = (base, n) => `${base}.p${n}.jsonl`;

/**
 * The BUILT-IN default directory: XDG state, never the checkout.
 * State (not cache, not config): a session log is data the machine produced and should survive a
 * reboot, but it is not something a human hand-edits. `env` is injectable so a test can resolve a
 * default WITHOUT touching a real home directory.
 */
export function defaultSessionLogDir({ env = process.env } = {}) {
  const stateHome = trimmed(env.XDG_STATE_HOME)
    || join(trimmed(env.HOME) || homedir(), '.local', 'state');
  return join(stateHome, 'argus-presenter', 'logs');
}

/** Is `candidate` the checkout itself, or inside it? Used to REFUSE, not to warn. */
export function isInsideRepoCheckout(candidate, repoDir = REPO_ROOT) {
  const a = resolve(candidate), b = resolve(repoDir);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Where this deployment's session logs go, and WHERE THAT CAME FROM.
 * Order: $PRESENTER_SESSION_LOG_DIR > config `sessionLogDir` > built-in XDG-state default.
 * Returns { sessionLogDir, sessionLogDirSource, sessionLogDirError }.
 *
 * ⚠ Never throws. A broken config file is LOUD for the port (P16.1 made it fatal at import,
 * deliberately) but must not be fatal here: the log is the instrument, and an instrument that
 * can refuse to let the session start is worse than no instrument.
 *
 * ⚠ INHERITED FROM P16.1, AND IT WILL SURPRISE SOMEBODY: loadDeploymentConfig resolves THE FIRST
 * FILE FOUND, WHOLE-FILE — not key-by-key. A deployment with a repo-local presenter-config.json
 * that sets only `presenterPort` therefore IGNORES an XDG file containing `sessionLogDir`
 * entirely, and this function reports `sessionLogDirSource: 'built-in'` when that happens. Put
 * both keys in the SAME file. (The same warning is on the example config, where a reader meets it.)
 */
export function resolveSessionLogDir({ env = process.env, repoDir = REPO_ROOT, config = null } = {}) {
  const fromEnv = trimmed(env[SESSION_LOG_DIR_ENV]);
  let sessionLogDir = null, sessionLogDirSource = null, sessionLogDirError = null;
  if (fromEnv) { sessionLogDir = resolve(fromEnv); sessionLogDirSource = 'env'; }
  else {
    let cfg = config;
    if (!cfg) {
      try { cfg = loadDeploymentConfig({ env, repoDir }); }
      catch (e) { cfg = null; sessionLogDirError = `deployment config unreadable, using the built-in default: ${(e && e.message) || e}`; }
    }
    const fromCfg = cfg ? trimmed(cfg[SESSION_LOG_DIR_KEY]) : null;
    if (fromCfg) { sessionLogDir = resolve(fromCfg); sessionLogDirSource = 'config'; }
    else { sessionLogDir = defaultSessionLogDir({ env }); sessionLogDirSource = 'built-in'; }
  }
  // REQUIREMENT 2, enforced rather than asserted. A log directory inside the checkout would put
  // players' words one `git add -A` away from a public repository, and this repo's one
  // history-free directory (modules/) is protected only by a gitignore line. Refuse, and say so.
  if (isInsideRepoCheckout(sessionLogDir, repoDir)) {
    return {
      sessionLogDir: null,
      sessionLogDirSource,
      sessionLogDirError: `session log directory ${sessionLogDir} is inside the checkout ${resolve(repoDir)} — refusing (the log carries session transcripts and must live outside any repository)`,
    };
  }
  return { sessionLogDir, sessionLogDirSource, sessionLogDirError };
}

/** Every part file in `dir`, grouped by session, oldest session first. Cheap; never throws. */
export function listSessionLogs(sessionLogDir) {
  const bySession = new Map();
  let names = [];
  try { names = readdirSync(sessionLogDir); } catch { return []; }
  for (const name of names) {
    const m = PART_RE.exec(name);
    if (!m) continue;
    const sessionLogId = m[1], partIndex = Number(m[2]);
    let bytes = 0, mtimeMs = 0;
    try { const st = statSync(join(sessionLogDir, name)); bytes = st.size; mtimeMs = st.mtimeMs; } catch { continue; }
    const s = bySession.get(sessionLogId) || { sessionLogId, parts: [], bytes: 0, mtimeMs: 0 };
    s.parts.push({ partIndex, partName: name, bytes });
    s.bytes += bytes;
    s.mtimeMs = Math.max(s.mtimeMs, mtimeMs);
    bySession.set(sessionLogId, s);
  }
  const out = [...bySession.values()];
  for (const s of out) s.parts.sort((a, b) => a.partIndex - b.partIndex);
  return out.sort((a, b) => (a.sessionLogId < b.sessionLogId ? -1 : a.sessionLogId > b.sessionLogId ? 1 : 0));
}

/**
 * Read one session's entries back, oldest part first. `limit` keeps the MOST RECENT `limit`
 * entries (a reader almost always wants the end of a session, not its first 200 ops).
 * A truncated tail line — the shape a SIGKILL mid-write leaves behind — is DROPPED, not fatal.
 */
export function readSessionLog(sessionLogDir, sessionLogId, { limit = 500 } = {}) {
  const s = listSessionLogs(sessionLogDir).find((x) => x.sessionLogId === sessionLogId);
  if (!s) return { sessionLogId, entries: [], parts: [], bytes: 0, truncated: false, unparsedLines: 0 };
  const entries = []; let unparsedLines = 0;
  for (const p of s.parts) {
    let text = '';
    try { text = readFileSync(join(sessionLogDir, p.partName), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { entries.push(JSON.parse(line)); } catch { unparsedLines++; }
    }
  }
  const truncated = limit != null && entries.length > limit;
  return {
    sessionLogId,
    entries: truncated ? entries.slice(entries.length - limit) : entries,
    parts: s.parts, bytes: s.bytes, truncated, unparsedLines,
  };
}

/**
 * A durable append-only log for ONE session.
 *
 * `sessionLogDir` null/absent ⇒ a DISABLED handle with the same shape (`append` is a no-op that
 * returns false). Callers never branch on whether logging is configured; there is one object.
 */
export function createSessionLog({
  sessionLogDir = null,
  sessionLogDirSource = null,
  sessionLogDirError = null,
  sessionLogId = null,
  maxBytes = SESSION_LOG_DEFAULTS.maxBytes,
  maxParts = SESSION_LOG_DEFAULTS.maxParts,
  maxSessions = SESSION_LOG_DEFAULTS.maxSessions,
  flushMs = SESSION_LOG_DEFAULTS.flushMs,
  bufferMaxBytes = SESSION_LOG_DEFAULTS.bufferMaxBytes,
  header = null,
  onWarn = null,
  now = Date.now,
} = {}) {
  const stats = { appended: 0, written: 0, dropped: 0, rotated: 0, prunedSessions: 0, failures: 0, bytes: 0 };
  let disabled = false;
  let disabledReason = null;
  let partIndex = 0;
  let partBytes = 0;
  const parts = [];                 // absolute paths, oldest first
  let buffer = [];
  let bufferBytes = 0;
  let timer = null;
  let writingPromise = null;

  const warn = (event, detail) => { try { if (onWarn) onWarn(event, detail); } catch { /* a broken sink is not a session failure */ } };

  function disable(reason, event = 'session-log-disabled') {
    if (disabled) return;
    disabled = true; disabledReason = reason;
    buffer = []; bufferBytes = 0;
    if (timer) { clearTimeout(timer); timer = null; }
    warn(event, { reason });
  }

  if (!sessionLogDir) {
    disabled = true;
    disabledReason = sessionLogDirError || 'no session log directory configured — this server logs nothing to disk';
  }

  // A stamp first so the name sorts chronologically, then randomness so two servers started in
  // the same second in the same directory cannot collide onto one file.
  const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const logId = sessionLogId || `session-${stamp}-${Math.random().toString(36).slice(2, 8)}`;

  /** Prune the OLDEST session logs so the directory cannot accumulate one file per run forever. */
  function pruneSessions() {
    const sessions = listSessionLogs(sessionLogDir).filter((s) => s.sessionLogId !== logId);
    const over = sessions.length - Math.max(0, maxSessions - 1);
    for (let i = 0; i < over; i++) {
      for (const p of sessions[i].parts) {
        try { unlinkSync(join(sessionLogDir, p.partName)); } catch { /* someone else's file; leave it */ }
      }
      stats.prunedSessions++;
    }
  }

  if (!disabled) {
    try {
      mkdirSync(sessionLogDir, { recursive: true });
      pruneSessions();
      parts.push(join(sessionLogDir, partFile(logId, 0)));
    } catch (e) {
      // The one failure mode worth distinguishing: an unwritable directory can never recover, so
      // fail FAST and silently-for-the-session rather than retry every flush for three hours.
      disable(`session log directory ${sessionLogDir} is not writable: ${(e && e.message) || e}`, 'session-log-unwritable');
    }
  }

  /** Rotate to a fresh part, dropping the oldest when this session is over its part budget. */
  function rotate() {
    partIndex++;
    parts.push(join(sessionLogDir, partFile(logId, partIndex)));
    while (parts.length > Math.max(1, maxParts)) {
      const oldest = parts.shift();
      try { unlinkSync(oldest); } catch { /* already gone */ }
    }
    partBytes = 0;
    stats.rotated++;
  }

  async function writeChunk(chunk) {
    // Rotate BEFORE the write when this chunk would take the part over its cap. A chunk larger
    // than maxBytes still goes out whole — a log line is the atom here, never split.
    if (partBytes > 0 && partBytes + chunk.length > maxBytes) rotate();
    await appendFile(parts[parts.length - 1], chunk);
    partBytes += chunk.length;
    stats.bytes += chunk.length;
  }

  function schedule() {
    if (disabled || timer || writingPromise || !buffer.length) return;
    timer = setTimeout(() => { timer = null; flushNow(); }, flushMs);
    if (timer.unref) timer.unref();     // the log must never hold the process open
  }

  function flushNow() {
    if (disabled || writingPromise || !buffer.length) return writingPromise || Promise.resolve();
    const chunk = buffer.join('');
    const lines = buffer.length;
    buffer = []; bufferBytes = 0;
    writingPromise = writeChunk(chunk).then(() => {
      stats.written += lines;
      stats.failures = 0;
    }).catch((e) => {
      stats.failures++;
      stats.dropped += lines;           // the chunk is gone; the session is not
      warn('session-log-write-failed', { err: String((e && e.message) || e).slice(0, 120), failures: stats.failures });
      if (stats.failures >= FAILURE_LIMIT) disable(`write failed ${stats.failures}× — giving up on this session's log: ${(e && e.message) || e}`);
    }).then(() => {
      writingPromise = null;
      schedule();
    });
    return writingPromise;
  }

  /**
   * Append one entry. NO I/O HAPPENS HERE — this is called from the op path, on the event loop
   * the live session shares. Returns false when the entry was not accepted.
   */
  function append(entry) {
    if (disabled) { stats.dropped++; return false; }
    let line;
    try { line = JSON.stringify(entry) + '\n'; }
    catch { stats.dropped++; return false; }     // non-serialisable: dropped, never thrown
    buffer.push(line); bufferBytes += line.length; stats.appended++;
    // Memory ceiling: a wedged disk drops the OLDEST buffered lines rather than growing the heap
    // under a live session. Losing the front of the buffer beats an OOM mid-play.
    while (bufferBytes > bufferMaxBytes && buffer.length > 1) {
      bufferBytes -= buffer.shift().length; stats.dropped++;
    }
    schedule();
    return true;
  }

  /** Force the buffer out and wait for it. For close paths and tests — never on the op path. */
  async function flush() {
    if (disabled) return status();
    if (timer) { clearTimeout(timer); timer = null; }
    while (buffer.length || writingPromise) {
      if (writingPromise) await writingPromise;
      else await flushNow();
    }
    return status();
  }

  /**
   * Final, SYNCHRONOUS flush. Legitimate here and nowhere else: the server is shutting down, so
   * there is no live session left to stall, and a tail lost to an async race is exactly the
   * evidence this phase exists to keep.
   */
  function close() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (disabled || !buffer.length) { return status(); }
    const chunk = buffer.join(''); const lines = buffer.length;
    buffer = []; bufferBytes = 0;
    try {
      if (partBytes > 0 && partBytes + chunk.length > maxBytes) rotate();
      appendFileSync(parts[parts.length - 1], chunk);
      partBytes += chunk.length; stats.bytes += chunk.length; stats.written += lines;
    } catch (e) {
      stats.dropped += lines;
      warn('session-log-close-write-failed', { err: String((e && e.message) || e).slice(0, 120) });
    }
    return status();
  }

  function status() {
    return {
      enabled: !disabled,
      sessionLogId: logId,
      sessionLogDir: sessionLogDir || null,
      sessionLogDirSource,
      sessionLogDirError: disabledReason || sessionLogDirError || null,
      parts: parts.map((p) => p.slice(p.lastIndexOf(sep) + 1)),
      pending: buffer.length,
      caps: { maxBytes, maxParts, maxSessions, flushMs, bufferMaxBytes },
      stats: { ...stats },
    };
  }

  /** This session's own entries, read back off disk (what the role-gated endpoint serves). */
  function read(opts = {}) {
    if (!sessionLogDir) return { sessionLogId: logId, entries: [], parts: [], bytes: 0, truncated: false, unparsedLines: 0 };
    return readSessionLog(sessionLogDir, opts.sessionLogId || logId, opts);
  }

  /** Every session log in the directory — this run's and previous runs'. */
  function sessions() { return sessionLogDir ? listSessionLogs(sessionLogDir) : []; }

  const handle = { append, flush, close, status, read, sessions, sessionLogId: logId };

  // The header is the provenance record: which build, which profile, when. Buffered like any
  // other line, so an unwritable directory costs nothing here either.
  if (!disabled) append({ kind: 'session-open', sessionLogId: logId, startedAt: new Date(now()).toISOString(), pid: process.pid, ...(header || {}) });

  return handle;
}
