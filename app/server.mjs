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
import { createHash, randomInt } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, watch, mkdirSync, unlinkSync, renameSync, appendFileSync, lstatSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { WebSocketServer } from 'ws';
import { assemble } from '../harness/assemble.mjs';
import { loadManifests, pluginDir, buildStationRegistry, buildSurfaceRegistry, pluginServerModule } from '../harness/plugins.mjs';
import * as log from './log.mjs';
import { createStore, isEphemeral, validOp } from './state.mjs';
import { ALL as ALL_READ_ROLES } from './permissions.mjs';
import { validate, summarize } from './validate.mjs';
import { createAsr } from './asr.mjs';
import { verifyCapability, mintCapability } from '../lib/capability.mjs';
import { presenterPort, authPolicy, normalizeAuthPolicy, identityConfig, identityServerOptions, identityStartupLine, bindHostsConfig, roomConfig, roomStartupLine, installConfigReloader } from '../lib/deployment-config.mjs';
import { makeAllowlist, makeOidcAdapter, makeTailscaleAdapter, defaultOidcDeps, makeTailscaleWhois, makeBreakGlassAdapter, isTailnetPeerAddress } from './identity.mjs';
/* Plan 0650 §2a — how long a socket's first frames may wait for `tailscale whois`, and how many may
 * queue while they do. The deadline is the whois timeout plus slack: past it the peer is simply
 * UNRESOLVED (a fenced participant), never a hang and never a grant. */
const IDENTITY_GATE_MS = 1600;
const IDENTITY_GATE_MAX_FRAMES = 64;
import { createSessionLog, resolveSessionLogDir, defaultSessionLogDir } from '../lib/session-log.mjs';
import { CursorBook, isDeliveryKey } from '../lib/delivery-cursors.mjs';
import { createCursorStore } from '../lib/cursor-store.mjs';
import { selectProfile, DEFAULT_PROFILE } from './profiles.mjs';
import { createHeuristicSummarizer } from './summarizer.mjs';
import { buildDigest } from './digests.mjs';
import { deriveTrust, annotate as annotateTrust, sanitizeUntrusted, sanitizeFields, TRUST } from './untrusted.mjs';
import { renderMarkdown } from './markdown.mjs';
// Plan 0530 P2 (seam S-A) — the HTTP route table, lifted out of createServer(). It imports
// NOTHING from this file: everything it used to capture from the closure is handed to it
// explicitly at the call site below. A back-import would be a cycle, and a cycle would mean the
// seam was cut in the wrong place.
import { createWireActions } from './wire-actions.mjs';
import { createApiSurface } from './api-surface.mjs';
import { createHttpHandler } from './http-routes.mjs';

// X6 resilience caps.
const MAX_CONNS = 200;              // connection cap
// MERGE (S209): the two sides are NOT in tension — different caps, different jobs.
// Keep BOTH. Reverting MAX_PAYLOAD to 256KB silently re-breaks voice capture (a whole-utterance
// burst is ~937KB and ws closes with 1009) — that was one of the five stacked bugs fixed in S206.
const MAX_PAYLOAD = 1024 * 1024;    // per-frame ws byte cap (S206: 256KB->1MB for voice bursts)
const MAX_VALUE_BYTES = 64 * 1024;  // Plan 0471 M3: per-value cap (mirrors state.mjs) — lastResults path
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

// ── Plan 0522 P11 (R11) — MODULE LIFECYCLE ────────────────────────────────────────────────
// `status` is the ONE optional manifest field this phase adds. `kind` already exists on almost
// every module and is the grouping axis, so no second hierarchy is invented.
//
// ⚠ I1 (surface parity) BY CONSTRUCTION. The control page reads /api/modules and the agent
// reads mcp/tools.mjs `presenter_modules`, and those are two separate directory scans. If the
// defaults lived in each of them, one surface would eventually decide a module is `retired`
// and the other would not. They both call THIS function instead.
//
// ⚠ FAILURE POSTURE — DELIBERATELY *NOT* buildStationRegistry's. That builder throws at load,
// because it reads ONE deployment-wide file ONCE at boot: a bad file should stop the server
// rather than surprise a live session. This reads ~30 independent content files LAZILY, per
// request, so a throw here would empty the entire picker because one file has a typo — the
// exact session-stopper I4 forbids. So an unrecognised value CANNOT hide anything: it degrades
// to the permissive default and is reported back in `statusInvalid` so the surface can say so
// out loud. Only an explicit, RECOGNISED status ever removes a row from the default view.
export const MODULE_STATUSES = ['active', 'working', 'retired'];
export const MODULE_KIND_NONE = 'Uncategorized';
export function moduleLifecycle(man) {
  const m = man || {};
  const kind = typeof m.kind === 'string' ? m.kind.trim() : '';
  const raw = (m.status === undefined || m.status === null) ? '' : String(m.status).trim();
  const norm = raw.toLowerCase();
  const ok = MODULE_STATUSES.includes(norm);
  return {
    kind: kind || null,                          // null ⇒ the picker groups it under MODULE_KIND_NONE
    status: ok ? norm : 'active',                // absent OR unrecognised ⇒ active (I4: the permissive default)
    statusInvalid: (raw && !ok) ? raw.slice(0, 40) : null,
  };
}

/**
 * Plan 0514 §5 — the seat-name slug. lowercase · non-[a-z0-9] → '-' · collapse repeats ·
 * trim · cap 24 chars. Empty ⇒ 'anon'. Same link ⇒ same userId, every time. That is the
 * whole point: two players sharing one nameless link land on the same seat, which is correct
 * because identical links are indistinguishable by construction.
 */
export function slugForSeat(name) {
  const s = String(name == null ? '' : name)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 24).replace(/-$/, '');
  return s || 'anon';
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

