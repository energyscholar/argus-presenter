/*
 * app/log.mjs — server-side structured logging (bounded ring buffer).
 * Levels error|warn|info|debug|trace, per-subsystem tag, one JSON line per entry.
 * Flag-gated by AP_LOG (env) or setLevel(); optional stderr echo via AP_LOG_STDERR.
 *
 * OPSEC (S7): log paths/opIds/roles freely, but NEVER leak gm-only VALUES to a
 * participant-scope sink. Callers put sensitive data in `fields` and pass
 * {roles:[...]} = the roles allowed to READ those values. view(role) redacts
 * fields the viewer's role may not see. Structural metadata (ts/level/tag/msg)
 * is always visible — keep secrets OUT of `msg`.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const RING_MAX = 500;
const ring = [];
let threshold = LEVELS[process.env.AP_LOG] ?? LEVELS.info;

export function setLevel(l) { if (l in LEVELS) threshold = LEVELS[l]; return getLevel(); }
export function getLevel() { return Object.keys(LEVELS).find((k) => LEVELS[k] === threshold); }
export function clear() { ring.length = 0; }

function fmt(e) { return JSON.stringify({ ts: e.ts, level: e.level, tag: e.tag, msg: e.msg, ...e.fields }); }

/** Record a log entry. Returns the entry, or null if suppressed (below threshold). */
export function log(level, tag, msg, fields = {}, { roles = null } = {}) {
  if ((LEVELS[level] ?? 99) > threshold) return null;
  const entry = { ts: Date.now(), level, tag, msg: String(msg), fields: fields || {}, roles };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
  if (process.env.AP_LOG_STDERR) { try { process.stderr.write(fmt(entry) + '\n'); } catch {} }
  return entry;
}

export const error = (tag, msg, fields, opts) => log('error', tag, msg, fields, opts);
export const warn  = (tag, msg, fields, opts) => log('warn',  tag, msg, fields, opts);
export const info  = (tag, msg, fields, opts) => log('info',  tag, msg, fields, opts);
export const debug = (tag, msg, fields, opts) => log('debug', tag, msg, fields, opts);
export const trace = (tag, msg, fields, opts) => log('trace', tag, msg, fields, opts);

function redact(fields) { const o = {}; for (const k of Object.keys(fields || {})) o[k] = '[redacted]'; return o; }

/**
 * Read the ring for a viewer of `role`, most-recent-last, redacting the FIELDS of
 * any entry whose `roles` allowlist excludes this viewer. Metadata always shown.
 * This is the read-perm filter for debug/log sinks (S7).
 */
export function view(role, { max = 100 } = {}) {
  return ring.slice(-max).map((e) => {
    const canSee = !e.roles || e.roles.includes(role);
    return { ts: e.ts, level: e.level, tag: e.tag, msg: e.msg, fields: canSee ? e.fields : redact(e.fields) };
  });
}

/** Raw tail (server-trusted, unredacted). For same-process diagnostics only. */
export function tail(max = 100) { return ring.slice(-max); }
