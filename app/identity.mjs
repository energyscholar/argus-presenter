/*
 * app/identity.mjs — Plan 0543 P2: IDENTITY ADAPTERS (SECURITY-CRITICAL).
 *
 * THE ONE RULE THIS MODULE SERVES. Command-authority over Argus (trust:self — words that may become
 * an instruction) comes ONLY from a VERIFIED PRINCIPAL. A shared password never does. This module
 * answers exactly one question per adapter — "who is this, PROVABLY?" — and returns a principal or
 * null. It does NOT decide trust; resolveIdentity (server.mjs, P3) maps a principal → trust through
 * the fail-closed allowlist. Keeping "who" and "how much authority" separate is the whole design.
 *
 * Three adapters, any one of which yields a verified principal:
 *   - loopback   — a TRUE-local connection (peer is loopback AND no forwarding header). Offline path.
 *   - oidc       — Google sign-in: PKCE + state + nonce + RS256/JWKS verification of the ID token.
 *   - tailscale  — a DIRECT tailnet peer's identity (never over the tunnel, where the peer is cloudflared).
 *
 * NOTHING here is trusted from the client. The loopback verdict is read from the SOCKET, not a claim;
 * the OIDC principal is read from a signature this server verified; the allowlist is server-side data.
 */
import { createHash, createPublicKey, verify as cryptoVerify, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

/* ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE LOOPBACK TRAP (§2.2) — the worst hole if it is wrong.
 *
 * The presenter binds loopback and `cloudflared` proxies EVERY tunnel request from 127.0.0.1. So
 * "the socket peer is loopback" is NOT proof of local: over the tunnel the peer is ALSO 127.0.0.1.
 * A true-local connection is loopback peer AND no forwarding header. Any forwarding header means the
 * request crossed a proxy ⇒ treat as remote. Fail-safe: if unsure, REMOTE.
 * ───────────────────────────────────────────────────────────────────────────────────────────── */
export const FORWARDING_HEADERS = Object.freeze(['x-forwarded-for', 'cf-connecting-ip', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto']);
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** True iff ANY known forwarding header is present and non-empty on the request. */
export function hasForwardingHeader(req) {
  const headers = (req && req.headers) || {};
  for (const h of FORWARDING_HEADERS) {
    const v = headers[h];
    if (v !== undefined && v !== null && String(v).trim() !== '') return true;
  }
  return false;
}

/** True iff the request is a TRUE loopback connection: loopback socket peer AND no forwarding header. */
export function isTrueLoopback(req) {
  if (!req) return false;
  if (hasForwardingHeader(req)) return false;                 // crossed a proxy ⇒ remote (fail-safe)
  const peer = req.socket && req.socket.remoteAddress;
  return typeof peer === 'string' && LOOPBACK_PEERS.has(peer.trim());
}

/*
 * The loopback adapter. ⚠ Bruce's ruling (2026-08-05): LOOPBACK IS NOT A TRUST SIGNAL — any local
 * process or webpage generates loopback traffic; it is not equivalent to file access and grants
 * NOTHING. `isTrueLoopback`/`hasForwardingHeader` remain exported for the tailscale adapter's
 * direct-peer check and for tests, but NO code path turns loopback into `self`. Kept intentionally
 * inert so that "am I local?" can never be mistaken for "am I authorized?".
 */
export function loopbackPrincipal(req) {
  return isTrueLoopback(req) ? { provider: 'loopback', sub: 'loopback', name: 'local', email: null } : null;
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ALLOWLIST (E) — the single most important line in the plan.
 *
 * FAIL-CLOSED: a verified principal that is NOT on the list authenticates but authorizes to
 * 'participant' (fenced). Being signed in is NOT being authorized. An absent/empty list authorizes
 * NOBODY — every verified principal is fenced. The list is gitignored deployment data.
 * ───────────────────────────────────────────────────────────────────────────────────────────── */
export function makeAllowlist(entries) {
  const map = new Map();
  if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
    for (const [k, v] of Object.entries(entries)) {
      const key = String(k).trim().toLowerCase();
      if (!key) continue;
      const role = (v && typeof v === 'object' && typeof v.role === 'string') ? v.role
        : (typeof v === 'string' ? v : null);
      if (role) map.set(key, { role });
    }
  }
  return {
    size: map.size,
    /**
     * Look a principal's key up. Returns { allowed, role }. The DEFAULT — key null, key not present,
     * empty list — is ALWAYS { allowed:false, role:'participant' }. There is no path that returns
     * allowed:true without an explicit list hit. That is the fail-closed invariant (E-guard, T5).
     */
    lookup(key) {
      const k = (key == null) ? '' : String(key).trim().toLowerCase();
      if (k) { const hit = map.get(k); if (hit) return { allowed: true, role: hit.role }; }
      return { allowed: false, role: 'participant' };
    },
  };
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
 * OIDC — Google sign-in. base64url + PKCE + the ID-TOKEN VERIFIER.
 *
 * The verifier is the load-bearing security piece and is PURE (takes the JWKS as input), so it is
 * fully testable offline with a locally-minted RS256 token. Order is deliberate: pin the algorithm,
 * verify the signature over the RAW signing input BEFORE any claim is trusted, THEN check
 * iss/aud/exp/nonce. A `none`/HS token is rejected at the alg pin (RS256 only — no key confusion).
 * ───────────────────────────────────────────────────────────────────────────────────────────── */
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function b64urlJson(s) { return JSON.parse(b64urlToBuf(s).toString('utf8')); }

/** A random URL-safe token (state, nonce, session id). */
export function randomToken(bytes = 32) { return b64url(randomBytes(bytes)); }

/** A PKCE pair: { verifier, challenge } where challenge = base64url(sha256(verifier)), method S256. */
export function pkcePair() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/**
 * Verify a Google (or any OIDC) ID token. `jwks` is an ARRAY of JWK public keys.
 * Returns { ok:true, principal:{provider:'oidc',sub,email,name,emailVerified} } or { ok:false, reason }.
 * `reason` is for server-side logging ONLY — never surface it or any token material to a client.
 */
export function verifyIdToken(jwt, { jwks, iss, aud, nonce, now = Date.now() } = {}) {
  if (typeof jwt !== 'string' || jwt.length === 0 || jwt.length > 8192) return { ok: false, reason: 'malformed' };
  const parts = jwt.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); }
  catch (e) { return { ok: false, reason: 'malformed' }; }
  if (!header || header.alg !== 'RS256') return { ok: false, reason: 'alg' };   // pin RS256: rejects 'none' and HS* key-confusion
  const keys = Array.isArray(jwks) ? jwks : [];
  // Match by kid. Fall back to a lone key ONLY when the token declares NO kid — a token that names a
  // kid must match it, or a rotated/attacker kid would silently be verified against the wrong key.
  const key = keys.find((k) => k && k.kid === header.kid) || (!header.kid && keys.length === 1 ? keys[0] : null);
  if (!key) return { ok: false, reason: 'no-key' };
  let pub;
  try { pub = createPublicKey({ key, format: 'jwk' }); } catch (e) { return { ok: false, reason: 'bad-key' }; }
  const signingInput = Buffer.from(parts[0] + '.' + parts[1]);
  const sig = b64urlToBuf(parts[2]);
  let good = false;
  try { good = cryptoVerify('RSA-SHA256', signingInput, pub, sig); } catch (e) { return { ok: false, reason: 'bad-sig' }; }
  if (!good) return { ok: false, reason: 'bad-sig' };
  // Signature authentic ⇒ claims are trustworthy. Now, and only now, check them.
  if (iss != null) {
    const issOk = Array.isArray(iss) ? iss.includes(payload.iss) : payload.iss === iss;
    if (!issOk) return { ok: false, reason: 'iss' };
  }
  if (aud != null) {
    const audOk = Array.isArray(payload.aud) ? payload.aud.includes(aud) : payload.aud === aud;
    if (!audOk) return { ok: false, reason: 'aud' };
  }
  if (typeof payload.exp !== 'number' || !isFinite(payload.exp) || payload.exp * 1000 <= now) return { ok: false, reason: 'expired' };
  if (nonce != null && payload.nonce !== nonce) return { ok: false, reason: 'nonce' };
  return {
    ok: true,
    principal: {
      provider: 'oidc',
      sub: (payload.sub != null ? String(payload.sub) : null),
      email: (typeof payload.email === 'string' ? payload.email : null),
      name: (typeof payload.name === 'string' ? payload.name : null),
      emailVerified: payload.email_verified === true,
    },
  };
}

/* ── Cookie helpers ─────────────────────────────────────────────────────────────────────────── */
/** Parse a Cookie header into a plain object. Never throws. */
export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
export const SESSION_COOKIE = 'ap_sid';

/**
 * The OIDC adapter — session store + cookie + the login/callback verification LOGIC.
 *
 * DELIBERATELY zero-dependency and network-injectable: `exchangeCode` (the token-endpoint POST) and
 * `fetchJwks` (the JWKS GET) are passed in, so the security logic is testable offline with a local
 * keypair. Absent `config` (no client id / endpoints), the adapter is INACTIVE and every route is a
 * clean 404 — OIDC is opt-in, never a half-configured half-open door.
 *
 * ⚠ INTEGRATION SEAM (untestable offline): the session cookie must be readable at the WS UPGRADE on
 * the tunnel origin — same-origin callback + SameSite=Lax. If that binding is wrong a verified user
 * reads as unverified at the socket (the A-lockout). Verify against the live tunnel before relying on it.
 */
export function makeOidcAdapter(config, { exchangeCode, fetchJwks, now = () => Date.now(), sessionTtlMs = 12 * 3600 * 1000 } = {}) {
  const active = !!(config && config.clientId && config.authEndpoint && config.tokenEndpoint && config.redirectUri);
  const sessions = new Map();   // sid -> { principal, exp }
  const pending = new Map();    // state -> { verifier, nonce, exp }
  const PENDING_TTL = 10 * 60 * 1000;

  function sweep() {
    const t = now();
    for (const [k, v] of sessions) if (v.exp <= t) sessions.delete(k);
    for (const [k, v] of pending) if (v.exp <= t) pending.delete(k);
  }

  return {
    active,
    _sessions: sessions,   // test-only observability
    _pending: pending,

    /** Begin login: mint state+nonce+PKCE, remember them server-side, return the authorization URL. */
    beginLogin() {
      if (!active) return null;
      const state = randomToken();
      const nonce = randomToken();
      const pkce = pkcePair();
      pending.set(state, { verifier: pkce.verifier, nonce, exp: now() + PENDING_TTL });
      const u = new URL(config.authEndpoint);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', config.clientId);
      u.searchParams.set('redirect_uri', config.redirectUri);
      u.searchParams.set('scope', config.scope || 'openid email profile');
      u.searchParams.set('state', state);
      u.searchParams.set('nonce', nonce);
      u.searchParams.set('code_challenge', pkce.challenge);
      u.searchParams.set('code_challenge_method', 'S256');
      return { url: u.toString(), state };
    },

    /**
     * Complete login from the callback query { code, state }. Enforces: state MUST match a pending
     * request (CSRF / missing-state ⇒ reject); exchange the code (PKCE verifier bound to the state);
     * verify the ID token (sig + iss + aud + exp + nonce). On success mint a session id.
     * Returns { ok:true, sid, principal } or { ok:false, reason } — reason is internal.
     */
    async completeLogin(query = {}) {
      if (!active) return { ok: false, reason: 'inactive' };
      sweep();
      const state = query.state;
      if (typeof state !== 'string' || !state) return { ok: false, reason: 'missing-state' };
      const p = pending.get(state);
      if (!p) return { ok: false, reason: 'unknown-state' };
      pending.delete(state);   // single-use
      if (typeof query.code !== 'string' || !query.code) return { ok: false, reason: 'missing-code' };
      let tokenResp;
      try {
        tokenResp = await exchangeCode({
          code: query.code, codeVerifier: p.verifier, redirectUri: config.redirectUri,
          clientId: config.clientId, clientSecret: config.clientSecret, tokenEndpoint: config.tokenEndpoint,
        });
      } catch (e) { return { ok: false, reason: 'exchange-failed' }; }
      if (!tokenResp || typeof tokenResp.id_token !== 'string') return { ok: false, reason: 'no-id-token' };
      let jwks;
      try { jwks = await fetchJwks(config.jwksUri); } catch (e) { return { ok: false, reason: 'jwks-failed' }; }
      const v = verifyIdToken(tokenResp.id_token, {
        jwks, iss: config.issuer, aud: config.clientId, nonce: p.nonce, now: now(),
      });
      if (!v.ok) return { ok: false, reason: 'idtoken-' + v.reason };
      const sid = randomToken();
      sessions.set(sid, { principal: v.principal, exp: now() + sessionTtlMs });
      return { ok: true, sid, principal: v.principal };
    },

    /** The verified principal for a request's session cookie, or null (expired ⇒ null, so P3 can re-auth). */
    principalForRequest(req) {
      if (!active) return null;
      const cookies = parseCookies(req && req.headers && req.headers.cookie);
      const sid = cookies[SESSION_COOKIE];
      if (!sid) return null;
      const s = sessions.get(sid);
      if (!s) return null;
      if (s.exp <= now()) { sessions.delete(sid); return null; }   // expired ⇒ treat as unverified (prompt re-auth, P3)
      return s.principal;
    },

    /** True iff the request carries a session cookie whose session has EXPIRED (for the re-auth prompt, T12). */
    sessionExpired(req) {
      if (!active) return false;
      const cookies = parseCookies(req && req.headers && req.headers.cookie);
      const sid = cookies[SESSION_COOKIE];
      if (!sid) return false;
      const s = sessions.get(sid);
      return !!(s && s.exp <= now());
    },

    logout(req) {
      const cookies = parseCookies(req && req.headers && req.headers.cookie);
      const sid = cookies[SESSION_COOKIE];
      if (sid) sessions.delete(sid);
    },

    /** The Set-Cookie value for a freshly-minted session — HttpOnly + Secure + SameSite=Lax. */
    sessionCookie(sid) {
      return `${SESSION_COOKIE}=${encodeURIComponent(sid)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}`;
    },
    clearCookie() {
      return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
    },
  };
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
 * TAILSCALE — a DIRECT tailnet peer's identity. Offline-capable (tailnet, no Google).
 *
 * ⛔ Only for a DIRECT peer: over the tunnel the peer is cloudflared, so a forwarding header ⇒ NOT a
 * tailnet peer, no identity. The identity itself comes from an injected resolver (a header the
 * tailscale-serve/`tailscale whois` layer sets), never from a client claim.
 * ───────────────────────────────────────────────────────────────────────────────────────────── */
/* ── Default network deps for the OIDC adapter (node:https, zero dep) ────────────────────────────
 * Injected into makeOidcAdapter so the flow LOGIC stays testable offline (tests pass their own).
 * These are the only parts that touch the live IdP; they are never exercised by the test suite.
 */
export function defaultOidcDeps() {
  return {
    async exchangeCode({ code, codeVerifier, redirectUri, clientId, clientSecret, tokenEndpoint }) {
      const body = new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        client_id: clientId, code_verifier: codeVerifier,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      }).toString();
      return httpsJson(tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    },
    async fetchJwks(jwksUri) {
      const doc = await httpsJson(jwksUri, { method: 'GET' });
      return (doc && Array.isArray(doc.keys)) ? doc.keys : [];
    },
  };
}
async function httpsJson(url, { method = 'GET', headers = {}, body = null } = {}) {
  const { request } = await import('node:https');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({ hostname: u.hostname, path: u.pathname + u.search, method, headers, port: u.port || 443 }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; if (data.length > 1024 * 1024) { req.destroy(); reject(new Error('response too large')); } });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

export function makeTailscaleAdapter(config, { resolve } = {}) {
  const active = !!(config && config.enabled);
  return {
    active,
    /** The verified tailnet principal for a DIRECT peer, or null. */
    principalForRequest(req) {
      if (!active || typeof resolve !== 'function') return null;
      if (hasForwardingHeader(req)) return null;   // came via the tunnel ⇒ peer is cloudflared, not a tailnet user
      const user = resolve(req);                   // e.g. read a tailscale identity header / whois lookup
      if (!user || typeof user !== 'string') return null;
      return { provider: 'tailscale', sub: user, email: user, name: user };
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * Plan 0650 §2a — THE TAILSCALE RESOLVER THAT ACTUALLY RESOLVES (SECURITY-CRITICAL).
 *
 * ⛔⛔ WHAT WAS WRONG. `makeTailscaleAdapter` above has always been correct, and has always been
 * INERT: `createServer` defaulted `tailscaleResolve` to null, so the adapter's first line returned
 * null and the tailnet path existed only inside test files. mcp/surface-coverage.mjs said it was
 * "wired to the tailscale layer in production". It was not. Nothing supplied it.
 *
 * ⛔⛔ AND THE TEST'S RESOLVER MUST NEVER SHIP. Every existing test injects
 * `(req) => req.headers['tailscale-user-login']`. That is fine in a test and FATAL in production:
 * a header is a CLIENT CLAIM, so any stranger could type Bruce's address and become Bruce. Line 308
 * of this file already stated the rule — the identity comes from the tailscale layer, "never from a
 * client claim" — and nothing enforced it.
 *
 * ⇒ THE PEER ADDRESS IS THE ONLY INPUT. `req.socket.remoteAddress` is set by the kernel from the
 * TCP connection; a client cannot choose it. Measured against a live tailscaled: a connection made
 * to the node's own tailnet address presents that 100.64/10 address, and `tailscale whois` on it
 * names the person; a loopback connection presents `127.0.0.1`, and whois answers "peer not found".
 * That separation IS the security boundary, and it also honours Bruce's standing ruling (2026-08-05)
 * that loopback is not an auth signal and grants nothing.
 *
 * ⚠ SYNCHRONOUS SEAM, ASYNCHRONOUS TRUTH. `makeTailscaleAdapter` calls `resolve(req)` synchronously
 * inside the `hello` handler, but `tailscale whois` is a subprocess. Blocking the event loop on a
 * shell-out would stall every other participant in the room, so this splits in two:
 *   prime(req)   — async, started at CONNECTION time, fills a short-TTL cache. Never throws.
 *   resolve(req) — sync, reads ONLY that cache. A miss is null (fenced), never a wait.
 * server.mjs holds the connection's first frames until `prime` settles or a hard deadline passes,
 * so a hung `whois` costs a bounded delay and yields NO identity — it can never hang the socket.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/** The tailnet address space: 100.64.0.0/10 (CGNAT) and fd7a:115c:a1e0::/48 (Tailscale ULA). */
export function isTailnetPeerAddress(addr) {
  if (typeof addr !== 'string') return false;
  let a = addr.trim().toLowerCase();
  if (!a) return false;
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  if (a.startsWith('::ffff:')) a = a.slice(7);                 // v4-mapped v6 ⇒ compare as v4
  if (LOOPBACK_PEERS.has(a)) return false;                     // ⛔ loopback is NEVER a tailnet peer
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return false;
    return o[0] === 100 && o[1] >= 64 && o[1] <= 127;          // 100.64.0.0/10
  }
  return a.startsWith('fd7a:115c:a1e0:');
}

/** The SOCKET peer address, or null. ⛔ Reads the socket and nothing else — never a header. */
export function peerAddressOf(req) {
  const a = req && req.socket && req.socket.remoteAddress;
  return (typeof a === 'string' && a.trim()) ? a.trim() : null;
}

/**
 * Parse `tailscale whois --json <ip>` output into a login name, or null.
 * ⚠ A TAGGED NODE IS NOT A PERSON: tagged devices whois as `tagged-devices`, which must never
 * become a principal — otherwise any tagged CI box on the tailnet would hold Bruce's authority.
 */
export function parseWhoisJson(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  let doc;
  try { doc = JSON.parse(stdout); } catch (e) { return null; }
  const u = doc && (doc.UserProfile || doc.userProfile);
  const login = u && (u.LoginName || u.loginName);
  if (typeof login !== 'string' || !login.trim()) return null;
  const v = login.trim().toLowerCase();
  if (v === 'tagged-devices') return null;
  return v;
}

export const TAILSCALE_WHOIS_TIMEOUT_MS = 1200;

/** The default shell-out. ⚠ Absent binary / down daemon / hang ⇒ REJECT, and the caller maps that to null. */
async function defaultWhoisExec(peer, { timeoutMs = TAILSCALE_WHOIS_TIMEOUT_MS } = {}) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(hard); fn(v); };
    const child = execFile('tailscale', ['whois', '--json', peer],
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, windowsHide: true },
      (err, stdout) => (err ? finish(reject, err) : finish(resolve, String(stdout || ''))));
    child.on('error', () => {});   // ENOENT also arrives at the callback; this stops the duplicate throw
    // Belt AND braces: execFile's own timeout kills the child, but if the kill itself wedges we still
    // give up here. ⛔ A hung whois must never hold a connection open.
    const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} finish(reject, new Error('whois-timeout')); }, timeoutMs + 250);
    if (hard.unref) hard.unref();
  });
}