export function createServer({ port = 0, controlToken = null, rolePassword = null, roleSeed = null, voiceEnabled = undefined, capSecret = null, profile = DEFAULT_PROFILE, settlingMs = null, queueMaxPending = null, queueTtlMs = null, perTurnBudgetMs = null, perTurnWrapMs = null, floorThresholds = null, sessionLogDir = null, enforceOAuth = undefined, allowPasswordCommandOnLAN = undefined, allowlist = null, oidc = null, oidcDeps = null, oidcSessionTtlMs = null, tailscale = null, tailscaleResolve = null, tailscaleWhois = null, breakGlass = null, breakGlassDeps = null, revokedNonceFile = null, sessionStoreFile = null, bindHosts = null, cursorDir = null } = {}) {
  // Plan 0543 P1 — the AUTH POLICY dial. Validated HERE (the single startup path shared by the CLI
  // self-run and presenter_start): an unknown enforceOAuth value THROWS rather than falling through
  // to a policy the deployer never chose. This slice is plumbing only — P3 makes the policy govern.
  const AUTH_POLICY = normalizeAuthPolicy({ enforceOAuth, allowPasswordCommandOnLAN }, 'createServer()');
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
  /* Plan 0539 P3.1 (SECURITY) — THE OTHER HALF OF 0537 P1.2, and it is not where the plan said.
   *
   * 0539 P3.1 named `mcp/tools.mjs:146` (`gated` from `!!rest.rolePassword`) as an unfixed instance
   * of the empty-string class. ⛔ REFUTED BY MEASUREMENT: that line is unreachable with an empty
   * password, because the MCP tool funnels through `createServer`, which throws ~15 lines above.
   * `presenter_start({rolePassword: ''})` and `{rolePassword: '   '}` both raise the 0537 error.
   *
   * ✅ But the CLASS is real, and this is where it actually lives. `controlToken || env || null` is
   * the exact `||` idiom 0537 P1.2 removed for the password and left standing for the TOKEN — so
   * `PRESENTER_CONTROL_TOKEN=` (a blank env line, a cleared config field) still yields
   * CONTROL_TOKEN=null and an UNGATED server, with no complaint. The same operator mistake is a
   * loud failure for one credential and a silent open door for the other, which is worse than
   * either rule applied consistently. Verified first that nothing in the tree supplies an empty
   * token: the MCP path mints one before it can happen, and no test passes `controlToken: ''`. */
  const CONTROL_TOKEN_SUPPLIED = (controlToken !== null && controlToken !== undefined) ? controlToken
    : (process.env.PRESENTER_CONTROL_TOKEN !== undefined ? process.env.PRESENTER_CONTROL_TOKEN : null);
  if (typeof CONTROL_TOKEN_SUPPLIED === 'string' && CONTROL_TOKEN_SUPPLIED.trim() === '') {
    throw new Error('controlToken was supplied but is empty (or whitespace). An empty token cannot gate anything, and accepting it would start an UNGATED server. Set a real token, or omit controlToken entirely to run open on purpose.');
  }
  const CONTROL_TOKEN = CONTROL_TOKEN_SUPPLIED || null;
  // AUTH-ROLE (P5.5): a shared PASSWORD gate via a seeded hash ("keep honest people
  // honest"). The seed is a public salt; the password is secret. ROLE_HASH =
  // sha256(seed + password). The browser computes the same hash and sends it as the
  // hello token — plaintext never leaves the client. NULL password ⇒ this gate is
  // inactive (so createServer() with no credential stays UNGATED for existing tests).
  const ROLE_SEED = roleSeed || process.env.PRESENTER_ROLE_SEED || 'argus-presenter';
  // Plan 0537 P1.2 (SECURITY) — an EMPTY password must never silently disable this gate.
  // `rolePassword || env || null` treated '' as "absent": an operator who set the password to an
  // empty string (a blank config field, `PRESENTER_ROLE_PASSWORD=`) got ROLE_HASH=null and an
  // UNGATED server — while `gated` still reported true if a control token happened to exist, so
  // the readout agreed with them and the room was open. Fail LOUDLY instead: a credential that
  // was explicitly supplied and is unusable is an error, not a default.
  const ROLE_PW_SUPPLIED = (rolePassword !== null && rolePassword !== undefined) ? rolePassword
    : (process.env.PRESENTER_ROLE_PASSWORD !== undefined ? process.env.PRESENTER_ROLE_PASSWORD : null);
  if (typeof ROLE_PW_SUPPLIED === 'string' && ROLE_PW_SUPPLIED.trim() === '') {
    throw new Error('rolePassword was supplied but is empty (or whitespace). An empty password cannot gate anything, and accepting it would start an UNGATED server that reports itself as gated. Set a real password, or omit rolePassword entirely to run open on purpose.');
  }
  const ROLE_PW = ROLE_PW_SUPPLIED;
  const ROLE_HASH = ROLE_PW ? sha256hex(ROLE_SEED + ROLE_PW) : null;
  // Plan 0472 P4 (SECURITY): the HMAC secret for permissioned GUEST capability links (/?cap=…).
  // From the option or PRESENTER_CAP_SECRET. There is NO insecure default and an empty string is
  // treated as UNSET — when null, capability links are DISABLED and every presented `cap` is rejected.
  // NEVER logged or echoed. Independent of the control-token / role-password gate (a cap never grants
  // a control role; that gate alone governs presenter/ai).
  const CAP_SECRET = capSecret || process.env.PRESENTER_CAP_SECRET || null;
  // Revoked-nonce set. api.revokeCap(nonce) adds; a revoked nonce is rejected on hello even if its HMAC
  // + exp are still valid.
  // Plan 0543 P4 — the set is DURABLE when a file is configured: the one real bug 0489 flagged was that
  // a revocation died with the process, so a still-unexpired guest link came back to life across a
  // restart. When `revokedNonceFile` is set, we LOAD it at start and REWRITE it on every revoke. The
  // library default is null (in-memory only) so the test suite writes nothing; the CLI / presenter_start
  // resolve a durable path. Never fatal: an unreadable/unwritable file degrades to in-memory, loudly.
  const revokedNonces = new Set();
  const REVOKED_FILE = (typeof revokedNonceFile === 'string' && revokedNonceFile.trim()) ? revokedNonceFile.trim() : null;
  if (REVOKED_FILE) {
    try {
      const arr = JSON.parse(readFileSync(REVOKED_FILE, 'utf8'));
      if (Array.isArray(arr)) for (const n of arr) if (typeof n === 'string' && n) revokedNonces.add(n);
    } catch (e) { /* absent/unreadable ⇒ start empty; a fresh deployment has no file yet */ }
  }
  function persistRevokedNonces() {
    if (!REVOKED_FILE) return;
    try { mkdirSync(dirname(REVOKED_FILE), { recursive: true }); writeFileSync(REVOKED_FILE, JSON.stringify([...revokedNonces])); }
    catch (e) { try { log.warn('cap', 'revoked-persist-failed', { err: String((e && e.message) || e).slice(0, 120) }); } catch {} }
  }
  /*
   * Plan 0543 P2 — IDENTITY ADAPTERS (the registry). Each yields a VERIFIED PRINCIPAL or null; NONE
   * of them decides trust (that is resolveIdentity, P3). Data-configured: oidc/tailscale/allowlist are
   * deployment config passed in; the network deps are injectable so the flow LOGIC is testable offline.
   *   - AUTH_ALLOWLIST — FAIL-CLOSED: a verified principal not on it authorizes to participant (fenced).
   *   - oidcAdapter    — Google sign-in (PKCE+state+nonce+RS256/JWKS); INACTIVE (inert 404) without config.
   *   - tsAdapter      — a DIRECT tailnet peer's identity (never over the tunnel).
   */
  const AUTH_ALLOWLIST = makeAllowlist(allowlist);
  /*
   * ── Plan 0693 T1 — THE SESSION STORE PATH IS DEPLOYMENT DATA, AND IT IS PASSED IN HERE ────────
   * `sessionStoreFile` null (every bare library call, i.e. the whole suite) ⇒ the adapter keeps its
   * sessions in memory exactly as before and writes nothing. Both launch paths resolve a path in
   * the declared state dir, so a REAL deployment's sign-in survives the next deploy.
   * ⛔ The warn hook receives CATEGORIES AND COUNTS ONLY — never a session id, never a principal.
   */
  const oidcAdapter = makeOidcAdapter(oidc, {
    ...(oidcDeps || defaultOidcDeps()),
    ...(oidcSessionTtlMs != null ? { sessionTtlMs: oidcSessionTtlMs } : {}),
    sessionStoreFile,
    onStoreWarn: (event, detail) => { try { log.warn('auth', event, detail || {}); } catch {} },
  });
  /*
   * ── Plan 0650 §2a — THE TAILNET RESOLVER IS BUILT HERE, NOT ROUTED FROM CONFIG ────────────────
   *
   * ⛔ THE 0543 FAILURE MODE WAS "the option existed and nothing supplied a value". Routing a
   * resolver through the deployment file would reproduce it one level up: a second place that can
   * be forgotten. So the PRODUCTION resolver is CONSTRUCTED FROM THE ONE FACT THAT ALREADY GOVERNS
   * IT — `tailscale.enabled`. Enable the adapter and it is wired, on both launch paths, by
   * construction. There is no configuration in which it can be enabled-but-inert again.
   *
   * `tailscaleResolve` (the pre-existing sync seam, injected by four test files) still WINS when
   * given, and `tailscaleWhois` lets a test drive the real two-phase resolver with `whois` and the
   * peer address stubbed. Neither is reachable from the MCP surface.
   */
  const tsWhois = tailscaleWhois
    || ((tailscale && tailscale.enabled && !tailscaleResolve) ? makeTailscaleWhois() : null);
  const tsAdapter = makeTailscaleAdapter(tailscale, {
    resolve: tailscaleResolve || (tsWhois ? (req) => tsWhois.resolve(req) : null),
  });
  /*
   * Plan 0543 P3 — BREAK-GLASS STARTUP GATE (the config gate only; the full recovery flow is 0489's).
   * enforceOAuth='control' RETIRES the password for the Control page, so if the OIDC provider is
   * unreachable and no local recovery credential exists, the deployment can lock everyone out. Refuse
   * to start without one. A break-glass credential is the 0489 §4.6 shape (loopback-only, single-use,
   * TTL, 0600 file); here we enforce only that ONE is configured (a token or a file path).
   */
  const breakGlassConfigured = !!(breakGlass && typeof breakGlass === 'object' && (breakGlass.token || breakGlass.file));
  if (AUTH_POLICY.enforceOAuth === 'control' && !breakGlassConfigured) {
    throw new Error("enforceOAuth='control' retires the password for the Control page; a break-glass credential must be configured (0489 §4.6: loopback-only, single-use, TTL, 0600 file) or an OIDC outage locks everyone out. Configure breakGlass, or run enforceOAuth='off'.");
  }
  /*
   * Plan 0650 §2b — ...AND NOW SOMETHING CONSUMES IT. The gate above has demanded this credential
   * since 0543 and no route has ever accepted one. POST /auth/break-glass redeems it; the adapter
   * enforces loopback-only, single-use, TTL and the 0600 file mode. It grants the CONTROL ROLE and
   * deliberately NOT trust:self — see deriveConnTrust below.
   */
  const bgAdapter = makeBreakGlassAdapter(breakGlass, breakGlassDeps || {});
  /*
   * Plan 0551 P2 — THE ONE STARTUP LINE: is sign-in ACTIVE, and how many principals are authorized?
   * Emitted HERE, inside the single startup path, so BOTH launch paths report it and so it states
   * what the server ACTUALLY received rather than what a config file said.
   *
   * ⛔ STATE, NEVER CONTENTS. The size of the allowlist, never its entries; that OIDC is configured,
   * never the client id or secret. This line reaches the log ring a debug endpoint can serve.
   *
   * WHY IT EXISTS: 0543 booted inert and said nothing. A server that has silently lost its sign-in
   * must be legible from the outside, or the next person also finds out on a phone.
   */
  log.info('auth', 'identity', {
    oidcActive: oidcAdapter.active,
    allowlistSize: AUTH_ALLOWLIST.size,
    tailscaleActive: tsAdapter.active,
    tailscaleResolverWired: !!(tailscaleResolve || tsWhois),   // Plan 0650 — INERT MUST BE VISIBLE: this was silently false for months
    breakGlass: breakGlassConfigured,
    breakGlassRedeemable: bgAdapter.active,
    enforceOAuth: AUTH_POLICY.enforceOAuth,
  });
  /*
   * Plan 0543 P3 — the AUTH CONTEXT for a connection. Bruce's ruling (2026-08-05): LOOPBACK/LOCALHOST
   * IS NOT AN AUTH SIGNAL — any local process or webpage generates loopback traffic, so it carries no
   * security value and grants NOTHING. The ONLY thing this reads is a VERIFIED PRINCIPAL (an OIDC
   * session cookie, or a DIRECT tailnet peer) and whether a live OIDC session has expired. Read from
   * the request, never from a client claim.
   */
  function computeAuthCtx(req) {
    // ⚠ Read sessionExpired BEFORE principalForRequest — the latter DELETES an expired session, which
    // would otherwise hide the expiry from the re-auth prompt (the A-fix). Order is load-bearing.
    const expiredBefore = oidcAdapter.sessionExpired(req);
    const verified = oidcAdapter.principalForRequest(req) || bgAdapter.principalForRequest(req) || tsAdapter.principalForRequest(req) || null;
    return { verified, sessionExpired: !verified && expiredBefore };
  }
  /** Plan 0543 P3 — the Control-page role from IDENTITY: ONLY a verified + ALLOWLISTED principal. Loopback grants nothing. */
  function identityGrantsControl(authCtx) {
    if (!authCtx || !authCtx.verified) return false;
    // Plan 0650 §2b — BREAK-GLASS BYPASSES THE ALLOWLIST, and must: the allowlist is keyed by the
    // email an IdP asserts, and the whole premise of break-glass is that the IdP is unreachable.
    // Presenting the on-box credential from loopback IS the authorization. It is single-use and
    // time-boxed by the adapter, and it stops here — it never reaches deriveConnTrust's SELF.
    if (authCtx.verified.provider === 'break-glass') return true;
    return AUTH_ALLOWLIST.lookup(authCtx.verified.email || authCtx.verified.sub).allowed;
  }
  /*
   * Plan 0543 P3 — THE COMMAND-TRUST DECISION (the one gate). Bruce's ruling: `self` (authority to send
   * prompts/commands to the agent) comes ONLY from a VERIFIED IDENTITY (OIDC | Tailscale) that is ALSO
   * on the allowlist. NOTHING else earns it — not loopback, not a password/control role, not a
   * self-asserted role. The allowlist (Bruce, Gen) is the sole authorization to command Argus.
   */
  function deriveConnTrust(ident, capGrant, authCtx) {
    if (capGrant || (ident && ident.isGuest)) return { trust: TRUST.GUEST };                         // 1. cap ⇒ guest (fenced)
    if (authCtx.verified) {
      // Plan 0650 §2b — ⛔ BREAK-GLASS IS NOT COMMAND AUTHORITY. Bruce's ruling above is that `self`
      // comes only from a VERIFIED IDENTITY (OIDC | Tailscale) that is ALSO on the allowlist. A
      // secret in a file on the box is neither: it says "someone reached this machine", not "this
      // is Bruce". So it opens the Control page (identityGrantsControl) and its words stay FENCED.
      if (authCtx.verified.provider === 'break-glass') return { trust: TRUST.PARTICIPANT, reason: 'break-glass: control page only, never command authority' };
      const al = AUTH_ALLOWLIST.lookup(authCtx.verified.email || authCtx.verified.sub);
      if (al.allowed) return { trust: TRUST.SELF };                                                   // 2. verified (OIDC|Tailscale) AND allowlisted ⇒ SELF
      return { trust: TRUST.PARTICIPANT, reason: 'signed in, not authorized' };                       // 3. verified but NOT allowlisted ⇒ fenced (E / the C dead-end)
    }
    if (authCtx.sessionExpired) return { trust: TRUST.PARTICIPANT, reason: 're-authentication required', reauth: true };  // A-fix: prompt re-auth, never a silent fence
    return { trust: TRUST.PARTICIPANT };   // 4. everything else — incl loopback, incl password-only (Control-page role, never self) ⇒ fenced
  }
  /*
   * ── Plan 0551 P3 — THE AUTH STATE A BROWSER MAY SEE (GET /api/auth-state) ────────────────────
   *
   * WHY IT EXISTS: a sign-in control that is always visible on a deployment with no IdP is a
   * button that 404s, and one that is never visible on a deployment WITH an IdP is 0543 — a
   * complete OAuth stack no human could reach. The page must be able to ask.
   *
   * ⛔ WHAT IT MAY SAY, AND NOTHING MORE:
   *   oidcActive  is sign-in configured on this deployment (a property of the SERVER, not of you)
   *   signedIn    does THIS request carry a verified session
   *   name        the display name of the person holding it — for their own eyes, on their own
   *               request. ⛔ NEVER the email, NEVER `sub`, NEVER the session id. The presence
   *               payload already carries ip/socketId (§0 of the plan); this must not join it.
   *   trust       the fence verdict, so the page can say "signed in, not authorized" out loud
   *               instead of leaving a person to discover it when their words are fenced.
   *
   * ⛓ trust is READ FROM deriveConnTrust — the SAME one function the socket uses. A second
   * trust computation here would be a second policy, and the two would eventually disagree.
   */
  /**
   * ⭐⭐ MAY THIS REQUEST OPEN A MICROPHONE? Two conditions, both required:
   *   1. VERIFIED — signed in through OIDC (or a tailnet peer we resolved), not merely present.
   *   2. GRANTED  — that person's allowlist entry carries `voice: true`, explicitly.
   * ⛔ FAIL-CLOSED AND OFF BY DEFAULT. Membership of the allowlist grants nothing here; driving the
   *   room and opening a microphone in it are different permissions. Anyone unlisted, unverified, on
   *   a cap link, or listed without the flag gets `false`.
   */
  function voiceAllowedFor(req, authCtx) {
    try {
      /* ⛔⛔ NO IDENTITY SYSTEM ⇒ NOBODY TO GRANT TO ⇒ THE SERVER FLAG GOVERNS.
       *   Requiring a per-user grant on a deployment with no IdP and no allowlist makes voice
       *   permanently dead: there is no way to become the person who was granted it. Caught by the
       *   full suite — V0472/V0470 spin exactly that deployment, and every voice test timed out
       *   waiting for a transcript the gate had refused. It would have hit every local and dev
       *   install identically, and silently.
       *   ⭐ This is not a hole: where an IdP IS configured the grant is still required, and the
       *     operator opted in by enabling voice at all. */
      if (!oidcAdapter.active && AUTH_ALLOWLIST.size === 0) return true;
      const ctx = authCtx || computeAuthCtx(req);
      /* ⛔ THE SILENT BRANCH. A lapsed or absent session removed the microphone with NO log line
       *   anywhere, so 'the voice option disappeared' was undiagnosable from the server side —
       *   the denial below only fires for someone already signed in. Cost a full debugging
       *   session on 2026-08-25. Say it out loud. */
      if (!ctx || !ctx.verified) { log.info('voice', 'not-signed-in', { oidcActive: oidcAdapter.active, allowlist: AUTH_ALLOWLIST.size }); return false; }
      const key = ctx.verified.email || ctx.verified.sub;
      const al = AUTH_ALLOWLIST.lookup(key);
      const ok = !!(al && al.allowed && al.voice === true);
      /* ⛔ A DENIAL FOR SOMEONE WHO IS SIGNED IN IS WORTH SAYING OUT LOUD. Silence here cost two
       *   round trips: the microphone simply did not appear and nothing anywhere said why. The key
       *   is logged because the failure mode is almost always that it is not the one on the list. */
      if (!ok) log.info('voice', 'not-granted', { key: key || null, provider: ctx.verified.provider, allowed: !!(al && al.allowed), voiceFlag: al ? al.voice : null });
      return ok;
    } catch (e) { log.warn('voice', 'grant-check-threw', { err: String((e && e.message) || e).slice(0, 120) }); return false; }
  }

  function authState(req) {
    const ctx = computeAuthCtx(req);
    const verdict = deriveConnTrust(null, null, ctx);
    const name = (ctx.verified && typeof ctx.verified.name === 'string' && ctx.verified.name.trim()) ? ctx.verified.name.trim() : null;
    return {
      oidcActive: oidcAdapter.active,
      signedIn: !!ctx.verified,
      name,
      trust: verdict.trust,
      voice: voiceAllowedFor(req, ctx),     // ⚠ pass the ctx: computeAuthCtx() deletes expired sessions
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ...(verdict.reauth ? { reauth: true } : {}),
    };
  }
  /* ⭐ THIS SERVER'S ACTION TABLE. Seeded with the pure handlers, then extended below with ones that
   *   close over this server's own scope. Per-server by construction, so two servers in one process
   *   can never share a handler that captured the other's state. */
  /* The wire fuse table. Filled at the end of createServer by createWireActions(); see there.
   * ⛔ PER-SERVER, never module-level: handlers close over THIS server's state, and the suite
   *   stands up many servers in one process. */
  const wireActions = new Map();

  const conns = new Map();     // ws -> {id,userId,userName,role}
  // Plan 0482 A4 — userId -> Set<ws>. One PERSON may hold several sockets (phone + laptop, or a
  // reconnect race where the old socket has not yet been reaped). The old Map<userId,ws> OVERWROTE
  // on collision, so every targeted push silently went to the newcomer and the incumbent went dark
  // with no error anywhere. DECISION: FAN-OUT, not refuse — refusing would break the ordinary
  // reconnect (the replacement socket would be turned away while the dead one still held the id).
  // Targeted delivery now reaches every live socket for that userId; the collision is logged loudly.
  const byUser = new Map();    // userId -> Set<ws>
  /** Bind `ws` to `userId`. Logs loudly when this userId already has a live socket. */
  function bindUser(userId, ws) {
    let set = byUser.get(userId);
    if (!set) { set = new Set(); byUser.set(userId, set); }
    if (set.size && !set.has(ws)) {
      log.warn('conn', 'duplicate-userId', { userId, existingSockets: set.size, action: 'fan-out',
        note: 'targeted content now delivered to ALL sockets for this userId' });
    }
    set.add(ws);
  }
  /** Unbind exactly this socket (never the whole userId — a peer socket may still be live). */
  function unbindUser(userId, ws) {
    const set = byUser.get(userId);
    if (!set) return;
    set.delete(ws);
    if (!set.size) byUser.delete(userId);
    else log.info('conn', 'duplicate-userId-remaining', { userId, remainingSockets: set.size });
  }
  /** Every live socket for `userId` (delivery fan-out). */
  function socketsFor(userId) { const s = byUser.get(userId); return s ? [...s] : []; }
  /** A single representative socket for `userId` — the most recently bound. For single-answer paths. */
  function latestFor(userId) { const s = socketsFor(userId); return s.length ? s[s.length - 1] : null; }
  let connSeq = 0;             // per-server connection counter -> stable socketId (S5-ready)
  /*
   * ── Plan 0522 P16.2 (R3) — THE DURABLE SESSION LOG ────────────────────────────────────────
   * The store's op-log is a bounded in-memory ring that dies with the process. The worked example
   * is a real live session whose process had exited before anyone came to measure: its evidence is
   * unrecoverable — and with it every "run one session and measure" criterion in 0508/0514/0516.
   * This writes the same ops to disk, OUTSIDE any repository.
   *
   * ⚠ ENABLEMENT IS DELIBERATELY ASYMMETRIC, exactly like the credential rule ~90 lines above.
   * A bare createServer() — every test in this suite — passes no `sessionLogDir` and sets no
   * PRESENTER_SESSION_LOG_DIR, so the handle comes back DISABLED and writes nothing: tests must
   * not scribble in a human's real ~/.local/state. The DEPLOYMENT paths (the CLI self-run at the
   * foot of this file, and presenter_start in mcp/tools.mjs) resolve the directory from
   * lib/deployment-config.mjs and pass it in, so a REAL session logs by default.
   *
   * ⚠ Nothing in this construction may throw: resolveSessionLogDir never does, and an unwritable
   * directory disables the log rather than the server (t44).
   */
  const sessionLogTarget = sessionLogDir
    ? { sessionLogDir, sessionLogDirSource: 'option', sessionLogDirError: null }
    : (process.env.PRESENTER_SESSION_LOG_DIR ? resolveSessionLogDir() : { sessionLogDir: null, sessionLogDirSource: null, sessionLogDirError: 'no session log directory configured — pass sessionLogDir, set PRESENTER_SESSION_LOG_DIR, or run the CLI/presenter_start (which read it from the deployment config)' });
  const sessionLog = createSessionLog({
    ...sessionLogTarget,
    header: { profile: ACTIVE_PROFILE.name || null, voiceEnabled: VOICE_ENABLED, gated: !!(CONTROL_TOKEN || ROLE_HASH) },
    onWarn: (event, detail) => log.warn('session-log', event, detail),
  });
  if (sessionLog.status().enabled) log.info('session-log', 'open', { sessionLogId: sessionLog.sessionLogId, dir: sessionLog.status().sessionLogDir, source: sessionLog.status().sessionLogDirSource });
  // core session state machine (Plan 0435 group B); P16.2 hangs the durable sink off its op path
  const store = createStore({ onOp: (entry) => sessionLog.append({ kind: 'op', ...entry }) });
  // Current DISPLAY per role / per user (C6): what a (re)connecting client should
  // be shown. A descriptor is re-rendered per connection on hello.
  const displayByRole = {};    // role -> descriptor
  const displayByUser = new Map(); // userId -> descriptor (per-user override)
  // Plan 0508 — SPOTLIGHT: userIds a controller has allowed to promote their own station display
  // to everyone. Default-deny; nothing here until a controller grants it. spotlightLast throttles.
  const spotlight = new Set();
  const spotlightLast = new Map();

  // ── Plan 0514 §3 — the STATION REGISTRY. Plugin DATA, read through the ONE manifest loader.
  // Validation throws HERE, at load, so a malformed registry stops the server starting instead
  // of surprising a live session. No plugin declares stations ⇒ an empty registry ⇒ every
  // station surface below is inert and a teaching deployment sees no change whatsoever.
  // ONE manifest read, two registries built from it — a plugin's declaration must not be able to
  // differ between them because the disk changed in between.
  const bootManifests = loadManifests();
  const stationRegistry = buildStationRegistry(bootManifests, { log });
  // ── Plan 0526 P1 §5 — the SURFACE REGISTRY. Same footing, same loader, same failure posture.
  // A surface is a screen a viewer may CALL UP; it is declared by the deployment and loaded HERE,
  // once, so that it outlives every `present_module`. Nothing below ever writes to it: `setModule`
  // replaces `contentModule` and cannot reach this binding, which is the whole point of the phase
  // (0514 §13.1 is the same class of bug, one layer down).
  const surfaceRegistry = buildSurfaceRegistry(bootManifests, { log });
  // Plan 0514 §4.2a — the SEAT RESOLVER. Core stores NO seat→station map (§13.2): it asks the
  // plugin at the moment it needs a value and forgets it. Null until a plugin registers one, in
  // which case stations are inert.
  let seatResolver = null;
  // Plan 0514 §9 — tools contributed by a plugin's server module. Core keeps the list; it has no
  // idea what any of them do.
  const pluginTools = new Map();
  // ATT (Plan 0466, decision 1): presenter-gated "roster visible to attendees", DEFAULT OFF.
  // Presenter/ai always see the full roster; a participant attendance-request is answered
  // self-only until the presenter turns this ON. In-memory session state (v0.1).
  let rosterVisibleToAttendees = false;
  const everSeen = new Set();  // userIds seen (to count reconnects)
  const everSeenOrder = [];    // Plan 0471 L2: FIFO to bound everSeen (client controls userId)
  const EVER_SEEN_MAX = 5000;
  let contentModule = null;    // Group I: the current content module { title?, beats:[{component,opts,requires?}] }
  let currentBeat = -1;        // index of the displayed beat
  // Plan 0522 P4 (R4) — TWO-STAGE DELIVERY. A staging slot is PER CALLER and PER SESSION-MEMORY
  // only: `stage_beat` renders a candidate to the caller's OWN surface and remembers which beat
  // that was, so a later `send_beat` knows what to publish. It is deliberately NOT a display map —
  // nothing here is consulted by renderDisplay/redisplayFor, so a staged beat cannot leak into a
  // reconnect, a role default, or another controller (I3, t07/t09). Key: 'ws:<socketId>' for a
  // control socket, 'api' for the in-process caller.
  const stagedByCaller = new Map();   // callerKey -> { desc, beatId, index, at }
  // X3 telemetry sink (controller-read-only). Feedback from stress points.
  const telem = {
    ops: { applied: 0, denied: 0, malformed: 0, throttled: 0, duplicate: 0 },
    fanout: { sum: 0, count: 0 },
    applyMs: { sum: 0, count: 0, max: 0 },
    reconnects: 0, renderErrors: 0, opApplyFailures: 0, frameErrors: 0,
    rtt: { last: null, sum: 0, count: 0 },
  };
  const telemetryView = () => ({
    ops: { ...telem.ops },
    avgFanout: telem.fanout.count ? +(telem.fanout.sum / telem.fanout.count).toFixed(2) : 0,
    fanoutSamples: telem.fanout.count,
    avgApplyMs: telem.applyMs.count ? +(telem.applyMs.sum / telem.applyMs.count).toFixed(3) : 0,
    maxApplyMs: +telem.applyMs.max.toFixed(3),
    reconnects: telem.reconnects, renderErrors: telem.renderErrors, opApplyFailures: telem.opApplyFailures, frameErrors: telem.frameErrors,
    rtt: { last: telem.rtt.last, avg: telem.rtt.count ? +(telem.rtt.sum / telem.rtt.count).toFixed(1) : null, samples: telem.rtt.count },
  });
  const polls = new Map();     // promptId -> {spec, votes:Map(userId->{value,userName,ts}), open}
  const acks = new Map();      // ackId -> { message, requestedAt, target, by:Map(userId->{userName,at}) } — eyes-on handshake
  const ACKS_MAX = 256;        // Plan 0471 M2: bound the number of distinct outstanding ackIds
  const lastResults = {};      // PRIM-results: promptId -> { userId -> {type,value} } (last beat result per user)
  const lastResultsOrder = []; // Plan 0471 M3: FIFO of promptIds for LRU eviction of lastResults
  const LAST_RESULTS_MAX = 500;// Plan 0471 M3: bound distinct promptIds retained
  const listeners = { presence: [], result: [], poll: [], transcript: [], inbox: [], turnComplete: [], barge_in: [] };
  const emit = (ev, data) => listeners[ev].forEach((cb) => { try { cb(data); } catch (e) {} });

  const CONTROL = join(__dirname, 'control.html');
  const BRANDING = join(__dirname, 'branding', 'argus-presenter.svg');
  const LIB = join(__dirname, '..', 'lib');   // Plan 0470: voice-stub/capture/worklet live in repo lib/
  // --- Content-module registry. Modules are LOCAL JSON files (NOT the web) in MODULES_DIR
  // (default ./modules; set PRESENTER_MODULES_DIR to point at your content, e.g. a campaign's
  // adventures/). Read + validated on demand, cached by file mtime so repeat loads are snappy.
  const MODULES_DIR = process.env.PRESENTER_MODULES_DIR || join(__dirname, '..', 'modules');
  // ── Plan 0522 P12 — THE ARCHIVE. Retirement is a MOVE, never a delete. `modules/*.json` is
  // gitignored, so 28 of 29 modules on this box have NO version history whatsoever: an `rm` is
  // permanent and unrecoverable, and a session deck is indistinguishable from a throwaway
  // iteration to anything but a human. So the hard retirement relocates the file one directory
  // down and stops there. Undo is `mv` back — the only undo that exists.
  //
  // ⚠ NO EXCLUSION CODE IS NEEDED to keep the archive out of the picker: listModules() /
  // listSeries() are non-recursive readdirSync scans filtered to `.json`, so a SUBDIRECTORY is
  // never a candidate. That is also why the archive is a directory rather than a suffix.
  const ARCHIVE_DIR = join(MODULES_DIR, '_archive');
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
    // Plan 0522 P10 — `summary` rides the list summary. The picker's option LABEL is the title
    // alone (plus the actionable ⚠/ERR markers); the counts and the one-line summary move into
    // the option's `title=` tooltip, and the tooltip cannot show what the API never sent. The
    // field is additive and nullable: every existing consumer of this shape ignores it.
    // Plan 0522 P11 — `kind` (grouping) and `status` (lifecycle) ride the same list summary,
    // normalised by the shared moduleLifecycle() so /api/modules and the MCP surface cannot
    // disagree about what a module's lifecycle IS. Additive and nullable, like `summary`.
    const life = moduleLifecycle(man);
    return { id, title: man.title || module.title || id, version: man.version || null,
      summary: man.summary || null,
      kind: life.kind, status: life.status, statusInvalid: life.statusInvalid,
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

  // ── Plan 0522 P12 — MANAGE MODULES: the curation surface ──────────────────────────────────
  //
  // ⚠ THIS IS NOT listModules(). The picker's list is an IN-SESSION list and is deliberately
  // lossy: it drops `error` rows and 0-beat/0-section rows so a broken file cannot put a bogus
  // entry in front of the GM at 20:05. The curation list is BETWEEN-SESSIONS and must be the
  // opposite — a module too broken to load is precisely what someone curating needs to see, and
  // a file that is invisible in both lists is a file nobody can ever clean up. So this scan
  // drops nothing and reports the breakage as a field.
  //
  // `symlink` is the other field the picker has no use for and this surface cannot work without.
  // A module file in MODULES_DIR may be a SYMLINK into a live source tree, so a manifest write
  // through it edits a DIFFERENT repository. The panel renders the flag and the write path
  // refuses (below) — belt and braces, because a UI-only guard is one stale render from useless.
  function moduleAdminRow(id) {
    const file = join(MODULES_DIR, id + '.json');
    let symlink = false;
    try { symlink = lstatSync(file).isSymbolicLink(); } catch (e) { /* unreadable ⇒ reported below */ }
    let module = null, error = null;
    try { module = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { error = String((e && e.message) || e).slice(0, 120); }
    const man = (module && module.manifest) || {};
    const life = moduleLifecycle(man);
    return {
      id, symlink, error,
      title: man.title || (module && module.title) || id,
      kind: life.kind, status: life.status, statusInvalid: life.statusInvalid,
      beats: (module && module.beats || []).length, sections: (module && module.sections || []).length,
    };
  }
  function listModulesAdmin() {
    if (!existsSync(MODULES_DIR)) return [];
    return readdirSync(MODULES_DIR)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.series.json'))
      .map((f) => moduleAdminRow(f.slice(0, -5)))
      .sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' }));
  }
  /**
   * Apply ONE curation op. Returns { code, body } — never throws, never partially applies.
   *
   * ⚠ THE WRITE PATH IS STRICTER THAN THE READ PATH, ON PURPOSE. moduleLifecycle() degrades an
   * unrecognised status to `active` because a throw there would empty the whole picker over one
   * typo (P11/I4). Here the input is a human clicking a control this second, so an unrecognised
   * status is REJECTED rather than silently rewritten: permissive on read, strict on write.
   */
  function moduleAdminOp(id, msg) {
    if (!/^[\w.-]+$/.test(id)) return { code: 400, body: { error: 'bad id' } };
    const file = join(MODULES_DIR, id + '.json');
    if (!existsSync(file)) return { code: 404, body: { error: 'not found', id } };
    // The symlink refusal is FIRST and applies to every op. It is stated as a reason the panel
    // can render, not a bare 4xx — "refuse VISIBLY" is the requirement; a silent no-op here means
    // an operator believing they curated something they did not.
    let symlink = false;
    try { symlink = lstatSync(file).isSymbolicLink(); } catch (e) { /* fall through to the op */ }
    if (symlink) {
      log.warn('modules', 'admin-refused-symlink', { id, op: msg && msg.op });
      return { code: 409, body: { error: 'refusing to modify a symlinked module — it points into another repository', id, symlink: true } };
    }
    const op = msg && msg.op;
    if (op === 'status') {
      const status = String((msg && msg.status) || '').trim().toLowerCase();
      if (!MODULE_STATUSES.includes(status)) return { code: 400, body: { error: 'bad status (' + MODULE_STATUSES.join('|') + ')', id, got: (msg && msg.status) || null } };
      let module;
      try { module = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return { code: 422, body: { error: 'module is not readable JSON — fix or archive it', id, detail: String((e && e.message) || e).slice(0, 120) } }; }
      module.manifest = Object.assign({}, module.manifest, { status });
      try { writeFileSync(file, JSON.stringify(module, null, 2)); } catch (e) { return { code: 500, body: { error: String((e && e.message) || e) } }; }
      moduleCache.delete(id);
      log.info('modules', 'admin-status', { id, status });
      return { code: 200, body: { ok: true, id, status } };
    }
    if (op === 'retire') {
      // MOVE. Never unlinkSync — see the ARCHIVE_DIR note. An existing destination is a REFUSAL,
      // not an overwrite: the archive is the only copy, so clobbering it destroys the one thing
      // this whole mechanism exists to preserve.
      const dest = join(ARCHIVE_DIR, id + '.json');
      if (existsSync(dest)) return { code: 409, body: { error: 'a module of that id is already archived — move it aside first', id, archived: dest } };
      try { mkdirSync(ARCHIVE_DIR, { recursive: true }); renameSync(file, dest); }
      catch (e) { return { code: 500, body: { error: String((e && e.message) || e) } }; }
      moduleCache.delete(id);
      log.info('modules', 'admin-retired', { id, dest, note: 'MOVED, not deleted — restore with mv' });
      return { code: 200, body: { ok: true, id, retired: true, archived: dest } };
    }
    return { code: 400, body: { error: 'bad op (status|retire)', id } };
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
  // Plan 0530 P2 (seam S-A) — the HTTP route table now lives in app/http-routes.mjs. It was 262
  // lines of inline if/else here; what remains is the wiring. ⛔ Nothing about the routes changed.
  /*
   * ── Plan 0650 — OPT-IN EXTRA BINDS (the tailnet interface) ───────────────────────────────────
   *
   * WHY THIS EXISTS. The whole tailnet identity path is unreachable unless the server is actually
   * LISTENING on the tailnet address: a peer that can only reach 127.0.0.1 always presents
   * 127.0.0.1, which correctly earns no identity. Bruce's deployment binds loopback only, so
   * `enforceOAuth:'control'` had exactly one usable door — Google, over the PUBLIC tunnel — which
   * is the inversion the plan set out to fix: a control meant to REDUCE exposure was mandating it.
   *
   * ⛔⛔ THE DEFAULT DOES NOT MOVE. `bindHosts` absent ⇒ loopback only, byte-for-byte the previous
   * behaviour. And 0.0.0.0 / :: / '*' are REFUSED OUTRIGHT by the config normaliser, not merely
   * discouraged: a tailnet bind is an authenticated private fabric, a wildcard bind is the open
   * internet, and the two must never be reachable by the same typo.
   *
   * ⚠ Extra binds share ONE handler and ONE WebSocketServer (via handleUpgrade), so there is one
   * room, one state machine, one identity decision — not a parallel server with its own rules.
   */
  const extraServers = [];
  async function resolveTailnetAddress() {
    try {
      const { execFile } = await import('node:child_process');
      const out = await new Promise((res, rej) => {
        const ch = execFile('tailscale', ['ip', '-4'], { timeout: 2000, killSignal: 'SIGKILL', windowsHide: true },
          (err, stdout) => (err ? rej(err) : res(String(stdout || ''))));
        ch.on('error', () => {});
      });
      const first = out.split('\n').map((l) => l.trim()).filter(Boolean)[0] || null;
      return (first && isTailnetPeerAddress(first)) ? first : null;
    } catch (e) { return null; }
  }
  async function bindExtraHosts(boundPort) {
    const asked = Array.isArray(bindHosts) ? bindHosts : (bindHosts ? [bindHosts] : []);
    if (!asked.length) return;
    const hosts = [];
    for (const raw of asked) {
      const h = String(raw || '').trim();
      if (!h) continue;
      if (h === '0.0.0.0' || h === '::' || h === '*') {   // second line of defence; the normaliser refuses these too
        log.warn('bind', 'wildcard-refused', { host: h });
        continue;
      }
      if (h.toLowerCase() === 'tailnet') {
        const ip = await resolveTailnetAddress();
        if (!ip) { log.warn('bind', 'tailnet-address-unresolved', {}); continue; }
        hosts.push(ip);
      } else hosts.push(h);
    }
    for (const h of hosts) {
      try {
        const extra = http.createServer(httpServer.listeners('request')[0]);
        // ONE WebSocketServer for the whole room: hand the upgrade to the same wss so a tailnet
        // socket lands in the same `conns`, with the same gate and the same identity decision.
        extra.on('upgrade', (ureq, usock, head) => {
          try { wss.handleUpgrade(ureq, usock, head, (ws) => wss.emit('connection', ws, ureq)); }
          catch (e) { try { usock.destroy(); } catch {} }
        });
        extra.on('error', (e) => { try { log.warn('bind', 'extra-error', { host: h, err: String((e && e.message) || e).slice(0, 120) }); } catch {} });
        await new Promise((res) => { extra.listen(boundPort, h, res); extra.once('error', res); });
        if (extra.listening) { extraServers.push(extra); log.info('bind', 'extra-host', { host: h, port: boundPort }); }
        else log.warn('bind', 'extra-failed', { host: h, port: boundPort });
      } catch (e) { try { log.warn('bind', 'extra-failed', { host: h, err: String((e && e.message) || e).slice(0, 120) }); } catch {} }
    }
  }
  // Every name below is a binding the handler used to capture from this closure, passed explicitly
  // because a function lifted out of a closure keeps none of it.
  const httpServer = http.createServer(createHttpHandler({
    __dirname, ARCHIVE_DIR, BRANDING, catalogueReadAuthed, CONTROL, CONTROL_TOKEN,
    htmlHeaders, httpControlAuthed, LIB, listModules, listModulesAdmin, listSeries,
    MODULE_STATUSES, moduleAdminOp, moduleCache, MODULES_DIR, moduleSummary, moduleWriteAuthed,
    pvsConsumerKey, readModuleFile, readSeriesFile, renderPresenterPage, ROLE_HASH, ROLE_SEED,
    sendStatic, sessionLog, sessionLogReadAuthed, VOICE_ENABLED,
    oidcAuth: oidcAdapter,   // Plan 0543 P2 — the OIDC login/callback/logout routes read this
    breakGlassAuth: bgAdapter,   // Plan 0650 §2b — POST /auth/break-glass redeems the recovery credential
    authState,               // Plan 0551 P3 — GET /api/auth-state reads this (state only; no email/sub/sid)
    // ⚠ A GETTER, NOT A VALUE. `const api` is declared ~2,400 lines below this call, so it is in
    // the temporal dead zone right now and reading it here would throw. The handler destructures
    // ctx per request, by which time this getter resolves.
    get api() { return api; },
  }));
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
  /*
   * Plan 0522 P16.2 (R6) — the control-credential CHECK, without the "ungated ⇒ open" policy.
   * The token is the SAME one the ws control roles (presenter/ai) present on hello; this is the
   * one auth scheme this server has, read out of a header or the query string.
   * ⚠ moduleWriteAuthed below does the identical check inline and is LEFT UNTOUCHED on purpose:
   * it is the data-loss guard SHAPE-A7/P12 own, and a refactor there buys three lines and risks
   * the one gate whose failure writes through a symlink into another repository.
   */
  function httpControlCredentialOk(req) {
    const q = new URLSearchParams((req.url.split('?')[1] || ''));
    const token = req.headers['x-control-token'] || q.get('token');
    return !!((CONTROL_TOKEN && token === CONTROL_TOKEN) || (ROLE_HASH && token === ROLE_HASH));
  }
  /** P16.2 (R6): the durable log is readable only by a control role, and only on a gated server. */
  function sessionLogReadAuthed(req) {
    if (!CONTROL_TOKEN && !ROLE_HASH) {
      log.warn('session-log', 'read-refused-ungated', { url: '/api/session-log',
        reason: 'no control credential is configured — the session log carries participants\' own words and fails closed (Plan 0522 P16.2 / R6)' });
      return { ok: false, code: 403, error: 'reading the session log requires a control credential, and this server has none configured — start it with a rolePassword (or a controlToken). The log carries the session transcript; it is not served ungated.' };
    }
    return httpControlCredentialOk(req) ? { ok: true } : { ok: false, code: 403, error: 'forbidden' };
  }
  /*
   * ── Plan 0529 P2 — READING THE CONTENT CATALOGUE IS ROLE-GATED, AND FAILS CLOSED. ─────────
   *
   * THE GAP. The per-beat visibility strip guards the SOCKET path: a participant is sent a beat
   * only when it is presented, and only the slice their role may see. None of that runs here.
   * `GET /api/modules/<id>` reads the authored file off disk and returns it whole — every beat,
   * including the ones the operator has not reached yet and the ones addressed to one seat.
   * Anyone holding the url got the ending before the room did.
   *
   * SAME CREDENTIAL, NO NEW SCHEME. This is the control credential the ws control roles present
   * on hello (CONTROL_TOKEN or the roleSeed+rolePassword hash), read out of `x-control-token` or
   * `?token=` — identical to /api/session-log and the module write.
   *
   * FAIL CLOSED, like /api/session-log and moduleWriteAuthed, and NOT like /api/situation. The
   * usual "ungated ⇒ open" rule is right for surfaces whose worst case is a LAN peer seeing the
   * roster. It is wrong here for the reason P16.1 recorded: presenter_start raises a PUBLIC
   * ingress, so ungated-and-public is an observed state of this deployment, not a hypothesis.
   * "No credential configured" is not "no gate to apply" — it is "nothing to verify against",
   * and the only safe answer to an unverifiable request for unrevealed content is no.
   *
   * ⚠ PLAYER-VISIBLE COST: NONE, and that is checkable rather than hopeful. app/presenter.html
   * fetches exactly ONE api route, /api/auth; beats reach the audience over the socket. The four
   * routes gated here are read by control.html and creator.html only — both control-role pages.
   */
  /*
   * ⛓ Plan 0532 P3 — THE REFUSAL CARRIES A STABLE `reason`, AND THE TWO REFUSALS ARE NOT THE SAME.
   *
   * Fail-closed is correct and unchanged; what was missing is that the operator could not tell the
   * two 403s apart without reading prose, and neither could the control page — so it rendered an
   * empty picker and no explanation. The `reason` codes below are what a client branches on:
   *
   *   'server-has-no-credential'  — a CONFIGURATION fault on this box. Nothing was configured, so
   *                                 there is nothing to verify against and no request can succeed.
   *                                 The long `error` names the fix. Disclosing it is safe here and
   *                                 only here: an ungated server has no secret to keep about its
   *                                 credential, because it has none, and this whole page is
   *                                 reachable by anyone who can reach the box at all.
   *   'credential-not-accepted'   — a CALLER fault: absent or wrong. It says nothing about how the
   *                                 server is configured (both the "you sent none" and the "yours
   *                                 is wrong" cases return exactly this, byte for byte), so it
   *                                 cannot be used to probe which scheme is in force.
   *
   * ⛔ No access decision changes. The same requests are refused and served as before.
   */
  function catalogueReadAuthed(req, route) {
    if (!CONTROL_TOKEN && !ROLE_HASH) {
      log.warn('modules', 'catalogue-read-refused-ungated', { url: route,
        reason: 'no control credential is configured — the catalogue carries unrevealed authored content and fails closed (Plan 0529 P2)' });
      return { ok: false, code: 403, reason: 'server-has-no-credential', error: 'reading the content catalogue requires a control credential, and this server has none configured — start it with a rolePassword (or a controlToken). These files carry material that has not been presented yet; they are not served ungated.' };
    }
    return httpControlCredentialOk(req) ? { ok: true }
      : { ok: false, code: 403, reason: 'credential-not-accepted', error: 'forbidden' };
  }
  /*
   * ── Plan 0522 P12 (R15) — MODULE MUTATION IS GATED UNCONDITIONALLY. FAIL CLOSED. ──────────
   *
   * Every OTHER gate on this server is "ungated ⇒ open", and that is right for them: an ungated
   * deployment is a LAN/test posture, and reading the roster or claiming a work item cannot
   * destroy anything. Module mutation is not in that class, and the difference is not a matter
   * of taste:
   *
   *   writeFileSync FOLLOWS SYMLINKS, and a module file in MODULES_DIR may be a symlink into a
   *   live source tree in a different repository. An uncredentialed POST overwrites a file in
   *   that repository, and the fs watcher then hot-reloads the wreckage. Deployments commonly
   *   gitignore their module directory, so there is often no version history to restore from.
   *
   * "No credential configured" is therefore not "no gate to apply" — it is "nothing to verify
   * against", and the only safe answer to an unverifiable request to destroy data is no. This
   * REPLACES the earlier LAN back-compat allowance (Plan 0471 H1's second test), deliberately.
   * The symlink refusal further down is the second, independent layer; neither is sufficient
   * alone — the symlink guard does not stop a stranger clobbering a real module, and a
   * credential does not stop a legitimate operator writing through a link by mistake.
   *
   * Returns { ok, code, error } so the caller can distinguish "you sent no credential" from
   * "this server has none to check", which is a configuration fault the operator must see.
   */
  function moduleWriteAuthed(req, rawPath) {
    if (!CONTROL_TOKEN && !ROLE_HASH) {
      log.warn('modules', 'write-refused-ungated', { url: req.url, method: req.method,
        reason: 'no control credential is configured — module writes fail closed (Plan 0522 P12 / R15)' });
      return { ok: false, code: 403, error: 'module writes require a control credential, and this server has none configured — start it with a controlToken (or PRESENTER_CONTROL_TOKEN)' };
    }
    const q = new URLSearchParams((String(rawPath == null ? req.url : rawPath).split('?')[1] || ''));
    const token = req.headers['x-control-token'] || q.get('token');
    const ok = (CONTROL_TOKEN && token === CONTROL_TOKEN) || (ROLE_HASH && token === ROLE_HASH);
    return ok ? { ok: true } : { ok: false, code: 403, error: 'forbidden' };
  }
  // ── Plan 0482 A2 — THE IDENTITY SEAM ────────────────────────────────────────────────
  // The ONE place role + userId are decided. Roles are an ALLOWLIST (a closed set); anything
  // unrecognised is downgraded to participant and logged loudly (I7 — never a silent no-op).
  // This is the seam an external identity provider (OAuth) later plugs into: replace the body,
  // not the call sites. There must be exactly one caller (the `hello` handler).
  //
  // Gate policy per role:
  //   participant          — always granted (the ungated default; no credential can be required)
  //   presenter | ai       — control roles. Ungated deployments grant tokenless (LAN back-compat,
  //                          asserted by test/unit/auth-role.test.mjs); when a credential IS
  //                          configured the hello token must match CONTROL_TOKEN or ROLE_HASH.
  //   gm                   — a PRIVILEGED READ role (see app/permissions.mjs DEFAULT_READ_POLICY:
  //                          it reads peer votes, answers, chat, copresent). It was previously
  //                          UNGATED — `?role=gm` handed any curious viewer the presenter's
  //                          private slice. It now requires a credential UNCONDITIONALLY:
  //                          when none is configured there is nothing to verify, so it is DENIED.
  //                          gm remains a legitimate, reachable role — it is gated, not abolished.
  const KNOWN_ROLES = new Set(['participant', 'presenter', 'ai', 'gm']);
  const CONTROL_ROLES = new Set(['presenter', 'ai']);

  /** True iff `token` matches a configured control credential. */
  function credentialOk(token) {
    return !!((CONTROL_TOKEN && token === CONTROL_TOKEN) || (ROLE_HASH && token === ROLE_HASH));
  }

  /**
   * Decide the EFFECTIVE identity for a connection from its `hello` frame.
   * Returns {userId, userName, role, isGuest, capScope?, capNonce?}.
   * NEVER throws and NEVER returns a role outside KNOWN_ROLES.
   */
  function resolveIdentity(m, capGrant, socketId, authCtx = {}) {
    // GUEST (capability link): identity comes from the authentic token, role HARD-FORCED to
    // participant. The client cannot widen either.
    if (capGrant) {
      return {
        userId: 'guest:' + capGrant.nonce,
        userName: capGrant.name || ('guest:' + capGrant.nonce),
        role: 'participant',
        isGuest: true,
        capScope: capGrant.scope,
        capNonce: capGrant.nonce,
      };
    }
    // Plan 0514 §5 / §5.1 — SEAT PROVISIONING, BY UID. When the link carries a station selector,
    // identity is DERIVED from the link and nothing else: userId = <stationCode>-<slug(userName)>,
    // always, one rule, no branch. That is what makes a reload return the SAME seat (0508 D3: an
    // anon seat minted a fresh userId on every reload and orphaned both its station and its
    // spotlight grant).
    //
    // §5.1 (Bruce, S220) — the selector is an INTEGER uid looked up in the registry. Absent,
    // non-numeric or unknown ⇒ the deployment default. There is NO string matching here: a uid
    // cannot be misspelled into a different station, whereas `?station=damage-control` silently
    // seated the DEFAULT station because that station's code was `dc`. The userId is derived from the RESOLVED
    // station, so `?stationUID=999&n=Les` yields <defaultCode>-les and never a bogus seat.
    if (m.stationUID !== undefined && !stationRegistry.isEmpty()) {
      const askedUid = Number.isInteger(m.stationUID) ? m.stationUID : null;
      const st = stationRegistry.get(askedUid) || stationRegistry.get(stationRegistry.defaultUid);
      const rawName = typeof m.userName === 'string' ? m.userName : '';
      const seatUserId = st.stationCode + '-' + slugForSeat(rawName);
      const seatUserName = rawName.trim() ? rawName : 'NAME UNKNOWN';
      const askedRole = m.role || 'participant';
      if (!KNOWN_ROLES.has(askedRole)) {
        log.warn('auth', 'role-denied', { socketId, userId: seatUserId, requested: String(askedRole), granted: 'participant', reason: 'unknown-role' });
        return { userId: seatUserId, userName: seatUserName, role: 'participant', isGuest: false, stationUid: st.stationUid };
      }
      if (askedRole !== 'participant') {
        const gated = !!(CONTROL_TOKEN || ROLE_HASH);
        // Plan 0543 P3 — under enforceOAuth='control' the password is RETIRED for control roles; the
        // Control-page role comes from IDENTITY only. Under 'off' the existing password gate is unchanged.
        const controlOk = (AUTH_POLICY.enforceOAuth === 'control') ? identityGrantsControl(authCtx) : (!gated || credentialOk(m.token));
        const gmOk = (AUTH_POLICY.enforceOAuth === 'control') ? identityGrantsControl(authCtx) : (gated && credentialOk(m.token));
        if (CONTROL_ROLES.has(askedRole) && controlOk) return { userId: seatUserId, userName: seatUserName, role: askedRole, isGuest: false, stationUid: st.stationUid };
        if (askedRole === 'gm' && gmOk) return { userId: seatUserId, userName: seatUserName, role: 'gm', isGuest: false, stationUid: st.stationUid };
        log.warn('auth', 'role-denied', { socketId, userId: seatUserId, requested: String(askedRole), granted: 'participant', reason: 'bad-credential' });
      }
      return { userId: seatUserId, userName: seatUserName, role: 'participant', isGuest: false, stationUid: st.stationUid };
    }
    const userId = m.userId || ('anon-' + Math.random().toString(36).slice(2, 8));
    const userName = m.userName || userId;
    const asked = m.role || 'participant';
    const deny = (reason) => {
      log.warn('auth', 'role-denied', { socketId, userId, requested: String(asked), granted: 'participant', reason });
      return { userId, userName, role: 'participant', isGuest: false };
    };

    if (!KNOWN_ROLES.has(asked)) return deny('unknown-role');       // closed set — no verbatim roles
    if (asked === 'participant') return { userId, userName, role: 'participant', isGuest: false };

    if (CONTROL_ROLES.has(asked)) {
      // Plan 0543 P3 — under enforceOAuth='control' the password is RETIRED for the Control page: the
      // role comes from IDENTITY only (loopback / verified+allowlisted). Under 'off' this is UNCHANGED.
      if (AUTH_POLICY.enforceOAuth === 'control') {
        return identityGrantsControl(authCtx) ? { userId, userName, role: asked, isGuest: false } : deny('control-requires-verified-identity');
      }
      const gated = !!(CONTROL_TOKEN || ROLE_HASH);
      if (gated && !credentialOk(m.token)) return deny('bad-credential');
      return { userId, userName, role: asked, isGuest: false };     // ungated ⇒ tokenless grant
    }
    // gm — credential required unconditionally; no credential configured ⇒ nothing to verify ⇒ deny.
    if (AUTH_POLICY.enforceOAuth === 'control') {                    // Plan 0543 P3 — identity, not password
      return identityGrantsControl(authCtx) ? { userId, userName, role: 'gm', isGuest: false } : deny('control-requires-verified-identity');
    }
    if (!(CONTROL_TOKEN || ROLE_HASH)) return deny('gm-requires-credential-none-configured');
    if (!credentialOk(m.token)) return deny('bad-credential');
    return { userId, userName, role: 'gm', isGuest: false };
  }

  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD });
  // Plan 0471 C1: a server-level socket error (bad handshake, etc.) must never reach
  // Node's default "Unhandled 'error'" path (which terminates the process).
  wss.on('error', (e) => { try { log.warn('wss', 'error', { err: String(e && e.message || e) }); } catch {} });

  // Returns TRUE only if the frame actually left. It used to return nothing and swallow every
  // throw, which made every delivery count downstream a count of sockets that MATCHED THE TARGET
  // FILTER rather than sockets that were WRITTEN TO — so "✔ sent to N recipients" survived a
  // serialization throw, a half-open socket, or a peer that was never OPEN. A receipt that cannot
  // observe failure is not a receipt (I5).
  function send(ws, msg) {
    try {
      if (!ws || ws.readyState !== 1) return false;   // 1 = OPEN; ws throws on CONNECTING anyway
      ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      try { log.warn('ws', 'send-failed', { err: String((e && e.message) || e).slice(0, 120) }); } catch {}
      return false;
    }
  }
  // Plan 0468 (Part A0): the heartbeat. The server pings every open socket every PING_MS; the
  // client replies {t:'pong'} (inbound traffic ⇒ c.lastSeen refreshed at L~338), so a silent but
  // connected client stays fresh (GREEN). A frozen/half-open socket stops ponging ⇒ lastSeen goes
  // stale ⇒ RED within STALE_MS. Cleared in close() (INV-7). unref so it never keeps the loop alive.
  const heartbeat = setInterval(() => {
    const ts = Date.now();
    for (const [ws] of conns) { if (ws.readyState === 1) { try { send(ws, { t: 'ping', ts }); } catch {} } }
  }, PING_MS);
  heartbeat.unref?.();
  // Plan 0482 A2: presence reports IDENTIFIED connections only. A socket that has opened but not
  // yet sent `hello` has no userId and no decided role — reporting it as a `participant` with
  // userId:null is a phantom: it inflates counts and lets an observer read a role that the
  // identity seam has not yet assigned. Presence is "who is here", not "how many sockets".
  // Plan 0514 §8: presence carries stationUid — the roster column that makes a byte-exact
  // mis-seat visible within seconds, and the share-target dropdown's source. Core stores NO
  // occupancy: it ASKS the plugin at the moment it builds the feed and then forgets (t0514-39).
  //
  // Plan 0522 P3 — ONE PERSON, ONE ROSTER ROW. Presence is a projection of PEOPLE, and it was
  // projecting SOCKETS: a seat-linked player has a stable derived id (userId =
  // <stationCode>-<slug(userName)>, resolveIdentity above), so a reload before the old socket is
  // reaped put the SAME person on the roster twice.
  //
  // ⚠ The naive dedupe is a WORSE bug than the one it fixes. Identity is derived from the link and
  // the typed name, so TWO DIFFERENT PEOPLE on one seat link typing one name get the SAME userId.
  // Silently collapsing them erases a real human from the GM's roster (I4). So we collapse by
  // userId AND SAY SO: a row backed by more than one live socket carries `conns` (how many) and
  // `contested` (more than one). Never report conns:1 while two sockets are live. The per-socket
  // view is not lost — `debugDump().connections` still lists every socket, one row each.
  //
  // Role on a collapsed row is the STRONGEST role held on that identity (a person holding a
  // presenter socket and a participant socket is a presenter who is also watching), not
  // whichever socket happened to connect first.
  const ROLE_RANK = { participant: 0, ai: 1, presenter: 2, gm: 3 };
  /** Fold per-socket entries into one row per userId. `mk(c)` builds the row; `fold(row, c)` merges. */
  function byPerson(mk) {
    const rows = [];
    const idx = new Map();
    for (const c of conns.values()) {
      if (!c.userId) { rows.push(mk(c)); continue; }   // unidentified socket: its own row, never merged
      const row = idx.get(c.userId);
      if (!row) { const r = mk(c); r.conns = 1; r.contested = false; idx.set(c.userId, r); rows.push(r); continue; }
      row.conns += 1;
      row.contested = true;
      if ((ROLE_RANK[c.role] ?? 0) > (ROLE_RANK[row.role] ?? 0)) row.role = c.role;
      if ((c.eyesOn || 0) > (row.eyesOn || 0)) row.eyesOn = c.eyesOn;
      if ((c.lastSeen || 0) > (row.lastSeen || 0)) row.lastSeen = c.lastSeen;
      if (row.socketIds) row.socketIds.push(c.id);
      if (row.ips) row.ips.push(c.ip || null);
    }
    return rows;
  }
  // Plan 0529 P1 — `safeId` neutralizes the fence sentinels in a participant-authored identity string
  // at SERVE time, leaving every other value (null, a number) exactly as it was. Both identity columns
  // are typed by the person in the row, and presence() is read by AGENTS as well as by control pages:
  // presenter_stations().seats and presenter_debug().presence are both built from it.
  const safeId = (s) => (typeof s === 'string' ? sanitizeUntrusted(s) : s);
  function presence() {
    return byPerson((c) => ({ userId: safeId(c.userId), userName: safeId(c.userName), role: c.role, eyesOn: c.eyesOn || null, stationUid: seatStationUid(c.userId) }))
      .filter((r) => r.userId);
  }
  // Full presence (incl. IP + socketId + current display id) pushed to CONTROL roles only, for the GM user list.
  function pushPresence() {
    // No-op unless a control client (presenter/ai) is actually listening — avoids building/sending
    // the presence feed on every display change when nobody's watching.
    const ctl = [...conns.values()].filter((c) => c.role === 'presenter' || c.role === 'ai');
    if (!ctl.length) return;
    // Plan 0514 §7 — the control roster gains a station column, which is what makes a byte-exact
    // mis-seat (a mis-cased `?station=` lands on the default, silently) VISIBLE within seconds
    // moment the player says "I can't see my screen". The LABEL is for a human to read; the uid
    // is the identifier. A stationCode still never reaches the wire (canon §3).
    // Plan 0522 P3 — one PERSON per row (see byPerson above). The GM roster is the surface the
    // duplicate rows were actually landing on, so it collapses on the same rule and shows the same
    // `conns` / `contested` pair. socketIds/ips accumulate so a contested seat can still be told
    // apart by the only fields that differ between two people sharing one derived id.
    const users = byPerson((c) => {
      const uid = seatStationUid(c.userId);
      const st = uid == null ? null : stationRegistry.get(uid);
      // Plan 0522 P14 — the spotlight grant rides the roster so the row's toggle shows the state
      // the server actually holds. A toggle that renders from its own last click is a toggle that
      // lies after any reconnect, and the grant already survives one (welcome.spotlightGranted).
      return { userId: safeId(c.userId), userName: safeId(c.userName), role: c.role, ip: c.ip, socketId: c.id, lastSeen: c.lastSeen, display: displayIdFor(c), eyesOn: c.eyesOn || null,
        stationUid: uid, stationLabel: st ? st.stationLabel : null, spotlightGranted: spotlight.has(c.userId), socketIds: [c.id], ips: [c.ip || null] };
    });
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
  // ── Plan 0522 P5 — STATION TARGETS ────────────────────────────────────────────────────────
  // The unified target selector offers ALL · every connected person · every DECLARED station, so
  // `station:<uid>` has to be addressable wherever a target is. It is resolved HERE, at the one
  // place every push already funnels through (`targets()`, 12 call sites), and not in the beat
  // path: otherwise the same string would mean PEOPLE in send_beat and a phantom userId in
  // pushComponent / clear / chime / reload, and the two control surfaces would diverge (I1).
  //
  // Core still holds NO occupancy (0514 §13.2) — it asks the plugin per connection, exactly as
  // pushPresence does. An unoccupied station resolves to ZERO sockets, honestly zero, which is
  // what makes the I5 recipient count truthful instead of reassuring.
  //
  // ⚠ A target reads as a station ONLY when the suffix is an integer the REGISTRY knows. Anything
  // else falls through to the userId path, so nobody can be shadowed out of existence by a naming
  // coincidence (I4).
  const STATION_TARGET_RE = /^station:(\d+)$/;
  function stationTargetUid(target) {
    if (typeof target !== 'string') return null;
    const m = STATION_TARGET_RE.exec(target);
    if (!m) return null;
    const uid = Number(m[1]);
    return stationRegistry.get(uid) ? uid : null;
  }
  /** Every socket currently seated at `uid`. Plugin-authoritative, never cached here. */
  function socketsAtStation(uid) {
    const out = [];
    for (const [ws, c] of conns.entries()) if (c.userId && seatStationUid(c.userId) === uid) out.push(ws);
    return out;
  }
  /** The distinct userIds seated at `uid` — the durable form a station push resolves to. */
  function usersAtStation(uid) {
    const seen = new Set();
    for (const c of conns.values()) if (c.userId && !seen.has(c.userId) && seatStationUid(c.userId) === uid) seen.add(c.userId);
    return [...seen];
  }
  function targets(target) {
    if (target === 'all' || target == null) return [...conns.keys()];
    if (['participant', 'presenter', 'ai'].includes(target))
      return [...conns.entries()].filter(([, c]) => c.role === target).map(([ws]) => ws);
    const stUid = stationTargetUid(target);                 // Plan 0522 P5: station:<uid> → its occupants
    if (stUid != null) return socketsAtStation(stUid);
    return socketsFor(target);   // by userId — ALL of that person's live sockets (A4 fan-out)
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
    // Plan 0539 P2.1 / 0538 §1(a) — `converged: false`. ⛓ THE ROOT OF THE X1 DOUBLE-DELIVERY IS THIS
    // LINE: the socket joins `conns` at TCP-CONNECT time, before any `hello` has been read, so it is
    // a broadcast recipient before it has an identity, let alone a converged state. Anything written
    // to the store while the handshake is still running is therefore broadcast to it AND replayed to
    // it by the resync that follows. It stops being a recipient-in-name-only at :1071.
    conns.set(ws, { id: 'c' + (++connSeq), userId: null, userName: null, role: 'participant', lastSeen: Date.now(), connectedAt: Date.now(), lastActive: 0, ip, converged: false });
    /*
     * ── Plan 0650 §2a — THE IDENTITY GATE: hold the first frames while `whois` runs ────────────
     *
     * THE PROBLEM THIS SOLVES. `makeTailscaleAdapter.principalForRequest` is SYNCHRONOUS — it is
     * called inside the `hello` handler — but resolving a tailnet peer means running a subprocess.
     * Blocking the event loop on it would stall every other participant in the room; not waiting at
     * all would mean the peer is always unresolved by the time `hello` arrives, and the tailnet path
     * would be inert in a second, subtler way.
     *
     * ⇒ Start the lookup HERE, at connect, and QUEUE this socket's frames until it settles. The
     * `hello` that decides the role is then answered from a warm cache, synchronously.
     *
     * ⛔ IT CANNOT WEDGE THE SOCKET. A hard deadline opens the gate regardless, and an unresolved
     * peer is simply NO IDENTITY — a fenced participant. `prime()` never rejects. The cost of a
     * dead `tailscale` is a bounded delay on tailnet peers only, then ordinary anonymous service.
     *
     * ⛓ NON-TAILNET PEERS PAY NOTHING: `prime()` returns an already-resolved promise for them, so
     * the gate opens on the next microtask — before any I/O-delivered frame can arrive.
     */
    let tsGate = null;
    if (tsWhois) {
      tsGate = { open: false, queue: [], timer: null };
      const openGate = () => {
        if (!tsGate || tsGate.open) return;
        tsGate.open = true;
        if (tsGate.timer) { clearTimeout(tsGate.timer); tsGate.timer = null; }
        const q = tsGate.queue; tsGate.queue = [];
        // Re-emit through the socket's own 'message' event: the gate is now open, so the wrapper
        // below falls straight through to the real handler, in the order the frames arrived.
        for (const [b, i] of q) { try { ws.emit('message', b, i); } catch (e) { try { log.warn('ws', 'gate-drain-failed', { err: String((e && e.message) || e).slice(0, 120) }); } catch {} } }
      };
      tsGate.timer = setTimeout(openGate, IDENTITY_GATE_MS);
      if (tsGate.timer.unref) tsGate.timer.unref();
      try { tsWhois.prime(req).then(openGate, openGate); } catch (e) { openGate(); }
    }
    // Plan 0471 C1: a socket-level 'error' (frame > MAX_PAYLOAD → ws RangeError 1009, invalid
    // UTF-8, bad RSV bits, ECONNRESET) must NOT hit Node's default handler and kill the process.
    ws.on('error', (e) => {
      telem.frameErrors++;   // Plan 0482 B3: a socket/frame fault is a HEALTH signal, not just a log line
      try { log.warn('ws', 'socket-error', { socketId: (conns.get(ws) || {}).id, err: String(e && e.message || e) }); } catch {}
      try { ws.close(1011); } catch {}
    });
    ws.on('message', (buf, isBinary) => {
      // Plan 0650 §2a — hold everything until this peer's identity is settled (see the gate above).
      // Bounded: past the cap the frame is dropped and COUNTED, never buffered without limit.
      if (tsGate && !tsGate.open) {
        if (tsGate.queue.length < IDENTITY_GATE_MAX_FRAMES) tsGate.queue.push([buf, isBinary]);
        else telem.frameErrors++;
        return;
      }
      // Plan 0470 (RT-6): the binary PCM lane branches BEFORE JSON.parse — audio is NEVER
      // parsed as JSON, is exempt from the durable-op cap, and is ignored unless the conn
      // has an active voice session (RT-7). Route it and return.
      if (isBinary) { handleVoiceBinary(conns.get(ws), ws, buf); return; }
      // Plan 0482 B3: an unparseable / non-object frame is a FRAME ERROR — counted so health can
      // see a client whose every frame is garbage (previously an entirely silent `return`).
      let m; try { m = JSON.parse(buf.toString()); } catch (e) { telem.frameErrors++; return; }
      if (m === null || typeof m !== 'object') { telem.frameErrors++; return; }   // Plan 0471 C2: null/primitive frame → no dispatch (null.t would throw)
      // Plan 0493 Phase D — PVS ws transport. A subscriber is read-only: once subscribed, the ONLY frame
      // it may send is pvs_unsubscribe; everything else (ops, votes, voice) is ignored (it is not a
      // participant). This branch runs BEFORE the participant dispatch so a subscriber can never act.
      if (pvsSubscribers.has(ws)) {
        if (m.t === 'pvs_unsubscribe') { pvsSubscribers.delete(ws); try { send(ws, { t: 'pvs_unsubscribed' }); } catch {} }
        // ⛔ Plan 0687 R2 (G5) — `pvs_ack` is the ONE other frame a subscriber may send, and it is
        // the reason this phase exists: only the consumer may say it has read a turn. It writes
        // nothing but this socket's OWN delivery position (the key comes from the subscriber table,
        // not the frame), so admitting it does not make a subscriber a participant. Everything else
        // still falls through to the return below and is ignored.
        else if (m.t === 'pvs_ack') {
          const ackAction = wireActions.get('pvs_ack');
          if (ackAction) { try { ackAction({ m, c: null, ws, req, send, telem, conns }); } catch (e) { log.warn('wire', 'action-threw', { t: m.t, err: String((e && e.message) || e).slice(0, 160) }); } }
        }
        return;
      }
      try {
      const c = conns.get(ws);
      if (c) c.lastSeen = Date.now();   // liveness (X4)
      /* ⛔ THE DISPATCH LIVES HERE, NOT ABOVE THE `try`. It passes `c`, and `c` is bound only on
       *   the line above. The block previously sat before this try, where `c` is undefined — so the
       *   moment a real action was registered, `action({ m, c, … })` threw ReferenceError straight
       *   into the generic dispatch-error catch. An EMPTY table never evaluated that argument, so
       *   the fault stayed invisible until the first migration (pong/telemetry) 'mysteriously'
       *   regressed X3 with nothing in the log to find.
       */
      /* ── WIRE ACTIONS (Plan 0661 phase 1) — BRANCH BY ABSTRACTION, steps 1+2 ────────────────
       *
       * ⭐ The 22 `m.t` values below ARE fuseactions; they have simply been dispatched by hand, as a
       *   356-line if/else chain. This is the abstraction they will move behind, one at a time.
       *
       * ⭐⭐ IT STARTS EMPTY, SO THIS COMMIT CHANGES NOTHING. An action absent from the table falls
       *   straight through to the chain below, byte-for-byte as before. Each later commit moves ONE
       *   action in and deletes its branch — behaviour-preserving, shippable, and reversible by
       *   deleting one entry. When the chain is empty it goes.
       *
       * ⛔ SAFE ONLY BECAUSE THE KEYS ARE UNIQUE. An if/else is ordered; a table is not, so
       *   overlapping conditions would change meaning. Audited: 22 actions, zero duplicates, every
       *   branch a plain equality on `m.t`.
       */
      {
        const action = wireActions.get(m.t);
        if (action) {
          try { action({ m, c, ws, req, send, telem, conns }); }
          catch (e) { log.warn('wire', 'action-threw', { t: m.t, err: String((e && e.message) || e).slice(0, 160) }); }
          return;
        }
      }
      } catch (e) { try { log.warn('ws', 'dispatch-error', { err: String(e && e.message || e) }); } catch {} }   // Plan 0471 C2: defense-in-depth
    });
    ws.on('close', () => {
      if (tsGate) { if (tsGate.timer) clearTimeout(tsGate.timer); tsGate.queue.length = 0; tsGate.open = true; }   // Plan 0650 — no timer, no buffer outlives the socket
      if (pvsSubscribers.has(ws)) { pvsSubscribers.delete(ws); log.info('pvs', 'unsubscribe-close', {}); }   // Plan 0493 D: socket close ends the watch (S12)
      const c = conns.get(ws);
      if (c && c.voice && c.voice.active) { if (c.voice.timer) clearTimeout(c.voice.timer); c.voice.active = false; voiceSessions = Math.max(0, voiceSessions - 1); }   // RT-14: drop an orphaned open segment
      if (c) stagedByCaller.delete(callerKey(c));   // Plan 0522 P4: the controller is gone; its staging slot goes with it
      if (c && c.userId) unbindUser(c.userId, ws); conns.delete(ws); updateChatListeners();
      // Plan 0514 §4.2a — tell the plugin the seat is gone, but only when this PERSON has no
      // live socket left (A4: one person may hold several). Without release() a disconnected
      // seat lingers in occupants and the roster drifts inside one session.
      if (c && c.userId && stationsActive() && !socketsFor(c.userId).length) {
        try { seatResolver.release(c.userId); } catch (e) { log.warn('station', 'resolver-release-failed', { userId: c.userId, err: String(e && e.message || e) }); }
      }
      emit('presence', presence());
      pushPresence();   // Plan 0471 M4: refresh the control user-list on disconnect (connect already does)
      evaluateFloor();   // Plan 0473 P6: a disconnect can lower the load (speaker gone) — reassess the floor
    });
  });

  // ---- Op protocol (Plan 0435 C3): {t:'op'} -> store.apply -> broadcast diff ----
  // Identity is the CONNECTION record (S1); opId is namespaced by conn id (S5) so a
  // client cannot forge/suppress another's dedup. Diffs are read-perm filtered per
  // recipient (S7). Broadcast-all v1 (§7 Q1).
  /* `actorOverride` (Plan 0537 P2.3) lets a SERVER-PARSED message write somewhere the sender
   * could not write on its own — today only `/gm …`, which lands in the controller-only `gm`
   * slice. It goes through handleOp rather than serverApply ON PURPOSE: the X6 durable-op rate
   * limit, the telemetry counters and the op-log attribution all live in this function, and a
   * private aside must not be the one message shape that escapes the rate limiter. The override
   * keeps the sender's userId and only lifts the ROLE, so the log still says who typed it. */
  function handleOp(c, m, actorOverride) {
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
    const res = store.apply(op, actorOverride || { userId: c.userId, role: c.role });
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
      // Plan 0482 B3: WARN, not debug. At debug a permission BUG (a rule that wrongly denies a
      // legitimate action) is indistinguishable from a participant simply not clicking anything.
      log.warn('op', 'denied', { socketId: c.id, path: m.path, verb: m.verb, by: c.userId });
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
        for (const p of Object.keys(e.diff)) if (store.perms.canRead({ role: c.role, userId: c.userId }, p)) visible[p] = e.diff[p];   // Plan 0471 C3: actor-aware read
        if (Object.keys(visible).length) send(ws, { t: 'host', msg: { source: 'argus-host', type: 'diff', diff: visible, by: e.by, version: e.version } });
      }
    } else {
      send(ws, { t: 'snapshot', state: store.snapshot({ role: c.role, userId: c.userId }).state, version: store.version() });   // Plan 0471 C3: actor-aware snapshot
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

  /* ────────────────────────── Plan 0537 P3 — DICE. THE SERVER ROLLS. ──────────────────────────
   * ⛓ THE DESIGN DECISION THIS PHASE RESTS ON: the client ASKS, the server ROLLS, computes
   * `success`, records and broadcasts. Nothing about the outcome is client-asserted. That removes
   * the target-knowledge problem (the target arrives WITH the request, so the server always has it)
   * and it removes the far worse problem in `components/dice/dice.js`, which calls Math.random() in
   * the browser: mount that on five screens and five people watch five different results of what
   * was supposed to be one roll.
   *
   * ⛓ ONE EVENT, TWO REPRESENTATIONS. `rolls/<id>` is the machine-readable record and is the ONLY
   * thing a future outcome hook may read. The readable line is for humans and is derived FROM the
   * record — ⛔ never the other way round. Nothing must ever parse the prose back into numbers.
   */
  const DICE_RE = /^(\d*)d(\d+)([+-]\d+)?$/i;
  /** Parse `NdS+M`. Returns null for anything else — an unparseable spec is REFUSED, never guessed. */
  function parseDice(spec) {
    const m = DICE_RE.exec(String(spec || '').trim());
    if (!m) return null;
    const count = m[1] === '' ? 1 : Number(m[1]);
    const sides = Number(m[2]);
    const mod = m[3] ? Number(m[3]) : 0;
    // Bounds are a REFUSAL, not a clamp: a clamp would silently roll something other than what was
    // asked for, and the asker would read the result as the answer to their question.
    if (!(count >= 1 && count <= 100)) return null;
    if (!(sides >= 2 && sides <= 1000)) return null;
    if (!(Math.abs(mod) <= 10000)) return null;
    return { count, sides, mod };
  }
  /** One die, from the CSPRNG — `randomInt` is uniform, unlike `Math.random()*n|0`. */
  function rollDie(sides) { return 1 + randomInt(sides); }

  /* ── Plan 0539 P1.7 — `modifiers: [{label, value}]`. A SCHEMA CHANGE, NOT A UI CHANGE. ──────────
   * 0537 collapsed every adjustment into the `spec` string, so by the time the record was written
   * the REASONS were already gone. `+2` can never be turned back into "skill 2" or "long range −1", and
   * a client that tried would be parsing prose to recover numbers — the exact failure `rollLine` was
   * written to prevent, in a smaller coat.
   *
   * ⛓ THE SHAPE IS DELIBERATELY GENERIC AND DELIBERATELY NOT CALLED `rollModifiers` (R2 amendment).
   * A capability level assembled from several named sources is the same stack as a roll's, and the
   * next caller must find
   * this shape already here rather than invent a second one. The renderer lives in lib/breakdown.js,
   * which knows nothing about dice, for the same reason.
   *
   * ⚠ `label: null` means "no reason was recorded". That is honest, and it is NOT the same as
   * inventing a reason. The bare modifier in a spec (`+2`) lands here with a null label so the shown
   * arithmetic still ADDS UP — a breakdown that omits a real contribution is worse than none.
   */
  const MODIFIERS_MAX = 24;
  function normalizeModifiers(mods) {
    if (!Array.isArray(mods)) return [];
    const out = [];
    for (const m of mods) {
      if (!m || typeof m !== 'object') continue;
      const value = Number(m.value);
      if (!Number.isFinite(value) || Math.abs(value) > 10000) continue;   // same bound as a spec modifier
      const label = (typeof m.label === 'string' && m.label.trim()) ? m.label.trim().slice(0, 80) : null;
      out.push({ label, value });
      if (out.length >= MODIFIERS_MAX) break;
    }
    return out;
  }

  /**
   * Perform (or record) a roll. `c` is the requesting connection.
   * `manualTotal != null` ⇒ the human rolled physical dice and typed the number in: it is recorded
   * with `entry:'manual'` and `rolls:[]`. ⛓ A log that cannot tell a roll from a claim is not a log,
   * so the distinction is a FIELD, not a convention — and `success` is still computed by the server
   * from the total it was given, so the target comparison is never the client's opinion either.
   */
  function doRoll(c, { spec, target = null, label = null, manualTotal = null, modifiers = null }) {
    const parsed = parseDice(spec);
    if (!parsed) return { ok: false, reason: 'bad-spec' };
    const tgt = (target === null || target === undefined) ? null : Number(target);
    if (tgt !== null && !Number.isFinite(tgt)) return { ok: false, reason: 'bad-target' };
    let rolls = [], total, mods = [];
    if (manualTotal !== null && manualTotal !== undefined) {
      if (!Number.isFinite(Number(manualTotal))) return { ok: false, reason: 'bad-total' };
      total = Number(manualTotal);
      // ⛔ A HAND-ENTERED TOTAL GETS AN EMPTY BREAKDOWN, deliberately. The human typed the finished
      // number; every adjustment they applied is already inside it. Listing the spec's `+2` beside it
      // would double-count on screen and claim an arithmetic the server never performed.
      mods = [];
    } else {
      for (let i = 0; i < parsed.count; i++) rolls.push(rollDie(parsed.sides));
      // Spec modifier first (it is part of what was asked for), then any labelled ones.
      mods = (parsed.mod ? [{ label: null, value: parsed.mod }] : []).concat(normalizeModifiers(modifiers));
      total = rolls.reduce((a, b) => a + b, 0) + mods.reduce((a, m) => a + m.value, 0);
    }
    const rec = {
      id: c.userId + '-' + Date.now() + '-' + randomInt(1e6),
      who: c.userId, whoName: c.userName || c.userId,
      label: (typeof label === 'string' && label.trim()) ? label.trim().slice(0, 120) : null,
      spec: `${parsed.count}d${parsed.sides}${parsed.mod ? (parsed.mod > 0 ? '+' + parsed.mod : String(parsed.mod)) : ''}`,
      rolls, modifiers: mods, total, target: tgt,
      success: tgt === null ? null : total >= tgt,
      entry: (manualTotal !== null && manualTotal !== undefined) ? 'manual' : 'rolled',
      ts: Date.now(),
    };
    // Written through handleOp with a lifted role so the roll log inherits the X6 rate limit and the
    // op-log attribution, exactly like the `/gm` aside. The sender's userId is preserved.
    handleOp(c, { path: 'rolls/' + rec.id, verb: 'set', value: rec }, { userId: c.userId, role: 'system' });
    // Representation 2, for humans, DERIVED from the record above.
    for (const sock of conns.keys()) send(sock, { t: 'roll', roll: rec, line: rollLine(rec) });
    log.info('roll', rec.entry, { who: rec.who, spec: rec.spec, total: rec.total, target: rec.target, success: rec.success });
    return { ok: true, roll: rec };
  }
  /** The human-readable rendering of a roll record. Derived, never authoritative. */
  function rollLine(r) {
    const dice = r.entry === 'manual' ? '(entered by hand)' : '[' + r.rolls.join(' ') + ']';
    const vs = r.target === null ? '' : `  vs ${r.target}+  —  ${r.success ? 'SUCCESS' : 'FAILURE'}`;
    // Plan 0539 P1.7 — LABELLED modifiers appear in the one-line form too, or the readable line
    // stops adding up the moment a skill-aware caller supplies one (the spec carries only the bare
    // number). Unlabelled ones are already inside `spec` and are not repeated.
    const named = (r.modifiers || []).filter((m) => m.label);
    const why = named.length ? ' ' + named.map((m) => `${m.value < 0 ? '−' : '+'}${Math.abs(m.value)} ${m.label}`).join(' ') : '';
    return `🎲 ${r.whoName} ${r.label ? r.label + ' ' : ''}${r.spec} ${dice}${why} = ${r.total}${vs}`;
  }
  /**
   * `/roll <spec> [target] [= total] [label…]` — the human affordance, routed into the SAME doRoll.
   * It rides the chat input that is already on screen, so dice cost zero new chrome.
   */
  function parseRollCommand(rest) {
    const toks = String(rest || '').trim().split(/\s+/).filter(Boolean);
    if (!toks.length) return null;
    const out = { spec: toks.shift(), target: null, manualTotal: null, label: null };
    if (toks.length && /^-?\d+$/.test(toks[0])) out.target = Number(toks.shift());
    if (toks.length && toks[0] === '=') { toks.shift(); if (toks.length && /^-?\d+$/.test(toks[0])) out.manualTotal = Number(toks.shift()); else return null; }
    else if (toks.length && /^=-?\d+$/.test(toks[0])) out.manualTotal = Number(toks.shift().slice(1));
    if (toks.length) out.label = toks.join(' ');
    return out;
  }

  function serverApply(op, actor) {
    const res = store.apply(op, actor || { userId: 'server', role: 'system' });
    if (res && res.diff && !res.ephemeral) broadcastDiff(res.diff, res);
    return res;
  }

  // P1: presenter control-message handler — the SAME server API the AI/MCP drives.
  // Presenter/ai only (server-authoritative role, S1/S2); others are ignored.
  function handleControl(c, m, ws) {
    // ── Plan 0522 P14 — `set_station` IS DISPATCHED BEFORE THE BLANKET ROLE CHECK, DELIBERATELY ──
    // It is this batch's one privilege escalation, and its gate lives in exactly ONE place:
    // `api.stationSet`, which this frame and the MCP tool both funnel through. Checking the role
    // here as well would put the decision in two places — and the surface that was checked here
    // would then be gated by a rule the MCP surface never runs, which is the I1 (surface parity)
    // failure this phase exists to prevent. It also lets the refusal carry a REASON back to the
    // caller (I5): the blanket drop below answers nothing at all, and a refusal that says nothing
    // is indistinguishable from a refusal that never happened.
    if (m.action === 'set_station') {
      const sa = m.args || {};
      const r = api.stationSet(sa.userId, sa.stationUid, c);
      send(ws, Object.assign({ t: 'station-set' }, r));
      log.info('control', 'set_station', { socketId: c.id, role: c.role, ok: r.ok, reason: r.reason || null });
      return;
    }
    if (c.role !== 'presenter' && c.role !== 'ai') { log.warn('control', 'denied', { socketId: c.id, role: c.role }); return; }
    const a = m.args || {};
    switch (m.action) {
      // PRIM-mirror (MON-2): render the TARGET user's current display in the target's
      // OWN context, then PUSH it back to THIS requesting control client (fire-and-forget,
      // not a reply). Lets the GM thumbnail "what that user sees". OPSEC: role-gated above.
      // Plan 0522 P5 — mirror answers for ANY target the unified selector can hold, not only a
      // userId: `{target:'station:3'}` renders what somebody sitting at that station is really
      // being shown. `{userId:…}` still works and is still echoed back verbatim — MON-2's client
      // and PRIM-mirror both address it that way, and an unknown/absent target still answers
      // html:null rather than inventing a plausible screen.
      case 'mirror': {
        const tgt = a.target != null ? String(a.target) : (a.userId != null ? String(a.userId) : null);
        const tc = liveConnForTarget(tgt);   // A4: one representative socket — mirror returns ONE html
        const desc = (tc && (displayByUser.get(tc.userId) || displayByRole[tc.role])) || null;
        const html = (desc && tc) ? descToHtml(tc, desc) : null;
        // Plan 0522 P14 — SAY WHICH SOCKET ANSWERED. P3 collapsed the roster to one row per
        // PERSON, so a contested seat (two live sockets, one derived identity) is one row with
        // two clients behind it, and `liveConnForTarget` silently picks the latest. Mirror is the
        // one row action that is inherently SOCKET-scoped (A4: it returns ONE html), so it now
        // reports the socketId it actually rendered rather than leaving the operator to assume.
        send(ws, { t: 'mirror', target: tgt, userId: a.userId != null ? a.userId : (tc ? tc.userId : null), socketId: tc ? tc.id : null, html });
        break;
      }
      // Plan 0522 P14 — SPOTLIGHT from the roster row. api.spotlight has existed since 0508 with
      // no button on any human surface: the grant was reachable only from MCP, so a GM without an
      // AI in the loop could not let a player share their station at all. IDENTITY-scoped by
      // construction — the grant set is keyed by userId — so it reaches every socket that identity
      // holds, which is the correct behaviour for a capability that belongs to a person.
      case 'spotlight': send(ws, Object.assign({ t: 'spotlight' }, api.spotlight(a.userId, a.granted !== false))); break;
      // Plan 0522 P15 — ▣ project a station's screen to the room. CONTROLLER-ONLY by
      // construction: every case in this switch is already past the role gate above, and unlike
      // `set_station` (which is reachable from MCP with an arbitrary userId and therefore needs
      // its own gate inside api.stationSet) this capability exists on exactly one surface.
      // TRANSIENT: it writes no seat — see projectStation's header for why that is load-bearing.
      case 'project_station':
        send(ws, Object.assign({ t: 'station-project' }, projectStation(a.stationUid, a.targets)));
        break;
      // Bell as a control: playable from the control page (🔔) and the verify-watching
      // path (👁 = bell + requireAck) via the SAME api.chime method the MCP tools drive.
      case 'bell': api.chime(a); break;
      case 'push_component': api.pushComponent(a.target || 'all', a.component, a.opts || {}, a.theme || 'argus', a.requires || []); break;
      case 'open_poll': api.openPoll(a); break;
      case 'close_poll': api.closePoll(a.promptId); break;
      case 'reload_clients': api.reloadClients(a.target || 'all', a.delay || 0); break;
      case 'clear': dropStaging(c); api.clear(a.target || 'all'); break;   // route through api.clear so display descriptor is also reset (reconnect → branding)
      // MON-1: drop a user's per-user override so they follow their ROLE/default display
      // again (or branding if the role has none). DISTINCT from clear(): clear BLANKS to
      // branding; reset_user RETARGETS to the role display. Role-gated above.
      case 'reset_user': {
        const uid = a.userId;
        displayByUser.delete(uid);
        // A4: retarget EVERY socket this person holds — resetting only one leaves the other stale.
        for (const tws of socketsFor(uid)) {
          const tc = conns.get(tws);
          if (!tc) continue;
          const desc = displayByRole[tc.role];
          if (desc) renderDisplay(tws, tc, desc); else send(tws, { t: 'clear' });
        }
        pushPresence();
        break;
      }
      case 'op': handleOp(c, { path: a.path, verb: a.verb, value: a.value, opId: a.opId }); break;   // drive an op as the presenter
      // ATT (Plan 0466, decision 1): presenter toggles whether attendees may see the roster.
      case 'set_roster_visible': rosterVisibleToAttendees = !!a.value; log.info('att', 'roster-visible', { value: rosterVisibleToAttendees }); break;
      case 'voice_enable': api.voiceEnable(a.target || 'all'); break;   // Plan 0470: request inbound voice on a target
      // Plan 0689 R4b — the counterpart. I1 parity: the release is reachable from the control page
      // for the same reason the request is, and it can only ever STOP capture.
      case 'voice_release': api.voiceRelease(a.target || 'all'); break;
      case 'set_module': api.setModule(a.module || { beats: a.beats || [] }); break;   // Group I
      case 'show_beat': dropStaging(c); api.showBeat(a.id != null ? a.id : (a.index | 0)); break;   // by id (branch nav) or index — R4: PUBLISHES, unchanged
      // Plan 0522 P4 (R4) — two-stage delivery. STAGE renders a candidate to THIS controller's
      // own surface (per-caller: keyed by socket, so a second controller is untouched — t09) and
      // writes nothing durable (t07). SEND publishes it and ACKS with the recipient count, so
      // "sent to 0 recipients" cannot be silent (I5). Both ack; the UI lands in P5/P6.
      case 'stage_beat': {
        const ref = a.id != null ? a.id : (a.index != null ? (a.index | 0) : null);
        // P5: the SAME `targets` array the send will carry. One control, one target — a candidate
        // is previewed as the audience it is about to reach, never as the presenter (t11).
        send(ws, Object.assign({ t: 'staged' }, api.stageBeat(ref, { key: callerKey(c), ws, conn: c, targets: a.targets })));
        break;
      }
      case 'send_beat':
        send(ws, Object.assign({ t: 'sent' }, api.sendBeat({ targets: a.targets, id: a.id, index: a.index }, { key: callerKey(c) })));
        break;
      // Plan 0522 P6 — a controller that PUBLISHES something else disarms its own staged
      // candidate. Without this the server slot stays armed while the page has moved on, and
      // `stagedBeat()` reports a candidate the operator no longer believes in — the same
      // instrument-lying-about-state failure the indicator exists to remove.
      case 'show_default': dropStaging(c); api.showDefault(); break;   // DEF-1: Home → module title page (or branding fallback)
      case 'next_beat': dropStaging(c); api.nextBeat(); break;
      case 'prev_beat': dropStaging(c); api.prevBeat(); break;
      case 'append_beat': api.appendBeat(a.beat || { component: a.component, opts: a.opts, requires: a.requires }); break;   // compose (I2) + AI co-author (I3)
      case 'load_module': api.loadModule(a.module); break;   // I4
      default: log.warn('control', 'unknown-action', { action: m.action });
    }
    log.info('control', m.action, { socketId: c.id });
  }

  function broadcastDiff(diff, meta) {
    let recipients = 0;
    for (const [ws, c] of conns.entries()) {
      /* ── Plan 0539 P2.2 — DO NOT BROADCAST TO A SOCKET THAT HAS NOT CONVERGED YET. ──────────────
       * Verified in 0538: this loop filtered by `canRead` ONLY, so a store write performed DURING a
       * client's own handshake (today the station-seat write, `seatResolver.select` → `occupancy.seat`)
       * was delivered here AND again by the resync a few lines later. Skipping it loses nothing: any
       * op broadcast while `converged === false` has `version <= store.version()` at the moment
       * `resyncOrSnapshot` runs, so it is either inside `oplogSince(lv)` and replayed, or inside the
       * snapshot taken at that same version.
       * ⛓ This fixes the CLASS, not the instance. It is harmless today only because the duplicated
       * slice (`ship/`) has no client subscriber; `map.js` → `showClick` SPAWNS DOM per diff, so the
       * first connect-time write into any spawn-on-diff slice would paint a visible double.
       * ⚠ Ephemerals (pointer/laser) are in neither the oplog nor the snapshot — see P2.4 in the
       * report for what that costs and what was actually observed. */
      if (!c.converged) continue;
      const visible = {};
      for (const p of Object.keys(diff)) if (store.perms.canRead({ role: c.role, userId: c.userId }, p)) visible[p] = diff[p];   // Plan 0471 C3: actor-aware read (per-recipient vote redaction)
      if (Object.keys(visible).length) {
        send(ws, { t: 'host', msg: { source: 'argus-host', type: 'diff', diff: visible, by: meta.by, version: meta.version } });
        recipients++;
      }
    }
    /*
     * X3 fan-out measurement. ⛔ ONLY SAMPLE WHEN THERE IS AN AUDIENCE. Fan-out is "how many
     * clients did this broadcast reach"; a broadcast made while nobody is connected is not a
     * fan-out of zero, it is not a sample at all. A plugin seeding its state at register fires
     * before the first client exists, and those 13 empty broadcasts dragged avgFanout to 0.21 —
     * a server reporting under one recipient per broadcast while every connected client was in
     * fact receiving everything. `recipients === 0` WITH an audience is still a real zero
     * (everything redacted) and is still sampled. Found 2026-08-11.
     *
     * ⚠ CONVERGED, not merely connected. The loop above skips `!c.converged` by design — a client
     * mid-handshake is served by the snapshot/resync path instead — so a broadcast during somebody's
     * hello can only ever score zero. Counting those measures the handshake, not the fan-out, and
     * with a station plugin (which writes a seat on every hello) that is three phantom zeroes per
     * joiner.
     */
    let audience = 0;
    for (const c of conns.values()) if (c.converged) audience++;
    if (audience > 0) { telem.fanout.sum += recipients; telem.fanout.count++; }
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
    // Plan 0522 P5 — a STATION target resolves to THE PEOPLE SEATED THERE, not to a key named
    // after the station. Writing `displayByUser.set('station:3', …)` would have created a durable
    // row that no connection ever reads, would have shown up in the roster's "sees" column and in
    // the I3 snapshot, and would have survived everyone leaving. Resolving to occupants makes a
    // station push exactly a per-user push to each of them (so a reconnect still works), leaves no
    // residue when the station is empty, and never touches SEAT state — 0514 §13.1 / I3.
    const stUid = stationTargetUid(target);
    if (target === 'all' || target == null) { for (const r of ROLES) displayByRole[r] = desc; displayByUser.clear(); }
    else if (ROLES.includes(target)) displayByRole[target] = desc;
    else if (stUid != null) { for (const uid of usersAtStation(stUid)) displayByUser.set(uid, desc); }
    else displayByUser.set(target, desc);   // by userId
    pushPresence();   // keep the GM user-list "currently sees" column live as displays change
  }
  // Stamp identity + apply the OPSEC scene strip via the PERMISSION MODEL (G2):
  // an item is included only if this role may READ its visibility. The scene
  // component keeps a thin client-side filter as defense-in-depth.
  // Plan 0482 A3 — RECURSIVE visibility strip. The old strip only ran when the TOP-LEVEL
  // component was `scene`, and only at depth 1. A scene nested inside a scene keeps its
  // children at items[i].opts.items, which were never inspected — so `visibility:'gm'` at
  // depth 2 was serialised straight into a participant's srcdoc. The strip is now applied at
  // EVERY depth and regardless of the enclosing component name: the server never emits bytes
  // the viewer may not read. Copy-on-write — the caller's opts object is never mutated.
  const VISIBILITY_MAX_DEPTH = 16;   // cycle/blow-up guard; deeper nesting is not stripped, so it is refused
  function stripVisibility(role, opts, depth = 0) {
    if (!opts || typeof opts !== 'object' || !Array.isArray(opts.items)) return opts;
    if (depth >= VISIBILITY_MAX_DEPTH) {
      log.warn('content', 'visibility-depth-exceeded', { depth, maxDepth: VISIBILITY_MAX_DEPTH, action: 'items-dropped' });
      return Object.assign({}, opts, { items: [] });   // fail-closed: never emit unstripped content
    }
    const items = [];
    for (const it of opts.items) {
      if (!it || typeof it !== 'object') { items.push(it); continue; }
      if (!store.perms.canSeeVisibility(role, it.visibility)) continue;   // dropped for this viewer
      const childOpts = stripVisibility(role, it.opts, depth + 1);
      items.push(childOpts === it.opts ? it : Object.assign({}, it, { opts: childOpts }));
    }
    return Object.assign({}, opts, { items });
  }
  function stampFor(c, component, opts) {
    const o = Object.assign({}, opts, { userId: c.userId, userName: c.userName, channel: c.userId, viewerRole: c.role });
    return stripVisibility(c.role, o);
  }
  function sendComponentTo(ws, c, desc) {
    const o = stampFor(c, desc.component, desc.opts || {});
    return send(ws, { t: 'content', contentId: o.promptId || null, html: assemble({ component: desc.component, opts: o, theme: desc.theme || 'argus', requires: desc.requires || [] }) });
  }
  /* ── Plan 0689 R5 — AN AUTHORED PAGE THAT HOSTS COMPONENTS ────────────────────────────────
   * ⭐⭐ There was never an architectural gap between "component" and "arbitrary HTML":
   * sendComponentTo already sends `{t:'content', html: assemble(...)}`, which is the EXACT message
   * pushContent sends. One render path, one sandboxed iframe, one postMessage bridge. So a page is
   * a third `desc.kind` beside `component`, not a second mechanism.
   *
   * ⛔ AND IT IS STAMPED AND STRIPPED PER VIEWER, exactly as a component is. `kind:'content'` sends
   * ONE html string to everybody — no identity, no OPSEC strip — which is right for opaque bytes
   * and wrong for a page carrying a dice check: every player would roll as nobody. So a mount's
   * `visibility:'gm'` is dropped SERVER-SIDE for a participant (the bytes never leave), and each
   * viewer's own userId/channel/role ride into every mount.
   */
  function stampPageFor(c, desc) {
    const o = Object.assign({}, desc.opts || {}, { userId: c.userId, userName: c.userName, channel: c.userId, viewerRole: c.role });
    const mounts = [];
    for (const m of (Array.isArray(desc.mounts) ? desc.mounts : [])) {
      if (!m || typeof m !== 'object') continue;
      if (!store.perms.canSeeVisibility(c.role, m.visibility)) continue;   // never emitted, not merely hidden
      const childOpts = stripVisibility(c.role, m.opts);
      mounts.push(childOpts === m.opts ? m : Object.assign({}, m, { opts: childOpts }));
    }
    return { opts: o, mounts };
  }
  function pageHtmlFor(c, desc) {
    const { opts, mounts } = stampPageFor(c, desc);
    return assemble({ html: desc.html || '', mounts, opts, theme: desc.theme || 'argus', requires: desc.requires || [] });
  }
  function sendPageTo(ws, c, desc) {
    return send(ws, { t: 'content', contentId: desc.contentId || null, html: pageHtmlFor(c, desc) });
  }
  // Produce the HTML STRING for `desc` rendered in viewer `c`'s context — the html-
  // producing half of renderDisplay, factored out for PRIM-mirror (server push of a
  // target's current display back to a control client). Mirrors renderDisplay's branches.
  function descToHtml(c, desc) {
    if (!desc) return '';
    if (desc.kind === 'content') return desc.html || '';
    if (desc.kind === 'component') return assemble({ component: desc.component, opts: stampFor(c, desc.component, desc.opts || {}), theme: desc.theme || 'argus', requires: desc.requires || [] });
    if (desc.kind === 'page') return pageHtmlFor(c, desc);   // Plan 0689 R5
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
  /**
   * Send `desc` down socket `ws`. `c` is the connection it is DELIVERED to; `viewer` is the
   * identity it is RENDERED AS, defaulting to that same connection — so every existing 3-argument
   * call behaves exactly as before.
   *
   * Plan 0522 P5 — separating the two IS the fidelity fix. Both identity-bearing branches stamped
   * the DELIVERY connection (`stampFor` for a component; `c.userId`/`c.userName`/`channel` for a
   * poll-choice), so a candidate beat rendered down the CONTROLLER's socket came out as the
   * presenter's copy of a per-user beat. The GM would have verified the one version no player was
   * ever going to receive. Now the bytes are the target's and only the delivery is the controller's.
   */
  function renderDisplay(ws, c, desc, viewer) {
    if (!desc) return;
    const v = viewer || c;
    if (desc.kind === 'content') send(ws, { t: 'content', contentId: desc.contentId || null, html: desc.html });
    else if (desc.kind === 'page') sendPageTo(ws, v, desc);   // Plan 0689 R5 — stamped for the VIEWER, like a component
    else if (desc.kind === 'component') sendComponentTo(ws, v, desc);
    else if (desc.kind === 'poll-choice') {
      const poll = polls.get(desc.promptId); if (!poll) return;
      send(ws, { t: 'content', contentId: desc.promptId, html: assemble({ component: 'choice', opts: { ...poll.spec, promptId: desc.promptId, userId: v.userId, userName: v.userName, channel: v.userId } }) });
    } else if (desc.kind === 'poll-results') {
      const poll = polls.get(desc.promptId); if (!poll) return; const t = tally(desc.promptId);
      send(ws, { t: 'content', contentId: desc.promptId + ':results', html: assemble({ component: 'poll-results', opts: { ...poll.spec, promptId: desc.promptId, tally: t.tally, count: t.count } }) });
    }
  }
  /**
   * On (re)connect: re-push the current content module (GAP fix, C6).
   *
   * This is also the ONE definition of "what the room is currently showing THIS viewer", read
   * LIVE from the display maps — 0526 P4's `unpeek` is the same question asked by a viewer
   * instead of by a reconnect, so it calls this rather than growing a second copy of the rule.
   * Returns the descriptor it sent, or null when the room has nothing on this viewer's screen.
   */
  function redisplayFor(ws, c) {
    const desc = displayByUser.get(c.userId) || displayByRole[c.role];
    if (desc) renderDisplay(ws, c, desc);
    return desc || null;
  }

  // ── Plan 0522 P4 — BEAT RESOLUTION, DESCRIPTION, PUBLICATION ────────────────────────────────
  // Three small functions extracted from the old showBeat body so that STAGING and PUBLISHING
  // share one implementation. There is no second rendering engine and no second push path:
  // `stage_beat` uses resolve+describe and hands the descriptor to the EXISTING renderDisplay;
  // `show_beat` and `send_beat` both go through publishBeat. R4: show_beat's behaviour is
  // unchanged — same routing, same layers, same module/current write, same return shape.

  /** A beat ref is an INDEX (number) or a beat ID (anything else). → {i, beat} | null. */
  function resolveBeatRef(ref) {
    if (!contentModule) return null;
    const beats = contentModule.beats || [];
    const i = typeof ref === 'number' ? ref : beats.findIndex((b) => b.id === ref);
    if (!(i >= 0) || i >= beats.length) return null;
    return { i, beat: beats[i] };
  }

  /**
   * The descriptor a beat WOULD publish — PURE. Reads the beat, writes nothing, touches no
   * display map. This is what makes staging safe (I3): the candidate can be rendered to one
   * socket with exactly the bytes a publish would have produced.
   * Layers are deliberately NOT folded in: a layer is a per-target override, and a preview is
   * rendered for one viewer at a time (the target-aware preview is P5's job).
   */
  function beatDescriptor(b) {
    const opts = (b.promptId != null) ? Object.assign({}, b.opts || {}, { promptId: b.promptId }) : (b.opts || {});
    return { kind: 'component', component: b.component, opts, theme: b.theme || 'argus', requires: b.requires || [] };
  }

  /**
   * PUBLISH beat `i`. `targetList` null/empty ⇒ the beat's OWN declared routing (`b.target`,
   * default 'all') — that is exactly what show_beat has always done. A non-empty targetList
   * (send_beat, P5) overrides the routing and addresses those targets instead.
   *
   * Returns the delivery accounting I5 demands: how many PEOPLE and how many SOCKETS it actually
   * reached. Counted as a SET of the sockets addressed, so a base push plus a layer push to the
   * same person is one recipient, and a target with no occupant is honestly 0.
   */
  function publishBeat(i, targetList) {
    const b = contentModule.beats[i];
    const explicit = Array.isArray(targetList) && targetList.length ? targetList : null;
    const bases = explicit || [b.target || 'all'];
    // `reached` is filled by pushComponent with the sockets it genuinely wrote to. It was
    // previously filled by re-running targets() alongside the push, which counted the ADDRESS
    // BOOK rather than the deliveries — see send()/pushComponent.
    const reached = new Set();
    // Route by the beat's target (per-user hooks broadcast to 'all' by default) and ensure promptId
    // reaches opts so interactive beats can actually collect/gate answers.
    const opts = (b.promptId != null) ? Object.assign({}, b.opts || {}, { promptId: b.promptId }) : (b.opts || {});
    for (const t of bases) { api.pushComponent(t, b.component, opts, b.theme || 'argus', b.requires || [], reached); }
    const addressed = new Set(reached);   // the BASE audience, frozen before layers widen `reached`
    // DEL-1: per-user layers. A layer with a `target` OVERRIDES the base opts for that
    // user/role (layer opts win). `when`-only layers are runner-evaluated — out of scope here.
    // Base goes to all; layered targets additionally receive the merged override (last-wins).
    // With an EXPLICIT target list, a layer for someone who is not being addressed is skipped —
    // sending to one station must not push to a third party.
    //
    // ⚠ Plan 0522 P5 — INTERSECT AUDIENCES, DO NOT COMPARE TARGET STRINGS. P4 skipped a layer
    // unless `explicit` literally contained `L.target`, which was right for the one case it had.
    // P5 makes explicit targets the ordinary path, and string equality then DROPS a layer whose
    // target names the same people by another name — a userId layer on a send to that person's
    // STATION, or on a send addressed to a role. A dropped layer is a beat that silently arrives
    // without its personalisation (I4). Sets of sockets say who is really being addressed.
    if (Array.isArray(b.layers)) for (const L of b.layers) {
      if (!L || !L.target) continue;
      if (explicit && !targets(L.target).some((lws) => addressed.has(lws))) continue;
      const lopts = Object.assign({}, b.opts || {}, L.opts || {}, (b.promptId != null) ? { promptId: b.promptId } : {});
      api.pushComponent(L.target, b.component, lopts, b.theme || 'argus', b.requires || [], reached);
    }
    currentBeat = i;
    serverApply({ path: 'module/current', verb: 'set', value: i });
    const people = new Set();
    for (const ws of reached) { const c = conns.get(ws); if (c && c.userId) people.add(c.userId); }
    return { sockets: reached.size, recipients: people.size, targets: bases.slice() };
  }

  /**
   * The staging key for a control connection. Per SOCKET, not per userId: two control pages open
   * on one login are two controllers, and staging on one must not arm GO on the other (t09).
   */
  function callerKey(c) { return 'ws:' + (c && c.id); }

  /**
   * Plan 0522 P6 — disarm THIS caller's staged candidate because it just published something
   * else. Only its own slot: a second controller's candidate is none of its business (t09).
   */
  function dropStaging(c) { stagedByCaller.delete(callerKey(c)); }

  /**
   * Normalise a `targets` argument to an array, or null for "do not narrow the audience".
   *
   * Plan 0522 P5 — the wire format is an ARRAY from the first commit (Bruce: *"data structure
   * should support it later"*), and `['all']` is its DEFAULT value, not a special send. `all` has
   * always meant "no restriction", so a list that is nothing but `all` normalises to null and the
   * beat's OWN declared routing applies — picking ALL in the selector is therefore byte-identical
   * to what clicking a beat has always done, including its per-user layers and its `target:` field.
   * Anything else is an explicit override that NARROWS the audience.
   */
  function normalizeTargets(t) {
    if (t == null) return null;
    const list = (Array.isArray(t) ? t : [t]).filter((x) => x != null && x !== '').map(String);
    if (!list.length) return null;
    if (list.every((x) => x === 'all')) return null;
    return list;
  }

  /**
   * Plan 0522 P5 — the LIVE connection a target names, or null. Used for previewing: the preview
   * must show what a real client is really being sent, so an unoccupied station and an absent
   * person both answer null rather than a plausible-looking fabrication (I5 — the GM sees that
   * nobody is there BEFORE pressing GO, instead of after).
   */
  function liveConnForTarget(target) {
    if (target == null || target === 'all') return null;
    const stUid = stationTargetUid(target);
    if (stUid != null) { const ws = socketsAtStation(stUid)[0]; return ws ? conns.get(ws) || null : null; }
    if (ROLES.includes(target)) { const ws = targets(target)[0]; return ws ? conns.get(ws) || null : null; }
    const ws = latestFor(target);
    return ws ? conns.get(ws) || null : null;
  }

  /**
   * The viewer identity a target implies, for STAMPING only — never for delivery. Falls back to a
   * SYNTHETIC viewer when nobody holds the target, carrying role `participant`: the conservative
   * role, so the OPSEC visibility strip can only ever remove more from a preview, never less.
   */
  function viewerForTarget(target) {
    if (target == null || target === 'all') return null;   // ⇒ render as the caller: the unchanged default
    const live = liveConnForTarget(target);
    if (live) return live;
    const stUid = stationTargetUid(target);
    if (stUid != null) { const st = stationRegistry.get(stUid); return { userId: null, userName: (st && st.stationLabel) || target, role: 'participant' }; }
    if (ROLES.includes(target)) return { userId: null, userName: target, role: target };
    return { userId: target, userName: target, role: 'participant' };
  }

  // ── Plan 0514 — STATIONS ─────────────────────────────────────────────────────────────────
  // DIVISION OF LABOUR (§13.2), and it is the whole point of the plan: core relays the registry
  // and renders the descriptor it is handed; the PLUGIN validates, records and answers. Core
  // holds no occupancy — so no display/module code path can reach it, and "a module load must
  // not clear stations" stops being a discipline and becomes something the architecture asserts.

  /** Stations are live only when a registry exists AND a plugin registered a seat resolver. */
  function stationsActive() { return !stationRegistry.isEmpty() && !!seatResolver; }

  // ── Plan 0522 P14 — WHO MAY SEAT SOMEBODY ELSE ───────────────────────────────────────────
  // The in-process API principal. `api` is handed to the MCP bridge and to registered plugins and
  // to nobody else; a participant reaches core only over the wire, where the actor is their own
  // connection. So a direct `api.stationSet(a, b)` is a CONTROL call by construction, and saying
  // so explicitly is what lets the same gate serve both surfaces without a second rule.
  const API_ACTOR = Object.freeze({ userId: 'api', role: 'ai', principal: 'in-process' });
  /** True only for a control role (presenter/ai). Anything else — including absent — is refused. */
  function isControllerActor(actor) { return !!actor && CONTROL_ROLES.has(actor.role); }

  /** Ask the plugin what this seat holds. Cheap + synchronous by contract; never cached here. */
  function seatStation(userId) {
    if (!stationsActive()) return null;
    try { return seatResolver.get(userId) || null; }
    catch (e) { log.warn('station', 'resolver-get-failed', { userId, err: String(e && e.message || e) }); return null; }
  }

  /** The uid this seat holds, or null when stations are inert. For `welcome` and presence. */
  function seatStationUid(userId) { const s = seatStation(userId); return s && s.uid != null ? s.uid : null; }

  /**
   * The CORE GENERIC PLACEHOLDER (§6.1): what a station with no screen descriptor renders.
   * Built from REGISTRY VALUES ONLY — core must not contain a single station name (t0514-15).
   */
  function stationPlaceholder(uid, c) {
    const st = stationRegistry.get(uid);
    return {
      kind: 'component', component: 'card', theme: 'argus', requires: [],
      opts: {
        title: (st && st.icon ? st.icon + ' ' : '') + (st ? st.stationLabel : ''),
        subtitle: c.userName || '',
        body: 'no active screen for this station yet',
      },
    };
  }

  /**
   * Render a seat's OWN station to that socket. Deliberately does NOT touch displayByUser —
   * a station is durable system state, a per-seat push is transient, and 0514 §13.1 exists
   * because both used to live in the same map.
   */
  function renderStationTo(ws, c, seat) {
    const desc = (seat && seat.descriptor) || stationPlaceholder(seat && seat.uid, c);
    renderDisplay(ws, c, desc);
    return desc;
  }

  /**
   * Plan 0522 P15 — a STATION's current screen, as a descriptor, or null.
   *
   * Core holds no occupancy and no station→screen map (0514 §13.2): the descriptor lives on the
   * SEAT, so a station's screen is whatever the plugin is currently answering for somebody who is
   * sitting there. Nobody sitting there ⇒ null, and the caller falls back to the core generic
   * placeholder — which is the honest answer for an empty station rather than a blank screen.
   */
  function stationDescriptor(uid) {
    for (const userId of usersAtStation(uid)) {
      const seat = seatStation(userId);
      if (seat && seat.uid === uid && seat.descriptor) return seat.descriptor;
    }
    return null;
  }

  /**
   * Plan 0522 P15 — ▣ PROJECT a station's screen onto a target's displays.
   *
   * ⚠⚠ I3 — TRANSIENT RENDER, DURABLE ASSIGNMENT, AND THIS IS THE WHOLE DESIGN CONSTRAINT.
   * The tempting implementation of "put station N on the room's screens" is to seat the room at
   * station N. That would durably re-seat every player through `seatResolver.select()` to show one
   * screen for thirty seconds, and every one of them would have to be put back by hand — so this
   * function does not call select(), does not touch a seat, and writes nothing the plugin owns.
   *
   * It also deliberately does NOT go through pushComponent: setDisplay('all') does
   * `displayByUser.clear()`, so a single projection would wipe every seat's per-seat push and
   * `▣ My station screen` would answer "nothing has been sent to your seat" for the rest of the
   * session. That is 0508's T7, found the hard way when `station-share` was written (above); the
   * same reasoning applies verbatim here, so the same shape does: render straight to the sockets.
   *
   * Each viewer is rendered in THEIR OWN context (renderDisplay stamps per connection), so the
   * identity stamp and the OPSEC visibility strip still apply — never a verbatim copy of one
   * seat's bytes fanned out to everybody.
   */
  function projectStation(stationUid, targetList) {
    const none = { ok: false, stationUid: null, stationLabel: null, projected: 0, targets: [] };
    if (!stationsActive()) return { ...none, reason: 'no-stations' };
    const uid = Number(stationUid);
    const st = Number.isFinite(uid) ? stationRegistry.get(uid) : null;
    // Refuse an unknown uid BY NAME. `select()` resolves an unknown uid to the deployment default
    // (0514 §5) because a player must always land somewhere; a projection has no such duty, and
    // silently projecting a different station than the one asked for is I5's silent wrong answer.
    if (!st) return { ...none, reason: 'no-such-station' };
    const bases = (Array.isArray(targetList) && targetList.length) ? targetList.slice() : ['all'];
    const reached = new Set();
    for (const t of bases) for (const ws of targets(t)) reached.add(ws);
    const shared = stationDescriptor(uid);
    let projected = 0;
    for (const ws of reached) {
      const c = conns.get(ws);
      if (!c) continue;
      renderDisplay(ws, c, shared || stationPlaceholder(uid, c));
      projected++;
    }
    log.info('station', 'projected', { stationUid: uid, targets: bases, projected, placeholder: !shared });
    return { ok: true, stationUid: uid, stationLabel: st.stationLabel, projected, targets: bases };
  }

  // ── Plan 0526 P1 — SURFACES ──────────────────────────────────────────────────────────────
  // A SURFACE is a declared screen a viewer may be shown on request. THE PHASE IS THE REGISTRY,
  // NOT THE VERB: everything here holds and ADDRESSES a surface (does it exist, may it be
  // summoned, what does it render as). Nothing here puts one on anybody's screen — the summoning
  // verb (`peek`/`unpeek`, 0526 P4) is deliberately a separate change, so that a defect in the
  // verb cannot cost the registry and vice versa.
  //
  // ⚠ WHY THERE IS NO `renderSurfaceTo` HERE. `renderStationTo(ws, c, seat)` reads
  // `seat.descriptor` — it is SEAT-shaped: it takes the row a plugin's seat resolver answered
  // with, and there is no seat behind a surface, so it cannot be handed a surfaceUid as written.
  // Rather than widen a function three station call sites depend on, the registry OWNS the
  // descriptor: `surfaceDescriptor(uid, c)` returns something `renderDisplay` already accepts, so
  // P4's peek is one call to the existing renderer and `renderStationTo` is left untouched.
  //
  // ⛓ ADDRESSED BY UID, NEVER BY CODE (naming canon §3, ruling in plan 0534 W4). Every function
  // below takes `surfaceUid` — an integer the registry assigned at load. `surfaceId` is the
  // author's word for the row and does not appear in any lookup, any wire frame, or any push
  // target here, for the same reason `stationCode` does not: a typo'd string resolves to nothing
  // and reports nothing, and that silence is the expensive failure this project has already paid
  // for once.

  /** Surfaces are live only when some plugin declared one. Empty registry ⇒ every surface refuses. */
  function surfacesActive() { return !surfaceRegistry.isEmpty(); }

  /**
   * The CORE GENERIC PLACEHOLDER for a declared surface with no screen — the sibling of
   * `stationPlaceholder`, and built from REGISTRY VALUES ONLY, so core still contains no
   * deployment's vocabulary. A declared-but-undrawn surface says so; it never renders blank.
   */
  function surfacePlaceholder(surfaceUid, c) {
    const sf = surfaceRegistry.get(surfaceUid);
    return {
      kind: 'component', component: 'card', theme: 'argus', requires: [],
      opts: {
        title: (sf && sf.icon ? sf.icon + ' ' : '') + (sf ? sf.surfaceLabel : ''),
        subtitle: (c && c.userName) || '',
        body: 'no screen declared for this surface yet',
      },
    };
  }

  /**
   * A surface's screen as a descriptor, or null when no such surface is declared.
   *
   * ⛓ THE SURVIVAL PROPERTY, and the reason this function is two lines instead of a lookup into
   * the loaded module: it reads `surfaceRegistry` and NOTHING ELSE. It does not consult
   * `contentModule`, `currentBeat`, `displayByRole` or `displayByUser`, so `setModule` — which
   * replaces the module wholesale and resets the beat — cannot change what it answers.
   * `requires` carries the DECLARING PLUGIN, so a surface drawn with a plugin's own component
   * still assembles when it is called up from a session running someone else's module.
   */
  function surfaceDescriptor(surfaceUid, c = null) {
    const sf = surfaceRegistry.get(surfaceUid);
    if (!sf) return null;
    if (!sf.screen) return surfacePlaceholder(surfaceUid, c);
    return {
      kind: 'component', component: sf.screen.component, theme: 'argus',
      requires: sf.pluginName ? [sf.pluginName] : [],
      opts: Object.assign({}, sf.screen.opts),
    };
  }

  /**
   * Resolve a surfaceUid for a caller. REFUSES BY NAME — `no-surfaces` (none declared anywhere),
   * `not-a-uid` (something that is not an integer at all — canon §3's loud failure), then
   * `no-such-surface` (an integer nobody declared) and `not-peekable` (declared, but not offered
   * to viewers). A silent no-op here would be I5's silent wrong answer: the viewer asks for a
   * screen, gets whatever was already there, and has no way to tell the two apart.
   *
   * ⚠ `not-a-uid` is separate from `no-such-surface` on purpose. They are different mistakes: one
   * is a caller that sent the author's code (or a label, or a string of digits) where the wire
   * takes an integer; the other is a caller addressing a surface this deployment does not have.
   * Collapsing them would tell a plugin author "no such surface" about a surface that exists.
   */
  function resolveSurface(surfaceUid, c = null) {
    if (!surfacesActive()) return { ok: false, reason: 'no-surfaces', surfaceUid: null };
    if (!Number.isInteger(surfaceUid)) return { ok: false, reason: 'not-a-uid', surfaceUid: null };
    const sf = surfaceRegistry.get(surfaceUid);
    if (!sf) return { ok: false, reason: 'no-such-surface', surfaceUid };
    if (!sf.peekable) return { ok: false, reason: 'not-peekable', surfaceUid: sf.surfaceUid, surfaceLabel: sf.surfaceLabel };
    return {
      ok: true, surfaceUid: sf.surfaceUid, surfaceLabel: sf.surfaceLabel, peekable: true,
      hasScreen: !!sf.screen, descriptor: surfaceDescriptor(sf.surfaceUid, c),
    };
  }

  /**
   * ── Plan 0526 P4 — PEEK: a viewer summons a declared surface onto their OWN screen ─────────
   *
   * ⛓ THE ONE PROPERTY THIS FUNCTION EXISTS TO HAVE: it touches exactly one socket. It writes no
   * seat, no display map, no store op, no module and no beat — it renders straight down `ws`,
   * exactly as `projectStation` and `station-share` do and for the same reason (0508 T7:
   * `setDisplay`/`pushComponent` would clear `displayByUser` for EVERYBODY, so a peek would wipe
   * every other viewer's per-seat push). So `peek` cannot change what anyone else sees, and it
   * cannot change what the facilitator sees, BY CONSTRUCTION rather than by discipline.
   *
   * Zero-privilege, so it is ungated for participants: it shows a screen the deployment already
   * declared peekable, to one person, changing nothing. DEFAULT-DENY does the gating — a surface
   * that never said `peekable: true` is refused by name (`resolveSurface` above).
   *
   * ⚠ THE ROOM STILL WINS. Nothing here marks the connection as "peeking", so a room push during a
   * peek lands on this socket like any other — the presenter can always reach a viewer, and the
   * peek is simply overwritten. That is 0526 P4's declared precedence, and it costs no code
   * because there is no peek STATE to give precedence to.
   */
  function peekTo(ws, c, surfaceUid) {
    const r = resolveSurface(surfaceUid, c);
    if (!r.ok) return r;
    renderDisplay(ws, c, r.descriptor);
    c.lastActive = Date.now();
    log.info('surface', 'peeked', { userId: c.userId, surfaceUid: r.surfaceUid });
    return r;
  }

  /**
   * ── Plan 0526 P4 — UNPEEK: go back to the room ─────────────────────────────────────────────
   *
   * ⛓ RULING (0526 P4): unpeek returns the viewer to WHAT THE ROOM IS SHOWING NOW, not to what it
   * was showing when they peeked. There is deliberately no saved descriptor: `redisplayFor` reads
   * the LIVE `displayByUser`/`displayByRole`, which is the same path a reconnect takes, so a beat
   * that moved during the peek is the beat they come back to. Restoring a snapshot would drop one
   * person back onto a beat nobody else is on — which is precisely the desync `peek` exists to
   * avoid, and it would be invisible to the presenter.
   *
   * It is also STATELESS, so it is always safe to call: "show me what the room is showing me" is a
   * meaningful request whether or not the caller was peeking, and there is no flag to go stale.
   * `restored:false` means the room has nothing on this viewer's screen (no beat, no branding) —
   * an honest answer, not a silent no-op.
   */
  function unpeekTo(ws, c) {
    const desc = redisplayFor(ws, c);
    c.lastActive = Date.now();
    log.info('surface', 'unpeeked', { userId: c.userId, restored: !!desc });
    return { ok: true, unpeeked: true, restored: !!desc };
  }

  /**
   * Plan 0514 §4.2 — load each plugin's optional server module and hand it the NEUTRAL
   * registration context. Core knows only that a plugin may have server-side code: it has no
   * idea what any of it means and contains no domain vocabulary.
   *
   * An import (or a register()) that throws is LOGGED AND SWALLOWED — a broken plugin degrades
   * the deployment to a plain Presenter, it never takes the server down mid-session (t0514-30).
   */
  async function loadPluginServerModules() {
    let manifests = {};
    try { manifests = loadManifests(); } catch (e) { log.warn('plugin', 'manifests-unreadable', { err: String(e && e.message || e) }); return; }
    for (const [name, manifest] of Object.entries(manifests)) {
      const rel = pluginServerModule(manifest);
      if (!rel) continue;                                   // no `server` key ⇒ nothing loaded
      try {
        const mod = await import(pathToFileURL(join(pluginDir(name), rel)).href);
        if (typeof mod.register !== 'function') { log.warn('plugin', 'server-module-has-no-register', { plugin: name, file: rel }); continue; }
        mod.register(pluginContext(name));
        log.info('plugin', 'server-module-loaded', { plugin: name, file: rel });
      } catch (e) {
        log.warn('plugin', 'server-module-failed', { plugin: name, file: rel, err: String(e && e.message || e) });
      }
    }
  }

  /** The neutral surface a plugin's server module gets. Nothing here names a domain. */
  function pluginContext(name) {
    return {
      // The shared store, with writes routed through the broadcasting reducer so a plugin's
      // state changes reach subscribed components. The ACTOR is the caller's to choose:
      // OVERRIDE_ROLES = {presenter, ai, system}; anything else is default-DENY and is counted
      // as `denied`, NOT thrown (app/permissions.mjs) — i.e. it fails quietly. Write as `system`.
      store: {
        get: (path) => store.get(path),
        apply: (op, actor) => serverApply(op, actor || { userId: 'plugin:' + name, role: 'system' }),
        version: () => store.version(),
        perms: store.perms,
      },
      // READ is default-DENY with an allow-list (Plan 0471 C3) and a missed rule renders a
      // component BLANK, never leaks. A plugin therefore declares its own readable prefix
      // rather than core hardcoding one — which also keeps core free of domain vocabulary.
      allowRead: (prefix, roles = ALL_READ_ROLES) => {
        if (typeof prefix !== 'string' || !prefix || prefix.includes('/')) throw new Error('allowRead expects a single top-level prefix');
        store.perms.readPolicy.push({ glob: prefix, roles: roles.slice() });
        log.info('plugin', 'read-prefix-allowed', { plugin: name, prefix, roles });
      },
      on: (ev, cb) => { if (listeners[ev]) listeners[ev].push(cb); },
      emit,
      log,
      // §9 — a plugin may contribute tools. They are NOT in mcp/tools.mjs, because their
      // vocabulary is the plugin's; core just holds the list and dispatches by name.
      addTool: (tool) => {
        if (!tool || typeof tool.name !== 'string' || typeof tool.handler !== 'function') throw new Error('addTool expects {name, handler}');
        pluginTools.set(tool.name, { ...tool, plugin: name });
        log.info('plugin', 'tool-registered', { plugin: name, tool: tool.name });
      },
      // The station rows this deployment declared, so the plugin can resolve uid → screen.
      stations: stationRegistry,
      // Plan 0526 P1 — the surface rows this deployment declared, read-only, same shape.
      surfaces: surfaceRegistry,
      // §4.2a — request/response, not fire-and-forget. Core calls select() on join and on
      // {t:'station-select'}, get() whenever it builds welcome/presence, release() on disconnect.
      provideSeatResolver: (r) => {
        if (!r || typeof r.select !== 'function' || typeof r.get !== 'function' || typeof r.release !== 'function') {
          throw new Error('provideSeatResolver expects {select, get, release}');
        }
        if (seatResolver) { log.warn('plugin', 'seat-resolver-already-registered', { plugin: name }); return; }
        seatResolver = r;
        log.info('plugin', 'seat-resolver-registered', { plugin: name });
      },
    };
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
      if (res && res.diff) {
        emit('poll', { type: 'update', promptId: pid, ...tally(pid) });   // controllers (presenter/ai) get raw vote diffs (override) → live poll-results
        // Plan 0471 D1: raw per-user votes are ALWAYS controller-only (C3 default-deny). The
        // AGGREGATE tally is what resultsMode governs. 'all' (public) → publish counts-only to a
        // readable slice so EVERYONE gets the aggregate (never per-user rows). 'control' (default,
        // private) → skip it; only controllers see the tally.
        if (poll.resultsMode === 'all') { const t = tally(pid); serverApply({ path: 'polls/' + pid + '/results', verb: 'set', value: { tally: t.tally, count: t.count } }); }
      }
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
    // Plan 0529 P1: a vote VALUE is participant-supplied and is not validated against the poll's
    // declared options, so it becomes a tally KEY verbatim — and the tally is spread into
    // situation.polls, an agent-facing payload. Only strings are neutralized: coercing a non-string
    // here would change the key a number/boolean vote has always produced.
    for (const uid of Object.keys(votes)) {
      const raw = votes[uid];
      const v = typeof raw === 'string' ? sanitizeUntrusted(raw) : raw;
      counts[v] = (counts[v] || 0) + 1; count++;
    }
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
  // ---- Plan 0493: PVS (Presenter Voice Session) lifecycle + comms mode (server-held state) ----
  // A PVS is confined to ONE agent session (§5); the terminator is the harness Monitor dying + an
  // explicit presenter_pvs_stop. State lives here (in-process) because a server restart ENDS the PVS
  // (the in-memory delivery cursor need not outlive the process), and because the comms MODE must be
  // stamped onto every delivered envelope (§6) — so the server, not the agent, is its authority.
  const PVS_MODES = new Set(['pocket', 'presenter', 'terminal']);   // §6 — closed set, keyed on Bruce's attention
  const PVS_DEFAULT_MODE = 'presenter';                             // §6/§8 — "assume I am looking at Presenter"
  let commsMode = PVS_DEFAULT_MODE;                                 // Phase B — the outbound channel-mix knob
  let pvs = null;   // null = no PVS open; else { open, consumer, openedAt, session }
  // Namespace the PVS delivery cursor (R2) so a watcher and a manual presenter_transcript read can NEVER
  // consume each other's turns. The consumer id is sanitized to a bounded, injection-free key.
  function pvsConsumerKey(consumer) { return 'pvs:' + String(consumer || 'default').replace(/[^\w.-]/g, '').slice(0, 64); }
  // ---- Plan 0493 Phase D — ws transport (Monitor({ws})) ----
  // A read-only transcript SUBSCRIBER: a socket that sends {t:'pvs_subscribe'} is a subscriber, NOT a
  // participant — removed from `conns`, so it is absent from the roster, carries no floor/backpressure
  // weight, and cannot send ops. It shares the SAME namespaced delivery cursor (R2) as the poll path, so
  // a spoken turn lands at ASR latency (removing the up-to-3 s poll wait, S12) and the watch ENDS when the
  // socket closes (teardown is a transport property). The 3 s /api/situation poll stays as the fallback.
  const pvsSubscribers = new Map();   // ws -> { consumer: <namespaced key> }
  // A deliverable turn: has text, is a settled (final) result, and is NOT the agent's own reply.
  function pvsDeliverable(entry) { return !!(entry && entry.final !== false && entry.text && entry.own !== true); }
  // Send ONE turn event to a subscriber and advance the shared delivery cursor. Echo-suppressed turns
  // (Phase E) are advanced-past but NOT sent — the cursor still moves so they never re-deliver.
  // ⛔ Plan 0687 R2 (G5) — THIS ADVANCES `sent`, NEVER `acked`. Handing bytes to a socket is a
  // TRANSPORT fact. Whether the agent on the other end read them is an AGENT fact, and only an
  // explicit ack (api.pvsAck) may record it. Acking here is the forbidden implementation: it makes
  // the whole harness at-most-once with ceremony, which is exactly the live defect of 2026-08-25 —
  // a response truncated mid-JSON acked turns nobody read.
  // `replay:true` re-sends from the ACKED position on a re-attach, so the `sent` guard is skipped.
  function deliverTurnToSub(ws, sub, entry, { replay = false } = {}) {
    const key = sub.consumer;
    if (!replay && cursors.delivery(key).sent >= entry.seq) return;   // already sent through this cursor
    cursors.markSent(key, entry.seq);                     // transport fact only (never `acked`)
    if (!pvsDeliverable(entry)) return;
    if (entry.echo === true) return;                       // Phase E: a TTS-loopback echo is not a Bruce turn
    send(ws, { t: 'turn', mode: commsMode, ...annotateTrust(entry, entry.trust) });
  }
  // Fan a freshly-emitted inbox entry out to every live subscriber (called from emitInbox).
  function fanOutToSubscribers(entry) { for (const [ws, sub] of pvsSubscribers) deliverTurnToSub(ws, sub, entry); }
  // ---- Plan 0493 Phase E — echo & hallucination hygiene (§10) ----
  // E1 (TTS loopback): S212 — Argus's own presenter_speak output was picked up by the mic and
  // re-transcribed as three verbatim "Bruce" turns. ⚠ 2026-08-25 (Plan 0685): the browser echo
  // canceller is no longer in the capture graph at all — it forced an in-call audio route on Android
  // — so the FIRST line of defence is now capture-side ducking during playback (duckWhilePlaying,
  // lib/voice-capture.mjs), and this delivery-layer dedupe is the LAST. It was always necessary:
  // echo cancellation was proven insufficient on its own. A voice turn that closely matches a
  // recent spoken payload (within a short window) is flagged echo:true and NOT delivered as a Bruce turn.
  const ECHO_WINDOW_MS = 12000;                 // a loopback is re-heard within a few seconds of speaking
  const recentSpeak = [];                       // { norm, ts } — bounded ring of recently-spoken payloads
  const normText = (t) => String(t == null ? '' : t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  function recordSpeak(text) {
    const norm = normText(text); if (!norm) return;
    recentSpeak.push({ norm, ts: Date.now() });
    while (recentSpeak.length > 20) recentSpeak.shift();
  }
  function wordJaccard(a, b) {
    const A = new Set(a.split(' ')), B = new Set(b.split(' '));
    if (!A.size || !B.size) return 0;
    let inter = 0; for (const w of A) if (B.has(w)) inter++;
    return inter / (A.size + B.size - inter);
  }
  function isEcho(text) {
    const norm = normText(text); if (!norm) return false;
    const now = Date.now();
    for (let i = recentSpeak.length - 1; i >= 0; i--) {
      const r = recentSpeak[i];
      if (now - r.ts > ECHO_WINDOW_MS) continue;
      if (r.norm === norm) return true;                                              // verbatim loopback
      if (r.norm.length >= 8 && (r.norm.includes(norm) || norm.includes(r.norm))) return true;  // partial
      if (wordJaccard(r.norm, norm) >= 0.8) return true;                             // near-duplicate
    }
    return false;
  }
  // E2 (near-silence hallucinations): whisper emits confident boilerplate on near-silence. The server
  // FLAGS a match as advisory (suspectHallucination) — it is still delivered; the AGENT decides. The
  // canonical set is documented in the PVS skill (Auditor half); this is a small, bounded seed.
  const HALLUCINATION_BOILERPLATE = [
    'thank you', 'thanks for watching', 'thank you for watching',
    'subs by www zeoranger co uk', 'subtitles by', 'please subscribe',
  ];
  function isBoilerplate(text) { const n = normText(text); return !!n && HALLUCINATION_BOILERPLATE.some((b) => n === b || n.includes(b)); }
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
  // Plan 0529 P1 — SANITIZE ON THE WAY IN. Everything else in the working set is fenced at SERVE time,
  // but the summarizer FOLDS what it is given into an opaque rolling headline: once a live sentinel is
  // inside `summary.text` there is no per-speaker boundary left to fence it at. A turn that scrolls out
  // of the 20-turn window would otherwise re-enter the agent's context RAW through the summarizer, so
  // the text and the display name are neutralized here, at the one door into that state.
  function stageSettledTurn(t) {
    const text = sanitizeUntrusted(t.items.map((i) => i.text || '').join(' ').trim());
    if (!text) return;                         // an empty turn carries no continuity — skip
    const last = t.items[t.items.length - 1];
    const userName = (last && last.userName) != null ? sanitizeUntrusted(last.userName) : null;
    const userId = t.userId != null ? sanitizeUntrusted(t.userId) : t.userId;
    settledTurnRing.push({ turnId: t.turnId, userId, userName, text });
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
  // The budget (ms) for a speaker's role/TRUST: an injected uniform override wins; else the profile's
  // per-role value; else — CRUCIALLY for a GUEST — the per-TRUST value; else the participant default; else
  // the module default. The TRUST fallback (Plan 0473 P12) is what makes the guest's TIGHT budget engage:
  // the server hard-forces a guest's role to 'participant', so a budget keyed only by role would miss the
  // guest's tight leash and silently hand it the generous default. The guest profile deliberately authors
  // its tight ms under byRole.GUEST (a trust key) and NO byRole.participant, so the role lookup cleanly
  // misses and the trust fallback engages — DATA, never a profile-NAME fork (every existing role lookup is
  // unchanged: role resolves first, so wearable/rpg/teaching behaviour is untouched).
  function perTurnBudgetFor(role, trust) {
    const ptb = api.profile().perTurnBudget || {};
    if (typeof ptb.overrideMs === 'number' && ptb.overrideMs >= 0) return ptb.overrideMs;
    const byRole = ptb.byRole || {};
    if (typeof byRole[role] === 'number') return byRole[role];
    if (typeof trust === 'string' && typeof byRole[trust] === 'number') return byRole[trust];   // P12: guest tight budget routes by trust
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
  function notifySpeaker(userId, msg) { for (const ws of socketsFor(userId)) send(ws, msg); }   // A4: every device they hold
  // Arm the budget timers for a FRESHLY-OPENED turn. Measured from turn-open and NOT reset when the turn
  // is extended (it bounds total turn duration — the whole point for a non-stop speaker). Cleared in
  // closeTurn. budgetMs <= 0 ⇒ no proactive budget (the hard backstop still applies).
  function armTurnBudget(t, role, trust) {
    const budgetMs = perTurnBudgetFor(role || 'participant', trust);
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
    // A4: finalize an active voice segment on whichever of this speaker's sockets holds one.
    for (const ws of socketsFor(userId)) {
      const c = conns.get(ws);
      if (c && c.voice && c.voice.active) { try { voiceSegFinalize(c, ws, {}); } catch (e) {} }
    }
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
      armTurnBudget(openTurn, entry.role, entry.trust);   // Plan 0473 P5/P12: budget clock keyed by role + TRUST (guest = tight)
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
  // ⛔⛔ Plan 0684 R2 — THIS DEFAULT IS THE DEFECT, and it is left in place ON PURPOSE. It resolves
  // INSIDE the release tree; the deploy pipeline keeps ten releases and prunes the rest, so
  // recording here works visibly and is then deleted by a later prune. Phase 0b is INERT and may
  // not change what is recorded or where, so the refusal lives one layer up: a ROOM that declares
  // `record` other than "none" and names no `transcriptDir` (and has no $PRESENTER_TRANSCRIPT_DIR)
  // is refused at startup — see assertRecordingIsDurable in lib/deployment-config.mjs. ⇒ When the
  // phase that wires rooms to recording arrives, THIS LINE is what it replaces.
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
  // ---- Plan 0473 P13: BARGE-IN + OWN-TURNS (ONE coherent conversation object) ----
  // Cross-plan (0469 outbound TTS + 0470 client). The OUTBOUND TTS reply leg (Plan 0469) is NOT built in
  // this branch, so P13 provides the barge-in MECHANISM + a fenced client seam, NOT real TTS audio.
  //
  // OWN-TURNS. When the AI/controller emits an outbound reply (emitOwnTurn, below) it lands in the SAME
  // unified inbox as any other turn — attributed role:'ai' (⇒ trust:'self' via deriveTrust), flagged
  // own:true. So presenter_situation / presenter_inbox surface ONE coherent conversation that INCLUDES
  // the agent's OWN contributions, not just inbound user turns. Being trust:'self' it is NOT fenced (the
  // agent is the trusted instruction side), and being own:true it is NOT re-queued as a judgment item
  // for the agent (deriveWorkFromTurn skips own-turns) — the agent does not judge its own reply.
  //
  // SPEAKING-STATE. `speaking` is true while the agent's TTS reply is (notionally) playing. It is set by
  // emitOwnTurn (the agent began speaking) and can be set/cleared explicitly via api.setSpeaking — the
  // seam Plan 0469 drives from real TTS start/stop.
  let speaking = false;
  function setSpeaking(on) { speaking = on === true; log.info('barge', 'speaking', { speaking }); return speaking; }
  // BARGE-IN. A user speaking WHILE the agent is speaking is an interruption: signal the speaker(s) to
  // DUCK/STOP the TTS (the actual audio duck is the Plan-0469 client seam — here we just emit the cue),
  // CLEAR speaking-state, and let the interrupting speech be recorded as an inbound turn independently
  // (the emitInbox path already stored it — nothing is lost). Broadcast to clients + emit a server event.
  function bargeIn(by) {
    const signal = { t: 'barge_in', by: by || null, ts: Date.now() };
    speaking = false;                                   // the TTS is being interrupted — stop "speaking"
    for (const ws of conns.keys()) send(ws, signal);    // client seam: DUCK/STOP cue to the speaker(s)
    emit('barge_in', signal);
    log.info('barge', 'barge-in', { by: by && by.userId });
    return signal;
  }
  // Interrupt ONLY when the agent IS speaking and the incoming speech is NOT the agent's own reply (an
  // own-turn never barges in on its own TTS). Idempotent per speaking-episode: bargeIn clears speaking,
  // so a second inbound item cannot re-fire until the agent speaks again.
  function maybeBargeIn(by, isOwn) {
    if (!speaking || isOwn === true) return null;
    return bargeIn(by);
  }

  // Plan 0472: land ONE item into the unified inbox. The item is a FLAT, EXTENSIBLE object. Plan 0473
  // P2 now populates the reserved `turnId` + `turnComplete` fields via assignTurn (below); future
  // increments may add more (annotations{...}, identity{...}, dropped) WITHOUT overloading these.
  // `final` means "segment-final ASR result" (this recognition pass is complete) — it does NOT mean the
  // speaker's turn is over. `turnComplete` (set when the turn settles) is the DISTINCT turn-end signal.
  // Plan 0473 P13: `own` marks the AGENT's OWN outbound reply (role:'ai', trust:'self') so it joins the
  // conversation object but never barges in on itself and is never queued as a judgment item.
  // ---- Plan 0687 R4 (G6/G10) — EVICTION IS COUNTED, AND DURABILITY COMES FIRST ----------------
  // The ring holds TRANSCRIPT_RING entries. An entry aging out is normal; an entry aging out while
  // a delivery consumer has not acked it is a POTENTIAL LOST TURN, so it is spilled to disk first
  // and only then forgotten. Nothing is ever dropped silently: every eviction is counted, every
  // unacked one is logged, and one with nowhere durable to go is counted SEPARATELY and warned.
  let evictedCount = 0;              // entries aged out of the ring, in total
  let evictedUnackedCount = 0;       // ... of those, ones a delivery consumer had not acked
  let spilledCount = 0;              // ... of those, ones written to the durable spill
  let unrecoverableDiscards = 0;     // ... of those, ones with NOWHERE durable to go (the real loss)
  function evictOldestInboxEntry() {
    const gone = inbox.shift();
    if (!gone) return;
    evictedCount++;
    const floorAck = cursors.minAcked();                  // null ⇒ no delivery consumer exists at all
    const unacked = floorAck !== null && gone.seq > floorAck;
    if (!unacked) {
      // Counted always; logged as a roll-up so a 500-turn flood does not write 500 lines.
      if (evictedCount % 100 === 0) log.info('cursor', 'evicted', { evictedCount, evictedUnackedCount, spilledCount, unrecoverableDiscards });
      return;
    }
    evictedUnackedCount++;
    if (cursorStore.spill(gone)) { spilledCount++; log.info('cursor', 'spilled-unacked', { seq: gone.seq, spilledCount }); return; }
    unrecoverableDiscards++;
    log.warn('cursor', 'discarded-unacked', { seq: gone.seq, unrecoverableDiscards, durable: cursorStore.configured });
  }
  // Everything after `fromSeq`, reading THROUGH the eviction boundary when a durable spill exists
  // (R4). Without a spill the ring is all there is, and the gap surfaces as the loud `missed`
  // marker in buildSituation — a visible hole, never a quiet truncation.
  function entriesAfter(fromSeq) {
    const ring = inbox.filter((i) => i.seq > fromSeq);
    const oldestRing = inbox.length ? inbox[0].seq : Infinity;
    if (!cursorStore.configured || fromSeq + 1 >= oldestRing) return { entries: ring, recovered: 0 };
    const recovered = cursorStore.readSpill(fromSeq).entries.filter((e) => e.seq < oldestRing);
    return { entries: [...recovered, ...ring], recovered: recovered.length };
  }
  // Once every delivery consumer has acked past a spilled entry, it is nobody's backlog any more.
  function compactSpill() {
    const floorAck = cursors.minAcked();
    if (floorAck === null || !cursorStore.configured) return;
    cursorStore.compactSpill(floorAck);
  }
  function deliveryStats() {
    return {
      ring: { size: inbox.length, cap: TRANSCRIPT_RING, oldestSeq: inbox.length ? inbox[0].seq : null, liveSeq: inboxSeq },
      evictedCount, evictedUnackedCount, spilledCount, unrecoverableDiscards,
      durable: cursorStore.configured, dir: cursorStore.dir,
      consumers: cursors.deliveryKeys().map((k) => ({ consumer: k, ...cursors.delivery(k) })),
    };
  }

  function emitInbox({ kind, userId, userName, role, text, conf = null, final = true, sessionId, isGuest = false, own = false, voiceId = null, voiceIdConf = null, speakerLabel = null, trust = null }) {
    const entry = {
      seq: ++inboxSeq, kind, userId, userName, role: role || null,
      // Plan 0473 P9 / 0543 P3: the SERVER-AUTHORITATIVE trust level. It is now the connection's
      // trust (c.trust) when the real hello-driven chat/voice path supplies it — because 0543 SPLIT
      // command-authority from the control-page role: a password-holder may hold role:presenter yet
      // be trust:participant (the D fix). When no explicit trust is passed (the agent's own reply,
      // the test-injection seam), fall back to the role-derived base map. Guest still wins first.
      trust: (trust === TRUST.SELF || trust === TRUST.PARTICIPANT || trust === TRUST.GUEST) ? trust : deriveTrust(role, isGuest),
      text, conf: (conf == null ? null : conf), final: final !== false,
      // Biometric voice-ID hooks (Plan 0476 P0; impl DEFERRED). Nullable, decorate-only. voiceId =
      // matched enrolled person (distinct from connection userId); speakerLabel SUPPLEMENTS userName,
      // never overwrites; voiceIdConf may be set even when voiceId is null. NOT strong auth (a stored
      // 16kHz segment is replayable) — never a sole credential. See project-presenter-biometric-voiceid.
      voiceId, voiceIdConf, speakerLabel,
      ts: Date.now(), sessionId: sessionId || SESSION_ID,
    };
    if (own === true) entry.own = true;   // Plan 0473 P13: the agent's OWN outbound reply (never fenced/queued/self-barged)
    // Plan 0493 Phase E — hygiene flags on inbound VOICE turns only (never the agent's own reply).
    // echo:true ⇒ a TTS loopback; it is NOT delivered as a Bruce turn (E1). suspectHallucination is
    // advisory only — still delivered, the agent decides (E2).
    if (kind === 'voice' && own !== true) {
      if (isEcho(text)) entry.echo = true;
      if (isBoilerplate(text) && (entry.conf == null || entry.conf < 0.6)) entry.suspectHallucination = true;
    }
    inbox.push(entry); if (inbox.length > TRANSCRIPT_RING) evictOldestInboxEntry();   // R4: counted, never silent
    assignTurn(entry);   // Plan 0473 P2: attach turnId + turnComplete (may settle the prior turn) BEFORE emit
    persistInboxItem(entry);   // RT-26: no-op unless PRESENTER_TRANSCRIPT_PERSIST is ON (voice AND text)
    // Back-compat: voice items still surface to control roles as {t:'transcript'} (presenter voice host).
    if (kind === 'voice') {
      for (const [ws, c] of conns.entries()) if (c.role === 'presenter' || c.role === 'ai') send(ws, { t: 'transcript', ...entry });
      emit('transcript', entry);
    }
    emit('inbox', entry);
    evaluateFloor();   // Plan 0473 P6: fresh input can push a consumer behind — reassess the floor
    // Plan 0473 P13: BARGE-IN — if a USER just spoke (a NON-own inbound turn) while the agent's TTS reply
    // is playing, interrupt it. The item is ALREADY recorded above (nothing lost); this only fires the
    // duck/stop cue + clears speaking-state. own-turns (the agent's own reply) never barge in on themselves.
    maybeBargeIn({ userId, userName, role: role || null, seq: entry.seq }, entry.own === true);
    // Wake every pending long-poll waiter (each resolves with what arrived and removes itself).
    for (const w of [...inboxWaiters]) w.wake();
    // Plan 0493 Phase D — push the turn to any ws subscriber at ASR latency (no poll wait).
    fanOutToSubscribers(entry);
    log.info('voice', 'inbox', { kind, userId, seq: entry.seq, len: (text || '').length });
    return entry;
  }
  // Back-compat shim: voice-path callers still call emitTranscript(); it is kind:'voice' into the inbox.
  function emitTranscript({ userId, userName, role, text, conf, isGuest = false, trust = null }) {
    return emitInbox({ kind: 'voice', userId, userName, role, text, conf, final: true, isGuest, trust });
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
    // Plan 0473 P13: BARGE-IN at the SOURCE — a user OPENING a voice segment while the agent's TTS reply
    // is playing is an interruption. Fire the duck/stop cue + clear speaking now (before the utterance is
    // even transcribed); the segment proceeds to capture, so the interrupting speech is still recorded.
    maybeBargeIn({ userId: c.userId, userName: c.userName, role: c.role, seq: null }, false);
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
    if (v.bytes === 0) log.info('voice', 'S6 srv-binary-first', { socketId: c.id, seq: v.seq, bytes: buf.length });   // S206 tracer: first PCM frame of a segment reached the server
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
    log.info('voice', 'S8 wav-written', { socketId: c.id, seq, bytes: pcm.length });   // S206 tracer
    log.info('voice', 'S9 asr-call', { socketId: c.id, seq });                          // S206 tracer
    const result = await ensureAsr().recognize(wavPath, seq);
    try { unlinkSync(wavPath); } catch (e) {}
    log.info('voice', 'S10 asr-result', { socketId: c.id, seq, text: String((result && result.text) || '').slice(0, 60) });   // S206 tracer
    if (!result || !result.text) { log.info('voice', 'no-text', { socketId: c.id, seq }); return; }
    emitTranscript({ userId: c.userId, userName: c.userName, role: c.role, text: result.text, conf: result.conf, isGuest: !!c.isGuest, trust: c.trust });
    // Plan 0476 P4: echo the speaker's OWN recognized words back to THEIR client only (rendered as a
    // single line above the input field). Participants never see peers' voice, but seeing your own words
    // is your own data. voiceId hooks ride along (null until biometric ID lands).
    send(ws, { t: 'echo', text: result.text, conf: result.conf, voiceId: null, voiceIdConf: null, speakerLabel: null });
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
  // ⛔ Plan 0687 R1 (G9) — TWO RECORDS, TWO MEANINGS. `cursors` replaces the old single
  // `situationCursors: Map<key, number>`, which carried a digest READ position and a PVS DELIVERY
  // position in one number — so one /api/situation read zeroed the PVS backlog for that key. Read
  // positions and delivery records now live in separate maps chosen by NAMESPACE, and a delivery
  // record is the PAIR {sent, acked}: `sent` is a transport fact this layer may advance, `acked` is
  // an AGENT fact only a consumer-originated ack may move (G5). See lib/delivery-cursors.mjs.
  // ⛔ Plan 0687 R3 (G10/RT-6) — durability is independent of RECORDING. The store is a small
  // per-room file; a room with record:"none" still recovers its ack positions. Not configured ⇒
  // inert, and said so at startup (below) — a stated default, never a silent skip.
  const cursorStore = createCursorStore({ dir: cursorDir || process.env.PRESENTER_CURSOR_DIR || null, log });
  let cursorSaveScheduled = false;
  const saveCursors = () => { if (cursorStore.configured) cursorStore.save({ cursors: cursors.toJSON(), inboxSeq }); };
  // Durable changes (an ack, a baseline, a drop) are coalesced onto the next tick so a burst of
  // acks is one write; `close()` flushes synchronously so nothing is owed at exit.
  const onDurableChange = () => {
    if (!cursorStore.configured || cursorSaveScheduled) return;
    cursorSaveScheduled = true;
    const t = setTimeout(() => { cursorSaveScheduled = false; saveCursors(); }, 0);
    t.unref?.();
  };
  const __restored = cursorStore.load();
  const cursors = __restored.book
    ? CursorBook.fromJSON(__restored.book, { onDurableChange })
    : new CursorBook({ onDurableChange });
  // Resume the seq counter above the persisted high-water: the ring is in-memory and would restart
  // at 1, which would make every persisted ack position swallow new turns instead of naming old ones.
  if (__restored.inboxSeq > inboxSeq) inboxSeq = __restored.inboxSeq;
  if (cursorStore.configured) {
    log.info('cursor', 'durable', { dir: cursorStore.dir, restored: __restored.present, resumedSeq: inboxSeq, consumers: cursors.deliveryKeys().length });
  } else {
    log.info('cursor', 'ephemeral', { reason: 'no cursorDir configured — delivery cursors do NOT survive a restart' });
  }
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
  // Plan 0529 P1 — the rolling summary, served as DELIMITED DATA. `speakers[].userName` is the one
  // participant-authored string the summarizer keeps structurally (the rest is folded into `text`), so
  // it is neutralized here before the whole snapshot is annotated at PARTICIPANT trust. The annotation
  // is additive: turnsSummarized / sheddedFolded / speakers / text keep their shapes, and `text` gains
  // the guarantee it never had — it cannot carry a live closing marker.
  function fencedSummary() {
    const v = summarizer.view();
    const speakers = (v.speakers || []).map((sp) => sanitizeFields(sp, ['userName']));
    return annotateTrust({ ...v, speakers }, TRUST.PARTICIPANT);
  }
  // Assemble the BOUNDED working set for `consumerId`, advancing that consumer's server-held cursor.
  function buildSituation(consumerId, recentN = RECENT_TURNS_N) {
    // ⛔ Plan 0687 R1 (G9) — namespace decides the SEMANTICS. A digest read jumps to the head; a
    // delivery consumer is fed entry by entry from its own record. They no longer share a number.
    const isDelivery = isDeliveryKey(consumerId);
    const last = isDelivery ? cursors.delivery(consumerId).sent : cursors.readPosition(consumerId);
    // R4: a delivery consumer reads PAST the ring's eviction boundary when a durable spill exists.
    const since = isDelivery ? entriesAfter(last).entries
      : inbox.filter((i) => i.seq > last);   // bounded: the ring is capped at TRANSCRIPT_RING
    // Plan 0493 R3 — a lost turn must be LOUD. If the oldest undelivered item's seq skips past last+1,
    // the items last+1..firstSeq-1 aged out of the ring before THIS consumer ever saw them (or the
    // consumer was armed past them). Surface a visible "⚠ N turns missed" marker — never a silent gap.
    let missed = 0;
    if (since.length && since[0].seq > last + 1) missed = since[0].seq - last - 1;
    // ⛔ G5/R2: SERVING IS NOT ACKING. A delivery consumer's `sent` moves; its `acked` does not,
    // so an unacked turn replays on the next attach instead of vanishing with the response.
    if (isDelivery) cursors.markSent(consumerId, inboxSeq);
    else cursors.setReadPosition(consumerId, inboxSeq);
    evaluateFloor();   // Plan 0473 P6: this read caught the consumer up (backlog reduced) — reassess the floor
    const att = api.attendance({ viewerRole: 'ai' });
    const openPolls = [...polls.entries()].filter(([, p]) => p.open)
      .map(([id, p]) => ({ promptId: id, prompt: p.spec && p.spec.prompt, open: true, ...tally(id) }));
    // Plan 0473 P9: DELIMIT-AS-DATA at serve time — participant/guest turns are fenced (untrusted
    // content the agent must treat as data, never as commands); self/controller turns pass through.
    // Plan 0493 E1 — echo loopbacks are never surfaced as turns (poll path); the ws path skips them too.
    const recentTurns = coalesceTurns(inbox.filter((i) => i.echo !== true), recentN).map((t) => annotateTrust(t, t.trust));
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
      // Plan 0493 §6 — the comms MODE is carried on every delivered envelope so each poll tells the
      // agent how to answer (advisory to the agent; the server never enforces it).
      mode: commsMode,
      newSinceLastRead: {
        count: since.length,
        // Plan 0493 E1 — an echo loopback advances the cursor (so it never re-delivers) but is NOT
        // surfaced as a Bruce turn: filter it out of the delivered set.
        turns: coalesceTurns(since.filter((i) => i.echo !== true), recentN).map((t) => annotateTrust(t, t.trust)),
        // Plan 0493 R3 — the gap marker travels WITH the delivery. missed>0 ⇒ N turns were lost.
        missed,
        ...(missed > 0 ? { missedMarker: '⚠ ' + missed + ' turns missed' } : {}),
      },
      // Plan 0473 P7: the ROLLING SUMMARY — continuity for context OLDER than the recent-N turns.
      // A PRECOMPUTED, BOUNDED snapshot (this is a pure read of the incrementally-maintained state via
      // the F-10 seam — it NEVER blocks/computes on read), so a long session is not amnesiac past N.
      // Plan 0529 P1: served FENCED, like recentTurns above. A summary is a FLATTENED MIXTURE of many
      // speakers' words with the per-speaker trust boundary already dissolved — untrusted BY
      // CONSTRUCTION — so it carries the label even though stageSettledTurn already neutralized it.
      summary: fencedSummary(),
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
    // Plan 0473 P13: the AGENT's OWN outbound reply is NOT a judgment item for the agent — it joins the
    // conversation (recent turns / summary) but never enters the work queue. (own-turns share one speaker,
    // so `last.own` reflects the whole turn.)
    if (last && last.own) return null;
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
      // Plan 0529 P1: `askers` are participant identities and `variants` are VERBATIM participant
      // utterances — a second copy of exactly the content the fence exists for, on a nested field
      // that annotateTrust below only reaches at the top level. Neutralized here.
      v.askers = (it.askers || []).slice(0, 50).map((a) => sanitizeFields(a, ['userId', 'userName']));
      if (it.variants) v.variants = it.variants.slice(0, 50).map((x) => (typeof x === 'string' ? sanitizeUntrusted(x) : x));
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
  // ⛔ G9: the FLOOR asks "how far behind is what we have handed over?" — a TRANSPORT question, so
  // it reads `sent`. It deliberately does NOT read `acked`: an agent that never acks is a
  // durability problem, not a reason to throttle the people speaking in the room. The unacked
  // distance is a separate aggregate (cursors.maxUnackedBacklog), used for redelivery, not floor.
  function consumerBacklog() { return cursors.maxTransportBacklog(inboxSeq); }
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

    /* ── THE API SURFACE (Plan 0661 phase 3) ─────────────────────────────────────────────────
   * The 89 members now live in app/api-surface.mjs. What remains here is the BINDING: an object
   * whose every property is a getter onto this closure, so the surface always reads live state.
   * ⛔ Getters, not values. Fifteen of these names are reassigned while the server runs; handing the
   *   surface a snapshot would make it read stale state silently. Uniform getters make that
   *   impossible rather than merely unlikely. */
  const __apiBindings = {
      get ACKS_MAX() { return ACKS_MAX; },
      get ACTIVE_PROFILE() { return ACTIVE_PROFILE; },
      get API_ACTOR() { return API_ACTOR; },
      get AUTH_POLICY() { return AUTH_POLICY; },
      get CAP_SECRET() { return CAP_SECRET; },
      get PRIORITY_DEFERRED() { return PRIORITY_DEFERRED; },
      get PVS_MODES() { return PVS_MODES; },
      get QUEUE_TEXT_MAX() { return QUEUE_TEXT_MAX; },
      get RECENT_TURNS_N() { return RECENT_TURNS_N; },
      get ROLES() { return ROLES; },
      get SESSION_ID() { return SESSION_ID; },
      get STALE_MS() { return STALE_MS; },
      get acks() { return acks; },
      get asr() { return asr; }, set asr(v) { asr = v; },
      get beatDescriptor() { return beatDescriptor; },
      get bgAdapter() { return bgAdapter; },
      get buildSituation() { return buildSituation; },
      get commsMode() { return commsMode; }, set commsMode(v) { commsMode = v; },
      get computeAuthCtx() { return computeAuthCtx; },
      get conns() { return conns; },
      get contentModule() { return contentModule; }, set contentModule(v) { contentModule = v; },
      get currentBeat() { return currentBeat; }, set currentBeat(v) { currentBeat = v; },
      get displayByRole() { return displayByRole; },
      get displayByUser() { return displayByUser; },
      get displayIdFor() { return displayIdFor; },
      get effectiveFloor() { return effectiveFloor; },
      get emitInbox() { return emitInbox; },
      get enforceQueueBounds() { return enforceQueueBounds; },
      get ensureAsr() { return ensureAsr; },
      get ephTimer() { return ephTimer; },
      get evaluateFloor() { return evaluateFloor; },
      get expireStale() { return expireStale; },
      get extraServers() { return extraServers; },
      get floorGated() { return floorGated; },
      get floorKnobs() { return floorKnobs; },
      get floorState() { return floorState; },
      get heartbeat() { return heartbeat; },
      get hotTimers() { return hotTimers; },
      get httpServer() { return httpServer; },
      get inbox() { return inbox; },
      get inboxSeq() { return inboxSeq; },
      get inboxWaiters() { return inboxWaiters; },
      get isControllerActor() { return isControllerActor; },
      get itemView() { return itemView; },
      get lastResults() { return lastResults; },
      get listeners() { return listeners; },
      get mutedParticipants() { return mutedParticipants; },
      get normalizeTargets() { return normalizeTargets; },
      get oidcAdapter() { return oidcAdapter; },
      get openTurn() { return openTurn; },
      get perTurnBudgetFor() { return perTurnBudgetFor; },
      get persistRevokedNonces() { return persistRevokedNonces; },
      get pluginTools() { return pluginTools; },
      get polls() { return polls; },
      get presence() { return presence; },
      get projectStation() { return projectStation; },
      get pruneTerminal() { return pruneTerminal; },
      get publishBeat() { return publishBeat; },
      get pushPresence() { return pushPresence; },
      get pvs() { return pvs; }, set pvs(v) { pvs = v; },
      get pvsConsumerKey() { return pvsConsumerKey; },
      get pvsSubscribers() { return pvsSubscribers; },
      get queueView() { return queueView; },
      get recordSpeak() { return recordSpeak; },
      get renderDisplay() { return renderDisplay; },
      get renderStationTo() { return renderStationTo; },
      get resolveBeatRef() { return resolveBeatRef; },
      get resolveSurface() { return resolveSurface; },
      get revokedNonces() { return revokedNonces; },
      get safeId() { return safeId; },
      get seatResolver() { return seatResolver; },
      get send() { return send; },
      get sendComponentTo() { return sendComponentTo; },
      get sendPageTo() { return sendPageTo; },   // Plan 0689 R5
      get serverApply() { return serverApply; },
      get sessionLog() { return sessionLog; },
      get setDisplay() { return setDisplay; },
      get setModerationFloor() { return setModerationFloor; },
      get setSpeaking() { return setSpeaking; },
      get sheddedCount() { return sheddedCount; },
      get cursors() { return cursors; },
      get cursorStore() { return cursorStore; },
      get compactSpill() { return compactSpill; },
      get deliveryStats() { return deliveryStats; },
      get entriesAfter() { return entriesAfter; },
      get saveCursors() { return saveCursors; },
      get socketsFor() { return socketsFor; },
      get speaking() { return speaking; },
      get spotlight() { return spotlight; },
      get spotlightLast() { return spotlightLast; },
      get stagedByCaller() { return stagedByCaller; },
      get stationRegistry() { return stationRegistry; },
      get stationsActive() { return stationsActive; },
      get store() { return store; },
      get surfaceRegistry() { return surfaceRegistry; },
      get tally() { return tally; },
      get targets() { return targets; },
      get telem() { return telem; },
      get telemetryView() { return telemetryView; },
      get tsWhois() { return tsWhois; },
      get viewerForTarget() { return viewerForTarget; },
      get voiceSessions() { return voiceSessions; },
      get watcher() { return watcher; },
      get workItemsMap() { return workItemsMap; },
      get wss() { return wss; },
  };
  const api = createApiSurface(__apiBindings);

  // Plan 0514 §4.2: plugin server modules are loaded BEFORE the api is handed out, so a caller
  // that gets a server back gets one whose plugins have already registered.
  /* ── POPULATE THE WIRE ACTION TABLE (Plan 0661 phase 1c) ──────────────────────────────────
   * Built HERE, at the end of createServer, because most of the context below is declared after the
   * websocket handler is wired — a factory call any earlier would hit a temporal dead zone. Nothing
   * can arrive before this runs: createServer completes synchronously, and the first frame is an I/O
   * callback. The Map object itself was created at the top and is only FILLED here, so the dispatch
   * that closes over it needs no indirection.
   * ⛔ The three getters are not decoration — see the live-read note in wire-actions.mjs. */
  for (const [t, fn] of createWireActions({
    CAP_SECRET,
    CONTROL_ROLES,
    EVER_SEEN_MAX,
    LAST_RESULTS_MAX,
    MAX_VALUE_BYTES,
    TRANSCRIPT_PERSIST,
    acks,
    api,
    bindUser,
    computeAuthCtx,
    conns,
    deliverTurnToSub,
    deriveConnTrust,
    displayByUser,
    doRoll,
    emit,
    emitInbox,
    evaluateFloor,
    everSeen,
    everSeenOrder,
    handleControl,
    handleOp,
    inbox,
    lastResults,
    lastResultsOrder,
    log,
    parseRollCommand,
    peekTo,
    presence,
    pushPresence,
    pushResult,
    pvsConsumerKey,
    pvsSubscribers,
    redisplayFor,
    renderDisplay,
    renderStationTo,
    resolveIdentity,
    resyncOrSnapshot,
    revokedNonces,
    rosterVisibleToAttendees,
    seatStation,
    send,
    sendComponentTo,
    shimAnswer,
    cursors,
    spotlight,
    spotlightLast,
    stationPlaceholder,
    stationRegistry,
    stationsActive,
    surfaceRegistry,
    surfacesActive,
    targets,
    telem,
    unbindUser,
    unpeekTo,
    updateChatListeners,
    verifyCapability,
    voiceAllowedFor,
    voiceSegFinalize,
    voiceSegStart,
    entriesAfter,
    compactSpill,
    get seatResolver() { return seatResolver; },
    get commsMode() { return commsMode; },
    get inboxSeq() { return inboxSeq; },
  })) wireActions.set(t, fn);

  return new Promise((resolve) => {
    httpServer.listen(port, '127.0.0.1', async () => {
      await loadPluginServerModules();
      // Plan 0650 — extra binds AFTER the primary one, so a bad address can never stop the
      // deployment coming up on loopback. Failures are logged, not thrown.
      await bindExtraHosts(httpServer.address().port);
      resolve(api);
    });
  });
}

// Runnable standalone: `node app/server.mjs [port]`
if (import.meta.url === `file://${process.argv[1]}`) {
  // Plan 0522 P16.1 (R1): the default port is DEPLOYMENT CONFIG, not a code constant — the same
  // declared value the MCP surface uses, so `npm start` and presenter_start cannot land on
  // different ports and disagree about which one the public ingress forwards to. No config file
  // anywhere ⇒ 3000. An explicit argv port still wins. See lib/deployment-config.mjs.
  const p = process.argv[2] ? parseInt(process.argv[2], 10) : presenterPort();
  // Real deployments are GATED out of the box: default the presenter password to
  // `password` (override via PRESENTER_ROLE_PASSWORD). This applies ONLY to the CLI
  // self-run — createServer() from tests stays ungated unless a credential is passed.
  // Plan 0471 H1: default to a REAL control token (random when unset) so the module
  // write-back never ships open — printed in the banner for the creator/writeback client.
  const cliToken = process.env.PRESENTER_CONTROL_TOKEN || 'password';   // TISSUE-THIN gate (deliberate, pre-OAuth): the visible literal password to enter the Control page
  // Plan 0522 P16.2 (R3): a REAL session logs to disk by default — that is the whole point, and
  // it is why the resolution happens HERE rather than inside createServer(). The library default
  // stays off so 475 tests never write into a human's ~/.local/state; the deployment default is
  // ${XDG_STATE_HOME:-~/.local/state}/argus-presenter/logs. Never fatal: a refused or unwritable
  // directory disables the log and the presenter still starts.
  const logTarget = resolveSessionLogDir();
  if (logTarget.sessionLogDirError) console.log('  session log:', 'DISABLED —', logTarget.sessionLogDirError);
  // Plan 0543 P1 — the auth policy is deployment config, read the same way the port is, so the CLI
  // self-run and presenter_start agree on it. A bad value throws here at startup, not silently.
  const policy = authPolicy();
  /*
   * Plan 0551 P2 — IDENTITY, from the SAME deployment file, through the SAME router the MCP tool
   * uses (C4). A divergence between these two launch paths is how 0543's class of bug is born, so
   * there is exactly one function that turns config into options: identityServerOptions().
   * A present-but-incomplete oidc block throws HERE, at startup, by name — never an inert boot.
   * The spread is LAST so a config-stated revokedNonceFile overrides the derived default below.
   */
  const identity = identityConfig();
  console.log(' ', identityStartupLine(identity));
  /*
   * Plan 0675 T3 (guard G12) — SAY WHICH ROOM THIS PROCESS SERVES, AND WHERE EVERY VALUE CAME FROM.
   * An invisible resolution is the trap: on 2026-08-25 a correctly-configured presenter had no
   * microphone and nothing anywhere stated what had actually been resolved.
   *
   * ⚠ PHASE 0 IS INERT. This line REPORTS; it changes nothing. No capability below is passed to
   * createServer, which is why the line says so out loud rather than letting a reader assume the
   * plugin set it names is the plugin set that loaded.
   *
   * ⛔ A malformed rooms block, or a PRESENTER_ROOM naming a room nobody declared, throws HERE —
   * at startup, by name — exactly as a half-stated oidc block does. Booting on a policy nobody
   * chose is the failure being prevented.
   */
  console.log(' ', roomStartupLine(roomConfig()));
  /*
   * Plan 0675 T5 — SIGHUP re-reads the deployment config and logs which top-level KEYS changed.
   * ⛔ A bad file KEEPS the previous configuration and the process stays up: a typo in an unrelated
   * section must not take down whatever this room was in the middle of. ⛔ Key names, never values.
   * ⚠ Installing this handler means SIGHUP no longer terminates the process — the one
   * externally-visible behaviour phase 0 changes, and it is installed HERE only, never by
   * createServer() and never by a test.
   */
  installConfigReloader();
  createServer({
    port: p,
    controlToken: cliToken,
    // No rolePassword — the ONLY gate is the literal control token 'password' (see cliToken above).
    sessionLogDir: logTarget.sessionLogDir,
    enforceOAuth: policy.enforceOAuth,
    allowPasswordCommandOnLAN: policy.allowPasswordCommandOnLAN,
    // Plan 0650 — extra listen addresses (e.g. the tailnet interface), so a tailnet peer can reach
    // the server and be identified by `tailscale whois`. Absent ⇒ loopback only, unchanged.
    bindHosts: bindHostsConfig(),
    // Plan 0543 P4 — a durable store for revoked guest-link nonces (in the state/log dir) so a
    // revocation survives a restart. State, not content: it holds only nonces.
    revokedNonceFile: join(logTarget.sessionLogDir || defaultSessionLogDir(), 'revoked-caps.json'),
    // Plan 0693 T1 — the durable OIDC session store, in the SAME declared state dir, for the same
    // reason and by the same rule: state, never the checkout, and never a caller-chosen path.
    // ⛔ A CREDENTIAL AT REST (0696 F9): mode 0600, sha256(sid) only, excluded from every backup.
    sessionStoreFile: join(logTarget.sessionLogDir || defaultSessionLogDir(), 'oidc-sessions.json'),
    ...identityServerOptions(identity),
  }).then((s) => {
    const u = s.url();   // base like http://127.0.0.1:PORT (no trailing slash)
    const slog = s.sessionLog.status();
    console.log('Argus Presenter running:');
    console.log('  display :', u + '/');
    console.log('  control :', u + '/control');
    console.log('  creator :', u + '/creator');
    console.log('  control token (x-control-token / ?token=):', cliToken);
    console.log('  session log:', slog.enabled ? `${slog.sessionLogDir}/${slog.sessionLogId}.p0.jsonl  (read: ${u}/api/session-log?token=…)` : `DISABLED — ${slog.sessionLogDirError}`);
  });
}
