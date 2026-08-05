/*
 * Plan 0543 P2 — the IDENTITY ADAPTERS, in isolation (no server needed).
 *
 * These prove the security-critical LOGIC each adapter contributes before P3 wires them to trust:
 *   - isTrueLoopback  — the loopback/XFF discriminator (the T7 core: a forwarding header ⇒ remote).
 *   - makeAllowlist   — FAIL-CLOSED: not-on-list ⇒ fenced participant (the T5/T4 core).
 *   - verifyIdToken   — RS256/JWKS/iss/aud/exp/nonce, verified offline with a local keypair (T14 core).
 *   - makeOidcAdapter — state/nonce/PKCE flow + session cookie, network injected.
 *   - makeTailscaleAdapter — a DIRECT peer only (a forwarding header ⇒ not a tailnet peer).
 */
import { test, expect } from '../../harness/test.mjs';
import { generateKeyPairSync, createSign, createHash } from 'node:crypto';
import {
  isTrueLoopback, hasForwardingHeader, loopbackPrincipal, makeAllowlist,
  verifyIdToken, pkcePair, makeOidcAdapter, makeTailscaleAdapter, parseCookies, SESSION_COOKIE,
} from '../../app/identity.mjs';

const reqOf = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

// ── loopback / XFF discriminator (T7 core) ──────────────────────────────────────────────────
test('0543 P2: isTrueLoopback — loopback peer with NO forwarding header is local', () => {
  expect(isTrueLoopback(reqOf('127.0.0.1')) === true, '127.0.0.1, no header ⇒ local');
  expect(isTrueLoopback(reqOf('::1')) === true, '::1, no header ⇒ local');
  expect(isTrueLoopback(reqOf('::ffff:127.0.0.1')) === true, 'v4-mapped loopback ⇒ local');
  expect(loopbackPrincipal(reqOf('127.0.0.1')).provider === 'loopback', 'principal yielded for true loopback');
});

