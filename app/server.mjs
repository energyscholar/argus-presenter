/*
 * Argus Presenter — greenfield server (lean, ideal API; not SO's broadcast model).
 * Transport: ws (native browser WebSocket). Node built-in http serves the page.
 *
 * User classes: participant | presenter | ai. Each connection authenticates an
 * identity {userId,userName,role} on hello; the server treats THAT as
 * authoritative and stamps it onto results (never trusts client-reported ids).
 *
 * Control surface (used by tests + the MCP server):
 *   pushContent(target, html, contentId)   target: userId | 'all' | role
 *   openPoll({promptId, prompt, options, target})  -> assembles a `choice` per channel
 *   getPoll(promptId) -> { tally, votes, count, spec }
 *   closePoll(promptId)
 *   presence() -> [{userId,userName,role}]
 *   on(event, cb)  events: 'presence','result','poll'
 */
import http from 'http';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, watch, mkdirSync, unlinkSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { WebSocketServer } from 'ws';
import { assemble } from '../harness/assemble.mjs';
import * as log from './log.mjs';
import { createStore, isEphemeral, validOp } from './state.mjs';
import { validate, summarize } from './validate.mjs';
import { createAsr } from './asr.mjs';
import { verifyCapability, mintCapability } from '../lib/capability.mjs';
import { selectProfile, DEFAULT_PROFILE } from './profiles.mjs';
import { createHeuristicSummarizer } from './summarizer.mjs';
import { buildDigest } from './digests.mjs';
import { deriveTrust, annotate as annotateTrust } from './untrusted.mjs';

// X6 resilience caps.
const MAX_CONNS = 200;              // connection cap
const MAX_PAYLOAD = 256 * 1024;     // per-frame byte cap (S6)
const DURABLE_OPS_PER_SEC = 50;     // per-conn durable-op rate (ephemeral is coalesced, not capped)

// Plan 0468: the dot means CONNECTION LIVENESS only. A real heartbeat keeps a silent-but-
// connected client's lastSeen fresh (its pong is inbound traffic) so it stays GREEN; missing
// STALE_MS worth of pings ⇒ present-but-stale ⇒ RED. PING_MS < STALE_MS/2 so a couple of dropped
// pings don't flip the dot. Shared by the heartbeat, the attendance api default, and health().
const PING_MS = 5000;               // heartbeat interval
const STALE_MS = 15000;             // > 3 missed pings ⇒ red (present-but-stale)

// Plan 0470 — inbound voice (mic -> client DSP -> server ASR). The binary PCM lane is an
// EPHEMERAL sibling of the JSON op lane: branched BEFORE JSON.parse, exempt from the durable-op
// cap, byte-rate capped, and ignored unless the connection has an active voice session.
const VOICE_SR = 16000;                        // server-side ASR sample rate (client resamples to this)
const VOICE_MAX_SESSIONS = 8;                  // RT-22: concurrent active voice sessions (<< MAX_CONNS)
const VOICE_BYTE_RATE_CAP = 64 * 1024;         // RT-7: sustained per-conn audio byte/s (PCM is 32 KB/s -> 2x headroom)
const VOICE_SEG_MAX_MS = 30000;                // RT-8: hard segment length cap -> force-cut
// RT-14 open-segment timeout is resolved PER createServer() (see segTimeoutMs) so tests can override it.
const VOICE_MIN_SEG_MS = 300;                  // RT-12: shorter than this -> drop (whisper hallucinates on blips)
const VOICE_SEG_MAX_BYTES = Math.round(VOICE_SR * 2 * VOICE_SEG_MAX_MS / 1000);
const VOICE_MIN_SEG_BYTES = Math.round(VOICE_SR * 2 * VOICE_MIN_SEG_MS / 1000);
// F1 fix: the worklet is final-only (buffers a whole utterance, flushes as one BURST at endpoint),
// so a per-SECOND rate cap wrongly truncates any >~2s utterance. A per-conn TOKEN BUCKET lets a full
// segment burst through whole (capacity = one 30s segment) while still throttling >2x-realtime floods
// at the sustained refill rate. The VOICE_SEG_MAX_BYTES force-cut still bounds a non-stop babbler.
const VOICE_TB_CAPACITY = VOICE_SEG_MAX_BYTES;   // a full 30s segment fits in one burst
const VOICE_TB_REFILL_BPS = 64 * 1024;           // sustained bytes/sec refill
const TRANSCRIPT_RING = 500;                   // in-memory cursored transcript log depth

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE = join(__dirname, 'presenter.html');

// Plan 0473 P0 — audio-in is OPTIONAL and USUALLY OFF ⇒ ZERO client cost when off.
// Parse a truthy env flag (1/true/on/yes). Used as the DEFAULT for createServer({voiceEnabled}).
function envVoiceEnabled() { return /^(1|true|on|yes)$/i.test(String(process.env.PRESENTER_VOICE_ENABLED || '').trim()); }

// Plan 0473 P0 — the audience page's voice code lives inside AP-VOICE:BEGIN..END markers
// (HTML comments in body, /* */ block comments inside <script>). When voice is OFF we remove
// those regions ENTIRELY before serving, so the page pulls ZERO voice bytes (no voice-stub
// <script>, no APVoice wiring, no mic row) and runs no always-on voice runtime.
const VOICE_BLOCK_RE = /[^\S\n]*(?:<!--|\/\*)\s*AP-VOICE:BEGIN\s*(?:-->|\*\/)[\s\S]*?(?:<!--|\/\*)\s*AP-VOICE:END\s*(?:-->|\*\/)[^\S\n]*\n?/g;
function stripVoiceBlocks(html) { return html.replace(VOICE_BLOCK_RE, ''); }
// Serve presenter.html, stripping the voice block(s) unless voice is enabled for this server.
export function renderPresenterPage(voiceEnabled) {
  const html = readFileSync(PAGE, 'utf8');
  return voiceEnabled ? html : stripVoiceBlocks(html);
}

// AUTH-ROLE (P5.5): standard seeded hash. The plaintext password NEVER travels —
// the browser sends sha256(seed + password); the server compares against ROLE_HASH.
function sha256hex(s) { return createHash('sha256').update(s).digest('hex'); }

// HAR: defense-in-depth HTTP hardening (see HARDENING.md).
// CSP for the HTML pages. 'unsafe-inline' is REQUIRED today — presenter/control/creator
// carry inline <script>/<style> and each srcdoc component runs an inline script; ws:/wss:
// are REQUIRED for the live socket; frame-src blob:/data: admits the sandboxed srcdoc iframes.
// (Future path: nonce the inline scripts and drop 'unsafe-inline' — noted in HARDENING.md.)
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss:; " +
  "frame-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'";
// Shared header set for the three HTML routes (/, /control, /creator).
const htmlHeaders = () => ({
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
});
// Serve a static-ish asset with a weak ETag (size + mtimeMs) + revalidation. On a
// matching if-none-match → 304 (no body). Used for the branding SVG + shipped .mjs modules.
function sendStatic(res, req, absPath, contentType) {
  try {
    const st = statSync(absPath);
    const etag = 'W/"' + st.size + '-' + st.mtimeMs + '"';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'no-cache' }); res.end(); return; }
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache', etag });
    res.end(readFileSync(absPath));
  } catch (e) { res.writeHead(404); res.end('not found'); }
}

