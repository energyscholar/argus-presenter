/*
 * Plan 0551 P3 — THE CLIENT AFFORDANCE: /api/auth-state, and a sign-in control that is visible
 * only when there is something to sign in to.
 *
 * WHAT WENT WRONG BEFORE. 0543 shipped the routes, the adapter, the fail-closed allowlist and the
 * trust path. Bruce opened the Presenter on his phone over the public tunnel and found NO SIGN-IN
 * OPTION — nothing in any client linked /auth/login, and /auth/login answered 404 anyway because
 * nothing configured the adapter. Phase 2 fixed the configuration; this is the half a human touches.
 *
 * ⛔ WHAT THIS FILE CANNOT DO. It cannot verify C1 — a human on a phone completing a real Google
 * sign-in and arriving trust:self. That needs Bruce, a real client, and Phase 4. Everything here is
 * the machinery UNDER that gesture, and passing it is not evidence the gesture works.
 *
 * The OIDC session below is minted through the server's own adapter (_oidcAdapterForTest, the 0543
 * seam) because the subject under test is the ENDPOINT and the PAGE, not the login flow.
 */
import { test, check, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function mintJwt(payload) {
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }));
  const p = b64url(JSON.stringify(payload));
  return `${h}.${p}.${b64url(createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey))}`;
}
const ISS = 'https://idp.example.invalid';
const AUD = 'client-0551';
const OIDC = {
  clientId: AUD, clientSecret: 'not-a-real-secret-0551', issuer: ISS,
  authEndpoint: ISS + '/authorize', tokenEndpoint: ISS + '/token', jwksUri: ISS + '/certs',
  redirectUri: 'https://presenter.example.invalid/auth/callback',
};
const holder = {};
const oidcDeps = { fetchJwks: async () => [JWK], exchangeCode: async () => ({ id_token: holder.__t }) };

/** Complete a login through the server's real adapter; return {cookie, sid}. */
async function signIn(server, { email, name }) {
  const A = server._oidcAdapterForTest;
  const begin = A.beginLogin();
  holder.__t = mintJwt({ iss: ISS, aud: AUD, sub: 'sub-of-' + email, email, name, nonce: A._pending.get(begin.state).nonce, exp: Math.floor(Date.now() / 1000) + 600 });
  const r = await A.completeLogin({ code: 'c', state: begin.state });
  expect(r.ok === true, 'the test seam minted a session', JSON.stringify(r));
  return { cookie: `ap_sid=${r.sid}`, sid: r.sid };
}
const authState = (server, cookie) => fetch(server.url() + '/api/auth-state', { headers: cookie ? { cookie } : {} }).then((r) => r.json());

test('0551 P3 — /api/auth-state reports oidcActive, and an anonymous caller may ask', async () => {
  // No oidc configured — the state of every deployment today, and 0543's silent one.
  const off = await createServer({ port: 0 });
  try {
    const s = await authState(off);
    check('with no oidc: oidcActive false', s.oidcActive === false, JSON.stringify(s));
    check('...signedIn false, name null', s.signedIn === false && s.name === null, JSON.stringify(s));
    check('...trust is the fenced default', s.trust === 'participant', JSON.stringify(s));
  } finally { await off.close(); }

  // Configured — the endpoint must SAY so, or the page can never reveal the control.
  const on = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: { 'yes@example.invalid': { role: 'presenter' } } });
  try {
    const anon = await authState(on);
    check('with oidc configured: oidcActive true, to an ANONYMOUS caller', anon.oidcActive === true, JSON.stringify(anon));
    check('...who is still not signed in and still fenced', anon.signedIn === false && anon.trust === 'participant', JSON.stringify(anon));
    // ⛔ Ungated on purpose: a phone with no credential must be able to learn a sign-in exists.
    const res = await fetch(on.url() + '/api/auth-state');
    check('the endpoint answers 200 with no credential (that is the feature)', res.status === 200, `status ${res.status}`);
    check('...and is never cached', /no-store/.test(res.headers.get('cache-control') || ''), res.headers.get('cache-control'));
  } finally { await on.close(); }
});

