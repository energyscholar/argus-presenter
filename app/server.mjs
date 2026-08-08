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
import { presenterPort, authPolicy, normalizeAuthPolicy, identityConfig, identityServerOptions, identityStartupLine } from '../lib/deployment-config.mjs';
import { makeAllowlist, makeOidcAdapter, makeTailscaleAdapter, defaultOidcDeps } from './identity.mjs';
import { createSessionLog, resolveSessionLogDir, defaultSessionLogDir } from '../lib/session-log.mjs';
import { selectProfile, DEFAULT_PROFILE } from './profiles.mjs';
import { createHeuristicSummarizer } from './summarizer.mjs';
import { buildDigest } from './digests.mjs';
import { deriveTrust, annotate as annotateTrust, sanitizeUntrusted, sanitizeFields, TRUST } from './untrusted.mjs';
import { renderMarkdown } from './markdown.mjs';
// Plan 0530 P2 (seam S-A) — the HTTP route table, lifted out of createServer(). It imports
// NOTHING from this file: everything it used to capture from the closure is handed to it
// explicitly at the call site below. A back-import would be a cycle, and a cycle would mean the
// seam was cut in the wrong place.
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

export function createServer({ port = 0, controlToken = null, rolePassword = null, roleSeed = null, voiceEnabled = undefined, capSecret = null, profile = DEFAULT_PROFILE, settlingMs = null, queueMaxPending = null, queueTtlMs = null, perTurnBudgetMs = null, perTurnWrapMs = null, floorThresholds = null, sessionLogDir = null, enforceOAuth = undefined, allowPasswordCommandOnLAN = undefined, allowlist = null, oidc = null, oidcDeps = null, oidcSessionTtlMs = null, tailscale = null, tailscaleResolve = null, breakGlass = null, revokedNonceFile = null } = {}) {
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
  const oidcAdapter = makeOidcAdapter(oidc, { ...(oidcDeps || defaultOidcDeps()), ...(oidcSessionTtlMs != null ? { sessionTtlMs: oidcSessionTtlMs } : {}) });
  const tsAdapter = makeTailscaleAdapter(tailscale, { resolve: tailscaleResolve });
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
    breakGlass: breakGlassConfigured,
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
    const verified = oidcAdapter.principalForRequest(req) || tsAdapter.principalForRequest(req) || null;
    return { verified, sessionExpired: !verified && expiredBefore };
  }
  /** Plan 0543 P3 — the Control-page role from IDENTITY: ONLY a verified + ALLOWLISTED principal. Loopback grants nothing. */
  function identityGrantsControl(authCtx) {
    if (!authCtx || !authCtx.verified) return false;
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
      const al = AUTH_ALLOWLIST.lookup(authCtx.verified.email || authCtx.verified.sub);
      if (al.allowed) return { trust: TRUST.SELF };                                                   // 2. verified (OIDC|Tailscale) AND allowlisted ⇒ SELF
      return { trust: TRUST.PARTICIPANT, reason: 'signed in, not authorized' };                       // 3. verified but NOT allowlisted ⇒ fenced (E / the C dead-end)
    }
    if (authCtx.sessionExpired) return { trust: TRUST.PARTICIPANT, reason: 're-authentication required', reauth: true };  // A-fix: prompt re-auth, never a silent fence
    return { trust: TRUST.PARTICIPANT };   // 4. everything else — incl loopback, incl password-only (Control-page role, never self) ⇒ fenced
  }
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
  // Every name below is a binding the handler used to capture from this closure, passed explicitly
  // because a function lifted out of a closure keeps none of it.
  const httpServer = http.createServer(createHttpHandler({
    __dirname, ARCHIVE_DIR, BRANDING, catalogueReadAuthed, CONTROL, CONTROL_TOKEN,
    htmlHeaders, httpControlAuthed, LIB, listModules, listModulesAdmin, listSeries,
    MODULE_STATUSES, moduleAdminOp, moduleCache, MODULES_DIR, moduleSummary, moduleWriteAuthed,
    pvsConsumerKey, readModuleFile, readSeriesFile, renderPresenterPage, ROLE_HASH, ROLE_SEED,
    sendStatic, sessionLog, sessionLogReadAuthed, VOICE_ENABLED,
    oidcAuth: oidcAdapter,   // Plan 0543 P2 — the OIDC login/callback/logout routes read this
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
    // Plan 0471 C1: a socket-level 'error' (frame > MAX_PAYLOAD → ws RangeError 1009, invalid
    // UTF-8, bad RSV bits, ECONNRESET) must NOT hit Node's default handler and kill the process.
    ws.on('error', (e) => {
      telem.frameErrors++;   // Plan 0482 B3: a socket/frame fault is a HEALTH signal, not just a log line
      try { log.warn('ws', 'socket-error', { socketId: (conns.get(ws) || {}).id, err: String(e && e.message || e) }); } catch {}
      try { ws.close(1011); } catch {}
    });
    ws.on('message', (buf, isBinary) => {
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
        return;
      }
      if (m.t === 'pvs_subscribe') {
        // Become a SUBSCRIBER: leave the participant set (no roster/floor/backpressure weight, cannot
        // send ops). Share the namespaced delivery cursor (R2); replay the unread backlog from it (R1),
        // then stream live. If no PVS baseline exists yet, baseline at the live seq (don't flood).
        const key = pvsConsumerKey(m.consumer || 'argusmon');
        const cc = conns.get(ws); if (cc && cc.userId) unbindUser(cc.userId, ws);
        conns.delete(ws); updateChatListeners(); emit('presence', presence()); evaluateFloor();
        if (!situationCursors.has(key)) situationCursors.set(key, inboxSeq);
        const from = situationCursors.get(key);
        pvsSubscribers.set(ws, { consumer: key });
        send(ws, { t: 'pvs_subscribed', consumer: key, resumeCursor: from, mode: commsMode });
        for (const it of inbox.filter((i) => i.seq > from)) deliverTurnToSub(ws, pvsSubscribers.get(ws), it);   // replay
        log.info('pvs', 'subscribe', { consumer: key, resumeFrom: from });
        return;
      }
      try {
      const c = conns.get(ws);
      if (c) c.lastSeen = Date.now();   // liveness (X4)
      if (m.t === 'hello') {
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
        // Plan 0482 A2: role + userId are decided in EXACTLY ONE function (resolveIdentity,
        // the identity seam). Guest/control/gm/unknown-role policy all live there; this call
        // site only applies the verdict.
        // Plan 0543 P3 — the AUTH CONTEXT (loopback verdict + any verified principal) is read from the
        // upgrade request `req`, then fed to BOTH decisions: resolveIdentity (the control-page ROLE)
        // and deriveConnTrust (command TRUST). This is where 0543 keeps "role" and "authority" separate.
        const authCtx = computeAuthCtx(req);
        const ident = resolveIdentity(m, capGrant, c.id, authCtx);
        c.userId = ident.userId;
        c.userName = ident.userName;
        c.role = ident.role;
        if (ident.isGuest) { c.isGuest = true; c.capScope = ident.capScope; c.capNonce = ident.capNonce; }
        // The SERVER-AUTHORITATIVE command-trust for this connection. Stamped on every turn this
        // connection emits (chat/voice) so the fence delimits it correctly. NEVER from the password.
        const trustVerdict = deriveConnTrust(ident, capGrant, authCtx);
        c.trust = trustVerdict.trust;
        c.trustReason = trustVerdict.reason || null;
        c.reauth = !!trustVerdict.reauth;
        bindUser(c.userId, ws);
        // welcome.role = the EFFECTIVE granted role, so the client learns if it was
        // silently downgraded (wrong/absent password) and can surface feedback.
        // RT-26 consent surface: tell every client whether recognized speech is being written to
        // disk. Default false (ephemeral-only) — saving people's words silently is a consent violation.
        // For a GUEST (capability link), surface guest:true + the granted scope so the client knows
        // exactly what it may do (talk/type) — the same consent/transparency surface as any participant.
        // Plan 0514 §4.2a / §8 — seat this connection at a station. select() is where "every
        // failure path lands on the default station" is implemented: an unresolvable uid comes back as the
        // default, never as an error, and never as a disconnect. Core records nothing.
        let seat = null;
        if (stationsActive()) {
          try { seat = seatResolver.select(c.userId, ident.stationUid != null ? ident.stationUid : stationRegistry.defaultUid); }
          catch (e) { log.warn('station', 'resolver-select-failed', { userId: c.userId, err: String(e && e.message || e) }); }
        }
        // Plan 0514 §8: the registry, this seat's station and its spotlight grant all ride the
        // welcome, so a client rebuilds its selector AND RESTORES ITS OWN STATE ON RECONNECT —
        // the 0508 D1 class of bug, designed out rather than patched.
        send(ws, { t: 'welcome', userId: c.userId, userName: c.userName, socketId: c.id, role: c.role, transcriptPersisting: TRANSCRIPT_PERSIST,
          // Plan 0543 P3 — the client learns its COMMAND-TRUST (distinct from role): whether its words
          // may become an instruction. `authReason` explains a fenced verdict ("signed in, not
          // authorized" — the E/C dead-end fix); `reauth:true` asks a lapsed session to re-authenticate
          // rather than being silently downgraded (the A fix).
          trust: c.trust, ...(c.trustReason ? { authReason: c.trustReason } : {}), ...(c.reauth ? { reauth: true } : {}),
          ...(c.isGuest ? { guest: true, scope: c.capScope } : {}),
          ...(stationsActive() ? {
            stationRegistry: stationRegistry.wire(),
            stationSelectorLabel: stationRegistry.selectorLabel,
            stationUid: seat && seat.uid != null ? seat.uid : stationRegistry.defaultUid,
            spotlightGranted: spotlight.has(c.userId),
          } : {}),
          // Plan 0526 P4 — the surfaces this viewer may call up, so a client can OFFER them
          // without asking. Wire form only: uid + label + flags, never a plugin's file layout and
          // never the author's `surfaceId`. Absent entirely when no plugin declared any, so a
          // deployment that has never heard of surfaces sees no change in its welcome at all.
          ...(surfacesActive() ? { surfaceRegistry: surfaceRegistry.wire() } : {}) });
        // C4/X1: converge the (re)connecting client. If it reports a lastVersion we
        // can still replay from the op-log, send only the MISSED ops (resync);
        // otherwise a full role-filtered snapshot (Memento).
        resyncOrSnapshot(ws, c, m.lastVersion);
        /* Plan 0539 P2.3 — from HERE on, live broadcasts are purely additive: the client's state is
         * caught up to `store.version()`, so anything arriving next is genuinely new.
         *
         * ⛓ WHERE THIS MAY GO, MEASURED RATHER THAN ASSUMED. The binding constraint is that it sit
         * AFTER THE CONNECT-TIME STORE WRITES — today the station-seat write ~20 lines above
         * (`seatResolver.select` → `occupancy.seat`). Break-tested three ways:
         *   · guard removed entirely            → X1 red, `got=[18,19,16,17,18,19]` (the original defect)
         *   · `converged = true` before the SEAT WRITE → X1 red, same signature
         *   · `converged = true` before the RESYNC     → X1 GREEN
         * That third result is the interesting one: it means the resync is NOT the boundary, the seat
         * write is. Nothing writes to the store between `resyncOrSnapshot` and this line, so the two
         * placements are observationally identical today. It is kept here anyway because that empty
         * window is an accident of the current handler, not a guarantee — the moment anything
         * store-writing is added to the handshake, only this position stays correct. ⛔ An earlier
         * "must be after the resync or the fix is undone" claim was written here first and was
         * simply WRONG; the break-test is what says otherwise. */
        c.converged = true;
        redisplayFor(ws, c);   // C6: re-push the currently-displayed content module
        if (everSeen.has(c.userId)) telem.reconnects++; else { everSeen.add(c.userId); everSeenOrder.push(c.userId); if (everSeenOrder.length > EVER_SEEN_MAX) everSeen.delete(everSeenOrder.shift()); }   // Plan 0471 L2: bounded
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
          // Plan 0471 M3: this path bypasses store.validOp, so enforce the 64KB value cap here,
          // and bound lastResults to LAST_RESULTS_MAX distinct promptIds (FIFO evict).
          let vsize = 0; try { vsize = JSON.stringify(r.value === undefined ? null : r.value).length; } catch { vsize = Infinity; }
          if (vsize > MAX_VALUE_BYTES) {
            log.warn('result', 'value-too-large', { promptId: r.promptId, userId: r.userId, bytes: vsize });
          } else {
            if (!lastResults[r.promptId]) {
              lastResults[r.promptId] = {};
              lastResultsOrder.push(r.promptId);
              while (lastResultsOrder.length > LAST_RESULTS_MAX) { const old = lastResultsOrder.shift(); delete lastResults[old]; }
            }
            lastResults[r.promptId][r.userId] = { type: r.type, value: r.value };
            pushResult(r);
          }
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
        // Plan 0471 M2: ONLY an OUTSTANDING chime (created by api.chime requireAck) accepts an
        // ack. An unknown/attacker-chosen ackId is dropped — it no longer creates a map entry,
        // so the `acks` map can't be grown by unauth {t:'ack'} frames.
        const ackId = (m && m.ackId) || 'ready';
        const a = acks.get(ackId);
        if (!a) { log.debug('ack', 'unknown-ackId', { socketId: c.id, ackId }); return; }
        c.eyesOn = Date.now();                              // this connection is confirmed watching (not AFK)
        c.lastActive = Date.now();                          // ATT: eyes-on CONFIRM click = deliberate interaction
        a.by.set(c.userId, { userName: c.userName, at: c.eyesOn });
        log.info('ack', 'eyes-on', { ackId, userId: c.userId });
        pushPresence();                                    // control user-list reflects eyes-on immediately
        // ── ⛓ THE SIX MESSAGES THAT PUT SOMETHING ON A SCREEN (0526 P4's naming seam) ─────────
        // Rule zero says a name means one thing, and this chain now holds six verbs that all end
        // in "somebody sees something". They are NOT synonyms; each answers a different question,
        // and the next person to add a seventh should have to say which of these it is not:
        //
        //   station-select  WRITES the caller's seat (seatResolver.select), then renders it.
        //                   The only one of the six that changes durable state.
        //   station-show    renders the caller's OWN SEAT's station. Source: the seat. No write.
        //   station-default renders the idle branding to the caller. Source: nothing. No write.
        //   station-share   renders the caller's own station TO EVERYONE. Escalation ⇒ granted,
        //                   throttled. The only one of the six that reaches other people.
        //   peek            renders a DECLARED SURFACE to the caller. Source: the registry, which
        //                   no module can touch. No seat, no write, nobody else affected.
        //   unpeek          renders whatever the ROOM is currently showing the caller. Source: the
        //                   live display maps. No write.
        //
        // ⚠ `station-show` IS "peek my own station" and the overlap is real — it is not folded in
        // because the two read DIFFERENT SOURCES (a seat the plugin owns vs a registry core owns)
        // and folding them would put the seat resolver behind the surface verb. Two sources, two
        // verbs, one sentence each: that is the seam, stated rather than left to be rediscovered.
      } else if (m.t === 'station-select') {
        // Plan 0514 §8 — SELF-SCOPED and UNGATED, by the same zero-privilege argument as
        // station-show: it changes only what the caller sees. Core hands the request to the
        // plugin, which validates and RECORDS it, and renders whatever comes back.
        if (!stationsActive()) { send(ws, { t: 'station', ok: false, reason: 'no-stations' }); }
        else {
          let seat = null;
          try { seat = seatResolver.select(c.userId, m.stationUid); }
          catch (e) { log.warn('station', 'resolver-select-failed', { userId: c.userId, err: String(e && e.message || e) }); }
          // Unknown/absent uid ⇒ the plugin answered with the deployment default. Never a throw,
          // never a disconnect — §5's single failure rule, applied on the wire.
          if (!seat) send(ws, { t: 'station', ok: false, reason: 'no-stations' });
          else {
            renderStationTo(ws, c, seat);
            c.lastActive = Date.now();
            send(ws, { t: 'station', ok: true, stationUid: seat.uid });
            log.info('station', 'selected', { userId: c.userId, stationUid: seat.uid });
            pushPresence();
          }
        }
      } else if (m.t === 'station-default') {
        // Plan 0514 §7 — ⟲ Show default. Idle branding for THIS socket only; displayByUser is
        // untouched, so `▣ My station screen` still works afterwards. Deliberately NOT
        // api.showDefault / default branding — those are controller-scoped and clear the stored
        // descriptor for everyone.
        send(ws, { t: 'clear' });
        c.lastActive = Date.now();
        send(ws, { t: 'station', ok: true, defaulted: true });
      } else if (m.t === 'station-show') {
        // Plan 0508 — STATION SCREEN (self-scoped, ungated). Zero privilege: it shows you only
        // what is already yours, so a participant may always call it. Lets a player park on a
        // shared beat, then flick back to their own station without asking the GM.
        // Plan 0514 §13.2 — the SOURCE is now the seat's STATION (machine → registry →
        // descriptor), never displayByUser. That map is the transient per-seat push layer and a
        // module load clears it, which is exactly why every seat's station used to vanish on
        // `present_module` (§13.1). §13.4 records the accepted consequence: this button now means
        // "show my station", which is what it says. With no stations declared it keeps its 0508
        // meaning, so a teaching deployment is untouched.
        if (stationsActive()) {
          const seat = seatStation(c.userId);
          if (seat) { renderStationTo(ws, c, seat); c.lastActive = Date.now(); }
          else send(ws, { t: 'station', ok: false, reason: 'no-station' });
        } else {
          const desc = displayByUser.get(c.userId);
          if (desc) { renderDisplay(ws, c, desc); c.lastActive = Date.now(); }
          else send(ws, { t: 'station', ok: false, reason: 'no-station' });
        }
      } else if (m.t === 'station-share') {
        // Plan 0508 — SPOTLIGHT. Promote the caller's OWN station display to everyone. This IS an
        // escalation (a participant changing what the room sees), so it is default-DENY and must be
        // granted per-user by a controller (api.spotlight). Throttled: one share per 3 s per user.
        // Plan 0514 §6.2: the grant model, the throttle and the targets are UNCHANGED — only the
        // SOURCE moved, from displayByUser to the seat's station. Two lines, inside an existing
        // handler; not a new sharing subsystem.
        const seatForShare = stationsActive() ? seatStation(c.userId) : null;
        const desc = seatForShare
          ? ((seatForShare.descriptor) || stationPlaceholder(seatForShare.uid, c))
          : displayByUser.get(c.userId);
        if (!spotlight.has(c.userId)) { send(ws, { t: 'station', ok: false, reason: 'not-granted' }); log.warn('station', 'share-denied', { userId: c.userId }); }
        else if (!desc) send(ws, { t: 'station', ok: false, reason: 'no-station' });
        else if (Date.now() - (spotlightLast.get(c.userId) || 0) < 3000) send(ws, { t: 'station', ok: false, reason: 'too-fast' });
        else {
          spotlightLast.set(c.userId, Date.now());
          c.lastActive = Date.now();
          // Target: 'all', a ROLE, or a single userId — one-by-one is deliberate, so a player can
          // walk one crewmate through a readout without taking over every screen.
          const tgt = (typeof m.target === 'string' && m.target) ? m.target : 'all';
          // SHARE IS TRANSIENT PROJECTION — it deliberately does NOT go through pushComponent.
          // pushComponent calls setDisplay, and setDisplay('all') does displayByUser.clear(): a
          // single share would wipe EVERY seat's station, the sharer's included, and "▣ My station
          // screen" would answer "nothing has been sent to your seat" for the rest of the session.
          // (Caught by t0508 T7.) So we render straight to the sockets and touch no descriptor:
          // stations stay durable, the projection lasts until the next push. Each viewer is still
          // rendered in THEIR own context, so identity stamping and the OPSEC strip still apply —
          // never a verbatim copy of the sharer's HTML.
          let n = 0;
          if (desc.kind === 'component') for (const t of targets(tgt)) { sendComponentTo(t, conns.get(t), desc); n++; }
          log.info('station', 'shared', { userId: c.userId, target: tgt, to: n, component: desc.component });
          send(ws, { t: 'station', ok: true, shared: n });
          emit('presence', presence());
        }
      } else if (m.t === 'peek') {
        // Plan 0526 P4 — SELF-SERVICE NAVIGATION. A participant calls up a declared surface on
        // their own screen. Self-scoped and ungated by the same zero-privilege argument as
        // station-show; DEFAULT-DENY on the surface row is what decides whether they may.
        // ⛓ THE WIRE TAKES A UID: {t:'peek', surfaceUid:<int>} (canon §3 — the author's
        // `surfaceId` never reaches this line). A refusal always names its reason.
        const peeked = peekTo(ws, c, m.surfaceUid);
        if (peeked.ok) send(ws, { t: 'surface', ok: true, surfaceUid: peeked.surfaceUid, surfaceLabel: peeked.surfaceLabel, hasScreen: peeked.hasScreen });
        else send(ws, { t: 'surface', ok: false, reason: peeked.reason, surfaceUid: peeked.surfaceUid == null ? null : peeked.surfaceUid, ...(peeked.surfaceLabel ? { surfaceLabel: peeked.surfaceLabel } : {}) });
      } else if (m.t === 'unpeek') {
        // Plan 0526 P4 — BACK TO THE ROOM. Renders the room's CURRENT display to this socket, so
        // a beat that moved during the peek is the beat the viewer rejoins (see unpeekTo).
        // Stateless: always safe to send, even when the caller was not peeking.
        const back = unpeekTo(ws, c);
        send(ws, { t: 'surface', ok: true, surfaceUid: null, unpeeked: true, restored: back.restored });
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
      } else if (m.t === 'voicedbg') {
        // Plan 0476 P1: client voice stage-tracer (S1..S10 + level meter). Logs to the voice-debug ring
        // (visible via presenter_debug) — NEVER the inbox/transcript, so the transcript + echo line stay
        // clean. Untrusted client content is confined to a bounded log field.
        if (m && typeof m.tag === 'string') log.info('voicedbg', m.tag.slice(0, 48), { socketId: c && c.id, ...(m.data && typeof m.data === 'object' ? m.data : {}) });
      } else if (m.t === 'roll') {
        // Plan 0537 P3.2 — the wire form: {t:'roll', spec, target?, label?, total?}. `total` is the
        // MANUAL entry (physical dice, typed in) and is the only number a client may contribute —
        // it is recorded as `entry:'manual'` so the log can always tell a roll from a claim.
        if (c && c.isGuest && !(c.capScope || []).includes('type')) { log.warn('cap', 'roll-out-of-scope', { socketId: c.id }); return; }
        if (c) {
          // Plan 0539 P1.7 — labelled modifiers are CONTROLLER-ONLY on the wire. A participant may
          // still ask for `+2` through the spec (it is part of the request, like the target), but it
          // may not attach a REASON to a number: a skill name appearing in the room's log as though
          // the session had established it is an assertion, and 0537's rule is that the client asks
          // and the server answers. The skill-aware caller this field exists for is a plugin/agent,
          // which holds a control role. A participant's `modifiers` are dropped, not refused —
          // the roll itself is perfectly valid without them.
          const supplied = CONTROL_ROLES.has(c.role) ? m.modifiers : null;
          const res = doRoll(c, { spec: m.spec, target: m.target, label: m.label, manualTotal: m.total, modifiers: supplied });
          if (!res.ok) send(ws, { t: 'roll_refused', reason: res.reason, text: 'expected {spec:"<count>d<sides>[+mod]", target?, label?, total?}' });
        }
      } else if (m.t === 'chat') {
        // Plan 0472: typed text is FIRST-CLASS input. Land it in the unified inbox attributed to the
        // SERVER-AUTHORITATIVE connection identity (never the client payload). D5 = DUAL-WRITE: also
        // drive the chat STORE slice so the existing read-perm'd chat display (P3) keeps working.
        // Plan 0472 P4: a GUEST may type ONLY if its capability scope includes 'type' (the scope is
        // token-signed, so it cannot be widened by the client). Non-guests are unaffected.
        if (c && c.isGuest && !(c.capScope || []).includes('type')) { log.warn('cap', 'type-out-of-scope', { socketId: c.id }); return; }
        if (c && typeof m.text === 'string' && m.text.length) {
          c.lastActive = Date.now();   // ATT: typing = deliberate human interaction
          const id = (typeof m.id === 'string' && m.id) ? m.id : (c.userId + '-' + Date.now());
          // Plan 0537 P2.3 — `/gm <text>` is a PRIVATE ASIDE TO THE GM. Parsed HERE, on the server,
          // not in the client: the client cannot be the authority on which of its own messages stay
          // private, and a second client (or a bot on a raw socket) would otherwise miss the rule
          // entirely. The aside is written to the `gm` slice, which is already controller-read-only
          // by default-deny — no second secrecy mechanism, and no way for it to reach `chat`.
          const aside = /^\/gm(?:\s+([\s\S]*))?$/.exec(m.text.trim());
          if (aside) {
            const body = (aside[1] || '').trim();
            // ⛓ The client MUST be told what happened. A message that simply vanishes from the room
            // is the invisible-GO defect wearing a new coat: the sender assumes it landed, and the
            // only evidence either way is its absence. Both branches below answer.
            if (!body) { send(ws, { t: 'chat_private', ok: false, reason: 'empty', text: '' }); return; }
            const asideTs = Date.now();
            emitInbox({ kind: 'text', userId: c.userId, userName: c.userName, role: c.role, text: body, conf: null, final: true, isGuest: !!c.isGuest, private: true, trust: c.trust });
            handleOp(c, { path: 'gm/asides/' + id, verb: 'set', value: { id, text: body, name: c.userName, userId: c.userId, ts: asideTs } },
              { userId: c.userId, role: 'system' });   // sender's id, lifted role — see handleOp
            // Plan 0539 P1.3 — the receipt now carries `id` + `ts`. THE SENDER IS THE ONLY PERSON
            // WHO CANNOT READ THEIR OWN ASIDE: it lives in the controller-only `gm` slice, so a
            // participant's reader has no other source for it. Without an id the sender's log
            // cannot dedupe it against the copy a CONTROLLER does receive over `gm/asides`, and a
            // facilitator would see their own aside twice. Without a ts it cannot be ordered
            // against the room's talk, which is the whole point of showing it at all.
            send(ws, { t: 'chat_private', ok: true, text: body, id, ts: asideTs, name: c.userName });
            return;
          }
          // Plan 0537 P3 — `/roll …` from the chat input. It routes into the SAME doRoll() the
          // `{t:'roll'}` wire message uses, so there is exactly one place a roll is produced. ⛔ It
          // does NOT also land in `chat`: a roll's record is `rolls`, and duplicating it as prose in
          // the room's talk would create a second, parseable representation of the same event.
          const rollCmd = /^\/roll(?:\s+([\s\S]*))?$/.exec(m.text.trim());
          if (rollCmd) {
            const args = parseRollCommand(rollCmd[1]);
            if (!args) { send(ws, { t: 'roll_refused', reason: 'usage', text: '/roll <count>d<sides>[+mod] [target] [= total] [label]' }); return; }
            const res = doRoll(c, args);
            if (!res.ok) send(ws, { t: 'roll_refused', reason: res.reason, text: '/roll <count>d<sides>[+mod] [target] [= total] [label]' });
            return;
          }
          emitInbox({ kind: 'text', userId: c.userId, userName: c.userName, role: c.role, text: m.text, conf: null, final: true, isGuest: !!c.isGuest, trust: c.trust });
          // Plan 0539 P1.1 — `ts` and `userId` are ADDED to the record, and both are load-bearing for
          // the reader. `chat` is a keyed collection, not a list: a client rebuilding the log from a
          // snapshot gets an OBJECT, whose key order is an implementation detail and not a history.
          // Without a server-stamped `ts` there is nothing to sort by, and "newest at the bottom"
          // becomes "whatever order V8 felt like". `userId` is what lets a reader tell YOUR line from
          // a line by someone who typed the same display name.
          handleOp(c, { path: 'chat', verb: 'add', value: { id, text: m.text, name: c.userName, userId: c.userId, ts: Date.now() } });   // display slice (best-effort; perm-gated)
        }
      }
      } catch (e) { try { log.warn('ws', 'dispatch-error', { err: String(e && e.message || e) }); } catch {} }   // Plan 0471 C2: defense-in-depth
    });
    ws.on('close', () => {
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
  function deliverTurnToSub(ws, sub, entry) {
    const key = sub.consumer;
    if (situationCursors.get(key) >= entry.seq) return;   // already delivered through this cursor
    situationCursors.set(key, entry.seq);                 // advance regardless of send (no re-delivery)
    if (!pvsDeliverable(entry)) return;
    if (entry.echo === true) return;                       // Phase E: a TTS-loopback echo is not a Bruce turn
    send(ws, { t: 'turn', mode: commsMode, ...annotateTrust(entry, entry.trust) });
  }
  // Fan a freshly-emitted inbox entry out to every live subscriber (called from emitInbox).
  function fanOutToSubscribers(entry) { for (const [ws, sub] of pvsSubscribers) deliverTurnToSub(ws, sub, entry); }
  // ---- Plan 0493 Phase E — echo & hallucination hygiene (§10) ----
  // E1 (TTS loopback): S212 — Argus's own presenter_speak output was picked up by the mic and
  // re-transcribed as three verbatim "Bruce" turns. echoCancellation in the capture graph is necessary
  // but proven insufficient, so we dedupe at the DELIVERY layer: a voice turn that closely matches a
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
    const last = situationCursors.get(consumerId) || 0;
    const since = inbox.filter((i) => i.seq > last);   // bounded: the ring is capped at TRANSCRIPT_RING
    // Plan 0493 R3 — a lost turn must be LOUD. If the oldest undelivered item's seq skips past last+1,
    // the items last+1..firstSeq-1 aged out of the ring before THIS consumer ever saw them (or the
    // consumer was armed past them). Surface a visible "⚠ N turns missed" marker — never a silent gap.
    let missed = 0;
    if (since.length && since[0].seq > last + 1) missed = since[0].seq - last - 1;
    situationCursors.set(consumerId, inboxSeq);         // advance the cursor to everything now shown
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
    // Plan 0543 P1 — the CURRENT auth policy, surfaced for presenter_status. Read-only; the dial is
    // set once at startup (config edit + restart), never mutated live.
    authPolicy: () => ({ ...AUTH_POLICY }),
    // Plan 0473 P1 — READ the active session profile's knobs (settling/shedding/budget/floor/digest/
    // queue). The engine/tools call this to configure behaviour; they must consume knobs, never the
    // profile NAME (drift guard). P2 is the FIRST real consumer: it reads settlingMs from here.
    profile: () => ACTIVE_PROFILE,
    presence,
    on: (ev, cb) => { if (listeners[ev]) listeners[ev].push(cb); },
    pushContent(target, html, contentId) {
      setDisplay(target, { kind: 'content', html, contentId });
      let n = 0;   // deliveries, not address-book entries — see send()
      for (const ws of targets(target)) { if (send(ws, { t: 'content', contentId: contentId || null, html })) n++; }
      return n;
    },
    // Role-aware push: assemble PER channel, stamping identity + viewerRole, and
    // STRIP gm-only scene items for non-GM viewers (real OPSEC — secret content
    // never leaves the server for a player). This is the per-role-render path.
    // requires = the content module's declared plugin deps (Node-style). The
    // assembler bundles core + exactly that transitive closure; [] ⇒ pure core.
    // `deliveredOut` (optional Set) collects the sockets the frame ACTUALLY reached, so a caller
    // can report delivery without re-running targets() and counting the filter a second time.
    pushComponent(target, component, opts = {}, theme = 'argus', requires = [], deliveredOut = null) {
      const desc = { kind: 'component', component, opts, theme, requires };
      setDisplay(target, desc);                          // C6: remember for (re)connects
      let count = 0;
      for (const ws of targets(target)) {
        if (sendComponentTo(ws, conns.get(ws), desc)) { count++; if (deliveredOut) deliveredOut.add(ws); }
      }
      return count;
    },
    openPoll({ promptId, prompt, options, target = 'participant', resultsTarget = null, resultsMode = 'control' }) {
      // Plan 0471 D1: resultsMode 'control' (default, private — matches OPSEC) | 'all' (public aggregate).
      const mode = resultsMode === 'all' ? 'all' : 'control';
      log.info('poll', 'open', { promptId, options: (options || []).length, resultsMode: mode });
      polls.set(promptId, { spec: { prompt, options }, open: true, resultsMode: mode });
      // Plan 0482 B4 — RUNTIME idempotency. Opening a poll reseeds spec/open, but the votes
      // subtree used to survive, and tally() reads the store. So rehearse → close → open live
      // on one server process and every prompt started PRE-VOTED with the rehearsal's ballots.
      // Opening a poll is a fresh ballot by definition: clear the votes (and any cached
      // aggregate) FIRST, so the seeded results below and every later tally start from zero.
      serverApply({ path: 'polls/' + promptId + '/votes', verb: 'clear' });
      // D1: seed the store so the poll is a first-class state slice.
      serverApply({ path: 'polls/' + promptId + '/spec', verb: 'set', value: { prompt, options } });
      serverApply({ path: 'polls/' + promptId + '/open', verb: 'set', value: true });
      serverApply({ path: 'polls/' + promptId + '/resultsMode', verb: 'set', value: mode });   // controllers act on it (participants: denied, harmless)
      if (mode === 'all') serverApply({ path: 'polls/' + promptId + '/results', verb: 'set', value: { tally: {}, count: 0 } });   // seed readable aggregate
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
    // Plan 0508 — grant/revoke a seat's right to promote its own station display to everyone.
    // Tells that seat immediately so its Config panel can show or hide the Share control.
    spotlight(userId, granted = true) {
      if (granted) spotlight.add(userId); else { spotlight.delete(userId); spotlightLast.delete(userId); }
      // Plan 0522 P14 (I5) — how many live clients were told. A grant to somebody not yet
      // connected is legitimate (it rides their `welcome` when they arrive), so 0 is not an
      // error here; it is a fact the operator is entitled to see rather than infer.
      let notified = 0;
      for (const ws of socketsFor(userId)) { send(ws, { t: 'station', ok: true, granted: !!granted }); notified++; }
      log.info('station', granted ? 'spotlight-granted' : 'spotlight-revoked', { userId, notified });
      pushPresence();
      return { userId, granted: !!granted, notified, holders: [...spotlight] };
    },
    spotlightHolders: () => [...spotlight],
    // ── Plan 0514 §9 — the agent's read of the room and its hand on a seat ────────────────
    /** The declared registry (never a stationCode — canon §3) plus which seat holds what. */
    stations() {
      return {
        stationSelectorLabel: stationRegistry.selectorLabel,
        stationDefaultUid: stationRegistry.defaultUid,
        stations: stationRegistry.wire(),
        seats: presence().map((p) => ({ userId: p.userId, userName: p.userName, stationUid: p.stationUid })),
      };
    },
    // ── Plan 0526 P1 — the DECLARED SURFACES ─────────────────────────────────────────────
    /**
     * Every surface this deployment declared, in wire form. Deployment DATA: it is the same
     * answer before, during and after a `present_module`, because a surface is not part of a
     * module. Empty list ⇒ nobody declared any, and every `surfaceScreen` call refuses.
     */
    surfaces() { return { surfaces: surfaceRegistry.wire() }; },
    /**
     * Address ONE surface BY UID: does it exist, may a viewer be shown it, what does it render as.
     * `{ok:true, descriptor}` or `{ok:false, reason}` — never a silent null. The reasons are
     * `no-surfaces` · `not-a-uid` · `no-such-surface` · `not-peekable`.
     *
     * ⛓ `surfaceUid` is an INTEGER (canon §3), the one the registry assigned at load and the one
     * `surfaces()` reports. Passing the author's `surfaceId` string is refused as `not-a-uid`,
     * loudly, rather than searched for — that refusal IS the reason the uid exists.
     *
     * This is the addressing half. The verb that puts a surface on a viewer's own screen is
     * `{t:'peek'}` on that viewer's socket (0526 P4); it is deliberately not on `api`, because it
     * renders down one connection and an in-process caller does not have one.
     */
    surfaceScreen: (surfaceUid) => resolveSurface(surfaceUid, null),
    /**
     * Seat a player who cannot manage the dropdown. Unresolvable uid ⇒ the default, never an error.
     *
     * ⛔ Plan 0522 P14 — THIS IS THE GATE, AND IT IS THE ONLY ONE.
     *
     * Self-selection (`station-select`, 0514 §8) is ungated by the zero-privilege argument: it
     * changes only what the caller sees. `stationSet` takes an ARBITRARY userId, so it changes
     * what ANOTHER person sees — a different capability wearing the same resolver call.
     * `seatResolver.select()`'s signature does not distinguish its callers (join, self-select and
     * this all reach it with the same two arguments), so the gate cannot live in the resolver;
     * and if it lived in the transport, the control page and the MCP tool would each be gated by
     * a rule the other never runs. It lives here, before select(), where BOTH surfaces meet.
     *
     * `actor` is the requesting connection, or the in-process API principal when core is driven
     * directly. `api` is handed only to the MCP bridge and to plugins — a participant never holds
     * it — so the default is the declared control principal, not an absent check.
     */
    stationSet(userId, stationUid, actor = API_ACTOR) {
      if (!isControllerActor(actor)) {
        log.warn('station', 'set-denied', { userId, role: (actor && actor.role) || null, socketId: (actor && actor.id) || null });
        return { userId, stationUid: null, ok: false, reason: 'not-controller', delivered: 0 };
      }
      if (!stationsActive()) return { userId, stationUid: null, ok: false, reason: 'no-stations', delivered: 0 };
      // I5 — NO SILENT NON-DELIVERY. Before P14 this returned ok:true for a userId nobody
      // occupies: it wrote a resolver record no socket would ever read, and let a caller "prove"
      // a station change that never reached a human. A seat link re-derives identity and re-seats
      // on hello (§5.1), so such a record could not even survive the person actually arriving.
      // Refuse by name, and write nothing.
      const socks = socketsFor(userId);
      if (!socks.length) return { userId, stationUid: null, ok: false, reason: 'not-connected', delivered: 0 };
      const seat = seatResolver.select(userId, stationUid);
      // IDENTITY-scoped, and necessarily so: the resolver keys a seat by userId and has no socket
      // concept, so a CONTESTED identity (P3: two live sockets, one derived id) has ONE seat and
      // both of its clients move together. `delivered` reports how many were actually re-rendered.
      let delivered = 0;
      for (const ws of socks) { const c = conns.get(ws); if (c) { renderStationTo(ws, c, seat); send(ws, { t: 'station', ok: true, stationUid: seat.uid }); delivered++; } }
      log.info('station', 'set', { userId, stationUid: seat.uid, delivered });
      pushPresence();
      return { userId, stationUid: seat.uid, ok: true, delivered };
    },
    /**
     * Plan 0522 P15 (R18) — ▣ PROJECT a station's screen. Exposed by REFERENCE, so the wire's
     * `case 'project_station'` and this method are one implementation, not two that must be kept
     * in step. See projectStation's own header for the I3 argument.
     *
     * ⚠ THREE NAMES, ONE CAPABILITY, AND THE SPLIT IS DELIBERATE (R19) — it is the same one
     * `stationSet` already runs: the WIRE action is verb-first (`project_station`, beside
     * `set_station`), the API method is noun-first (`stationProject`, beside `stationSet`), and
     * the TOOL prefixes that (`presenter_station_project`, beside `presenter_station_set`). The
     * api/tool halves are noun-first so the station family sorts together in an alphabetical tool
     * list instead of scattering across p- and s-.
     *
     * ⛔ WHY THIS IS NOT GATED, WHILE `stationSet` IS. The difference is not that one is riskier
     * in feel; it is that they sit on opposite sides of handleControl's role gate.
     * `case 'set_station'` is handled BEFORE that gate on purpose — so a participant's attempt is
     * refused BY NAME (I5) instead of silently dropped — which means the wire can hand
     * `api.stationSet` a non-controller actor, and the gate has to live inside the method.
     * `case 'project_station'` sits AFTER the gate, so the only callers that reach here are a
     * control connection, the MCP bridge, and a registered plugin: there is no second caller
     * class to defend against, and a gate would be checking a condition already proven.
     *
     * And the capability itself carries the zero-privilege argument that ungates `station-show`
     * and `api.spotlight`'s siblings: it writes NOTHING. No seat moves, no descriptor is stored,
     * no state records that it happened; the next push replaces it. Pushing content to the room
     * is a controller's ordinary business — every other content-push api method (pushComponent,
     * showBeat, chime, clear) is ungated in-process for the same reason. `stationSet` is gated
     * because it DURABLY re-seats another person, and that is an escalation this is not.
     */
    stationProject: projectStation,
    /** Tools a plugin contributed through register() (§4.2). Core holds the list, not the meaning. */
    pluginTools: () => [...pluginTools.values()].map((t) => ({ name: t.name, description: t.description || '', input: t.input || null, plugin: t.plugin })),
    /** Dispatch one plugin tool by name. Unknown name ⇒ a listed error, never a throw into the room. */
    async callPluginTool(name, args = {}) {
      const t = pluginTools.get(name);
      if (!t) return { ok: false, error: `no such plugin tool: ${name}`, available: [...pluginTools.keys()] };
      try { return { ok: true, result: await t.handler(args || {}) }; }
      catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    },
    // Plan 0508 — tell every control page to re-scan MODULES_DIR. Lets Argus drop a new module on
    // disk mid-session and have it appear in the GM's picker without a reload or a restart.
    modulesChanged(id = null) {
      let n = 0;
      for (const [ws, c] of conns.entries())
        if (c.role === 'presenter' || c.role === 'ai') { send(ws, { t: 'module-changed', id }); n++; }
      log.info('module', 'modules-changed', { id, notified: n });
      return n;
    },
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
    // Plan 0473 P13 — BARGE-IN + OWN-TURNS (ONE coherent conversation object). Cross-plan (0469 + 0470).
    // emitOwnTurn({text}): the agent/controller emits an OUTBOUND reply. It joins the SAME unified inbox
    // as any turn — role:'ai' ⇒ trust:'self', flagged own:true — so situation/inbox show ONE conversation
    // that INCLUDES the agent's own contributions. It also (by default) sets speaking-state active (the
    // agent is now speaking its TTS reply); pass speaking:false to add the turn WITHOUT arming barge-in.
    // Returns the emitted (annotated) inbox entry.
    emitOwnTurn: ({ text, userId = 'argus', userName = 'Argus', role = 'ai', speaking: sp = true } = {}) => {
      const entry = emitInbox({ kind: 'reply', userId, userName, role, text, conf: null, final: true, own: true });
      if (sp) setSpeaking(true);
      return annotateTrust(entry, entry.trust);   // serve-shape (own:true + trust:'self', unfenced)
    },
    // setSpeaking(on): the outbound-TTS seam (Plan 0469 drives this from real TTS start/stop). While
    // speaking is true, a NON-own inbound user turn / voice_seg_start triggers a barge-in (duck/stop cue).
    setSpeaking: (on) => setSpeaking(on),
    // isSpeaking(): is the agent's outbound reply currently playing (barge-in armed)? Observability hook.
    isSpeaking: () => speaking,
    // ---- Plan 0493 Phase A/B — PVS lifecycle + comms mode (server-held, session-scoped) ----
    // pvsStart({mode,consumer,session}): OPEN a PVS. Returns resumeCursor (R1) = the delivery cursor
    // this consumer resumes FROM — never "now" on a re-arm (the S212 bug that lost turns 12/13). On a
    // genuine FIRST open the cursor is baselined at the current live seq (do not replay pre-session
    // backlog); a re-arm (the consumer already has a held cursor) PRESERVES it, so the unread gap
    // REPLAYS. Does NOT open a mic (§5) — presenter_voice_enable is a separate, deliberate act.
    pvsStart: ({ mode, consumer = 'argusmon', session = null } = {}) => {
      const key = pvsConsumerKey(consumer);
      const reopening = !!(pvs && pvs.open);
      if (mode != null && PVS_MODES.has(mode)) commsMode = mode;   // an explicit mode wins; else keep the standing mode
      // R1: baseline the delivery cursor ONLY when this consumer has none yet (fresh open). Re-arm keeps it.
      if (!situationCursors.has(key)) situationCursors.set(key, inboxSeq);
      const resumeCursor = situationCursors.get(key);
      pvs = { open: true, consumer: key, openedAt: (pvs && pvs.openedAt) || Date.now(), session: session != null ? session : (pvs && pvs.session) || null };
      log.info('pvs', 'start', { consumer: key, mode: commsMode, resumeCursor, liveCursor: inboxSeq, reopening });
      return { open: true, mode: commsMode, consumer: key, resumeCursor, liveCursor: inboxSeq, sessionId: SESSION_ID, session: pvs.session, reopened: reopening };
    },
    // pvsStop({}): CLOSE the PVS. Idempotent (§5 — stopping a closed PVS succeeds quietly). Drops the
    // delivery cursor so a later PVS re-baselines rather than inheriting an orphan cursor.
    pvsStop: () => {
      const wasOpen = !!(pvs && pvs.open);
      const key = pvs && pvs.consumer;
      if (key) situationCursors.delete(key);
      if (wasOpen) log.info('pvs', 'stop', { consumer: key });
      pvs = null;
      return { stopped: true, wasOpen };
    },
    // pvsState(): the current PVS record for presenter_status. Always reports a mode (the standing
    // default when no PVS is open — §8).
    pvsState: () => (pvs && pvs.open)
      ? { open: true, mode: commsMode, consumer: pvs.consumer, openedAt: pvs.openedAt, session: pvs.session,
          deliveredCursor: situationCursors.get(pvs.consumer) || 0, liveCursor: inboxSeq }
      : { open: false, mode: commsMode },
    // commsMode(set?): Plan 0493 Phase B — GET (no arg) or SET the comms mode (§6). Returns the
    // effective mode. An unknown value is REFUSED (the closed-set / tail-de-index trap) and the mode is
    // left unchanged. Mode is advisory to the agent — the server never blocks a speak/push on it; it
    // only stores it and stamps it on every delivered envelope so the agent knows how to answer.
    commsMode: (set) => {
      if (set != null) {
        if (!PVS_MODES.has(set)) return { ok: false, reason: 'unknown-mode', mode: commsMode, modes: [...PVS_MODES] };
        commsMode = set; log.info('pvs', pvs ? 'mode' : 'mode-no-pvs', { mode: set });
      }
      return { ok: true, mode: commsMode, pvsOpen: !!(pvs && pvs.open) };
    },
    // presentText({text,title,target}): Plan 0493 §8 — the STANDARD text-response surface. Renders
    // markdown SERVER-SIDE into sanitised HTML (app/markdown.mjs — every text segment escaped, so even
    // untrusted text is escaped-not-executed, S11) and pushes it to the `prose` card, replacing the
    // current display (like show_beat). This is what §7 calls "the card": the presenter-mode default is
    // present_text(markdown) + a one-line presenter_speak pointer. Dense is fine — Bruce reads fast — and
    // long content scrolls in the card rather than clipping. Returns the delivery count + a byte size.
    presentText: ({ text = '', title = null, target = 'all' } = {}) => {
      const html = renderMarkdown(text);
      const opts = { html };
      if (title != null) opts.title = String(title);
      const n = api.pushComponent(target, 'prose', opts, 'argus', []);
      log.info('present', 'text', { target, chars: String(text).length, html: html.length });
      return { presented: n, target, chars: String(text).length, htmlBytes: html.length };
    },
    // Test/observability hook: live PVS ws subscriber count (assert no leak + teardown-on-close).
    getPvsSubscriberCount: () => pvsSubscribers.size,
    // Test/observability seam — inject an inbox item through the REAL emit path (turn assignment,
    // trust derivation, waiter wake). Mirrors the WS voice/text ingress without a socket. `_`-prefixed,
    // like the other test hooks; not part of the driving surface.
    _emitInboxForTest: (spec = {}) => { const e = emitInbox(spec); return annotateTrust(e, e.trust); },
    _oidcAdapterForTest: oidcAdapter,   // Plan 0543 P3 — test seam: mint a verified OIDC session to drive the trust path
    _authCtxForTest: (req) => computeAuthCtx(req),   // Plan 0543 P3 — test seam: inspect the loopback/verified verdict for a req
    // Plan 0522 P4 (I3) — the DURABLE DISPLAY STATE, serialised. The only seam through which a
    // test can assert that staging wrote nothing: t07 compares this string (plus every seat's
    // stationUid, read from presence()) before and after a stage. Field-by-field spot checks were
    // rejected — a new descriptor field would slip through them unnoticed.
    _displayStateForTest: () => JSON.stringify({
      byRole: Object.fromEntries(ROLES.map((r) => [r, displayByRole[r] || null])),
      byUser: Object.fromEntries([...displayByUser.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    }),
    // Plan 0473 P4 — WORK-QUEUE operator surface (server-tracked status/owner; the agent holds nothing).
    // workItems(): the current ACTIONABLE queue (pending + claimed), prioritized + bounded (aged pruned).
    workItems: () => queueView(),
    // Plan 0473 P12 — the resolved per-turn budget (ms) a speaker of {role, trust} gets under the active
    // profile. Observability hook proving the guest's TIGHT budget ROUTES BY TRUST (role=participant,
    // trust=guest → the tight leash), tighter than a trusted 'self' speaker — deterministic, no timers.
    turnBudgetFor: ({ role = 'participant', trust } = {}) => perTurnBudgetFor(role, trust),
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
      persistRevokedNonces();   // Plan 0543 P4 — survive a restart (0489's flagged bug)
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
      if (requireAck) {
        const prev = acks.get(ackId); acks.set(ackId, { message, requestedAt: Date.now(), target, by: (prev && prev.by) || new Map() });
        while (acks.size > ACKS_MAX) { const oldest = acks.keys().next().value; if (oldest === ackId) break; acks.delete(oldest); }   // Plan 0471 M2: bound distinct ackIds (FIFO evict)
      }
      return targets(target).map((ws) => send(ws, { t: 'chime', message, requireAck: !!requireAck, ackId, bell: bell !== false })).length;
    },
    // SPEAK (Plan 0491 §10, minimum working slice): on-device speechSynthesis, driven by a
    // transient frame — exactly like chime, NO setDisplay, so it never re-fires on reconnect.
    // Clamp server-side (~300 chars): the spoken channel is a précis, not the record (§2.3).
    speak: (text, target = 'all') => {
      const clamped = String(text || '').slice(0, 300);
      recordSpeak(clamped);   // Plan 0493 E1: remember what we said so its mic loopback can be deduped
      return targets(target).map((ws) => send(ws, { t: 'speak', text: clamped })).length;
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
      // Plan 0529 P1: the roster is an AGENT-FACING payload (situation.roster, presenter_attendance)
      // and its two identity columns are typed by the person in the row. They never went through the
      // fence — a hostile display name emitted a live closing marker straight into the agent's context
      // from a row that carries no `text` at all. Neutralized on EVERY row (a control row's name is
      // typed too), so the redacted participant view below inherits it.
      const full = [...conns.values()].map((c) => {
        const lastSeenAgoSec = Math.floor((now - (c.lastSeen || now)) / 1000);
        const connected = (now - (c.lastSeen || 0)) <= staleMs;   // green when fresh, red when stale
        return {
          userId: safeId(c.userId), userName: safeId(c.userName), role: c.role,
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
    closePoll: (promptId) => { const p = polls.get(promptId); if (p) p.open = false; serverApply({ path: 'polls/' + promptId + '/open', verb: 'set', value: false }); const t = tally(promptId); if (p && p.resultsMode === 'all') serverApply({ path: 'polls/' + promptId + '/results', verb: 'set', value: { tally: t.tally, count: t.count } }); return { promptId, ...t }; },   // Plan 0471 D1: publish final aggregate in public mode
    // Debug snapshot for the ?debug overlay + the presenter_debug MCP tool.
    // state = current authoritative view (proto: polls; the core store extends this
    // in group C); opLog = the structured-log tail (role-redacted for the viewer).
    debugDump: (role = 'presenter') => ({
      presence: presence(),
      connections: [...conns.values()].map((c) => ({ socketId: c.id, userId: safeId(c.userId), role: c.role })),   // 0529 P1: a self-asserted id is participant-authored
      state: { polls: [...polls.entries()].map(([id, p]) => ({ promptId: id, open: p.open, ...tally(id) })), store: store.snapshot({ role, userId: null }).state },
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
    // R4 — UNCHANGED SEMANTICS. show_beat PUBLISHES IMMEDIATELY, on both surfaces. Every existing
    // cue script, the MCP tool, auto-follow and ▶ Start depend on that and must keep depending on
    // it; two-stage delivery is ADDED alongside as stageBeat/sendBeat, never by redefining this.
    showBeat(ref) {
      const r = resolveBeatRef(ref);   // by index OR beat id (branch nav)
      if (!r) return null;
      publishBeat(r.i, null);          // null ⇒ the beat's own declared routing, as always
      return { index: r.i, component: r.beat.component, target: r.beat.target || 'all' };
    },
    /**
     * Plan 0522 P4 (R4) — STAGE a candidate beat. Renders it to the CALLER'S OWN surface only and
     * remembers it for a later sendBeat. Writes NOTHING durable: no displayByRole, no
     * displayByUser, no seat state (I3 — t07 asserts byte-identity across a stage).
     * `ctx` = { key, ws, conn, targets }. Without a socket there is nothing to render to, so the
     * slot is recorded and `rendered:false` is reported rather than pretending.
     *
     * Plan 0522 P5 — `ctx.targets` is the SAME array the send will carry, and it does two things:
     * the candidate is rendered AS that target (so a per-user beat previews as the person who will
     * actually get it, not as the presenter), and the slot remembers it, so a later GO with no
     * targets of its own ships where the preview said it would. One control, not two.
     */
    stageBeat(ref, ctx = {}) {
      const key = ctx.key || 'api';
      if (ref == null) return { ok: false, reason: 'no-beat-ref', staged: false };
      const r = resolveBeatRef(ref);
      if (!r) return { ok: false, reason: 'no-such-beat', staged: false, ref: String(ref) };
      const desc = beatDescriptor(r.beat);
      const list = normalizeTargets(ctx.targets);          // ['all'] ⇒ null ⇒ the beat's own routing
      const as = (list && list.length === 1) ? list[0] : null;   // the UI is single-select; the protocol is not
      // Plan 0522 P6 (t16) — a slot holds ONE candidate, so staging a second beat destroys the
      // first. That destruction is invisible from the outside unless the ack says so, and an
      // unsent beat the operator thinks is still armed is I5's silent non-delivery with an extra
      // step. The PREVIOUS occupant is reported whenever it was a DIFFERENT beat; re-staging the
      // same beat loses nothing and reports nothing.
      const prev = stagedByCaller.get(key) || null;
      const replaced = (prev && !(prev.index === r.i && prev.beatId === (r.beat.id != null ? r.beat.id : null)))
        ? { beatId: prev.beatId, index: prev.index, targets: prev.targets || ['all'] } : null;
      stagedByCaller.set(key, { desc, beatId: r.beat.id != null ? r.beat.id : null, index: r.i, at: Date.now(), targets: list });
      let rendered = false;
      if (ctx.ws && ctx.conn) { renderDisplay(ctx.ws, ctx.conn, desc, viewerForTarget(as)); rendered = true; }
      log.info('beat', 'stage', { key, index: r.i, beatId: r.beat.id != null ? r.beat.id : null, rendered, targets: list || ['all'], replaced });
      return { ok: true, staged: true, index: r.i, beatId: r.beat.id != null ? r.beat.id : null, component: r.beat.component, rendered,
        targets: list || ['all'], as: as || 'all', replaced };
    },
    /**
     * Plan 0522 P4 (R4) — SEND (publish) the caller's staged beat. `targets` is an ARRAY from the
     * first commit (P5's wire format); a bare string is accepted and wrapped. Omitted ⇒ the beat's
     * own declared routing, i.e. identical to show_beat.
     * I5: the result carries how many recipients it ACTUALLY reached, so "sent to 0" can never be
     * silent. An explicit `id`/`index` overrides the staged slot (a caller may publish directly).
     */
    sendBeat({ targets: tgt = null, id = null, index = null } = {}, ctx = {}) {
      const key = ctx.key || 'api';
      const staged = stagedByCaller.get(key) || null;
      const ref = (id != null) ? id
        : (index != null) ? index
          : staged ? (staged.beatId != null ? staged.beatId : staged.index) : null;
      if (ref == null) return { ok: false, reason: 'nothing-staged', sent: false, recipients: 0, sockets: 0 };
      const r = resolveBeatRef(ref);
      if (!r) return { ok: false, reason: 'no-such-beat', sent: false, recipients: 0, sockets: 0, ref: String(ref) };
      // P5: targets SUPPLIED with the send win; otherwise inherit the ones the preview was rendered
      // for. `tgt != null` — not `normalizeTargets(tgt)` — because ['all'] normalises to null and
      // means "do not narrow", which must OVERRIDE a staged station, not silently fall back to it.
      const list = (tgt != null) ? normalizeTargets(tgt) : (staged ? staged.targets || null : null);
      const res = publishBeat(r.i, list);
      stagedByCaller.delete(key);   // it shipped; the slot is no longer armed
      log.info('beat', 'send', { key, index: r.i, targets: res.targets, recipients: res.recipients, sockets: res.sockets });
      return { ok: true, sent: true, index: r.i, beatId: r.beat.id != null ? r.beat.id : null, component: r.beat.component,
        targets: res.targets, recipients: res.recipients, sockets: res.sockets };
    },
    /** The caller's currently staged beat, or null. Observability for the P6 indicator + tests. */
    stagedBeat(ctx = {}) {
      const s = stagedByCaller.get(ctx.key || 'api');
      return s ? { beatId: s.beatId, index: s.index, at: s.at, targets: s.targets || ['all'] } : null;
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
      // Plan 0482 B3 — health must react to the signals that mean THE SURFACE IS DEAD, and must
      // NOT react to the signal that means the permission model is doing its job.
      //   FAULTS (degrade): renderErrors + opApplyFailures — the client cannot draw or apply;
      //   throttled — we are dropping the user's input; frameErrors — frames arriving as garbage;
      //   malformed — ops arriving unusable. Every one of these means someone's session is broken.
      //   DENIALS (never degrade): a denied op is default-deny WORKING. Five benign denials used to
      //   drive errorRate to 1.0 and report 'degraded' — crying wolf, while a wholly dead frame
      //   pipeline still read green because none of the fault counters were consulted at all.
      const faults = {
        renderErrors: telem.renderErrors,
        opApplyFailures: telem.opApplyFailures,
        frameErrors: telem.frameErrors,
        throttled: o.throttled,
        malformed: o.malformed,
      };
      const faultCount = faults.renderErrors + faults.opApplyFailures + faults.frameErrors + faults.throttled + faults.malformed;
      const status = (anyStale || faultCount > 0) ? 'degraded' : 'green';
      /*
       * ── Plan 0525 P2 (I1) — IS THIS SESSION BEING RECORDED? ─────────────────────────────────
       * The CLI banner has answered that since P16.2 ("session log: <dir>/<id>.p0.jsonl" or
       * "DISABLED — <reason>"). The AGENT had no way to ask — and presenter_start, which is the
       * path that raises the public ingress, is the path the real sessions come up on. A recorder
       * nobody can confirm is running is the failure P16.2 exists to fix, with extra steps.
       *
       * It lands HERE, beside `opLogSize`, because that is the IN-MEMORY ring this log backstops:
       * the two numbers are the same measurement, one bounded at 1000 and freed with the process,
       * the other durable. The counters below are of a kind with opsApplied / faults / errorRate,
       * and the failure modes that matter are silent DEGRADATIONS mid-session (a directory that
       * stops being writable, three consecutive write failures disabling the log, lines dropped by
       * a wedged disk) — which need the surface an agent polls, not one it reads once at start.
       *
       * ⛔ STATE, NEVER CONTENT. Directory, provenance, id, counters. The log carries participants'
       * own spoken and typed words, and its read surface is deliberately ONE role-gated endpoint
       * (GET /api/session-log, control credential required, fails closed when none is configured —
       * R6). Adding a second read path for third parties' speech is a decision, and it is not this
       * one's to make. Nothing below can carry an entry: the fields are enumerated, never spread.
       *
       * ⚠ DELIBERATELY NOT FOLDED INTO `status`. A disabled log does not degrade the verdict. The
       * library default IS off — a bare createServer() writes nothing, which is what keeps this
       * suite out of a human's ~/.local/state — so degrading on it would paint every test red and
       * teach a reader to ignore the word. Whether stats.dropped / stats.failures should degrade a
       * DEPLOYED session is a real question and a separate one; it is reported, not scored.
       */
      const slog = sessionLog.status();
      return {
        status, connections,
        opsApplied: o.applied, errorRate,
        faults, faultCount, denied: o.denied,   // denials REPORTED (visible) but never degrading
        stateVersion: store.version(), opLogSize: store.oplogSince(0).length,
        sessionLog: {
          enabled: slog.enabled,
          sessionLogId: slog.sessionLogId,
          sessionLogDir: slog.sessionLogDir,
          sessionLogDirSource: slog.sessionLogDirSource,
          // The REASON, under the SAME name the CLI banner and /api/session-log already use. A
          // gauge that reads "off" without saying why is the dead-gauge shape: a reader cannot
          // tell the deliberate library default from a disk that said no. Non-null while ENABLED
          // too — that is the "config unreadable, fell back to the built-in default" warning, and
          // it is worth surfacing rather than swallowing.
          sessionLogDirError: slog.sessionLogDirError,
          stats: { ...slog.stats },
        },
        rtt: telem.rtt.last, reconnects: telem.reconnects,
      };
    },
    // X5 RAF metrics from the attributed/timestamped op-log.
    raf: ({ windowMs = 5000 } = {}) => {
      const entries = store.oplogSince(0);
      const total = entries.length;
      const CONTROLLERS = new Set(['ai', 'presenter']);
      const peerVisible = entries.filter((e) => e.role === 'participant' && store.perms.canRead({ role: 'participant', userId: null }, e.path)).length;   // Plan 0471 C3
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
    // Plan 0522 P16.2 — the durable session log HANDLE (like `store`, an object, not a getter).
    // status()/read()/sessions() are the observability the phase exists to provide; append() is
    // the same seam createStore drives. Reading it over HTTP is role-gated (/api/session-log).
    sessionLog,
    close: () => new Promise((res) => { try { sessionLog.close(); } catch { /* a log must never block a shutdown either */ } clearInterval(heartbeat); /* Plan 0468 (INV-7) */ if (ephTimer) clearTimeout(ephTimer); for (const t of hotTimers.values()) clearTimeout(t); hotTimers.clear(); for (const w of [...inboxWaiters]) w.wake(); /* Plan 0472: drain pending long-poll waiters (resolve, no dangling) */ if (openTurn && openTurn.timer) { clearTimeout(openTurn.timer); openTurn.timer = null; } /* Plan 0473 P2: clear a pending turn-settling timer */ for (const [, c] of conns) { if (c.voice && c.voice.timer) clearTimeout(c.voice.timer); } if (asr) { try { asr.close(); } catch (e) {} asr = null; } watcher && watcher.close(); wss.clients.forEach((c) => c.close()); httpServer.close(() => res()); }),
    _http: httpServer,
    _acks: acks,                 // Plan 0471 M2: test-only observability (bounded map)
    _lastResults: lastResults,   // Plan 0471 M3: test-only observability (bounded object)
  };

  // Plan 0514 §4.2: plugin server modules are loaded BEFORE the api is handed out, so a caller
  // that gets a server back gets one whose plugins have already registered.
  return new Promise((resolve) => {
    httpServer.listen(port, '127.0.0.1', async () => { await loadPluginServerModules(); resolve(api); });
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
  createServer({
    port: p,
    controlToken: cliToken,
    // No rolePassword — the ONLY gate is the literal control token 'password' (see cliToken above).
    sessionLogDir: logTarget.sessionLogDir,
    enforceOAuth: policy.enforceOAuth,
    allowPasswordCommandOnLAN: policy.allowPasswordCommandOnLAN,
    // Plan 0543 P4 — a durable store for revoked guest-link nonces (in the state/log dir) so a
    // revocation survives a restart. State, not content: it holds only nonces.
    revokedNonceFile: join(logTarget.sessionLogDir || defaultSessionLogDir(), 'revoked-caps.json'),
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
