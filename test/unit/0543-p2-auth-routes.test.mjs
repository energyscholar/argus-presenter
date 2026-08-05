/*
 * Plan 0543 P2 — the OIDC login ROUTES are wired into the running server, and are inert (clean 404)
 * when OIDC is not configured. Also proves createServer accepts the identity config (allowlist /
 * oidc / tailscale) and still starts. This is P2's server-side seam; the flow LOGIC is proved in
 * 0543-p2-identity-adapters.test.mjs. No trust behaviour changes here — that is P3.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';

const oidcConfig = {
  clientId: 'client-123', clientSecret: 'shh', issuer: 'https://accounts.google.com',
  authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
  redirectUri: 'https://presenter.example/auth/callback',
};

test('0543 P2: /auth/login is a clean 404 when OIDC is not configured', async () => {
  const s = await createServer({ port: 0 });
  try {
    const res = await fetch(s.url() + '/auth/login', { redirect: 'manual' });
    expect(res.status === 404, '/auth/login ⇒ 404 without OIDC config', String(res.status));
  } finally { await s.close(); }
});

test('0543 P2: /auth/login redirects to the IdP with state + PKCE when OIDC is configured', async () => {
  const s = await createServer({ port: 0, oidc: oidcConfig, oidcDeps: { exchangeCode: async () => ({}), fetchJwks: async () => [] } });
  try {
    const res = await fetch(s.url() + '/auth/login', { redirect: 'manual' });
    expect(res.status === 302, '/auth/login ⇒ 302 redirect', String(res.status));
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith('https://accounts.google.com/o/oauth2/v2/auth') && loc.includes('code_challenge=') && loc.includes('state='),
      'redirect carries the IdP url + PKCE challenge + state', loc.slice(0, 120));
  } finally { await s.close(); }
});

test('0543 P2: /auth/logout redirects and clears the session cookie (OIDC configured)', async () => {
  const s = await createServer({ port: 0, oidc: oidcConfig, oidcDeps: { exchangeCode: async () => ({}), fetchJwks: async () => [] } });
  try {
    const res = await fetch(s.url() + '/auth/logout', { redirect: 'manual' });
    expect(res.status === 302, '/auth/logout ⇒ 302', String(res.status));
    const sc = res.headers.get('set-cookie') || '';
    expect(/ap_sid=;/.test(sc) && /Max-Age=0/.test(sc), 'logout clears the cookie', sc);
  } finally { await s.close(); }
});

test('0543 P2: createServer accepts allowlist + tailscale config and starts', async () => {
  const s = await createServer({
    port: 0,
    allowlist: { 'gen@x.com': { role: 'presenter' } },
    tailscale: { enabled: true }, tailscaleResolve: (req) => req.headers['tailscale-user-login'] || null,
  });
  try {
    expect(typeof s.url() === 'string', 'server started with identity config');
  } finally { await s.close(); }
});