test('0551 P3 — signed in AND allowlisted reads self; signed in and NOT reads fenced', async () => {
  const server = await createServer({
    port: 0, oidc: OIDC, oidcDeps,
    allowlist: { 'yes@example.invalid': { role: 'presenter' } },
  });
  try {
    const ok = await signIn(server, { email: 'yes@example.invalid', name: 'Allowed Person' });
    const a = await authState(server, ok.cookie);
    check('an allowlisted principal reads signedIn', a.signedIn === true, JSON.stringify(a));
    check('...with their DISPLAY NAME', a.name === 'Allowed Person', JSON.stringify(a));
    check('...and trust self — the whole point of signing in', a.trust === 'self', JSON.stringify(a));

    const no = await signIn(server, { email: 'nope@example.invalid', name: 'Other Person' });
    const b = await authState(server, no.cookie);
    check('a NON-allowlisted principal is signed in', b.signedIn === true, JSON.stringify(b));
    check('...and still FENCED (fail-closed authorization, C2)', b.trust === 'participant', JSON.stringify(b));
    check('...and is TOLD why, rather than discovering it when a turn is fenced',
      b.reason === 'signed in, not authorized', JSON.stringify(b));

    // ⛔ THE LEAK CHECK. The presence payload already carries ip/socketId; this must not join it.
    const raw = JSON.stringify(a) + JSON.stringify(b);
    check('⛔ no email reaches the browser', !/yes@example\.invalid|nope@example\.invalid/.test(raw), raw);
    check('⛔ no `sub` reaches the browser', !/sub-of-/.test(raw) && !('sub' in a), raw);
    check('⛔ no session id reaches the browser', !raw.includes(ok.sid) && !raw.includes(no.sid), raw);
    check('⛔ and no key called sid/sessionId/email/sub exists at all',
      ['sid', 'sessionId', 'email', 'sub', 'token'].every((k) => !(k in a) && !(k in b)), JSON.stringify(Object.keys(a)));
  } finally { await server.close(); }
});

test('0551 P3 — the sign-in control exists in BOTH clients and ships HIDDEN', async () => {
  const presenter = readFileSync(join(APP, 'presenter.html'), 'utf8');
  const control = readFileSync(join(APP, 'control.html'), 'utf8');
  for (const [name, src] of [['presenter.html', presenter], ['control.html', control]]) {
    check(`${name} links /auth/login`, src.includes('href="/auth/login"'), 'no sign-in link');
    check(`${name} offers sign-OUT too`, src.includes('href="/auth/logout"'), 'no sign-out link');
    check(`${name} asks /api/auth-state`, src.includes('/api/auth-state'), 'never asks whether sign-in exists');
    check(`${name} gates the reveal on oidcActive — never assumed`, /oidcActive/.test(src), 'reveal is not gated');
    check(`${name} ships the control DISPLAY:NONE (a deployment with no IdP is unchanged)`,
      /#ap-signin\{[^}]*display:none/.test(src), 'the control is visible by default');
    // A phone is where the feature was found missing: the platform minimum tap target is 44px.
    check(`${name} sizes the control for a PHONE (44px tap target)`, /#ap-signin\{[^}]*min-height:44px/.test(src), 'tap target too small');
    check(`⛔ ${name} never renders an email or a sub from the payload`,
      !/authState[^\n]*\.email|st\.email|st\.sub/.test(src), 'a client renders an identifier the endpoint must not send');
  }
  // The served display page really carries it (renderPresenterPage strips regions when voice is off).
  const server = await createServer({ port: 0, oidc: OIDC, oidcDeps });
  try {
    const html = await fetch(server.url() + '/').then((r) => r.text());
    check('the SERVED display page carries the sign-in control', html.includes('id="ap-signin"') && html.includes('href="/auth/login"'), 'stripped from the served page');
    const ctl = await fetch(server.url() + '/control').then((r) => r.text());
    check('the SERVED control page carries it too', ctl.includes('id="ap-signin"') && ctl.includes('href="/auth/login"'), 'stripped from the served page');
  } finally { await server.close(); }
});

test('0551 P3 — /auth/login is reachable when configured, and 404s when it is not', async () => {
  // The route half of the same fact the page reads: a revealed control must not lead to a 404.
  const on = await createServer({ port: 0, oidc: OIDC, oidcDeps });
  try {
    const r = await fetch(on.url() + '/auth/login', { redirect: 'manual' });
    check('configured ⇒ /auth/login redirects to the IdP', r.status === 302, `status ${r.status}`);
    check('...to the declared authorization endpoint', String(r.headers.get('location') || '').startsWith(OIDC.authEndpoint), r.headers.get('location'));
  } finally { await on.close(); }
  const off = await createServer({ port: 0 });
  try {
    const r = await fetch(off.url() + '/auth/login', { redirect: 'manual' });
    check('unconfigured ⇒ 404, and the control stays hidden so nobody meets it', r.status === 404, `status ${r.status}`);
  } finally { await off.close(); }
});