export function createServer({ port = 0, controlToken = null, rolePassword = null, roleSeed = null, voiceEnabled = undefined, capSecret = null, profile = DEFAULT_PROFILE, settlingMs = null, queueMaxPending = null, queueTtlMs = null, perTurnBudgetMs = null, perTurnWrapMs = null, floorThresholds = null } = {}) {
  // Plan 0473 P1 — SESSION-TYPE PROFILE (the config-knob spine). Selected ONCE at session start;
  // its knobs are DATA the working-set engine will READ (settling/shedding/budget/floor/digest/queue).
  // Unknown/absent name falls back cleanly to the default (wearable). Profiles are data, not forks.
  const SESSION_PROFILE = selectProfile(profile);
  // Plan 0473 P2 — an explicit `settlingMs` at session start OVERRIDES the active profile's settling
  // knob. It is threaded THROUGH the profile object (a shallow clone of the same knob shape), NOT a
  // code branch — so the turn engine still reads the window from api.profile().settlingMs, and the
  // override is just tuning/testing config. Absent ⇒ the profile's own settlingMs governs.
  // Plan 0473 P4 — likewise `queueMaxPending` / `queueTtlMs` OVERRIDE the active profile's queuePolicy
  // knobs (bound + aging TTL), threaded through the SAME knob shape (never a code branch) so the queue
  // engine keeps reading them from api.profile().queuePolicy and tests can inject a short TTL / small bound.
  let ACTIVE_PROFILE = SESSION_PROFILE;
  if (typeof settlingMs === 'number' && settlingMs >= 0) ACTIVE_PROFILE = { ...ACTIVE_PROFILE, settlingMs };
  if (typeof queueMaxPending === 'number' || typeof queueTtlMs === 'number') {
    const qp = { ...(ACTIVE_PROFILE.queuePolicy || {}) };
    if (typeof queueMaxPending === 'number') qp.maxPending = queueMaxPending;
    if (typeof queueTtlMs === 'number') qp.ttlMs = queueTtlMs;
    ACTIVE_PROFILE = { ...ACTIVE_PROFILE, queuePolicy: qp };
  }
  // Plan 0473 P5 — likewise `perTurnBudgetMs` (the cap) / `perTurnWrapMs` (when the wrap-up cue fires,
  // ms from turn-open) OVERRIDE the active profile's perTurnBudget, threaded THROUGH the SAME knob shape
  // (never a code branch). `overrideMs` is a UNIFORM (all-role) tuning/test cap; `wrapMs` an explicit
  // wrap-lead time. The budget engine keeps reading these from api.profile().perTurnBudget, so tests can
  // inject a short cap and the wearable's soft/generous per-role budget still governs by default.
  if (typeof perTurnBudgetMs === 'number' || typeof perTurnWrapMs === 'number') {
    const ptb = { ...(ACTIVE_PROFILE.perTurnBudget || {}) };
    ptb.byRole = { ...(ptb.byRole || {}) };
    if (typeof perTurnBudgetMs === 'number') ptb.overrideMs = perTurnBudgetMs;
    if (typeof perTurnWrapMs === 'number') ptb.wrapMs = perTurnWrapMs;
    ACTIVE_PROFILE = { ...ACTIVE_PROFILE, perTurnBudget: ptb };
  }
  // Plan 0473 P6 — likewise an explicit `floorThresholds` at session start OVERRIDES/MERGES the active
  // profile's floorThresholds knob (enable + tune the load levels), threaded THROUGH the SAME knob shape
  // (never a code branch) so the floor engine keeps reading them from api.profile().floorThresholds.
  // Absent ⇒ the profile's own floorThresholds govern (wearable = disabled → floor is a no-op).
  if (floorThresholds && typeof floorThresholds === 'object') {
    ACTIVE_PROFILE = { ...ACTIVE_PROFILE, floorThresholds: { ...(ACTIVE_PROFILE.floorThresholds || {}), ...floorThresholds } };
  }
  // Plan 0473 P0: audio-in is OPTIONAL, DEFAULT OFF. Explicit boolean wins; else the env flag; else off.
  // When off, the served presenter.html carries ZERO voice code (strip below) — the audience display
  // is byte-clean of voice. The unified inbox + typed chat are NOT voice and stay on regardless.
  const VOICE_ENABLED = (typeof voiceEnabled === 'boolean') ? voiceEnabled : envVoiceEnabled();
  // AUTH-1: a shared secret gates the control roles (presenter/ai). When null,
  // behaviour is unchanged / LAN-open — any browser may claim a control role.
  const CONTROL_TOKEN = controlToken || process.env.PRESENTER_CONTROL_TOKEN || null;
  // AUTH-ROLE (P5.5): a shared PASSWORD gate via a seeded hash ("keep honest people
  // honest"). The seed is a public salt; the password is secret. ROLE_HASH =
  // sha256(seed + password). The browser computes the same hash and sends it as the
  // hello token — plaintext never leaves the client. NULL password ⇒ this gate is
  // inactive (so createServer() with no credential stays UNGATED for existing tests).
  const ROLE_SEED = roleSeed || process.env.PRESENTER_ROLE_SEED || 'argus-presenter';
  const ROLE_PW = rolePassword || process.env.PRESENTER_ROLE_PASSWORD || null;
  const ROLE_HASH = ROLE_PW ? sha256hex(ROLE_SEED + ROLE_PW) : null;
  // Plan 0472 P4 (SECURITY): the HMAC secret for permissioned GUEST capability links (/?cap=…).
  // From the option or PRESENTER_CAP_SECRET. There is NO insecure default and an empty string is
  // treated as UNSET — when null, capability links are DISABLED and every presented `cap` is rejected.
  // NEVER logged or echoed. Independent of the control-token / role-password gate (a cap never grants
  // a control role; that gate alone governs presenter/ai).
  const CAP_SECRET = capSecret || process.env.PRESENTER_CAP_SECRET || null;
  // In-memory revoked-nonce set. api.revokeCap(nonce) adds; a revoked nonce is rejected on hello even
  // if its HMAC + exp are still valid. In-memory by design (short-lived tokens; a restart = new session).
  const revokedNonces = new Set();
  const conns = new Map();     // ws -> {id,userId,userName,role}
  const byUser = new Map();    // userId -> ws
  let connSeq = 0;             // per-server connection counter -> stable socketId (S5-ready)
  const store = createStore(); // core session state machine (Plan 0435 group B)
  // Current DISPLAY per role / per user (C6): what a (re)connecting client should
  // be shown. A descriptor is re-rendered per connection on hello.
  const displayByRole = {};    // role -> descriptor
  const displayByUser = new Map(); // userId -> descriptor (per-user override)
  // ATT (Plan 0466, decision 1): presenter-gated "roster visible to attendees", DEFAULT OFF.
  // Presenter/ai always see the full roster; a participant attendance-request is answered
  // self-only until the presenter turns this ON. In-memory session state (v0.1).
  let rosterVisibleToAttendees = false;
  const everSeen = new Set();  // userIds seen (to count reconnects)
  let contentModule = null;    // Group I: the current content module { title?, beats:[{component,opts,requires?}] }
  let currentBeat = -1;        // index of the displayed beat
  // X3 telemetry sink (controller-read-only). Feedback from stress points.
  const telem = {
    ops: { applied: 0, denied: 0, malformed: 0, throttled: 0, duplicate: 0 },
    fanout: { sum: 0, count: 0 },
    applyMs: { sum: 0, count: 0, max: 0 },
    reconnects: 0, renderErrors: 0, opApplyFailures: 0,
    rtt: { last: null, sum: 0, count: 0 },
  };
  const telemetryView = () => ({
    ops: { ...telem.ops },
    avgFanout: telem.fanout.count ? +(telem.fanout.sum / telem.fanout.count).toFixed(2) : 0,
    fanoutSamples: telem.fanout.count,
    avgApplyMs: telem.applyMs.count ? +(telem.applyMs.sum / telem.applyMs.count).toFixed(3) : 0,
    maxApplyMs: +telem.applyMs.max.toFixed(3),
    reconnects: telem.reconnects, renderErrors: telem.renderErrors, opApplyFailures: telem.opApplyFailures,
    rtt: { last: telem.rtt.last, avg: telem.rtt.count ? +(telem.rtt.sum / telem.rtt.count).toFixed(1) : null, samples: telem.rtt.count },
  });
  const polls = new Map();     // promptId -> {spec, votes:Map(userId->{value,userName,ts}), open}
  const acks = new Map();      // ackId -> { message, requestedAt, target, by:Map(userId->{userName,at}) } — eyes-on handshake
  const lastResults = {};      // PRIM-results: promptId -> { userId -> {type,value} } (last beat result per user)
  const listeners = { presence: [], result: [], poll: [], transcript: [], inbox: [], turnComplete: [] };
  const emit = (ev, data) => listeners[ev].forEach((cb) => { try { cb(data); } catch (e) {} });

  const CONTROL = join(__dirname, 'control.html');
  const BRANDING = join(__dirname, 'branding', 'argus-presenter.svg');
  const LIB = join(__dirname, '..', 'lib');   // Plan 0470: voice-stub/capture/worklet live in repo lib/
  // --- Content-module registry. Modules are LOCAL JSON files (NOT the web) in MODULES_DIR
  // (default ./modules; set PRESENTER_MODULES_DIR to point at your content, e.g. a campaign's
  // adventures/). Read + validated on demand, cached by file mtime so repeat loads are snappy.
  const MODULES_DIR = process.env.PRESENTER_MODULES_DIR || join(__dirname, '..', 'modules');
  const moduleCache = new Map();   // id -> { mtimeMs, module }
  function readModuleFile(id) {
    if (!/^[\w.-]+$/.test(id)) return null;          // no path traversal
    const file = join(MODULES_DIR, id + '.json');
    if (!existsSync(file)) return null;
    const mtimeMs = statSync(file).mtimeMs;
    const hit = moduleCache.get(id);
    if (hit && hit.mtimeMs === mtimeMs) return hit.module;   // cache hit
    const module = JSON.parse(readFileSync(file, 'utf8'));
    moduleCache.set(id, { mtimeMs, module });
    return module;
  }
  // Summarize ONE module id into the shape the GM <select> uses. Shared by listModules
  // and series resolution (/api/series/:id) so a series' modules describe identically to
  // the flat list. `missing` = the error string when the id resolves to no file.
  function moduleSummary(id, missing = 'unreadable') {
    let module; try { module = readModuleFile(id); } catch (e) { return { id, error: String(e.message || e).slice(0, 80) }; }
    if (!module) return { id, error: missing };
    const man = module.manifest || {};
    const v = summarize(validate(module));
    return { id, title: man.title || module.title || id, version: man.version || null,
      beats: (module.beats || []).length, sections: (module.sections || []).length, warn: v.warn, info: v.info };
  }
  function listModules() {
    if (!existsSync(MODULES_DIR)) return [];
    // SKIP *.series.json — those are SERIES manifests (an ordered list of module ids), not modules.
    return readdirSync(MODULES_DIR)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.series.json'))
      .map((f) => moduleSummary(f.slice(0, -5)))
      // Keep ONLY real content modules: drop unreadable/non-module files (error), and drop
      // JSON that parses but is not a content module (no beats AND no sections — e.g. a stray
      // *-responses.json log). Prevents bogus 0-beat entries in the GM <select>.
      .filter((m) => !m.error && !(m.beats === 0 && m.sections === 0));
  }
  // --- Series registry. A SERIES is the level above Module: a file `<id>.series.json` =
  // { manifest:{title,summary?}, moduleIds:[...] } listing modules to walk in order.
  function readSeriesFile(id) {
    if (!/^[\w.-]+$/.test(id)) return null;               // reuse the module path-guard
    const file = join(MODULES_DIR, id + '.series.json');
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  function listSeries() {
    if (!existsSync(MODULES_DIR)) return [];
    return readdirSync(MODULES_DIR)
      .filter((f) => f.endsWith('.series.json'))
      .map((f) => {
        const id = f.slice(0, -('.series.json'.length));
        let s; try { s = readSeriesFile(id); } catch (e) { return null; }   // skip unreadable
        if (!s) return null;
        const man = s.manifest || {};
        return { id, title: man.title || id, count: (s.moduleIds || []).length };
      })
      .filter(Boolean);
  }
  // AUT-2: hot-reload. Watch MODULES_DIR; when a *.json module file changes on disk,
  // invalidate its cache and notify the control roles (presenter/ai) so a just-
  // edited/just-saved module is discoverable without a server restart. Debounced —
  // fs.watch fires duplicate/rapid events; coalesce with a short trailing timer per id.
  let watcher = null;
  const hotTimers = new Map();   // id -> trailing debounce timer
  function notifyModuleChanged(id) {
    moduleCache.delete(id);
    for (const [ws, c] of conns.entries())
      if (c.role === 'presenter' || c.role === 'ai') send(ws, { t: 'module-changed', id });
    log.info('module', 'changed', { id });
  }
  try {
    if (existsSync(MODULES_DIR)) {
      watcher = watch(MODULES_DIR, (evt, filename) => {
        if (!filename || !filename.endsWith('.json')) return;
        const id = filename.replace(/\.json$/, '');
        if (hotTimers.has(id)) clearTimeout(hotTimers.get(id));
        hotTimers.set(id, setTimeout(() => { hotTimers.delete(id); notifyModuleChanged(id); }, 150));
      });
    }
  } catch (e) { log.warn('module', 'watch-failed', { err: String((e && e.message) || e).slice(0, 80) }); }
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/?')) {
      // Plan 0473 P0: strip the voice block(s) unless voice is enabled ⇒ zero voice bytes when off.
      res.writeHead(200, htmlHeaders());
      res.end(renderPresenterPage(VOICE_ENABLED));
    } else if (req.url === '/control' || req.url.startsWith('/control?')) {
      res.writeHead(200, htmlHeaders());
      res.end(readFileSync(CONTROL, 'utf8'));
    } else if (req.url === '/creator' || req.url.startsWith('/creator?')) {
      // AUT-3: the Content Creator authoring panel (beat-list editor + manifest + in-browser
      // validate + live preview). Served exactly like /control.
      res.writeHead(200, htmlHeaders());
      res.end(readFileSync(join(__dirname, 'creator.html'), 'utf8'));
    } else if (req.url === '/branch.mjs') {
      // DEL-2: serve the SINGLE-SOURCE branch resolver to the browser panel so the
      // GM outline imports the SAME resolveNext the server/runner use (no duplication).
      sendStatic(res, req, join(__dirname, 'branch.mjs'), 'text/javascript; charset=utf-8');
    } else if (req.url === '/validate.mjs') {
      // AUT-3: serve the SINGLE-SOURCE validator so the Content Creator imports the SAME
      // validate()/summarize() the server uses (no duplication) for in-browser validation.
      sendStatic(res, req, join(__dirname, 'validate.mjs'), 'text/javascript; charset=utf-8');
    } else if (req.url === '/lib/voice-stub.js') {
      // Plan 0470 Tier 0: the sub-1KB always-on voice stub (dynamic-imports Tier 1 on enable()).
      sendStatic(res, req, join(LIB, 'voice-stub.js'), 'text/javascript; charset=utf-8');
    } else if (req.url === '/lib/voice-capture.mjs') {
      // Plan 0470 Tier 1 controller — served only when a client enable()s voice (T-LAZY).
      sendStatic(res, req, join(LIB, 'voice-capture.mjs'), 'text/javascript; charset=utf-8');
    } else if (req.url === '/lib/voice-worklet.js') {
      // Plan 0470 Tier 1 DSP worklet (pure JS; loaded via audioWorklet.addModule).
      sendStatic(res, req, join(LIB, 'voice-worklet.js'), 'text/javascript; charset=utf-8');
    } else if (req.url === '/branding/argus-presenter.svg') {
      // Default idle branding art (self-contained animated SVG; no external dep).
      sendStatic(res, req, BRANDING, 'image/svg+xml; charset=utf-8');
    } else if (req.url === '/api/auth' || req.url.startsWith('/api/auth?')) {
      // AUTH-ROLE (P5.5): tell the client whether the presenter role is gated + the public
      // SALT it must hash with. NEVER returns ROLE_HASH, ROLE_PW, or CONTROL_TOKEN — only the
      // seed (public by design) and a boolean. The browser computes sha256(seed+password).
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(JSON.stringify({ gated: !!(CONTROL_TOKEN || ROLE_HASH), seed: ROLE_SEED }));
    } else if (req.url === '/api/modules') {
      // Discover available modules (id, title, counts, validation summary) — for the GM panel's SELECT list.
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(listModules()));
    } else if (req.url.startsWith('/api/modules/')) {
      const rawPath = req.url.slice(13);
      const id = decodeURIComponent(rawPath.split('?')[0]);
      if (req.method === 'POST') {
        // AUT-1: module write-back. The Content Creator POSTs a module JSON; it lands in
        // MODULES_DIR so listModules()/the GM <select> discovers it. MUTATION → guarded:
        // AUTH-gated (when a control token is configured), path-safe id, hard size cap.
        // AUTH: if a control token is set, require it (header or ?token=); else 403.
        if (CONTROL_TOKEN) {
          const q = rawPath.split('?')[1] || '';
          const qtoken = new URLSearchParams(q).get('token');
          const token = req.headers['x-control-token'] || qtoken;
          if (token !== CONTROL_TOKEN) { res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
        }
        // id guard: no path separators / traversal (reuse readModuleFile's rule).
        if (!/^[\w.-]+$/.test(id)) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'bad id' })); return; }
        // Body with a HARD size cap — accumulate, abort past the cap.
        const CAP = 512 * 1024;
        let body = ''; let aborted = false;
        req.on('data', (chunk) => {
          if (aborted) return;
          body += chunk;
          if (body.length > CAP) { aborted = true; res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'too large' })); req.destroy(); }
        });
        req.on('end', () => {
          if (aborted) return;
          let module;
          try { module = JSON.parse(body); } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'invalid json' })); return; }
          try {
            writeFileSync(join(MODULES_DIR, id + '.json'), JSON.stringify(module, null, 2));
            moduleCache.delete(id);   // invalidate so the next read reflects the write
          } catch (e) { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: String(e.message || e) })); return; }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, id, validation: summarize(validate(module)) }));
        });
        return;
      }
      // Fetch ONE module (full JSON + validation) so the panel can validate-then-load.
      let module = null; try { module = readModuleFile(id); } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: String(e.message || e) })); return; }
      if (!module) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ id, module, validation: summarize(validate(module)) }));
    } else if (req.url === '/api/series') {
      // Discover available series (id, title, module count) — for the GM panel's series SELECT.
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(listSeries()));
    } else if (req.url.startsWith('/api/series/')) {
      // Fetch ONE series: its manifest + moduleIds, plus each module resolved to the SAME
      // summary shape as listModules (missing ids → { id, error:'missing' }).
      const id = decodeURIComponent(req.url.slice(12).split('?')[0]);
      if (!/^[\w.-]+$/.test(id)) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'bad id' })); return; }
      let series = null; try { series = readSeriesFile(id); } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: String(e.message || e) })); return; }
      if (!series) { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'not found' })); return; }
      const modules = (series.moduleIds || []).map((mid) => moduleSummary(mid, 'missing'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(JSON.stringify({ id, series, modules }));
    } else if (req.url === '/api/situation' || req.url.startsWith('/api/situation?')) {
      // Plan 0473 P8 — the HUMAN DIGEST FACE reads the SAME bounded WORKING SET the AI consumes via
      // presenter_situation. GET returns api.situation for a per-page consumer id (server-held cursor),
      // so the human face (control.html) and the AI face (MCP) are ONE working set. OPSEC: the roster in
      // the digest carries control-only fields (ip/socketId), so this is GATED behind the control
      // credential when one is configured — parity with the presence feed + module write-back. Ungated
      // server (LAN/tests, no credential) → open, like the rest of the control surface.
      if (!httpControlAuthed(req)) { res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
      const cid = new URLSearchParams((req.url.split('?')[1] || '')).get('c') || 'default';
      Promise.resolve(api.situation({ consumerId: 'ctl:' + cid })).then((sit) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(sit));
      }).catch((e) => { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: String((e && e.message) || e) })); });
    } else if (req.url === '/api/work' || req.url.startsWith('/api/work?')) {
      // Plan 0473 P8 — the HUMAN one-click resolve/claim/defer. A digest button POSTs {id, op, note?,
      // owner?}; the op routes through the SAME api.resolveWork / claimWork / deferWork the MCP tools
      // call — so the two faces never disagree (server-tracked status/owner prevent double-handling).
      if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'method not allowed' })); return; }
      if (!httpControlAuthed(req)) { res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
      const CAP = 16 * 1024; let body = ''; let aborted = false;
      req.on('data', (chunk) => { if (aborted) return; body += chunk; if (body.length > CAP) { aborted = true; res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'too large' })); req.destroy(); } });
      req.on('end', () => {
        if (aborted) return;
        let msg; try { msg = JSON.parse(body || '{}'); } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'invalid json' })); return; }
        const id = msg && msg.id, op = msg && msg.op;
        if (typeof id !== 'string' || !id) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'missing id' })); return; }
        let item = null;
        if (op === 'resolve') item = api.resolveWork(id, { note: msg.note != null ? String(msg.note) : null });
        else if (op === 'claim') item = api.claimWork(id, { owner: msg.owner != null ? String(msg.owner) : 'presenter' });
        else if (op === 'defer') item = api.deferWork(id);
        else { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'bad op (resolve|claim|defer)' })); return; }
        if (!item) { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'no such actionable item' })); return; }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, item }));
      });
    } else { res.writeHead(404); res.end('not found'); }
  });
  // Plan 0473 P8 — control-credential gate for the HTTP working-set surface (situation + work). Mirrors
  // the WS control-role rule (L~501): GRANTED iff ungated (no token AND no password hash) OR the request
  // carries a token (x-control-token header, or ?token=) that matches CONTROL_TOKEN or ROLE_HASH.
  function httpControlAuthed(req) {
    const gated = !!(CONTROL_TOKEN || ROLE_HASH);
    if (!gated) return true;
    const q = new URLSearchParams((req.url.split('?')[1] || ''));
    const token = req.headers['x-control-token'] || q.get('token');
    return (CONTROL_TOKEN && token === CONTROL_TOKEN) || (ROLE_HASH && token === ROLE_HASH);
  }
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD });

  function send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch (e) {} }
  // Plan 0468 (Part A0): the heartbeat. The server pings every open socket every PING_MS; the
  // client replies {t:'pong'} (inbound traffic ⇒ c.lastSeen refreshed at L~338), so a silent but
  // connected client stays fresh (GREEN). A frozen/half-open socket stops ponging ⇒ lastSeen goes
  // stale ⇒ RED within STALE_MS. Cleared in close() (INV-7). unref so it never keeps the loop alive.
  const heartbeat = setInterval(() => {
    const ts = Date.now();
    for (const [ws] of conns) { if (ws.readyState === 1) { try { send(ws, { t: 'ping', ts }); } catch {} } }
  }, PING_MS);
  heartbeat.unref?.();
  function presence() { return [...conns.values()].map((c) => ({ userId: c.userId, userName: c.userName, role: c.role, eyesOn: c.eyesOn || null })); }
  // Full presence (incl. IP + socketId + current display id) pushed to CONTROL roles only, for the GM user list.
  function pushPresence() {
    // No-op unless a control client (presenter/ai) is actually listening — avoids building/sending
    // the presence feed on every display change when nobody's watching.
    const ctl = [...conns.values()].filter((c) => c.role === 'presenter' || c.role === 'ai');
    if (!ctl.length) return;
    const users = [...conns.values()].map((c) => ({ userId: c.userId, userName: c.userName, role: c.role, ip: c.ip, socketId: c.id, lastSeen: c.lastSeen, display: displayIdFor(c), eyesOn: c.eyesOn || null }));
    for (const [ws, c] of conns.entries()) if (c.role === 'presenter' || c.role === 'ai') send(ws, { t: 'presence', users });
  }
  // PRIM-results: forward a beat result (answer/continue) to CONTROL roles ONLY (presenter/ai),
  // mirroring pushPresence's OPSEC filter — participants must never receive a `t:'result'` frame.
  function pushResult(r) {
    for (const [ws, c] of conns.entries())
      if (c.role === 'presenter' || c.role === 'ai')
        send(ws, { t: 'result', promptId: r.promptId, userId: r.userId, userName: r.userName, type: r.type, value: r.value });
  }
  // A short label for what a given connection is currently showing (for the user list / tiny preview).
  function displayIdFor(c) {
    const d = displayByUser.get(c.userId) || displayByRole[c.role];
    if (!d) return 'idle';
    if (d.kind === 'content') return d.contentId || 'content';
    if (d.kind === 'component') return (d.opts && d.opts.promptId) || d.component || 'component';
    return d.kind || 'display';
  }
  function targets(target) {
    if (target === 'all' || target == null) return [...conns.keys()];
    if (['participant', 'presenter', 'ai'].includes(target))
      return [...conns.entries()].filter(([, c]) => c.role === target).map(([ws]) => ws);
    const ws = byUser.get(target); return ws ? [ws] : [];   // by userId
  }

  wss.on('connection', (ws, req) => {
    if (conns.size >= MAX_CONNS) { log.warn('conn', 'cap-reached', { conns: conns.size }); try { ws.close(1013, 'server busy'); } catch {} return; }
    // Capture client IP (x-forwarded-for through a proxy, else the socket peer). Shown ONLY to
    // presenter/ai in the user list — never broadcast to participants.
    const ip = ((req && (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress))) || '').toString().split(',')[0].trim() || null;
    // ATT (Plan 0466 / reworked 0468): connectedAt = this connection's start (connectedSec; RESETS on
    // reconnect — a reconnect is a NEW connection record). lastSeen (keepalive, refreshed by the Part A0
    // heartbeat's pong) drives the connection-liveness dot. lastActive stays in the struct (still set on
    // deliberate interaction) but Plan 0468 no longer surfaces it or anything derived from it (G5).
    conns.set(ws, { id: 'c' + (++connSeq), userId: null, userName: null, role: 'participant', lastSeen: Date.now(), connectedAt: Date.now(), lastActive: 0, ip });
    ws.on('message', (buf, isBinary) => {
      // Plan 0470 (RT-6): the binary PCM lane branches BEFORE JSON.parse — audio is NEVER
      // parsed as JSON, is exempt from the durable-op cap, and is ignored unless the conn
      // has an active voice session (RT-7). Route it and return.
      if (isBinary) { handleVoiceBinary(conns.get(ws), ws, buf); return; }
      let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
      const c = conns.get(ws);
      if (c) c.lastSeen = Date.now();   // liveness (X4)
      if (m.t === 'hello') {
        c.userId = m.userId || ('anon-' + Math.random().toString(36).slice(2, 8));
        c.userName = m.userName || c.userId;
        // Plan 0472 P4 (SECURITY): a signed, scoped, revocable GUEST capability link (?cap=<token>).
        // The HMAC is verified over the RAW payload bytes BEFORE any field is trusted; exp + revocation
        // are enforced; the rejection reason stays INTERNAL (a generic warn only — never the reason or
        // any secret/nonce is surfaced). A presented cap makes this connection a GUEST: role is
        // HARD-FORCED to participant (never presenter/ai, whatever the payload/hello claims), identity +
        // scope come from the (authentic) token, and the client CANNOT widen either. Disabled entirely
        // when no secret is configured. A cap NEVER bypasses the control gate below — it is a separate,
        // guest-only path.
        let capGrant = null;
        if (m.cap) {
          if (CAP_SECRET) {
            try {
              const v = verifyCapability(m.cap, CAP_SECRET, { now: Date.now(), isRevoked: (n) => revokedNonces.has(n) });
              if (v.ok) capGrant = v.payload;
              else log.warn('cap', 'invalid-capability', { socketId: c.id });   // GENERIC: no reason, no secret material
            } catch (e) { log.warn('cap', 'invalid-capability', { socketId: c.id }); }   // never let a bad token crash the conn
          } else {
            log.warn('cap', 'capability-disabled', { socketId: c.id });   // links disabled: no secret configured
          }
        }
        if (capGrant) {
          // GUEST identity: participant only. Attribution is bound to the token nonce (not client-claimed),
          // so a guest can neither impersonate another userId nor promote itself.
          c.role = 'participant';
          c.isGuest = true;
          c.capScope = capGrant.scope;
          c.capNonce = capGrant.nonce;
          c.userId = 'guest:' + capGrant.nonce;
          if (capGrant.name) c.userName = capGrant.name;
        } else {
          // AUTH-1 / AUTH-ROLE: control roles require a credential when one is configured.
          // GRANTED iff: ungated (no token AND no password hash) OR the hello token matches
          // CONTROL_TOKEN (when set) OR it matches ROLE_HASH (the seeded password hash, when
          // set). Otherwise downgrade to participant. CONTROL_TOKEN-only behaves exactly as
          // before; neither configured ⇒ ungated (LAN-open back-compat).
          let reqRole = m.role || 'participant';
          if (reqRole === 'presenter' || reqRole === 'ai') {
            const gated = !!(CONTROL_TOKEN || ROLE_HASH);
            const ok = !gated
              || (CONTROL_TOKEN && m.token === CONTROL_TOKEN)
              || (ROLE_HASH && m.token === ROLE_HASH);
            if (!ok) {
              log.warn('auth', 'control-denied', { userId: c.userId, role: reqRole });
              reqRole = 'participant';
            }
          }
          c.role = reqRole;
        }
        byUser.set(c.userId, ws);
        // welcome.role = the EFFECTIVE granted role, so the client learns if it was
        // silently downgraded (wrong/absent password) and can surface feedback.
        // RT-26 consent surface: tell every client whether recognized speech is being written to
        // disk. Default false (ephemeral-only) — saving people's words silently is a consent violation.
        // For a GUEST (capability link), surface guest:true + the granted scope so the client knows
        // exactly what it may do (talk/type) — the same consent/transparency surface as any participant.
        send(ws, { t: 'welcome', userId: c.userId, socketId: c.id, role: c.role, transcriptPersisting: TRANSCRIPT_PERSIST, ...(c.isGuest ? { guest: true, scope: c.capScope } : {}) });
        // C4/X1: converge the (re)connecting client. If it reports a lastVersion we
        // can still replay from the op-log, send only the MISSED ops (resync);
        // otherwise a full role-filtered snapshot (Memento).
        resyncOrSnapshot(ws, c, m.lastVersion);
        redisplayFor(ws, c);   // C6: re-push the currently-displayed content module
        if (everSeen.has(c.userId)) telem.reconnects++; else everSeen.add(c.userId);
        send(ws, { t: 'ping', ts: Date.now() });   // X3 RTT probe
        log.info('conn', 'hello', { socketId: c.id, userId: c.userId, role: c.role, lastVersion: m.lastVersion || 0 });
        updateChatListeners();   // P3
        emit('presence', presence()); pushPresence();
      } else if (m.t === 'result') {
        if (c) c.lastActive = Date.now();   // ATT: beat answer/continue + poll vote = deliberate human interaction
        // Authoritative identity from the connection, NOT the client payload.
        const r = Object.assign({}, m.msg, { userId: c.userId, userName: c.userName, channel: c.userId });
        shimAnswer(c, r);      // D2: poll vote (and generic answer) -> store op
        emit('result', r);     // map view/click/pointer are store ops now (E1-E4) — no relay
        // PRIM-results: track last result per prompt and forward to CONTROL roles ONLY (OPSEC:
        // presenter/ai — participants must NEVER receive a peer's answer/continue).
        // Auditor: only meaningful results (answer/continue) — drop lifecycle events (ready/step/change/
        // flow-complete) that carry the SAME promptId and would false-trigger DEL-2 branch nav (S190 gotcha).
        if (r.promptId != null && (r.type === 'answer' || r.type === 'continue')) {
          lastResults[r.promptId] = lastResults[r.promptId] || {};
          lastResults[r.promptId][r.userId] = { type: r.type, value: r.value };
          pushResult(r);
        }
      } else if (m.t === 'op') {
        handleOp(c, m);
      } else if (m.t === 'control') {
        handleControl(c, m, ws);
      } else if (m.t === 'pong') {
        if (typeof m.ts === 'number') { const rtt = Date.now() - m.ts; telem.rtt.last = rtt; telem.rtt.sum += rtt; telem.rtt.count++; }
      } else if (m.t === 'telemetry') {
        if (m.kind === 'render-error') telem.renderErrors++;
        else if (m.kind === 'op-apply-failure') telem.opApplyFailures++;
        else if (m.kind === 'rtt' && typeof m.value === 'number') { telem.rtt.last = m.value; telem.rtt.sum += m.value; telem.rtt.count++; }
      } else if (m.t === 'request-poll') {
        emit('poll', { type: 'request', from: { userId: c.userId, userName: c.userName }, spec: m.spec });
      } else if (m.t === 'ack') {
        // Eyes-on acknowledgement: the viewer clicked CONFIRM on a requireAck chime.
        const ackId = (m && m.ackId) || 'ready';
        c.eyesOn = Date.now();                              // this connection is confirmed watching (not AFK)
        c.lastActive = Date.now();                          // ATT: eyes-on CONFIRM click = deliberate interaction
        let a = acks.get(ackId);
        if (!a) { a = { message: null, requestedAt: null, target: 'all', by: new Map() }; acks.set(ackId, a); }
        a.by.set(c.userId, { userName: c.userName, at: c.eyesOn });
        log.info('ack', 'eyes-on', { ackId, userId: c.userId });
        pushPresence();                                    // control user-list reflects eyes-on immediately
      } else if (m.t === 'attendance-request') {
        // ATT (Plan 0466 §2.5): request/reply — NO standing push. Redaction is SERVER-SIDE,
        // keyed on the CONNECTION's authoritative role. Control/ai always get the full roster;
        // a participant gets the redacted roster ONLY when the presenter gate is ON, else self-only.
        const control = (c.role === 'presenter' || c.role === 'ai');
        // Plan 0468: no activity thresholds — connection liveness only. Pass optional staleMs; else default.
        if (control) {
          const att = api.attendance({ staleMs: m.staleMs, viewerRole: c.role });
          send(ws, { t: 'attendance', roster: att.roster, summary: att.summary, rosterVisible: rosterVisibleToAttendees });
        } else if (rosterVisibleToAttendees) {
          const att = api.attendance({ staleMs: m.staleMs, viewerRole: 'participant' });
          send(ws, { t: 'attendance', roster: att.roster, summary: att.summary });
        } else {
          // gate OFF ⇒ deny = self-only (decision 1). Reuse the redacted build, filter to self.
          const att = api.attendance({ staleMs: m.staleMs, viewerRole: 'participant' });
          const self = att.roster.filter((r) => r.userId === c.userId);
          const summary = {
            connected: self.filter((r) => r.connected).length,
            offline: self.filter((r) => !r.connected).length,
            eyesOn: self.filter((r) => r.eyesOn).length,
            total: self.length,
          };
          send(ws, { t: 'attendance', roster: self, summary });
        }
      } else if (m.t === 'voice_seg_start') {
        // Plan 0470: control frame bracketing an utterance (binary PCM follows on the same conn).
        voiceSegStart(c, ws, m);
      } else if (m.t === 'voice_seg_end') {
        voiceSegFinalize(c, ws, {});   // finalize -> WAV -> WARM ASR -> transcript out
      } else if (m.t === 'chat') {
        // Plan 0472: typed text is FIRST-CLASS input. Land it in the unified inbox attributed to the
        // SERVER-AUTHORITATIVE connection identity (never the client payload). D5 = DUAL-WRITE: also
        // drive the chat STORE slice so the existing read-perm'd chat display (P3) keeps working.
        // Plan 0472 P4: a GUEST may type ONLY if its capability scope includes 'type' (the scope is
        // token-signed, so it cannot be widened by the client). Non-guests are unaffected.
        if (c && c.isGuest && !(c.capScope || []).includes('type')) { log.warn('cap', 'type-out-of-scope', { socketId: c.id }); return; }
        if (c && typeof m.text === 'string' && m.text.length) {
          c.lastActive = Date.now();   // ATT: typing = deliberate human interaction
          emitInbox({ kind: 'text', userId: c.userId, userName: c.userName, role: c.role, text: m.text, conf: null, final: true, isGuest: !!c.isGuest });
          const id = (typeof m.id === 'string' && m.id) ? m.id : (c.userId + '-' + Date.now());
          handleOp(c, { path: 'chat', verb: 'add', value: { id, text: m.text, name: c.userName } });   // display slice (best-effort; perm-gated)
        }
      }
    });
    ws.on('close', () => {
      const c = conns.get(ws);
      if (c && c.voice && c.voice.active) { if (c.voice.timer) clearTimeout(c.voice.timer); c.voice.active = false; voiceSessions = Math.max(0, voiceSessions - 1); }   // RT-14: drop an orphaned open segment
      if (c && c.userId) byUser.delete(c.userId); conns.delete(ws); updateChatListeners(); emit('presence', presence());
      evaluateFloor();   // Plan 0473 P6: a disconnect can lower the load (speaker gone) — reassess the floor
    });
  });

  // ---- Op protocol (Plan 0435 C3): {t:'op'} -> store.apply -> broadcast diff ----
  // Identity is the CONNECTION record (S1); opId is namespaced by conn id (S5) so a
  // client cannot forge/suppress another's dedup. Diffs are read-perm filtered per
  // recipient (S7). Broadcast-all v1 (§7 Q1).
  function handleOp(c, m) {
    if (c) c.lastActive = Date.now();   // ATT: any store op (chat/slider/form/pointer/vote) = deliberate human interaction
    // X6 per-conn rate limit on DURABLE ops (ephemeral is coalesced/uncapped).
    if (!isEphemeral(m && m.path)) {
      const now = Date.now();
      if (!c.rl || now - c.rl.winStart >= 1000) c.rl = { winStart: now, count: 0, warned: false };
      c.rl.count++;
      if (c.rl.count > DURABLE_OPS_PER_SEC) {
        telem.ops.throttled++;
        if (!c.rl.warned) { log.warn('rl', 'throttled', { socketId: c.id, path: m && m.path }); c.rl.warned = true; }
        return;   // drop excess
      }
    }
    const opId = c.id + ':' + (m.opId != null ? String(m.opId) : ('a' + Math.random().toString(36).slice(2, 8)));
    const op = { path: m.path, verb: m.verb, value: m.value, opId };
    if (!validOp(op)) { telem.ops.malformed++; log.debug('op', 'malformed', { socketId: c.id, path: m && m.path }); return; }
    const t0 = Date.now();
    const res = store.apply(op, { userId: c.userId, role: c.role });
    telem.applyMs.sum += (Date.now() - t0); telem.applyMs.count++; telem.applyMs.max = Math.max(telem.applyMs.max, Date.now() - t0);
    if (res && res.diff) {
      telem.ops.applied++;
      if (res.ephemeral) queueEphemeral(res.diff, res);   // X2 — coalesce, not logged
      else broadcastDiff(res.diff, res);
      log.trace('op', 'applied', { socketId: c.id, path: m.path, verb: m.verb, by: res.by, version: res.version, ephemeral: !!res.ephemeral }, { roles: ['presenter', 'ai'] });
    } else if (res && res.duplicate) {
      telem.ops.duplicate++;
      log.trace('op', 'duplicate', { socketId: c.id, opId });
    } else {
      telem.ops.denied++;
      log.debug('op', 'denied', { socketId: c.id, path: m.path, verb: m.verb, by: c.userId });
    }
  }

  // X1: converge a (re)connecting client. Replay missed ops if the requested
  // lastVersion is still covered by the retained op-log; else a full snapshot.
  function resyncOrSnapshot(ws, c, lastVersion) {
    const lv = (typeof lastVersion === 'number' && lastVersion >= 0) ? lastVersion : 0;
    const log = store.oplogSince(0);
    const earliest = log.length ? log[0].version : store.version() + 1;
    const canReplay = lv > 0 && lv <= store.version() && lv >= earliest - 1;
    if (canReplay) {
      const missed = store.oplogSince(lv);
      send(ws, { t: 'resync', from: lv, to: store.version(), count: missed.length });
      for (const e of missed) {
        const visible = {};
        for (const p of Object.keys(e.diff)) if (store.perms.canRead(c.role, p)) visible[p] = e.diff[p];
        if (Object.keys(visible).length) send(ws, { t: 'host', msg: { source: 'argus-host', type: 'diff', diff: visible, by: e.by, version: e.version } });
      }
    } else {
      send(ws, { t: 'snapshot', state: store.snapshot(c.role).state, version: store.version() });
    }
  }

  // Apply an op on the server's behalf (system controller by default) and broadcast
  // the resulting durable diff. Used to seed/close polls and to shim answers to ops.
  // P3: publish the count of attached LISTENERS (presenter/ai) so participant chat
  // inputs enable only when someone is listening. Sent as a transient control
  // message (NOT a store op) — presence-derived, must not grow the durable state.
  function currentListeners() { return [...conns.values()].filter((c) => c.role === 'presenter' || c.role === 'ai').length; }
  function updateChatListeners() {
    const count = currentListeners();
    for (const ws of conns.keys()) send(ws, { t: 'chat_listeners', n: count });
  }

  function serverApply(op, actor) {
    const res = store.apply(op, actor || { userId: 'server', role: 'system' });
    if (res && res.diff && !res.ephemeral) broadcastDiff(res.diff, res);
    return res;
  }

  // P1: presenter control-message handler — the SAME server API the AI/MCP drives.
  // Presenter/ai only (server-authoritative role, S1/S2); others are ignored.
  function handleControl(c, m, ws) {
    if (c.role !== 'presenter' && c.role !== 'ai') { log.warn('control', 'denied', { socketId: c.id, role: c.role }); return; }
    const a = m.args || {};
    switch (m.action) {
      // PRIM-mirror (MON-2): render the TARGET user's current display in the target's
      // OWN context, then PUSH it back to THIS requesting control client (fire-and-forget,
      // not a reply). Lets the GM thumbnail "what that user sees". OPSEC: role-gated above.
      case 'mirror': {
        const uid = a.userId;
        const tws = byUser.get(uid);
        const tc = tws ? conns.get(tws) : null;
        const desc = displayByUser.get(uid) || (tc && displayByRole[tc.role]) || null;
        const html = (desc && tc) ? descToHtml(tc, desc) : null;
        send(ws, { t: 'mirror', userId: uid, html });
        break;
      }
      // Bell as a control: playable from the control page (🔔) and the verify-watching
      // path (👁 = bell + requireAck) via the SAME api.chime method the MCP tools drive.
      case 'bell': api.chime(a); break;
      case 'push_component': api.pushComponent(a.target || 'all', a.component, a.opts || {}, a.theme || 'argus', a.requires || []); break;
      case 'open_poll': api.openPoll(a); break;
      case 'close_poll': api.closePoll(a.promptId); break;
      case 'reload_clients': api.reloadClients(a.target || 'all', a.delay || 0); break;
      case 'clear': api.clear(a.target || 'all'); break;   // route through api.clear so display descriptor is also reset (reconnect → branding)
      // MON-1: drop a user's per-user override so they follow their ROLE/default display
      // again (or branding if the role has none). DISTINCT from clear(): clear BLANKS to
      // branding; reset_user RETARGETS to the role display. Role-gated above.
      case 'reset_user': {
        const uid = a.userId;
        displayByUser.delete(uid);
        const tws = byUser.get(uid);
        const tc = tws ? conns.get(tws) : null;
        const desc = tc ? displayByRole[tc.role] : null;
        if (tws && tc) { if (desc) renderDisplay(tws, tc, desc); else send(tws, { t: 'clear' }); }
        pushPresence();
        break;
      }
      case 'op': handleOp(c, { path: a.path, verb: a.verb, value: a.value, opId: a.opId }); break;   // drive an op as the presenter
      // ATT (Plan 0466, decision 1): presenter toggles whether attendees may see the roster.
      case 'set_roster_visible': rosterVisibleToAttendees = !!a.value; log.info('att', 'roster-visible', { value: rosterVisibleToAttendees }); break;
      case 'voice_enable': api.voiceEnable(a.target || 'all'); break;   // Plan 0470: request inbound voice on a target
      case 'set_module': api.setModule(a.module || { beats: a.beats || [] }); break;   // Group I
      case 'show_beat': api.showBeat(a.id != null ? a.id : (a.index | 0)); break;   // by id (branch nav) or index
      case 'show_default': api.showDefault(); break;   // DEF-1: Home → module title page (or branding fallback)
      case 'next_beat': api.nextBeat(); break;
      case 'prev_beat': api.prevBeat(); break;
      case 'append_beat': api.appendBeat(a.beat || { component: a.component, opts: a.opts, requires: a.requires }); break;   // compose (I2) + AI co-author (I3)
      case 'load_module': api.loadModule(a.module); break;   // I4
      default: log.warn('control', 'unknown-action', { action: m.action });
    }
    log.info('control', m.action, { socketId: c.id });
  }

  function broadcastDiff(diff, meta) {
    let recipients = 0;
    for (const [ws, c] of conns.entries()) {
      const visible = {};
      for (const p of Object.keys(diff)) if (store.perms.canRead(c.role, p)) visible[p] = diff[p];
      if (Object.keys(visible).length) {
        send(ws, { t: 'host', msg: { source: 'argus-host', type: 'diff', diff: visible, by: meta.by, version: meta.version } });
        recipients++;
      }
    }
    telem.fanout.sum += recipients; telem.fanout.count++;   // X3 fan-out measurement
  }

  // X2: ephemeral (pointer/laser) coalescing. Merge latest-per-path and flush at
  // ~15 Hz so a 100 ops/s stream produces a bounded broadcast count. Not logged.
  let ephPending = null, ephTimer = null, ephBy = null;
  function queueEphemeral(diff, meta) {
    if (!ephPending) ephPending = {};
    for (const p of Object.keys(diff)) ephPending[p] = diff[p];   // latest-wins coalesce
    ephBy = meta.by;
    if (!ephTimer) ephTimer = setTimeout(flushEphemeral, 66);
  }
  function flushEphemeral() {
    ephTimer = null;
    const diff = ephPending; ephPending = null;
    if (diff) broadcastDiff(diff, { by: ephBy, version: null });
  }

  // ---- Current-display tracking + per-connection render (C6) ----
  const ROLES = ['participant', 'presenter', 'ai'];
  function setDisplay(target, desc) {
    if (target === 'all' || target == null) { for (const r of ROLES) displayByRole[r] = desc; displayByUser.clear(); }
    else if (ROLES.includes(target)) displayByRole[target] = desc;
    else displayByUser.set(target, desc);   // by userId
    pushPresence();   // keep the GM user-list "currently sees" column live as displays change
  }
  // Stamp identity + apply the OPSEC scene strip via the PERMISSION MODEL (G2):
  // an item is included only if this role may READ its visibility. The scene
  // component keeps a thin client-side filter as defense-in-depth.
  function stampFor(c, component, opts) {
    const o = Object.assign({}, opts, { userId: c.userId, userName: c.userName, channel: c.userId, viewerRole: c.role });
    if (component === 'scene' && Array.isArray(o.items)) o.items = o.items.filter((it) => store.perms.canSeeVisibility(c.role, it.visibility));
    return o;
  }
  function sendComponentTo(ws, c, desc) {
    const o = stampFor(c, desc.component, desc.opts || {});
    send(ws, { t: 'content', contentId: o.promptId || null, html: assemble({ component: desc.component, opts: o, theme: desc.theme || 'argus', requires: desc.requires || [] }) });
  }
  // Produce the HTML STRING for `desc` rendered in viewer `c`'s context — the html-
  // producing half of renderDisplay, factored out for PRIM-mirror (server push of a
  // target's current display back to a control client). Mirrors renderDisplay's branches.
  function descToHtml(c, desc) {
    if (!desc) return '';
    if (desc.kind === 'content') return desc.html || '';
    if (desc.kind === 'component') return assemble({ component: desc.component, opts: stampFor(c, desc.component, desc.opts || {}), theme: desc.theme || 'argus', requires: desc.requires || [] });
    if (desc.kind === 'poll-choice') {
      const poll = polls.get(desc.promptId); if (!poll) return '';
      return assemble({ component: 'choice', opts: { ...poll.spec, promptId: desc.promptId, userId: c.userId, userName: c.userName, channel: c.userId } });
    }
    if (desc.kind === 'poll-results') {
      const poll = polls.get(desc.promptId); if (!poll) return ''; const t = tally(desc.promptId);
      return assemble({ component: 'poll-results', opts: { ...poll.spec, promptId: desc.promptId, tally: t.tally, count: t.count } });
    }
    return '';
  }
  function renderDisplay(ws, c, desc) {
    if (!desc) return;
    if (desc.kind === 'content') send(ws, { t: 'content', contentId: desc.contentId || null, html: desc.html });
    else if (desc.kind === 'component') sendComponentTo(ws, c, desc);
    else if (desc.kind === 'poll-choice') {
      const poll = polls.get(desc.promptId); if (!poll) return;
      send(ws, { t: 'content', contentId: desc.promptId, html: assemble({ component: 'choice', opts: { ...poll.spec, promptId: desc.promptId, userId: c.userId, userName: c.userName, channel: c.userId } }) });
    } else if (desc.kind === 'poll-results') {
      const poll = polls.get(desc.promptId); if (!poll) return; const t = tally(desc.promptId);
      send(ws, { t: 'content', contentId: desc.promptId + ':results', html: assemble({ component: 'poll-results', opts: { ...poll.spec, promptId: desc.promptId, tally: t.tally, count: t.count } }) });
    }
  }
  // On (re)connect: re-push the current content module (GAP fix, C6).
  function redisplayFor(ws, c) {
    const desc = displayByUser.get(c.userId) || displayByRole[c.role];
    if (desc) renderDisplay(ws, c, desc);
  }

  // D2: shim a component 'answer' into a store op. Poll answers -> a per-user vote
  // slice (perm: self); other answers -> answers/{pid}/{self}. Close guard (D4):
  // votes into a closed poll are dropped.
  function shimAnswer(c, r) {
    if (r.type !== 'answer' || r.promptId == null) return;
    const pid = r.promptId;
    const poll = polls.get(pid);
    if (poll) {
      if (!poll.open) return;   // closed -> denied
      const res = serverApply({ path: 'polls/' + pid + '/votes/' + c.userId, verb: 'set', value: r.value }, { userId: c.userId, role: c.role });
      if (res && res.diff) emit('poll', { type: 'update', promptId: pid, ...tally(pid) });   // diff broadcast (serverApply) drives poll-results
    } else {
      serverApply({ path: 'answers/' + pid + '/' + c.userId, verb: 'set', value: r.value }, { userId: c.userId, role: c.role });
    }
  }

  function tally(promptId) {
    const poll = polls.get(promptId); if (!poll) return { tally: {}, count: 0 };
    const counts = {};
    (poll.spec.options || []).forEach((o) => { counts[o.value] = 0; });
    const votes = store.get('polls/' + promptId + '/votes') || {};   // store is authoritative (D2)
    let count = 0;
    for (const uid of Object.keys(votes)) { const v = votes[uid]; counts[v] = (counts[v] || 0) + 1; count++; }
    return { tally: counts, count, spec: poll.spec };
  }

  // ---- Plan 0470: inbound voice (binary PCM lane -> WARM ASR seam -> transcript out) ----
  // The ASR worker is PLUGGABLE (PRESENTER_ASR_CMD) and WARM: created lazily on the first
  // voice-enable / seg-start, model loaded ONCE, kept alive across every segment (RT-17/25).
  let asr = null;
  const segTimeoutMs = parseInt(process.env.PRESENTER_VOICE_SEG_TIMEOUT_MS || '3000', 10);   // RT-14 (per-server; test-overridable)
  let voiceSessions = 0;                 // active voice sessions (capped, RT-22)
  // Plan 0472: the ONE unified voice+text INBOX. Voice transcripts AND typed text land here as a
  // single cursored ring; `kind` discriminates them and one global monotonic `seq` interleaves them
  // by arrival. getTranscripts is a kind==='voice' VIEW over this ring (back-compat alias).
  const inbox = [];                      // cursored in-memory ring (presenter_inbox / presenter_transcript read this)
  let inboxSeq = 0;
  // A stable id for this server instance's session — every inbox item carries it so a consumer can
  // tell a fresh server run from a resumed one (the ring is in-memory; a restart starts a new session).
  const SESSION_ID = 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  // Long-poll waiters (Plan 0472): each pending presenter_inbox({waitMs}) that had nothing ready
  // registers ONE waiter here; it is resolved (and removed) on the next emit, at its timeout, or on
  // server close. Never left dangling — no leaked timers or promises.
  const inboxWaiters = new Set();
  // ---- Plan 0473 P2: TURN COALESCING (fragments -> turns) ----
  // A speaker's CONSECUTIVE inbox items (voice OR typed text) are grouped into a TURN by a per-speaker
  // SETTLING WINDOW read from the ACTIVE PROFILE (api.profile().settlingMs — wearable = 400ms; consumed
  // as a knob, never branched on the profile NAME). A new item from the SAME identity within the window
  // EXTENDS the open turn (shared turnId, timer reset). A gap > settlingMs, OR an item from a DIFFERENT
  // identity, CLOSES the open turn (fires `turnComplete`) and starts a fresh one. Single conversational
  // floor (one open turn) — a speaker change is itself a close, so turns are NEVER merged across
  // identities. `turnComplete` is DISTINCT from `final`: `final` = one ASR/segment result is complete
  // (0472 hygiene); `turnComplete` = the speaker's TURN has settled. An item can be final:true while its
  // turn is still open (turnComplete:false). Server-side; carried on the reserved item fields.
  let turnSeq = 0;
  let openTurn = null;   // { turnId, userId, items:[entry...], timer, wrapTimer, budgetTimer, budgetMs, startedAt } | null

  // ---- Plan 0473 P7: ROLLING SUMMARY (continuity BEYOND the recent-N turns) ----
  // The situation digest (P3) surfaces only the last-N turns; a session is UNBOUNDED in duration, so
  // context OLDER than N would be LOST (the agent — even a solo wearable over a long conversation —
  // goes amnesiac past N). The rolling summary RETAINS that aged-out context, itself BOUNDED, and is
  // PRECOMPUTED INCREMENTALLY as turns SETTLE/AGE (never computed on-read) so situation() never blocks.
  //
  // F-10 SEAM: the updater is a SWAPPABLE unit behind this single `summarizer` reference. DEFAULT = the
  // cheap incremental heuristic (app/summarizer.mjs): NO LLM, NO new dependency, NO agent cognition. A
  // future cheap-model (Haiku) worker or an agent-assist presenter_set_summary would just reassign
  // `summarizer` to another {kind,onTurnAged,onShed,view} — the engine calls only that interface, and
  // Tier-1/situation() NEVER hard-depends on an LLM. NONE of those replacements is built here.
  const summarizer = createHeuristicSummarizer();
  // Staging ring modelling the recent-N window BY TURN COUNT (mirrors coalesceTurns(...).slice(-N)):
  // a turn folds into the summary EXACTLY when a newer settled turn pushes it out of the last-N. O(1)/turn.
  const settledTurnRing = [];
  // Feed ONE freshly-settled turn to the staging ring; the evicted head (now older than recent-N) folds
  // into the rolling summary. Incremental + non-blocking (pure in-memory), called from closeTurn.
  function stageSettledTurn(t) {
    const text = t.items.map((i) => i.text || '').join(' ').trim();
    if (!text) return;                         // an empty turn carries no continuity — skip
    const last = t.items[t.items.length - 1];
    settledTurnRing.push({ turnId: t.turnId, userId: t.userId, userName: (last && last.userName) || null, text });
    while (settledTurnRing.length > RECENT_TURNS_N) summarizer.onTurnAged(settledTurnRing.shift());
  }

  // ---- Plan 0473 P5: PROACTIVE per-turn budget (transparent — never a silent truncation) ----
  // A single conversational TURN is TIME-bounded by the ACTIVE PROFILE's perTurnBudget knob (per role/
  // trust — read here, NEVER a name fork). This is the USER-FACING proactive layer that sits ABOVE the
  // hard VOICE_SEG_MAX_BYTES backstop (which is kept). It matters most for VOICE ("talkative granny who
  // won't yield the floor"), but the engine is turn-generic (voice OR text). As an open turn approaches
  // its budget the speaker gets a visible WRAP-UP cue BEFORE the cap; AT the cap the turn is gracefully
  // CLOSED/yielded and the speaker NOTIFIED — the captured content is PRESERVED (settled), never cut.
  const DEFAULT_TURN_BUDGET_MS = 120000;   // fallback when a profile/role sets no budget (generous, soft)
  const WRAP_AT_FRACTION = 0.8;            // default: wrap-up cue fires at 80% of the budget (lead = 20%)
  // The budget (ms) for a speaker's role: an injected uniform override wins; else the profile's per-role
  // value; else the participant default; else the module default. Consumes the knob, never the name.
  function perTurnBudgetFor(role) {
    const ptb = api.profile().perTurnBudget || {};
    if (typeof ptb.overrideMs === 'number' && ptb.overrideMs >= 0) return ptb.overrideMs;
    const byRole = ptb.byRole || {};
    if (typeof byRole[role] === 'number') return byRole[role];
    if (typeof byRole.participant === 'number') return byRole.participant;
    return DEFAULT_TURN_BUDGET_MS;
  }
  // When (ms from turn-open) the WRAP-UP cue fires: an explicit injected wrapMs wins; else a fraction of
  // the budget. Clamped strictly inside (0, budget) so wrap always precedes the cap.
  function perTurnWrapAt(budgetMs) {
    const ptb = api.profile().perTurnBudget || {};
    const at = (typeof ptb.wrapMs === 'number' && ptb.wrapMs >= 0) ? ptb.wrapMs : Math.round(budgetMs * WRAP_AT_FRACTION);
    return Math.max(0, Math.min(at, budgetMs - 1));
  }
  // Deliver a server→client signal to a SPEAKER by userId (their live socket). Never silent: this is how
  // the wrap-up / close is surfaced to the person holding the floor.
  function notifySpeaker(userId, msg) { const ws = byUser.get(userId); if (ws) send(ws, msg); }
  // Arm the budget timers for a FRESHLY-OPENED turn. Measured from turn-open and NOT reset when the turn
  // is extended (it bounds total turn duration — the whole point for a non-stop speaker). Cleared in
  // closeTurn. budgetMs <= 0 ⇒ no proactive budget (the hard backstop still applies).
  function armTurnBudget(t, role) {
    const budgetMs = perTurnBudgetFor(role || 'participant');
    if (!(budgetMs > 0)) return;
    t.budgetMs = budgetMs; t.startedAt = Date.now();
    const wrapAt = perTurnWrapAt(budgetMs);
    if (wrapAt > 0) { t.wrapTimer = setTimeout(() => onTurnWrap(t), wrapAt); t.wrapTimer.unref?.(); }
    t.budgetTimer = setTimeout(() => onTurnBudgetCap(t), budgetMs); t.budgetTimer.unref?.();
  }
  // Proactive WRAP-UP: the turn is nearing its budget — cue the speaker to wrap up. Fired ONCE, only while
  // this turn is still the open one (a turn that already closed early is a no-op).
  function onTurnWrap(t) {
    if (openTurn !== t || t.budgetWrapped) return;
    t.budgetWrapped = true;
    const remainingMs = Math.max(0, t.budgetMs - (Date.now() - t.startedAt));
    log.info('voice', 'turn-budget-wrap', { turnId: t.turnId, userId: t.userId, remainingMs });
    notifySpeaker(t.userId, { t: 'turn_budget', state: 'wrap', turnId: t.turnId, budgetMs: t.budgetMs, remainingMs, mode: (api.profile().perTurnBudget || {}).mode || 'soft' });
  }
  // AT the cap: gracefully CLOSE/yield the turn and NOTIFY the speaker (never a silent cut). Finalize any
  // active voice segment for that speaker so the mic YIELDS (the captured audio is still transcribed, not
  // discarded), then settle the turn (turnComplete + work derivation) with reason 'budget'.
  function onTurnBudgetCap(t) {
    if (openTurn !== t) return;
    const userId = t.userId, turnId = t.turnId;
    log.warn('voice', 'turn-budget-cap', { turnId, userId, budgetMs: t.budgetMs });
    notifySpeaker(userId, { t: 'turn_budget', state: 'closed', turnId, reason: 'budget', budgetMs: t.budgetMs, mode: (api.profile().perTurnBudget || {}).mode || 'soft' });
    // Yield the floor: finalize (do NOT discard) any active voice segment for this speaker.
    const ws = byUser.get(userId); const c = ws ? conns.get(ws) : null;
    if (c && c.voice && c.voice.active) { try { voiceSegFinalize(c, ws, {}); } catch (e) {} }
    closeTurn('budget');
  }

  // Close the open turn: mark its items complete (ring update, so a later read sees a settled turn) and
  // fire ONE `turnComplete` signal (event). Idempotent when nothing is open.
  function closeTurn(reason = 'settle') {
    if (!openTurn) return null;
    const t = openTurn; openTurn = null;
    if (t.timer) { clearTimeout(t.timer); t.timer = null; }
    if (t.wrapTimer) { clearTimeout(t.wrapTimer); t.wrapTimer = null; }         // P5: clear budget timers
    if (t.budgetTimer) { clearTimeout(t.budgetTimer); t.budgetTimer = null; }
    for (const it of t.items) it.turnComplete = true;
    const last = t.items[t.items.length - 1];
    const signal = { turnId: t.turnId, userId: t.userId, role: last.role,
      seqs: t.items.map((i) => i.seq), lastSeq: last.seq, count: t.items.length,
      ts: Date.now(), reason };
    emit('turnComplete', signal);
    // Plan 0473 P4: a SETTLED turn is the substrate a work item is DERIVED from (cheap rule below).
    deriveWorkFromTurn(t, last);
    // Plan 0473 P7: a SETTLED turn is also staged for the ROLLING SUMMARY — when it later ages out of
    // the recent-N window it folds into the summary (continuity beyond recent-N). Incremental, non-blocking.
    stageSettledTurn(t);
    log.info('voice', 'turn-complete', { turnId: t.turnId, userId: t.userId, items: signal.count, reason });
    return signal;
  }
  // Attach turnId + turnComplete to a freshly-emitted inbox item, opening/extending/closing turns.
  function assignTurn(entry) {
    const settlingMs = api.profile().settlingMs;   // consume the profile knob (never the profile NAME)
    if (openTurn && openTurn.userId !== entry.userId) closeTurn('speaker-change');   // never merge identities
    if (openTurn) {                                 // same speaker within the window ⇒ extend the turn
      entry.turnId = openTurn.turnId;
      entry.turnComplete = false;
      openTurn.items.push(entry);
    } else {                                        // open a fresh turn
      const turnId = 'turn-' + (++turnSeq);
      entry.turnId = turnId;
      entry.turnComplete = false;
      openTurn = { turnId, userId: entry.userId, items: [entry], timer: null };
      armTurnBudget(openTurn, entry.role);          // Plan 0473 P5: start the per-turn budget clock (from open)
    }
    if (openTurn.timer) clearTimeout(openTurn.timer);
    if (settlingMs > 0) {                           // (re)arm: settle after settlingMs of silence
      openTurn.timer = setTimeout(() => closeTurn('settle'), settlingMs);
      openTurn.timer.unref?.();
    } else {                                        // settlingMs === 0 ⇒ every item is its own settled turn
      closeTurn('settle');
    }
  }
  // RT-26 persistence policy. Recognized text is EPHEMERAL BY DEFAULT — it lives ONLY in the
  // bounded ring above; ring eviction / restart losing history is INTENDED. Disk persistence is
  // OPT-IN via PRESENTER_TRANSCRIPT_PERSIST; when ON, one JSONL line per FINAL transcript is
  // appended to a STABLE file under PRESENTER_TRANSCRIPT_DIR (so a restart appends, not truncates).
  // Audio segment WAVs are ALWAYS deleted after ASR regardless of the flag — only text is ever
  // persistable. When ON, clients are TOLD (welcome.transcriptPersisting) — never save silently.
  const TRANSCRIPT_PERSIST = /^(1|true|yes|on)$/i.test(process.env.PRESENTER_TRANSCRIPT_PERSIST || '');
  const TRANSCRIPT_DIR = process.env.PRESENTER_TRANSCRIPT_DIR || join(__dirname, '..', '.transcripts');
  const TRANSCRIPT_FILE = join(TRANSCRIPT_DIR, 'transcripts.jsonl');
  // RT-26 (Plan 0472: applies to TEXT too). Persist ONE JSONL line per inbox item — voice or text —
  // only when PRESENTER_TRANSCRIPT_PERSIST is ON. Default OFF ⇒ nothing touches disk (ephemeral ring).
  function persistInboxItem(e) {
    if (!TRANSCRIPT_PERSIST) return;   // default OFF: nothing touches disk
    try { mkdirSync(TRANSCRIPT_DIR, { recursive: true }); appendFileSync(TRANSCRIPT_FILE, JSON.stringify({ ts: e.ts, kind: e.kind, userId: e.userId, userName: e.userName, role: e.role, trust: e.trust, seq: e.seq, text: e.text, conf: e.conf }) + '\n'); }
    catch (err) { log.warn('voice', 'transcript-persist-fail', { msg: String(err && err.message || err) }); }
  }
  function ensureAsr() {
    if (!asr) asr = createAsr({ cwd: join(__dirname, '..'), onReady: () => announceVoiceStatus({ ready: true }) });
    return asr;
  }
  function announceVoiceStatus(obj) {   // "recognizer ready" / status -> control roles only
    for (const [ws, c] of conns.entries()) if (c.role === 'presenter' || c.role === 'ai') send(ws, { t: 'voice_status', ...obj });
  }
  // Wrap 16 kHz mono PCM16 in a minimal WAV container (whisper's native input; no transcode).
  function pcm16ToWav(pcm) {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(VOICE_SR, 24); h.writeUInt32LE(VOICE_SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
  }
  // Plan 0472: land ONE item into the unified inbox. The item is a FLAT, EXTENSIBLE object. Plan 0473
  // P2 now populates the reserved `turnId` + `turnComplete` fields via assignTurn (below); future
  // increments may add more (annotations{...}, identity{...}, dropped) WITHOUT overloading these.
  // `final` means "segment-final ASR result" (this recognition pass is complete) — it does NOT mean the
  // speaker's turn is over. `turnComplete` (set when the turn settles) is the DISTINCT turn-end signal.
  function emitInbox({ kind, userId, userName, role, text, conf = null, final = true, sessionId, isGuest = false }) {
    const entry = {
      seq: ++inboxSeq, kind, userId, userName, role: role || null,
      // Plan 0473 P9: the SERVER-AUTHORITATIVE trust level, stamped at ingest from role + isGuest (both
      // server-decided; never client-reported). Carried on every item so every downstream consumer
      // (inbox, coalesced turns, work queue) can DELIMIT untrusted content as data. Guest wins first
      // because the server hard-forces a guest's role to 'participant'.
      trust: deriveTrust(role, isGuest),
      text, conf: (conf == null ? null : conf), final: final !== false,
      ts: Date.now(), sessionId: sessionId || SESSION_ID,
    };
    inbox.push(entry); if (inbox.length > TRANSCRIPT_RING) inbox.shift();
    assignTurn(entry);   // Plan 0473 P2: attach turnId + turnComplete (may settle the prior turn) BEFORE emit
    persistInboxItem(entry);   // RT-26: no-op unless PRESENTER_TRANSCRIPT_PERSIST is ON (voice AND text)
    // Back-compat: voice items still surface to control roles as {t:'transcript'} (presenter voice host).
    if (kind === 'voice') {
      for (const [ws, c] of conns.entries()) if (c.role === 'presenter' || c.role === 'ai') send(ws, { t: 'transcript', ...entry });
      emit('transcript', entry);
    }
    emit('inbox', entry);
    evaluateFloor();   // Plan 0473 P6: fresh input can push a consumer behind — reassess the floor
    // Wake every pending long-poll waiter (each resolves with what arrived and removes itself).
    for (const w of [...inboxWaiters]) w.wake();
    log.info('voice', 'inbox', { kind, userId, seq: entry.seq, len: (text || '').length });
    return entry;
  }
  // Back-compat shim: voice-path callers still call emitTranscript(); it is kind:'voice' into the inbox.
  function emitTranscript({ userId, userName, role, text, conf, isGuest = false }) {
    return emitInbox({ kind: 'voice', userId, userName, role, text, conf, final: true, isGuest });
  }
  function voiceArmTimeout(c, ws) {   // RT-14: an open segment starved of frames is flushed/discarded
    const v = c.voice; if (!v) return;
    if (v.timer) clearTimeout(v.timer);
    v.timer = setTimeout(() => { log.warn('voice', 'seg-timeout', { socketId: c.id, seq: v.seq }); voiceSegFinalize(c, ws, {}); }, segTimeoutMs);
    v.timer.unref?.();
  }
  function voiceSegStart(c, ws, m) {
    if (!c) return;
    // Plan 0472 P4: a GUEST may open a voice segment ONLY if its capability scope includes 'speak'
    // (token-signed; not client-widenable). Surface the refusal (never silent). Non-guests unaffected.
    if (c.isGuest && !(c.capScope || []).includes('speak')) { log.warn('cap', 'speak-out-of-scope', { socketId: c.id }); send(ws, { t: 'voice_rejected', reason: 'not permitted' }); return; }
    // Plan 0473 P6 — PROACTIVE floor gate: under HOLD (overload) refuse a NEW segment AT THE SOURCE and
    // tell the speaker to hold, instead of accepting audio only to shed it downstream. No-op when the
    // floor is disabled (solo wearable) — so existing single-speaker voice behaviour is unchanged.
    if (floorGated()) { log.info('floor', 'gated-seg-start', { socketId: c.id, userId: c.userId }); send(ws, { t: 'floor', state: 'hold', gated: true }); return; }
    if (!c.voice) c.voice = { active: false, seq: 0, chunks: [], bytes: 0, startedAt: 0, timer: null, tokens: VOICE_TB_CAPACITY, lastRefill: Date.now() };
    const v = c.voice;
    if (v.active) { if (v.timer) clearTimeout(v.timer); v.active = false; voiceSessions = Math.max(0, voiceSessions - 1); v.chunks = []; v.bytes = 0; }   // drop a stray-open prior segment
    if (voiceSessions >= VOICE_MAX_SESSIONS) {   // RT-22: reject over cap, with a surfaced reason
      log.warn('voice', 'sessions-cap', { socketId: c.id, cap: VOICE_MAX_SESSIONS });
      send(ws, { t: 'voice_rejected', reason: 'server voice capacity reached' });
      return;
    }
    ensureAsr();   // RT-25: warm the recognizer now, so the first utterance doesn't eat the model load
    v.active = true; v.seq = (typeof m.seq === 'number' ? m.seq : v.seq + 1); v.chunks = []; v.bytes = 0; v.startedAt = Date.now();
    v.tokens = VOICE_TB_CAPACITY; v.lastRefill = Date.now();   // F1: full-capacity bucket per segment
    voiceSessions++;
    voiceArmTimeout(c, ws);
    evaluateFloor();   // Plan 0473 P6: a new active speaker changes the load — reassess the floor
    log.info('voice', 'seg-start', { socketId: c.id, userId: c.userId, seq: v.seq, sessions: voiceSessions });
  }
  // Binary PCM frame from a conn. IGNORED unless that conn has an active voice session (RT-7);
  // byte-rate capped; force-cut past the segment length cap (RT-8). NEVER JSON-parsed.
  function handleVoiceBinary(c, ws, buf) {
    const v = c && c.voice;
    if (!v || !v.active) { log.warn('voice', 'binary-no-session', { socketId: c && c.id }); return; }   // RT-7 drop
    c.lastSeen = Date.now();
    // F1 fix (RT-7): TOKEN BUCKET, not a per-second window — a final-only burst of a whole utterance
    // (up to VOICE_SEG_MAX_BYTES) passes intact; only >2x-realtime sustained floods throttle. A drop is
    // SURFACED to the speaker (voice_dropped), never silent.
    const now = Date.now();
    v.tokens = Math.min(VOICE_TB_CAPACITY, v.tokens + (now - v.lastRefill) * VOICE_TB_REFILL_BPS / 1000);
    v.lastRefill = now;
    if (v.tokens < buf.length) { log.warn('voice', 'rate-drop', { socketId: c.id, seq: v.seq }); send(ws, { t: 'voice_dropped', seq: v.seq, reason: 'rate' }); return; }
    v.tokens -= buf.length;
    v.chunks.push(Buffer.from(buf)); v.bytes += buf.length;
    voiceArmTimeout(c, ws);
    if (v.bytes >= VOICE_SEG_MAX_BYTES) { log.warn('voice', 'seg-forcecut', { socketId: c.id, bytes: v.bytes }); voiceSegFinalize(c, ws, {}); }   // RT-8
  }
  async function voiceSegFinalize(c, ws, { discard = false, reason } = {}) {
    const v = c && c.voice; if (!v || !v.active) return;
    if (v.timer) { clearTimeout(v.timer); v.timer = null; }
    v.active = false; voiceSessions = Math.max(0, voiceSessions - 1);
    evaluateFloor();   // Plan 0473 P6: a speaker yielding the floor lowers the load — reassess the floor
    const pcm = Buffer.concat(v.chunks, v.bytes); const seq = v.seq;
    v.chunks = []; v.bytes = 0;
    log.info('voice', 'seg-final', { socketId: c.id, seq, bytes: pcm.length });   // F1: byte-integrity trace (utterance must arrive whole)
    if (discard) { log.info('voice', 'seg-discard', { socketId: c.id, seq, reason }); return; }
    if (pcm.length < VOICE_MIN_SEG_BYTES) { log.info('voice', 'seg-too-short', { socketId: c.id, seq, bytes: pcm.length }); return; }   // RT-12
    const wavDir = join(tmpdir(), 'ap-asr'); try { mkdirSync(wavDir, { recursive: true }); } catch (e) {}
    const wavPath = join(wavDir, `seg-${c.id}-${seq}-${Date.now()}.wav`);
    try { writeFileSync(wavPath, pcm16ToWav(pcm)); } catch (e) { log.warn('voice', 'wav-fail', { msg: String(e && e.message || e) }); return; }
    const result = await ensureAsr().recognize(wavPath, seq);
    try { unlinkSync(wavPath); } catch (e) {}
    if (!result || !result.text) { log.info('voice', 'no-text', { socketId: c.id, seq }); return; }
    emitTranscript({ userId: c.userId, userName: c.userName, role: c.role, text: result.text, conf: result.conf, isGuest: !!c.isGuest });
  }

  // ---- Plan 0473 P3: BOUNDED SITUATION (the working set) + SERVER-HELD per-consumer cursor ----
  // `situation()` is the PRIMARY sense surface: a BOUNDED working set assembled from EXISTING server
  // state (display/beat, session profile, open polls + live tallies, roster) + the last-N coalesced
  // turns (P2) + a new-since-last-read delta. The response is ALWAYS bounded regardless of session
  // length — a 10k-turn session must NOT return full history (the inbox ring is already capped at
  // TRANSCRIPT_RING, and we additionally cap recent-turns to N, roster to a max, and per-turn text).
  const RECENT_TURNS_N = 20;          // bounded recent-turns window surfaced in the situation digest
  const SITUATION_ROSTER_MAX = 40;    // roster is bounded too (present + recently-active)
  const MAX_TURN_TEXT = 2000;         // per-turn verbatim text is capped so one mega-turn can't blow the cap
  // Server-held per-consumer cursor: consumerId -> last inboxSeq that consumer has been shown. The
  // CONSUMER never passes a cursor — the server tracks each consumer's last-read position, keyed by
  // its connection/session identity (the MCP tool keys by the stdio connection; tests key explicitly).
  const situationCursors = new Map();
  // Group the (bounded) inbox ring into coalesced TURNS (consecutive items sharing a turnId), newest
  // last, verbatim; return the last `n`. Per-turn text is length-capped (bounded-in-the-large).
  function coalesceTurns(items, n = RECENT_TURNS_N) {
    const turns = [];
    let cur = null;
    for (const it of items) {
      if (cur && cur.turnId === it.turnId && it.turnId != null) {
        cur.text = (cur.text + (it.text ? (cur.text ? ' ' : '') + it.text : '')).slice(0, MAX_TURN_TEXT);
        cur.count++; cur.lastSeq = it.seq; cur.ts = it.ts;
        cur.turnComplete = it.turnComplete === true; cur.kind = it.kind;
      } else {
        cur = {
          turnId: it.turnId || null, userId: it.userId, userName: it.userName, role: it.role || null,
          // Plan 0473 P9: a turn's trust is its speaker's — and a turn NEVER merges identities (a
          // speaker-change closes the turn), so every item in a turn shares one trust level.
          trust: it.trust, kind: it.kind, text: (it.text || '').slice(0, MAX_TURN_TEXT), count: 1,
          firstSeq: it.seq, lastSeq: it.seq, ts: it.ts, turnComplete: it.turnComplete === true,
        };
        turns.push(cur);
      }
    }
    return turns.slice(-n);
  }
  // A compact, bounded view of the current per-role display (what each broadcast role is showing now).
  function displaySummary() {
    const out = {};
    for (const r of ROLES) {
      const d = displayByRole[r];
      out[r] = d ? (d.kind === 'component' ? ((d.opts && d.opts.promptId) || d.component)
        : (d.contentId || d.kind)) : 'idle';
    }
    return out;
  }
  // The current beat, if a content module has one shown (currentBeat >= 0); else the module summary; null.
  function beatSummary() {
    if (!contentModule) return null;
    const total = (contentModule.beats || []).length;
    const b = (currentBeat >= 0) ? contentModule.beats[currentBeat] : null;
    return b ? { index: currentBeat, total, component: b.component, id: b.id != null ? b.id : null, title: contentModule.title }
      : { index: currentBeat, total, title: contentModule.title };
  }
  // Assemble the BOUNDED working set for `consumerId`, advancing that consumer's server-held cursor.
  function buildSituation(consumerId, recentN = RECENT_TURNS_N) {
    const last = situationCursors.get(consumerId) || 0;
    const since = inbox.filter((i) => i.seq > last);   // bounded: the ring is capped at TRANSCRIPT_RING
    situationCursors.set(consumerId, inboxSeq);         // advance the cursor to everything now shown
    evaluateFloor();   // Plan 0473 P6: this read caught the consumer up (backlog reduced) — reassess the floor
    const att = api.attendance({ viewerRole: 'ai' });
    const openPolls = [...polls.entries()].filter(([, p]) => p.open)
      .map(([id, p]) => ({ promptId: id, prompt: p.spec && p.spec.prompt, open: true, ...tally(id) }));
    // Plan 0473 P9: DELIMIT-AS-DATA at serve time — participant/guest turns are fenced (untrusted
    // content the agent must treat as data, never as commands); self/controller turns pass through.
    const recentTurns = coalesceTurns(inbox, recentN).map((t) => annotateTrust(t, t.trust));
    // Plan 0473 P4: the WORK QUEUE — judgment items, prioritized + bounded (aged/expired pruned).
    const queue = queueView();
    return {
      sessionId: SESSION_ID,
      profile: ACTIVE_PROFILE.name,
      bounded: true,
      situation: {
        display: displaySummary(),
        beat: beatSummary(),
        polls: openPolls,
        roster: att.roster.slice(0, SITUATION_ROSTER_MAX),
        rosterSummary: att.summary,
        // Plan 0473 P5/P10: the profile-specific DIGEST section (F-5), assembled by the DIGEST-CONTENT
        // SEAM keyed on the ACTIVE PROFILE's `digestContent` knob VALUE (DATA lookup, never a name
        // fork). wearable ('conversation') ⇒ null (the digest IS the conversation); rpg ('gm') ⇒ a GM
        // view (questions-to-GM + recent actions) + the mcp-gm scene/initiative/dice seam. The seam
        // reads ONLY the already-assembled, already-fenced pieces below — it never blocks/recomputes.
        digest: buildDigest(ACTIVE_PROFILE.digestContent, { queue, recentTurns }),
      },
      recentTurns,
      newSinceLastRead: { count: since.length, turns: coalesceTurns(since, recentN).map((t) => annotateTrust(t, t.trust)) },
      // Plan 0473 P7: the ROLLING SUMMARY — continuity for context OLDER than the recent-N turns.
      // A PRECOMPUTED, BOUNDED snapshot (this is a pure read of the incrementally-maintained state via
      // the F-10 seam — it NEVER blocks/computes on read), so a long session is not amnesiac past N.
      summary: summarizer.view(),
      // Plan 0473 P4: the WORK QUEUE — the judgment items, prioritized + bounded (aged/expired pruned).
      queue,
      // Plan 0473 P6: one-glance overload awareness. `floor` = the current proactive floor state
      // (go/wrap/hold); `backpressure.sheddedCount` = the reactive fold-to-summary total, SURFACED so a
      // shed is never silent (the LAST resort, secondary to the floor).
      floor: effectiveFloor(),
      backpressure: { sheddedCount, floor: effectiveFloor() },
      cursor: inboxSeq,   // informational only — the consumer does NOT need to pass this back
    };
  }

  // ---- Plan 0473 P4: WORK QUEUE (the judgment items in the working set) ----
  // Work items are DERIVED from completed TURNS (P2) by a CHEAP rule (NO ML): a settled turn becomes a
  // work item whose PRIORITY is set by whether it is a question/request. The active profile's queuePolicy
  // is honoured as DATA (never a name fork): `enqueue` decides which turns enter; `maxPending` bounds the
  // pending queue; `ttlMs` ages stale pending items out (F-11) so the queue is bounded like the rest of the
  // working set. The SERVER tracks each item's status/owner — the consuming agent holds NOTHING.
  const PRIORITY_DIRECTED = 2;      // a question/request — needs the agent's judgment now
  const PRIORITY_AMBIENT = 1;       // a statement / ambient chatter
  const PRIORITY_DEFERRED = 0;      // pushed to the back by presenter_defer
  const QUEUE_TEXT_MAX = 500;       // per-item verbatim text cap (bounded-in-the-large)
  const DEFAULT_QUEUE_MAX = 50;     // fallback bound when a profile sets no maxPending
  const DEFAULT_QUEUE_TTL_MS = 10 * 60 * 1000;   // pending items expire after this by default (bounded)
  const workItemsMap = new Map();   // id -> item (pending/claimed live here; resolved/expired kept for status tracking, bounded)
  const RESOLVED_KEEP = 100;        // bounded terminal-status history (resolved/expired) for server-side tracking
  let workSeq = 0;
  // Plan 0473 P6 — REACTIVE BACKSTOP counter: the running total of ambient turns folded-to-summary/count
  // when the queue overflows capacity. Surfaced in situation().backpressure so a shed is NEVER silent.
  // This is the LAST resort, secondary to the proactive floor control (below).
  let sheddedCount = 0;
  // Cheap question/request heuristic (F-4 minimal): trimmed text ends with '?'. No ML, no NLP.
  function isQuestion(text) { return /\?\s*$/.test(String(text || '').trim()); }
  // Read the queue knobs from the ACTIVE PROFILE (consume knobs, never the profile NAME — drift guard).
  function queueKnobs() {
    const qp = (ACTIVE_PROFILE.queuePolicy) || {};
    return {
      enqueue: qp.enqueue || 'all',                                            // 'all' | 'questions'
      maxPending: (typeof qp.maxPending === 'number' && qp.maxPending >= 0) ? qp.maxPending : DEFAULT_QUEUE_MAX,
      ttlMs: (typeof qp.ttlMs === 'number' && qp.ttlMs > 0) ? qp.ttlMs : DEFAULT_QUEUE_TTL_MS,
      cluster: qp.cluster === true,                                            // F-6: dedupe/cluster similar questions (teaching)
    };
  }

  // ---- Plan 0473 P11 (F-6): CHEAP question DEDUPE/CLUSTER (NO ML / NO LLM / NO new deps) ----
  // At CLASS scale the work queue ITSELF overloads: 20 near-simultaneous questions is its own overload,
  // even though each is a legitimate judgment item. So similar questions are CLUSTERED into ONE queue
  // item ("N students asked about X" — a count + the contributing askers) instead of 20 rows, keeping the
  // queue bounded + glanceable. The similarity metric is a NORMALIZED-KEYWORD JACCARD overlap: strip
  // punctuation, lowercase, drop stopwords + very short tokens, light-stem a trailing plural 's', and
  // compare the resulting keyword SETS. Purely lexical + O(words) — no model, no dependency. Gated on the
  // profile's `queuePolicy.cluster` knob (DATA), so wearable/rpg leave it OFF.
  const CLUSTER_THRESHOLD = 0.4;        // Jaccard >= this ⇒ "the same question" (tuned for near-duplicates)
  const CLUSTER_VARIANTS_MAX = 12;      // bound the retained variant phrasings per cluster
  const STOPWORDS = new Set(('a an the is are am was were be been being do does did done how what why when '
    + 'where which who whom whose this that these those i you we they he she it me us them my your our their '
    + 'to of in on for and or but with about as at by can could would should shall will may might if then '
    + 'than so up out off over under again just only also very not no yes here there').split(/\s+/));
  function keywordSet(text) {
    const out = new Set();
    for (let w of String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
      if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);   // light plural stem (closures→closure)
      if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w);
    }
    return out;
  }
  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0; for (const w of a) if (b.has(w)) inter++;
    return inter / (a.size + b.size - inter);
  }
  // Find the best-matching PENDING directed (question) item whose keywords clear the threshold — the
  // cluster the new question should fold into, or null to start a new item.
  function findClusterTarget(kw) {
    let best = null, bestSim = 0;
    for (const it of workItemsMap.values()) {
      if (it.status !== 'pending' || it.priority < PRIORITY_DIRECTED) continue;
      const sim = jaccard(kw, it._kw || (it._kw = keywordSet(it.text)));
      if (sim > bestSim) { bestSim = sim; best = it; }
    }
    return bestSim >= CLUSTER_THRESHOLD ? best : null;
  }

  // ---- Plan 0473 P11 (F-7): EXPLICIT MODERATION state (teacher gates WHO reaches the queue) ----
  // The teacher/presenter can MUTE a student (their input produces NO work items) — an explicit
  // moderation decision. This is DATA-gated on the profile's `floorThresholds.moderationOverrides` knob
  // (teaching); other profiles refuse the mute (no-op) so there is no behaviour fork on the profile name.
  const mutedParticipants = new Set();
  // DERIVE a work item from a settled turn `t` (its `last` item carries role). Cheap + profile-read.
  function deriveWorkFromTurn(t, last) {
    const knobs = queueKnobs();
    const text = t.items.map((i) => i.text || '').join(' ').trim().slice(0, QUEUE_TEXT_MAX);
    if (!text) return null;                                   // nothing to act on
    // Plan 0473 P11 (F-7): explicit moderation — a MUTED student produces NO work item (their input never
    // reaches the queue). The turn is still recorded in the inbox/recent-turns (continuity is not silently
    // dropped); it is the teacher's explicit decision to keep it out of the actionable queue.
    if (mutedParticipants.has(String(t.userId))) return null;
    const q = isQuestion(text);
    // Honour the profile knob: 'questions' ⇒ only questions/requests enqueue (ambient shed); 'all' ⇒
    // every directed turn is a work item (wearable — solo, all turns are directed at the agent).
    if (knobs.enqueue === 'questions' && !q) return null;
    // Plan 0473 P11 (F-6): at class scale, FOLD a similar question into an existing cluster item instead
    // of adding a 20th row — the queue stays bounded + glanceable. Cheap keyword-Jaccard, gated on the
    // `cluster` knob (DATA). A clustered item carries a `count` + the contributing `askers`.
    if (q && knobs.cluster) {
      const kw = keywordSet(text);
      const target = findClusterTarget(kw);
      if (target) {
        target.cluster = true;
        target.count = (target.count || 1) + 1;
        if (!target.askers) target.askers = [{ userId: target.userId, userName: target.userName }];
        target.askers.push({ userId: t.userId, userName: (last && last.userName) || null });
        if (!target.variants) target.variants = [target.text];
        if (target.variants.length < CLUSTER_VARIANTS_MAX && target.variants.indexOf(text) < 0) target.variants.push(text);
        for (const w of kw) target._kw.add(w);   // grow the cluster's vocabulary so later variants still match
        log.info('queue', 'cluster', { id: target.id, count: target.count });
        evaluateFloor();   // a fold does not add a pending item, but load awareness stays fresh
        return target;
      }
    }
    const item = {
      id: 'work-' + (++workSeq), turnId: t.turnId, userId: t.userId,
      userName: (last && last.userName) || null, text,
      // Plan 0473 P9: inherit the settled turn's SERVER-AUTHORITATIVE trust so the queued judgment item
      // (also consumed by the agent + shown in the human digest) is delimited as data if untrusted.
      trust: (last && last.trust) || deriveTrust(last && last.role, false),
      priority: q ? PRIORITY_DIRECTED : PRIORITY_AMBIENT,
      status: 'pending', owner: null, note: null,
      createdTs: Date.now(),
    };
    // Plan 0473 P11: cache the question's keyword set so later similar questions can cluster onto it
    // without recomputing (non-enumerable working field; NEVER copied into the served itemView).
    if (q && knobs.cluster) item._kw = keywordSet(text);
    workItemsMap.set(item.id, item);
    // Plan 0473 P6 — PROACTIVE-FIRST: reassess load + engage the floor (wrap/hold) BEFORE the reactive
    // shed. The floor gates NEW input at the source; only input that STILL exceeds capacity below hits
    // the reactive backstop — so the floor is always already in effect before sheddedCount can rise.
    evaluateFloor();
    enforceQueueBounds();                                     // REACTIVE last resort: shed ambient overflow WITH a count (F-11)
    return item;
  }
  // Age out stale PENDING items (claimed items are being handled ⇒ exempt) — lazy, called on every read
  // + mutation, so the queue never grows unbounded even with no reader running.
  function expireStale() {
    const { ttlMs } = queueKnobs();
    const now = Date.now();
    for (const it of workItemsMap.values()) {
      if (it.status === 'pending' && (now - it.createdTs) > ttlMs) { it.status = 'expired'; it.expiredTs = now; }
    }
  }
  // Keep the number of PENDING items <= maxPending: shed the LOWEST-priority, then OLDEST, first — so a
  // high-priority question is NEVER crowded out by heavy ambient. Claimed items don't count against the bound.
  function enforceQueueBounds() {
    const { maxPending } = queueKnobs();
    let pending = [...workItemsMap.values()].filter((it) => it.status === 'pending');
    if (pending.length <= maxPending) return;
    // sort ascending by (priority, createdTs) ⇒ the first entries are the ones to drop.
    pending.sort((a, b) => (a.priority - b.priority) || (a.createdTs - b.createdTs));
    const dropN = pending.length - maxPending;
    for (let i = 0; i < dropN; i++) { const it = pending[i]; it.status = 'shed'; it.shedTs = Date.now(); }
    sheddedCount += dropN;   // Plan 0473 P6: count the reactive shed so it is SURFACED, never silent
    // Plan 0473 P7: the P6 "fold ambient to summary" path — a shed is REPRESENTED in the rolling summary
    // WITH its count (never a silent drop). The shed turns' TEXT is already retained via stageSettledTurn
    // (every settled turn is staged); this records the backpressure MAGNITUDE as a summary dimension.
    summarizer.onShed(dropN);
    if (dropN > 0) log.info('queue', 'shed', { dropN, sheddedCount });
    pruneTerminal();
  }
  // Bound the retained terminal-status history (resolved/expired/shed) so workItemsMap can't grow forever.
  function pruneTerminal() {
    const terminal = [...workItemsMap.values()].filter((it) => it.status === 'resolved' || it.status === 'expired' || it.status === 'shed');
    if (terminal.length <= RESOLVED_KEEP) return;
    terminal.sort((a, b) => (a.expiredTs || a.shedTs || a.resolvedTs || a.createdTs) - (b.expiredTs || b.shedTs || b.resolvedTs || b.createdTs));
    for (let i = 0; i < terminal.length - RESOLVED_KEEP; i++) workItemsMap.delete(terminal[i].id);
  }
  // Stamp the dynamic `age` (ms since created) at serve time; return a bounded, plain item view.
  function itemView(it) {
    const v = { id: it.id, turnId: it.turnId, userId: it.userId, userName: it.userName, text: it.text,
      priority: it.priority, status: it.status, createdTs: it.createdTs, age: Date.now() - it.createdTs };
    if (it.owner) v.owner = it.owner;
    if (it.note != null) v.note = it.note;
    // Plan 0473 P11 (F-6): a CLUSTERED item carries how many students asked the same thing + the askers,
    // so the queue stays glanceable ("N students asked about X") instead of N rows. Additive; a singleton
    // item omits these (a plain 1-asker question).
    if (it.cluster) {
      v.cluster = true;
      v.count = it.count || 1;
      v.askers = (it.askers || []).slice(0, 50);
      if (it.variants) v.variants = it.variants.slice(0, 50);
    }
    // Plan 0473 P9: delimit-as-data — fence the item's text when its speaker is untrusted (participant/
    // guest), flag guests. Additive to the item shape; a self/controller item passes through unfenced.
    return annotateTrust(v, it.trust);
  }
  // The ACTIONABLE queue: pending + claimed only (resolved/expired/shed are dropped from the view),
  // prioritized (priority desc, then oldest-first within a priority = FIFO) and already bounded.
  function queueView() {
    expireStale();
    const live = [...workItemsMap.values()].filter((it) => it.status === 'pending' || it.status === 'claimed');
    live.sort((a, b) => (b.priority - a.priority) || (a.createdTs - b.createdTs));
    return live.map(itemView);
  }

  // ---- Plan 0473 P6: FLOOR CONTROL (proactive, at the SOURCE) + reactive backstop (last resort) ----
  // PROACTIVE-FIRST overload prevention. The server measures live LOAD from EXISTING state — concurrent
  // active speakers (voiceSessions), work-queue depth (pending items), and how far the consumer has
  // fallen behind (unread backlog) — against the ACTIVE PROFILE's `floorThresholds` knob (DATA, read via
  // floorKnobs(), NEVER a name fork). Crossing the WRAP level emits a gentle "please wrap" floor cue;
  // crossing HOLD emits "please hold" AND GATES new capture AT THE SOURCE (a would-be speaker is told to
  // hold instead of the server accepting audio only to shed it). When load clears, the floor returns to
  // 'go'. The wearable profile has floorThresholds.enabled:false (solo → a no-op); the mechanism is built
  // + tested with an enabled/injected threshold. The REACTIVE shed (`sheddedCount`, above) is the LAST
  // resort — secondary to, and always after, this proactive floor.
  const FLOOR_STATES = ['go', 'wrap', 'hold'];
  let floorState = 'go';
  // SEAM (F-7), WIRED in P11: explicit teacher moderation OVERRIDES the automatic load-based floor. When a
  // moderation floor is set it WINS over the auto floor everywhere the floor is consumed (effectiveFloor →
  // the broadcast cue + floorGated + the situation view). `moderationFloor` is the teacher's explicit
  // decision; `floorState` is the automatic (load-derived) level. Precedence: moderation first, auto second.
  let moderationFloor = null;
  function effectiveFloor() { return moderationFloor || floorState; }
  // Set (or clear, with null) the explicit moderation floor. DATA-gated on the profile's
  // `floorThresholds.moderationOverrides` knob (teaching) so it is not a profile-NAME fork: a profile that
  // does not grant moderation refuses the override (no-op). The override wins immediately via effectiveFloor;
  // broadcast the resulting cue so it is never silent. Returns {ok, floor(effective), auto}.
  function setModerationFloor(state) {
    if (!floorKnobs().moderationOverrides) return { ok: false, reason: 'moderation-not-permitted', floor: effectiveFloor(), auto: floorState };
    if (state !== null && !FLOOR_STATES.includes(state)) return { ok: false, reason: 'bad-state', floor: effectiveFloor(), auto: floorState };
    moderationFloor = state;
    log.info('floor', 'moderation', { moderationFloor, auto: floorState });
    broadcastFloor(effectiveFloor());   // the explicit decision wins over auto; never silent
    return { ok: true, floor: effectiveFloor(), auto: floorState };
  }
  // Read the floor knobs from the ACTIVE PROFILE (consume knobs, never the profile NAME — drift guard).
  function floorKnobs() {
    const ft = (ACTIVE_PROFILE.floorThresholds) || {};
    return { enabled: ft.enabled === true, speakers: ft.speakers || null, queue: ft.queue || null,
      backlog: ft.backlog || null, moderationOverrides: ft.moderationOverrides === true };
  }
  // Live LOAD signals, measured from existing server state (NO new bookkeeping).
  function pendingCount() { let n = 0; for (const it of workItemsMap.values()) if (it.status === 'pending') n++; return n; }
  // How far the furthest-behind consumer has fallen behind (unread inbox items). 0 when nobody has read.
  function consumerBacklog() { let max = 0; for (const last of situationCursors.values()) { const b = inboxSeq - last; if (b > max) max = b; } return max; }
  // The floor level ONE signal implies, given its {wrap,hold} thresholds (absent thresholds ⇒ ignored).
  function levelFor(value, th) {
    if (!th) return 'go';
    if (typeof th.hold === 'number' && value >= th.hold) return 'hold';
    if (typeof th.wrap === 'number' && value >= th.wrap) return 'wrap';
    return 'go';
  }
  function maxLevel(a, b) { return FLOOR_STATES.indexOf(a) >= FLOOR_STATES.indexOf(b) ? a : b; }
  // Broadcast the floor cue to clients — the would-be speakers RENDER "please hold"/"wrap up" + gate
  // capture on it (stub-tier; the SERVER decides, the client shows). Never silent.
  function broadcastFloor(state) { for (const ws of conns.keys()) send(ws, { t: 'floor', state }); }
  // Recompute the floor from current load; on a CHANGE, emit the cue. Called on every load-changing event
  // (input arrival, turn settle, queue mutation, speaker start/stop, situation read). Cheap + idempotent.
  function evaluateFloor() {
    const k = floorKnobs();
    let next = 'go';
    if (k.enabled) {
      next = maxLevel(next, levelFor(voiceSessions, k.speakers));
      next = maxLevel(next, levelFor(pendingCount(), k.queue));
      next = maxLevel(next, levelFor(consumerBacklog(), k.backlog));
    }
    if (next !== floorState) {
      floorState = next;
      log.info('floor', 'state', { state: floorState, speakers: voiceSessions, pending: pendingCount(), backlog: consumerBacklog() });
      broadcastFloor(effectiveFloor());
    }
    return floorState;
  }
  // PROACTIVE gate at the SOURCE: would a NEW segment right now be gated? True only under HOLD (enabled +
  // overloaded) — the server refuses to accept fresh audio only to shed it. (Explicit moderation would
  // override via effectiveFloor.) No-op when the floor is disabled (solo wearable).
  function floorGated() { return floorKnobs().enabled && effectiveFloor() === 'hold'; }

  const api = {
    url: () => `http://127.0.0.1:${httpServer.address().port}`,
    port: () => httpServer.address().port,
    // Plan 0473 P1 — READ the active session profile's knobs (settling/shedding/budget/floor/digest/
    // queue). The engine/tools call this to configure behaviour; they must consume knobs, never the
    // profile NAME (drift guard). P2 is the FIRST real consumer: it reads settlingMs from here.
    profile: () => ACTIVE_PROFILE,
    presence,
    on: (ev, cb) => { if (listeners[ev]) listeners[ev].push(cb); },
    pushContent(target, html, contentId) {
      setDisplay(target, { kind: 'content', html, contentId });
      const n = targets(target).map((ws) => send(ws, { t: 'content', contentId: contentId || null, html }));
      return n.length;
    },
    // Role-aware push: assemble PER channel, stamping identity + viewerRole, and
    // STRIP gm-only scene items for non-GM viewers (real OPSEC — secret content
    // never leaves the server for a player). This is the per-role-render path.
    // requires = the content module's declared plugin deps (Node-style). The
    // assembler bundles core + exactly that transitive closure; [] ⇒ pure core.
    pushComponent(target, component, opts = {}, theme = 'argus', requires = []) {
      const desc = { kind: 'component', component, opts, theme, requires };
      setDisplay(target, desc);                          // C6: remember for (re)connects
      let count = 0;
      for (const ws of targets(target)) { sendComponentTo(ws, conns.get(ws), desc); count++; }
      return count;
    },
    openPoll({ promptId, prompt, options, target = 'participant', resultsTarget = null }) {
      log.info('poll', 'open', { promptId, options: (options || []).length });
      polls.set(promptId, { spec: { prompt, options }, open: true });
      // D1: seed the store so the poll is a first-class state slice.
      serverApply({ path: 'polls/' + promptId + '/spec', verb: 'set', value: { prompt, options } });
      serverApply({ path: 'polls/' + promptId + '/open', verb: 'set', value: true });
      // C6: remember the poll display so late joiners see the choice / live results.
      setDisplay(target, { kind: 'poll-choice', promptId });
      // Assemble a per-channel `choice` stamped with that channel's identity.
      for (const ws of targets(target)) {
        const c = conns.get(ws);
        const html = assemble({ component: 'choice', opts: { prompt, options, promptId, userId: c.userId, userName: c.userName, channel: c.userId } });
        send(ws, { t: 'content', contentId: promptId, html });
      }
      // Optionally push a live results display to another target (e.g. presenter).
      // It stays live via store vote diffs (D3) — no bespoke relay.
      if (resultsTarget) {
        setDisplay(resultsTarget, { kind: 'poll-results', promptId });
        const html = assemble({ component: 'poll-results', opts: { prompt, options, promptId, count: 0 } });
        for (const ws of targets(resultsTarget)) send(ws, { t: 'content', contentId: promptId + ':results', html });
      }
      return { promptId, ...tally(promptId) };
    },
    getPoll: (promptId) => { const votes = store.get('polls/' + promptId + '/votes') || {}; return { promptId, ...tally(promptId), votes: Object.keys(votes).map((userId) => ({ userId, value: votes[userId] })) }; },
    // Hot-reload clients in place (swap client/server code without dropping them).
    reloadClients: (target = 'all', delay = 0) => targets(target).map((ws) => send(ws, { t: 'reload', delay })).length,
    // Plan 0470: REQUEST that a target enable inbound voice. This only sends {t:'voice_enable'};
    // the client still goes through the browser mic-permission prompt (uncoerceable, RT-9) — it
    // can never silently hot a participant's mic. Also warms the recognizer (RT-25).
    voiceEnable: (target = 'all') => { ensureAsr(); return targets(target).map((ws) => send(ws, { t: 'voice_enable' })).length; },
    // Cursored read of recognized speech — VOICE-ONLY view over the unified inbox (back-compat alias).
    // Returns voice entries with seq > since + the (global) next cursor.
    getTranscripts: (since = 0) => ({ transcripts: inbox.filter((t) => t.kind === 'voice' && t.seq > (since || 0)).map((t) => annotateTrust(t, t.trust)), cursor: inboxSeq }),
    // Plan 0472: cursored + optional long-poll read of the UNIFIED inbox (superset of getTranscripts).
    // Returns items with seq > since (interleaved voice+text, seq-ordered) + a next cursor. With
    // waitMs > 0 it LONG-POLLS: returns immediately if anything is already newer than `since`, else
    // registers ONE server-side waiter that resolves on the next emit or at the timeout. The `since`
    // arg is a MANUAL cursor today; the {items,cursor} contract also accommodates a future auto-cursor
    // (server-held per-consumer) mode and a companion presenter_situation() tool without a reshape.
    getInbox: (since = 0, waitMs = 0) => {
      const s = since || 0;
      // Plan 0473 P9: DELIMIT-AS-DATA — every served item is annotated with its trust; participant/guest
      // items are fenced (untrusted data, never commands) and guests flagged. Self/controller pass through.
      const serve = (items) => items.map((i) => annotateTrust(i, i.trust));
      const ready = inbox.filter((i) => i.seq > s);
      if (ready.length || !waitMs) return { items: serve(ready), cursor: inboxSeq };
      return new Promise((resolve) => {
        const w = { settled: false };
        w.wake = () => {
          if (w.settled) return; w.settled = true;
          clearTimeout(w.timer); inboxWaiters.delete(w);
          resolve({ items: serve(inbox.filter((i) => i.seq > s)), cursor: inboxSeq });   // emit-woke: new items; timeout: empty
        };
        w.timer = setTimeout(w.wake, waitMs);
        w.timer.unref?.();
        inboxWaiters.add(w);
      });
    },
    getInboxWaiters: () => inboxWaiters.size,   // test/observability hook: assert no waiter leak
    // Plan 0473 P3 — presenter_situation's engine. Returns the BOUNDED working set for a consumer,
    // advancing that consumer's SERVER-HELD cursor (the consumer passes NO cursor). Optional waitMs
    // long-polls (like getInbox): if nothing is newer than this consumer's stored cursor it registers
    // ONE inbox waiter and resolves on the next emit or at the timeout — then builds the current set.
    situation: ({ consumerId = 'default', waitMs = 0, recentN = RECENT_TURNS_N } = {}) => {
      const last = situationCursors.get(consumerId) || 0;
      if (inboxSeq > last || !waitMs) return buildSituation(consumerId, recentN);
      return new Promise((resolve) => {
        const w = { settled: false };
        w.wake = () => {
          if (w.settled) return; w.settled = true;
          clearTimeout(w.timer); inboxWaiters.delete(w);
          resolve(buildSituation(consumerId, recentN));   // emit-woke: new items folded in; timeout: current set
        };
        w.timer = setTimeout(w.wake, waitMs);
        w.timer.unref?.();
        inboxWaiters.add(w);
      });
    },
    // Plan 0473 P4 — WORK-QUEUE operator surface (server-tracked status/owner; the agent holds nothing).
    // workItems(): the current ACTIONABLE queue (pending + claimed), prioritized + bounded (aged pruned).
    workItems: () => queueView(),
    // Plan 0473 P6 — floor + backstop observability.
    // floorState(): the current EFFECTIVE floor ('go'|'wrap'|'hold') — proactive overload state (explicit
    // moderation, if set, wins over the automatic level here).
    floorState: () => effectiveFloor(),
    // Plan 0473 P11 (F-7) — the AUTOMATIC (load-derived) floor level, BEFORE any moderation override. Used
    // to prove that explicit moderation OVERRIDES the auto floor (auto='go' but effective='hold', or vice-versa).
    autoFloor: () => floorState,
    // floorGated(): would a NEW voice segment be gated right now (effective floor = hold, floor enabled)?
    floorGated: () => floorGated(),
    // Plan 0473 P11 (F-7) — EXPLICIT MODERATION control surface (teacher). All DATA-gated on the profile's
    // floorThresholds.moderationOverrides knob (teaching) — a profile that does not grant it no-ops.
    // moderate({floor}): set/clear the explicit moderation floor that OVERRIDES the automatic load floor.
    setModerationFloor: (state) => setModerationFloor(state),
    // muteParticipant(id)/unmuteParticipant(id): gate WHOSE input reaches the queue — a muted student
    // produces NO work items. Returns {ok, muted:[...]} (ok:false when moderation is not permitted).
    muteParticipant: (userId) => {
      if (!floorKnobs().moderationOverrides) return { ok: false, reason: 'moderation-not-permitted', muted: [...mutedParticipants] };
      mutedParticipants.add(String(userId));
      log.info('floor', 'mute', { userId: String(userId) });
      return { ok: true, muted: [...mutedParticipants] };
    },
    unmuteParticipant: (userId) => {
      if (!floorKnobs().moderationOverrides) return { ok: false, reason: 'moderation-not-permitted', muted: [...mutedParticipants] };
      mutedParticipants.delete(String(userId));
      log.info('floor', 'unmute', { userId: String(userId) });
      return { ok: true, muted: [...mutedParticipants] };
    },
    isMuted: (userId) => mutedParticipants.has(String(userId)),
    // backpressure(): the reactive backstop total ({sheddedCount, floor}) — a shed is never silent.
    backpressure: () => ({ sheddedCount, floor: effectiveFloor() }),
    // voiceSessionCount(): active voice sessions (used to prove a gated seg-start started NO capture).
    voiceSessionCount: () => voiceSessions,
    // workItem(id): the SERVER's full record for one item incl. terminal statuses (resolved/expired/shed)
    // + note/owner — proves the server, not the agent, tracks the state. null if unknown/pruned.
    workItem: (id) => { expireStale(); const it = workItemsMap.get(id); return it ? itemView(it) : null; },
    // debugAllWorkItems(): every RETAINED work item incl. terminal statuses (resolved/expired/shed) +
    // the `deferred` (deprioritized) flag — a test/observability hook proving whole-session invariants
    // (e.g. the wearable scenario: nothing was ever shed or deprioritized). Bounded like workItemsMap.
    debugAllWorkItems: () => { expireStale(); return [...workItemsMap.values()].map((it) => ({ ...itemView(it), deferred: !!it.deferred })); },
    // claim(id): mark an item as being handled (status=claimed) by `owner` — so a second consumer (human
    // via control.html, or another agent) won't double-handle it. Claimed items are exempt from the pending
    // aging-out. Returns the updated item view, or null for an unknown/non-pending-or-claimed id.
    claimWork: (id, { owner = 'agent' } = {}) => {
      expireStale();
      const it = workItemsMap.get(id);
      if (!it || (it.status !== 'pending' && it.status !== 'claimed')) return null;
      it.status = 'claimed'; it.owner = owner || 'agent'; it.claimedTs = Date.now();
      evaluateFloor();   // Plan 0473 P6: queue depth changed — reassess the floor
      log.info('queue', 'claim', { id, owner: it.owner });
      return itemView(it);
    },
    // resolve(id): the judgment is done — move the item OUT of the actionable queue (status=resolved). The
    // server retains the terminal record (with an optional note) so the state is server-tracked, not held
    // by the agent. Returns the updated item view, or null for an unknown/already-resolved id.
    resolveWork: (id, { note = null } = {}) => {
      const it = workItemsMap.get(id);
      if (!it || it.status === 'resolved') return null;
      it.status = 'resolved'; it.resolvedTs = Date.now(); if (note != null) it.note = String(note).slice(0, QUEUE_TEXT_MAX);
      pruneTerminal();
      evaluateFloor();   // Plan 0473 P6: work resolved lowers the load — reassess the floor (may clear to 'go')
      log.info('queue', 'resolve', { id });
      return itemView(it);
    },
    // defer(id): not now — release any claim, push the item to the BACK (lowest priority) and RESTART its
    // aging clock (defer = "look at it later", not "let it expire immediately"). Stays pending/actionable.
    deferWork: (id) => {
      expireStale();
      const it = workItemsMap.get(id);
      if (!it || (it.status !== 'pending' && it.status !== 'claimed')) return null;
      it.status = 'pending'; it.owner = null; it.priority = PRIORITY_DEFERRED; it.createdTs = Date.now(); it.deferred = true;
      evaluateFloor();   // Plan 0473 P6: PROACTIVE-FIRST — reassess the floor before any reactive shed
      enforceQueueBounds();
      log.info('queue', 'defer', { id });
      return itemView(it);
    },
    // Plan 0472 P4 — permissioned guest capability link operator surface.
    // capEnabled: are guest links configured at all (a secret present)?
    capEnabled: () => !!CAP_SECRET,
    // mintCap: sign a guest link payload with THIS server's secret. Returns the token, or null when
    // links are disabled. Caller supplies { sid, scope:['speak','type'], name?, exp (epoch s), nonce };
    // role is irrelevant (the server always forces participant). Keep exp SHORT. NEVER exposes the secret.
    mintCap: (payload = {}) => {
      if (!CAP_SECRET) return null;
      const nonce = payload.nonce || ('g-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
      const exp = (typeof payload.exp === 'number') ? payload.exp : (Math.floor(Date.now() / 1000) + 3600);   // default 1h
      const scope = Array.isArray(payload.scope) ? payload.scope.filter((s) => typeof s === 'string') : ['speak', 'type'];
      return mintCapability({ v: 1, sid: payload.sid != null ? payload.sid : SESSION_ID, role: 'participant', scope, name: payload.name || null, exp, nonce }, CAP_SECRET);
    },
    // revokeCap: revoke a guest link by nonce. Future hellos presenting that nonce are rejected even if
    // the HMAC + exp are still valid. Also closes any live connection currently holding that nonce.
    revokeCap: (nonce) => {
      if (!nonce) return false;
      revokedNonces.add(nonce);
      for (const [ws, c] of conns.entries()) if (c.isGuest && c.capNonce === nonce) { try { ws.close(); } catch (e) {} }
      log.info('cap', 'revoked', { nonce: String(nonce).slice(0, 8) });   // only a short prefix, for audit; not the token
      return revokedNonces.has(nonce);
    },
    isCapRevoked: (nonce) => revokedNonces.has(nonce),
    // Clear the display back to idle/branding. Sends {t:'clear'} to live clients AND drops the stored
    // display descriptor so a RECONNECTING client converges to idle branding, not the stale last content
    // (fixes "stuck on the end card, never reverts to branding"). Use as the standard session-end primitive.
    clear: (target = 'all') => { setDisplay(target, null); return targets(target).map((ws) => send(ws, { t: 'clear' })).length; },
    // CHIME (bell control): a transient signal (NOT a display descriptor — no setDisplay, so it
    // never re-fires on reconnect). Rings a gentle chime + shows a persistent banner on live
    // clients, so a human keeping the tab backgrounded knows to come look.
    // requireAck=true makes the banner show a CONFIRM button — the viewer must click it to
    // prove eyes-on (not AFK). Poll getAck(ackId) for who has confirmed / who is pending.
    // bell (default true) is carried in the frame: bell:false = SILENT ask (banner only, no
    // audio) — the client's onChime plays audio unless m.bell === false.
    chime: ({ message = 'Ready to start?', target = 'all', requireAck = false, ackId = 'ready', bell = true } = {}) => {
      if (requireAck) { const prev = acks.get(ackId); acks.set(ackId, { message, requestedAt: Date.now(), target, by: (prev && prev.by) || new Map() }); }
      return targets(target).map((ws) => send(ws, { t: 'chime', message, requireAck: !!requireAck, ackId, bell: bell !== false })).length;
    },
    // Eyes-on status for an ackId: who confirmed they're watching, and who (among current
    // viewers of the requested target) is still pending — the AFK signal.
    getAck: (ackId = 'ready') => {
      const a = acks.get(ackId);
      const viewerIds = targets((a && a.target) || 'all').map((ws) => conns.get(ws)).filter(Boolean).map((c) => c.userId);
      const by = a ? [...a.by.entries()].map(([userId, v]) => ({ userId, userName: v.userName, at: v.at })) : [];
      const acked = new Set(by.map((b) => b.userId));
      return { ackId, message: a ? a.message : null, requestedAt: a ? a.requestedAt : null, acked: by.length > 0, count: by.length, by, pending: viewerIds.filter((u) => u && !acked.has(u)) };
    },
    // ATT (Plan 0466 §2.4, reworked Plan 0468): the roster dot means CONNECTION LIVENESS ONLY,
    // uniform in every display. `connected` = lastSeen fresh within staleMs (kept fresh by the Part A0
    // heartbeat) ⇒ GREEN; stale ⇒ RED (present-but-stale; a CLEAN close removes the row entirely, G3).
    // NO idle-derived status and NO time-since-interaction number — both dropped (D2). Attention is a
    // SEPARATE explicit signal: `eyesOn` is a prior verify_watching CONFIRM only (D3) — never polling/content.
    // lastSeenAgoSec replaces the old idle number: bounded (heartbeat-refreshed), never epoch-sized (INV-5).
    attendance: ({ staleMs = STALE_MS, viewerRole = 'participant' } = {}) => {
      const now = Date.now();
      const control = (viewerRole === 'presenter' || viewerRole === 'ai');
      // TODO(opsec): throttle control-view info exposure — see plan 0466 §Deferred
      const full = [...conns.values()].map((c) => {
        const lastSeenAgoSec = Math.floor((now - (c.lastSeen || now)) / 1000);
        const connected = (now - (c.lastSeen || 0)) <= staleMs;   // green when fresh, red when stale
        return {
          userId: c.userId, userName: c.userName, role: c.role,
          connected,                                             // <-- the dot (liveness only)
          connectedSec: Math.floor((now - (c.connectedAt || now)) / 1000),
          lastSeenAgoSec,                                        // replaces old idle number; bounded, never epoch-sized
          eyesOn: !!c.eyesOn,                                    // explicit attendance (verify_watching CONFIRM)
          eyesOnAgoSec: c.eyesOn ? Math.floor((now - c.eyesOn) / 1000) : null,
          display: displayIdFor(c),
          ip: c.ip, socketId: c.id,                             // CONTROL-ONLY (stripped below for participants)
        };
      });
      const summary = {
        connected: full.filter((r) => r.connected).length,
        offline: full.filter((r) => !r.connected).length,
        eyesOn: full.filter((r) => r.eyesOn).length,
        total: full.length,
      };
      // Redaction is SERVER-SIDE (global invariant): participants get names + role + connected + eyesOn
      // ONLY — no ip/socketId/display/last-seen. Control/ai get the full rows (per-row buttons need them).
      const roster = control ? full : full.map((r) => ({
        userId: r.userId, userName: r.userName, role: r.role, connected: r.connected, eyesOn: r.eyesOn,
      }));
      return { roster, summary };
    },
    closePoll: (promptId) => { const p = polls.get(promptId); if (p) p.open = false; serverApply({ path: 'polls/' + promptId + '/open', verb: 'set', value: false }); return { promptId, ...tally(promptId) }; },
    // Debug snapshot for the ?debug overlay + the presenter_debug MCP tool.
    // state = current authoritative view (proto: polls; the core store extends this
    // in group C); opLog = the structured-log tail (role-redacted for the viewer).
    debugDump: (role = 'presenter') => ({
      presence: presence(),
      connections: [...conns.values()].map((c) => ({ socketId: c.id, userId: c.userId, role: c.role })),
      state: { polls: [...polls.entries()].map(([id, p]) => ({ promptId: id, open: p.open, ...tally(id) })), store: store.snapshot(role).state },
      version: store.version(),
      opLog: log.view(role, { max: 50 }),
      // Telemetry is controller-read-only (S7): only presenter/ai see the operational sink.
      telemetry: (role === 'presenter' || role === 'ai') ? telemetryView() : null,
    }),
    telemetry: telemetryView,
    // ---- Group I: content-module display + authoring (humans AND the AI) ----
    // A content module is a portable deck of beats; showing a beat pushes it to all
    // (viewers follow in lockstep). module/current + module/len are store slices.
    setModule(module) {
      contentModule = (module && typeof module === 'object')
        ? Object.assign({}, module, { title: module.title || (module.manifest && module.manifest.title) || 'Module', beats: module.beats || [] })
        : { title: 'Module', beats: [] };   // keep sections/manifest server-side (not just title+beats)
      currentBeat = -1;
      // Plan 0438 D: validate on load — observability only, NEVER blocks (warn-never-block).
      try { const v = summarize(validate({ title: contentModule.title, beats: contentModule.beats, manifest: module && module.manifest })); if (v.warn || v.info) log.info('module', 'validate', { warn: v.warn, info: v.info, codes: v.warnings.concat(v.infos).map((x) => x.code) }); } catch (e) { log.warn('module', 'validate-error', { err: String(e).slice(0, 120) }); }
      serverApply({ path: 'module/len', verb: 'set', value: contentModule.beats.length });
      serverApply({ path: 'module/current', verb: 'set', value: -1 });
      // DEF-1: auto-show the module's default/title page on load if declared+resolvable; else
      // leave branding (currentBeat stays -1, push nothing). The panel still drives Start via show_beat index:0.
      const did = contentModule.manifest && contentModule.manifest.defaultBeatId;
      if (did != null && contentModule.beats.findIndex((b) => b.id === did) >= 0) api.showBeat(did);
      return { title: contentModule.title, beats: contentModule.beats.length };
    },
    showBeat(ref) {
      if (!contentModule) return null;
      const i = typeof ref === 'number' ? ref : contentModule.beats.findIndex((b) => b.id === ref);   // by index OR beat id (branch nav)
      if (i < 0 || i >= contentModule.beats.length) return null;
      const b = contentModule.beats[i];
      // Route by the beat's target (per-user hooks broadcast to 'all' by default) and ensure promptId
      // reaches opts so interactive beats can actually collect/gate answers.
      const opts = (b.promptId != null) ? Object.assign({}, b.opts || {}, { promptId: b.promptId }) : (b.opts || {});
      api.pushComponent(b.target || 'all', b.component, opts, b.theme || 'argus', b.requires || []);
      // DEL-1: per-user layers. A layer with a `target` OVERRIDES the base opts for that
      // user/role (layer opts win). `when`-only layers are runner-evaluated — out of scope here.
      // Base goes to all; layered targets additionally receive the merged override (last-wins).
      if (Array.isArray(b.layers)) for (const L of b.layers) {
        if (!L || !L.target) continue;
        const lopts = Object.assign({}, b.opts || {}, L.opts || {}, (b.promptId != null) ? { promptId: b.promptId } : {});
        api.pushComponent(L.target, b.component, lopts, b.theme || 'argus', b.requires || []);
      }
      currentBeat = i;
      serverApply({ path: 'module/current', verb: 'set', value: i });
      return { index: i, component: b.component, target: b.target || 'all' };
    },
    nextBeat() { return api.showBeat(currentBeat + 1); },
    prevBeat() { return api.showBeat(Math.max(0, currentBeat - 1)); },
    // DEF-1: cascading default. A module WITH a resolvable manifest.defaultBeatId shows that
    // title/default beat; a module without one (or no module at all) falls back to branding
    // (clear). This is the mechanism behind Home + the STOP/end→branding cascade.
    showDefault() {
      const did = contentModule && contentModule.manifest && contentModule.manifest.defaultBeatId;
      if (did != null && contentModule.beats.findIndex((b) => b.id === did) >= 0) return api.showBeat(did);
      api.clear('all');
      return null;
    },
    appendBeat(beat) {
      if (!contentModule) contentModule = { title: 'Module', beats: [] };
      contentModule.beats.push(beat);
      serverApply({ path: 'module/len', verb: 'set', value: contentModule.beats.length });
      return { beats: contentModule.beats.length };
    },
    getModule() { return contentModule ? JSON.parse(JSON.stringify(contentModule)) : null; },   // portable snapshot (I4)
    loadModule(module) { return api.setModule(module); },
    // X4 health: liveness (last-seen/RTT), throughput, error rate, sizes, stuck detection.
    health: ({ staleMs = 10000 } = {}) => {
      const now = Date.now();
      const connections = [...conns.values()].map((c) => {
        const ageMs = now - (c.lastSeen || now);
        return { socketId: c.id, userId: c.userId, role: c.role, ageMs, stale: ageMs > staleMs };
      });
      const o = telem.ops, total = o.applied + o.denied + o.malformed;
      const errorRate = total ? +((o.denied + o.malformed) / total).toFixed(3) : 0;
      const anyStale = connections.some((x) => x.stale);
      const status = (anyStale || errorRate > 0.5) ? 'degraded' : 'green';
      return {
        status, connections,
        opsApplied: o.applied, errorRate,
        stateVersion: store.version(), opLogSize: store.oplogSince(0).length,
        rtt: telem.rtt.last, reconnects: telem.reconnects,
      };
    },
    // X5 RAF metrics from the attributed/timestamped op-log.
    raf: ({ windowMs = 5000 } = {}) => {
      const entries = store.oplogSince(0);
      const total = entries.length;
      const CONTROLLERS = new Set(['ai', 'presenter']);
      const peerVisible = entries.filter((e) => e.role === 'participant' && store.perms.canRead('participant', e.path)).length;
      const teacher = entries.filter((e) => CONTROLLERS.has(e.role)).length;
      // Peer->peer response edges: a participant op preceded (within windowMs) by a
      // DIFFERENT participant's op = a peer responding to a peer.
      const partOps = entries.filter((e) => e.role === 'participant');
      let edges = 0;
      for (let i = 0; i < partOps.length; i++) {
        for (let j = i - 1; j >= 0; j--) {
          if (partOps[i].ts - partOps[j].ts > windowMs) break;
          if (partOps[j].by !== partOps[i].by) { edges++; break; }
        }
      }
      return {
        totalOps: total,
        peerCatalysisRatio: total ? +(peerVisible / total).toFixed(3) : 0,
        teacherDependencyRatio: total ? +(teacher / total).toFixed(3) : 0,
        interactionDensity: partOps.length ? +(edges / partOps.length).toFixed(3) : 0,
        peerResponseEdges: edges, participantOps: partOps.length,
      };
    },
    store,
    close: () => new Promise((res) => { clearInterval(heartbeat); /* Plan 0468 (INV-7) */ if (ephTimer) clearTimeout(ephTimer); for (const t of hotTimers.values()) clearTimeout(t); hotTimers.clear(); for (const w of [...inboxWaiters]) w.wake(); /* Plan 0472: drain pending long-poll waiters (resolve, no dangling) */ if (openTurn && openTurn.timer) { clearTimeout(openTurn.timer); openTurn.timer = null; } /* Plan 0473 P2: clear a pending turn-settling timer */ for (const [, c] of conns) { if (c.voice && c.voice.timer) clearTimeout(c.voice.timer); } if (asr) { try { asr.close(); } catch (e) {} asr = null; } watcher && watcher.close(); wss.clients.forEach((c) => c.close()); httpServer.close(() => res()); }),
    _http: httpServer,
  };

  return new Promise((resolve) => { httpServer.listen(port, '127.0.0.1', () => resolve(api)); });
}

// Runnable standalone: `node app/server.mjs [port]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const p = parseInt(process.argv[2] || '4300', 10);
  // Real deployments are GATED out of the box: default the presenter password to
  // `password` (override via PRESENTER_ROLE_PASSWORD). This applies ONLY to the CLI
  // self-run — createServer() from tests stays ungated unless a credential is passed.
  createServer({
    port: p,
    controlToken: process.env.PRESENTER_CONTROL_TOKEN || null,
    rolePassword: process.env.PRESENTER_ROLE_PASSWORD || 'password',
  }).then((s) => {
    const u = s.url();   // base like http://127.0.0.1:PORT (no trailing slash)
    console.log('Argus Presenter running:');
    console.log('  display :', u + '/');
    console.log('  control :', u + '/control');
    console.log('  creator :', u + '/creator');
  });
}