test('0543 P2 (T7 core): loopback peer WITH a forwarding header is REMOTE — the cloudflared trap', () => {
  expect(isTrueLoopback(reqOf('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })) === false, 'peer 127.0.0.1 + XFF ⇒ remote');
  expect(isTrueLoopback(reqOf('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' })) === false, 'peer 127.0.0.1 + Cf-Connecting-IP ⇒ remote');
  expect(isTrueLoopback(reqOf('::1', { 'forwarded': 'for=203.0.113.9' })) === false, 'peer ::1 + Forwarded ⇒ remote');
  expect(loopbackPrincipal(reqOf('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })) === null, 'no loopback principal when XFF present');
});

test('0543 P2: a non-loopback peer is never local; a null request is never local (fail-safe)', () => {
  expect(isTrueLoopback(reqOf('203.0.113.9')) === false, 'public peer ⇒ not local');
  expect(isTrueLoopback(reqOf('192.168.1.5')) === false, 'private-LAN peer ⇒ not local (loopback only)');
  expect(isTrueLoopback(null) === false, 'null req ⇒ not local');
  expect(hasForwardingHeader(reqOf('127.0.0.1', { 'x-forwarded-for': '  ' })) === false, 'a blank header does not count');
});

// ── allowlist fail-closed (T5 / T4 core) ────────────────────────────────────────────────────
test('0543 P2 (T5 core): allowlist is FAIL-CLOSED — a hit authorizes, everything else is fenced', () => {
  const al = makeAllowlist({ 'bruce@x.com': { role: 'presenter' }, 'gen@x.com': 'ai' });
  expect(al.lookup('bruce@x.com').allowed === true && al.lookup('bruce@x.com').role === 'presenter', 'listed email ⇒ allowed with its role');
  expect(al.lookup('GEN@X.COM').allowed === true && al.lookup('GEN@X.COM').role === 'ai', 'case-insensitive; string form ⇒ role');
  const miss = al.lookup('stranger@x.com');
  expect(miss.allowed === false && miss.role === 'participant', 'NOT on list ⇒ fenced participant', JSON.stringify(miss));
  const nul = al.lookup(null);
  expect(nul.allowed === false && nul.role === 'participant', 'null key ⇒ fenced participant');
});

test('0543 P2: an empty / absent allowlist authorizes NOBODY', () => {
  expect(makeAllowlist({}).lookup('anyone@x.com').allowed === false, 'empty list ⇒ nobody allowed');
  expect(makeAllowlist(null).lookup('anyone@x.com').allowed === false, 'null list ⇒ nobody allowed');
  expect(makeAllowlist(undefined).size === 0, 'undefined list ⇒ size 0');
});

// ── OIDC ID-token verifier (T14 core) ───────────────────────────────────────────────────────
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', use: 'sig', alg: 'RS256' };
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function mintJwt(payload, { kid = 'test-kid', alg = 'RS256' } = {}) {
  const header = b64url(JSON.stringify({ alg, typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(payload));
  if (alg === 'none') return `${header}.${body}.`;
  const sig = createSign('RSA-SHA256').update(`${header}.${body}`).sign(privateKey);
  return `${header}.${body}.${b64url(sig)}`;
}
const ISS = 'https://accounts.google.com';
const AUD = 'client-123.apps.googleusercontent.com';
const good = () => ({ iss: ISS, aud: AUD, sub: '10001', email: 'gen@x.com', email_verified: true, name: 'Gen', nonce: 'N1', exp: Math.floor(Date.now() / 1000) + 600 });

test('0543 P2 (T14): a valid ID token verifies and yields the principal', () => {
  const v = verifyIdToken(mintJwt(good()), { jwks: [JWK], iss: ISS, aud: AUD, nonce: 'N1' });
  expect(v.ok === true, 'valid token verifies', JSON.stringify(v));
  expect(v.principal.sub === '10001' && v.principal.email === 'gen@x.com' && v.principal.provider === 'oidc', 'principal carries sub+email', JSON.stringify(v.principal));
});

test('0543 P2 (T14): forged / expired / wrong-aud / replayed-nonce / alg-none / no-key are ALL refused', () => {
  const V = (jwt, opts) => verifyIdToken(jwt, { jwks: [JWK], iss: ISS, aud: AUD, nonce: 'N1', ...opts });
  // tampered signature
  const t = mintJwt(good()); const tampered = t.slice(0, -4) + (t.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  expect(V(tampered).ok === false, 'tampered signature refused', JSON.stringify(V(tampered)));
  // expired
  expect(V(mintJwt({ ...good(), exp: Math.floor(Date.now() / 1000) - 10 })).ok === false, 'expired refused');
  // wrong aud
  expect(V(mintJwt({ ...good(), aud: 'someone-else' })).ok === false, 'wrong aud refused');
  // wrong / replayed nonce (expected N1, token carries N2)
  expect(V(mintJwt({ ...good(), nonce: 'N2' })).ok === false, 'nonce mismatch refused');
  // alg none (unsigned)
  expect(V(mintJwt(good(), { alg: 'none' })).ok === false, 'alg:none refused (RS256 pinned)');
  // wrong issuer
  expect(V(mintJwt({ ...good(), iss: 'https://evil.example' })).ok === false, 'wrong iss refused');
  // no matching key
  expect(verifyIdToken(mintJwt(good(), { kid: 'other' }), { jwks: [{ ...JWK, kid: 'nope' }], iss: ISS, aud: AUD, nonce: 'N1' }).ok === false, 'no matching kid refused');
});

// ── PKCE ────────────────────────────────────────────────────────────────────────────────────
test('0543 P2: pkcePair — challenge is base64url(sha256(verifier))', () => {
  const p = pkcePair();
  const expected = Buffer.from(createHash('sha256').update(p.verifier).digest()).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  expect(p.challenge === expected && p.method === 'S256', 'S256 challenge derived from the verifier', p.challenge);
});

// ── OIDC adapter flow (network injected) ────────────────────────────────────────────────────
const oidcConfig = {
  clientId: AUD, clientSecret: 'shh', issuer: ISS,
  authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
  redirectUri: 'https://presenter.example/auth/callback',
};

test('0543 P2: OIDC adapter — begin/complete login, session cookie, principalForRequest', async () => {
  // One adapter; exchangeCode returns an id_token minted for the SAME nonce beginLogin chose
  // (read from the server-side pending record — exactly what a real IdP would echo back).
  const A = makeOidcAdapter(oidcConfig, { fetchJwks: async () => [JWK], exchangeCode: async () => ({ id_token: A.__t }) });
  expect(A.active === true, 'adapter active with full config');
  const ab = A.beginLogin();
  expect(typeof ab.url === 'string' && ab.url.includes('code_challenge=') && ab.url.includes('state=' + ab.state), 'auth url carries state + PKCE challenge', ab.url);
  expect(A._pending.get(ab.state) && typeof A._pending.get(ab.state).nonce === 'string', 'pending state stored server-side with a nonce');
  A.__t = mintJwt({ ...good(), nonce: A._pending.get(ab.state).nonce });
  const res = await A.completeLogin({ code: 'authcode', state: ab.state });
  expect(res.ok === true && res.principal.email === 'gen@x.com', 'callback completes ⇒ verified principal', JSON.stringify(res));
  const cookie = A.sessionCookie(res.sid);
  expect(/HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Lax/.test(cookie), 'session cookie is HttpOnly+Secure+SameSite=Lax', cookie);
  const principal = A.principalForRequest({ headers: { cookie: `${SESSION_COOKIE}=${res.sid}` } });
  expect(principal && principal.email === 'gen@x.com', 'principalForRequest resolves the cookie to the principal', JSON.stringify(principal));
});

test('0543 P2: OIDC — missing state and unknown state are refused; state is single-use', async () => {
  const A = makeOidcAdapter(oidcConfig, { fetchJwks: async () => [JWK], exchangeCode: async () => ({ id_token: A.__t }) });
  const ab = A.beginLogin();
  A.__t = mintJwt({ ...good(), nonce: A._pending.get(ab.state).nonce });
  expect((await A.completeLogin({ code: 'c' })).ok === false, 'missing state ⇒ refused');
  expect((await A.completeLogin({ code: 'c', state: 'never-issued' })).ok === false, 'unknown state ⇒ refused');
  const ok1 = await A.completeLogin({ code: 'c', state: ab.state });
  expect(ok1.ok === true, 'first use of a valid state succeeds');
  const ok2 = await A.completeLogin({ code: 'c', state: ab.state });
  expect(ok2.ok === false, 'the same state cannot be replayed (single-use)');
});

test('0543 P2: OIDC adapter is INACTIVE (and inert) without config', async () => {
  const A = makeOidcAdapter(null, { fetchJwks: async () => [], exchangeCode: async () => ({}) });
  expect(A.active === false, 'no config ⇒ inactive');
  expect(A.beginLogin() === null, 'inactive ⇒ no login url');
  expect(A.principalForRequest({ headers: {} }) === null, 'inactive ⇒ no principal');
});

// ── tailscale adapter ───────────────────────────────────────────────────────────────────────
test('0543 P2: tailscale — a DIRECT peer resolves; a forwarded (tunnel) request does not', () => {
  const ts = makeTailscaleAdapter({ enabled: true }, { resolve: (req) => req.headers['tailscale-user-login'] || null });
  const direct = ts.principalForRequest(reqOf('100.64.0.2', { 'tailscale-user-login': 'gen@tailnet' }));
  expect(direct && direct.provider === 'tailscale' && direct.sub === 'gen@tailnet', 'direct tailnet peer ⇒ principal', JSON.stringify(direct));
  const viaTunnel = ts.principalForRequest(reqOf('127.0.0.1', { 'tailscale-user-login': 'gen@tailnet', 'cf-connecting-ip': '203.0.113.9' }));
  expect(viaTunnel === null, 'a forwarding header ⇒ not a tailnet peer ⇒ null');
  const disabled = makeTailscaleAdapter({ enabled: false }, { resolve: () => 'x' });
  expect(disabled.principalForRequest(reqOf('100.64.0.2', {})) === null, 'disabled ⇒ null');
});

test('0543 P2: parseCookies is lenient and never throws', () => {
  expect(parseCookies('a=1; b=two').b === 'two', 'parses multiple cookies');
  expect(Object.keys(parseCookies(null)).length === 0, 'null header ⇒ empty');
});