export function makeTailscaleWhois({
  exec = defaultWhoisExec,
  peerAddress = peerAddressOf,
  timeoutMs = TAILSCALE_WHOIS_TIMEOUT_MS,
  cacheTtlMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const cache = new Map();      // peer -> { login: string|null, exp }   (null is a NEGATIVE cache entry)
  const inflight = new Map();   // peer -> Promise

  /** The peer worth asking about, or null. Forwarded ⇒ the peer is the proxy, not the person. */
  function peerFor(req) {
    if (!req) return null;
    if (hasForwardingHeader(req)) return null;
    const a = peerAddress(req);
    return isTailnetPeerAddress(a) ? a : null;
  }

  return {
    /** SYNCHRONOUS. Cache only. ⛔ Never reads a header, never blocks, never throws. */
    resolve(req) {
      const peer = peerFor(req);
      if (!peer) return null;
      const hit = cache.get(peer);
      if (!hit || hit.exp <= now()) { cache.delete(peer); return null; }
      return hit.login;
    },
    /** ASYNC. Fills the cache. Resolves to a login or null; NEVER rejects, so no caller can throw. */
    prime(req) {
      const peer = peerFor(req);
      if (!peer) return Promise.resolve(null);
      const hit = cache.get(peer);
      if (hit && hit.exp > now()) return Promise.resolve(hit.login);
      if (inflight.has(peer)) return inflight.get(peer);
      const p = (async () => {
        let login = null;
        try { login = parseWhoisJson(await exec(peer, { timeoutMs })); }
        catch (e) { login = null; }   // absent / erroring / timed out ⇒ NO identity. Never a grant.
        cache.set(peer, { login, exp: now() + cacheTtlMs });
        inflight.delete(peer);
        return login;
      })();
      inflight.set(peer, p);
      return p;
    },
    _cache: cache,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * Plan 0650 §2b — BREAK-GLASS, ACTUALLY CONSUMED.
 *
 * ⛔ WHAT WAS WRONG. `enforceOAuth:'control'` REFUSES TO START without a break-glass credential,
 * naming the exact shape it wants — "loopback-only, single-use, TTL, 0600 file". The presence was
 * checked at server.mjs:306, reported in the startup line at :325, and CONSUMED BY NOTHING. No
 * route accepted it. The gate demanded a key for a lock that did not exist, so the one deployment
 * mode meant to reduce exposure could only be entered over the PUBLIC tunnel via Google.
 *
 * WHAT IT GRANTS, AND WHAT IT DELIBERATELY DOES NOT. It grants a CONTROL SESSION — the Control
 * page and the presenter/gm roles — and it does NOT grant `trust:self`. Bruce's standing ruling
 * (2026-08-05, recorded at server.mjs:348) is that command authority over Argus comes only from a
 * verified identity (OIDC | Tailscale) that is ALSO on the allowlist. A secret in a file on the box
 * is neither, so break-glass recovers the presentation, not the agent's ear.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */
export const BREAK_GLASS_COOKIE = 'ap_bg';
export const BREAK_GLASS_DEFAULT_TTL_MS = 15 * 60 * 1000;

/** Constant-time string compare over fixed-length digests (so length never leaks through timing). */
function secretEquals(a, b) {
  const da = createHash('sha256').update(String(a)).digest();
  const db = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(da, db);
}

/**
 * Read the credential. `token` is inline (tests, and a deployment that prefers config); `file` is
 * Bruce's live shape (~/.config/argus-presenter/break-glass, mode 0600).
 * ⚠ The FILE'S MTIME is the credential's issue time, so `touch`ing the file re-arms it. That is the
 * intended operator gesture: to use break-glass you go to the box, which is the whole premise.
 */
function defaultBreakGlassRead(config) {
  if (config.token) return { secret: String(config.token).trim(), mode: null, issuedAt: null };
  const st = statSync(config.file);
  return { secret: readFileSync(config.file, 'utf8').trim(), mode: st.mode & 0o777, issuedAt: st.mtimeMs };
}

export function makeBreakGlassAdapter(config, { readCredential = defaultBreakGlassRead, now = () => Date.now(), startedAt = null } = {}) {
  const active = !!(config && typeof config === 'object' && (config.token || config.file));
  // ⛔ loopback-only is the DEFAULT and must be turned off explicitly. Fail-safe, not fail-open.
  const loopbackOnly = !(config && config.loopbackOnly === false);
  const ttlMs = (config && Number.isFinite(config.ttlMs) && config.ttlMs > 0) ? config.ttlMs : BREAK_GLASS_DEFAULT_TTL_MS;
  const born = (startedAt != null) ? startedAt : now();
  const sessions = new Map();
  let spent = false;

  const principal = () => ({ provider: 'break-glass', sub: 'break-glass', email: null, name: 'break-glass', breakGlass: true });

  return {
    active, loopbackOnly, ttlMs,
    get spent() { return spent; },

    /**
     * Present the credential. Returns { ok:true, sid, principal } or { ok:false, reason }.
     * ⛓ ORDER IS LOAD-BEARING: `not-loopback` is decided FIRST, so a remote caller learns nothing
     * except that it is remote — never whether the credential was right, spent, or expired.
     */
    redeem(req, presented) {
      if (!active) return { ok: false, reason: 'inactive' };
      if (loopbackOnly && !isTrueLoopback(req)) return { ok: false, reason: 'not-loopback' };
      if (spent) return { ok: false, reason: 'spent' };
      let cred;
      try { cred = readCredential(config); } catch (e) { return { ok: false, reason: 'unreadable' }; }
      if (!cred || typeof cred.secret !== 'string' || !cred.secret) return { ok: false, reason: 'unreadable' };
      // ⛔ 0600 OR TIGHTER. A recovery credential every local account can read is not a credential.
      if (cred.mode != null && (cred.mode & 0o077) !== 0) return { ok: false, reason: 'bad-mode' };
      const issuedAt = (cred.issuedAt != null) ? cred.issuedAt : born;
      if (now() - issuedAt >= ttlMs) return { ok: false, reason: 'expired' };
      if (!secretEquals(presented == null ? '' : presented, cred.secret)) return { ok: false, reason: 'bad-credential' };
      // ⛔ SINGLE USE — spent the moment it is accepted. A second presentation FAILS.
      spent = true;
      const sid = randomToken();
      sessions.set(sid, { exp: now() + ttlMs });
      return { ok: true, sid, principal: principal() };
    },

    /** The break-glass principal for a request's cookie, or null. Still loopback-fenced per request. */
    principalForRequest(req) {
      if (!active) return null;
      if (loopbackOnly && !isTrueLoopback(req)) return null;
      const sid = parseCookies(req && req.headers && req.headers.cookie)[BREAK_GLASS_COOKIE];
      if (!sid) return null;
      const s = sessions.get(sid);
      if (!s) return null;
      if (s.exp <= now()) { sessions.delete(sid); return null; }
      return principal();
    },

    /* ⚠ NO `Secure` FLAG, DELIBERATELY. This cookie exists only on a plain-http loopback origin —
       the path taken when the IdP is unreachable — and `Secure` would make the browser drop it
       there, which is precisely the outage this credential exists to survive. SameSite=Strict +
       HttpOnly + the per-request loopback check are what fence it. */
    sessionCookie(sid) {
      return `${BREAK_GLASS_COOKIE}=${encodeURIComponent(sid)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}`;
    },
    _sessions: sessions,
  };
}
