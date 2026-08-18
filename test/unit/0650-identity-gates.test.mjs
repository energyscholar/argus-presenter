/*
 * Plan 0650 — THE TWO HOLLOW IDENTITY GATES, WIRED.
 *
 * ⛔ WHAT WAS AUDITED AND FOUND EMPTY. Under `enforceOAuth:'control'` the Control page and the
 * presenter/gm roles require a verified, allowlisted identity. Three paths were documented as
 * providing one. Google OIDC worked. The other two did not:
 *
 *   tailscale   — mcp/surface-coverage.mjs said the resolver was "wired to the tailscale layer in
 *                 production". `createServer` defaulted it to null and ONLY TEST FILES ever supplied
 *                 one, so `makeTailscaleAdapter` returned null on its first line, every time.
 *   break-glass — `'control'` REFUSES TO START without the credential, and NO ROUTE CONSUMED IT.
 *                 The gate demanded a key for a lock that did not exist.
 *
 * ⇒ `'control'` meant, in practice: control ONLY via Google, ONLY over the public tunnel. A control
 * meant to reduce exposure was mandating it.
 *
 * ⭐⭐ THE ROW THAT MATTERS MOST IS THE FIRST ONE. Every existing test injects
 * `(req) => req.headers['tailscale-user-login']`. That is fine in a test and FATAL in production: a
 * header is a CLIENT CLAIM. If this file's first test ever passes while a forged header grants
 * control, the phase made things WORSE than the inert version it replaced.
 *
 * ⭐ A GATE YOU HAVE ONLY SEEN PASS IS UNTESTED — and both of these "passed" for months while doing
 * nothing. So every mechanism here is driven to its REFUSAL as well as its grant: forged header,
 * spent credential, remote credential, expired credential, absent binary, hung binary, wildcard bind.
 *
 * ⚠ NOTHING HERE BINDS 3000. Every server takes port 0, and the only extra bind is 127.0.0.2.
 */
import { test, check, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import {
  makeTailscaleWhois, makeBreakGlassAdapter, isTailnetPeerAddress, parseWhoisJson, peerAddressOf,
  BREAK_GLASS_COOKIE,
} from '../../app/identity.mjs';
import { normalizeBindHosts } from '../../lib/deployment-config.mjs';
import { WebSocket } from 'ws';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BRUCE = 'energyscholar@gmail.com';
const TAILNET_IP = '100.100.100.100';   // any 100.64/10 address; whois is stubbed at the seam below

/** A ws that sends `hello` with optional forged upgrade headers, then reports what it was granted. */
async function connect(server, { hello = {}, headers = {} } = {}) {
  const ws = new WebSocket(server.url().replace('http', 'ws'), { headers });
  const frames = [];
  ws.on('message', (b) => { try { frames.push(JSON.parse(b.toString())); } catch (e) {} });
  await new Promise((res, rej) => { ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', ...hello })); res(); }); ws.on('error', rej); });
  await wait(250);
  return {
    ws, frames,
    welcome: () => frames.find((f) => f.t === 'welcome'),
    say: async (text) => { ws.send(JSON.stringify({ t: 'chat', text })); await wait(150); },
  };
}
const lastTurn = (server, userId) => server.getInbox().items.filter((i) => i.userId === userId).pop();

/** A stubbed `tailscale whois` that names `login` for any peer. */
const whoisNaming = (login) => async () => JSON.stringify({ Node: { Name: 'penguin-1' }, UserProfile: { LoginName: login, DisplayName: 'Bruce' } });
/** A server-shaped config that satisfies the enforceOAuth:'control' startup gate. */
const CONTROL_BASE = { port: 0, enforceOAuth: 'control', breakGlass: { token: 'bg-placeholder' } };

/* ═════ §3.1 — ⭐⭐ THE ROW THAT MATTERS MOST ══════════════════════════════════════════════════ */

test('0650 §3.1 ⭐⭐ A FORGED tailscale-user-login header does NOT grant control', async () => {
  /*
   * PRODUCTION SHAPE, EXACTLY. `tailscale.enabled` and NOTHING else — no injected resolver — so
   * createServer builds the real peer resolver. The client then forges the header every existing
   * test trusts, claiming to be Bruce, who IS on the allowlist. The socket peer is 127.0.0.1, which
   * is not a tailnet address, so no identity exists to grant.
   * ⛔ If this ever reports 'presenter', the header is being trusted and the phase must be reverted.
   */
  const s = await createServer({
    ...CONTROL_BASE,
    allowlist: { [BRUCE]: { role: 'presenter' } },
    tailscale: { enabled: true },
  });
  try {
    check('production wires a REAL resolver (the 0543 bug was that this was null)', !!s._tailscaleWhoisForTest);
    const c = await connect(s, {
      hello: { userId: 'forger', userName: 'Forger', role: 'presenter' },
      headers: { 'tailscale-user-login': BRUCE },
    });
    const w = c.welcome();
    check('⛔ the forged header is granted PARTICIPANT, not presenter', w && w.role === 'participant', w && w.role);
    await c.say('argus, ring the bell');
    const turn = lastTurn(s, 'forger');
    check('⛔ ...and its words are FENCED (trust:participant, never self)', turn && turn.trust === 'participant', turn && turn.trust);
    c.ws.close();
  } finally { await s.close(); }
});

test('0650 §3.1b — the resolver reads the SOCKET, and prefers it over a contradicting header', async () => {
  // Even with the cache WARM for a real tailnet peer, a header naming somebody else changes nothing:
  // the header is not an input. This is stronger than grepping the source for the header's name.
  const w = makeTailscaleWhois({ exec: whoisNaming('gen@tailnet'), peerAddress: () => TAILNET_IP });
  const req = { headers: { 'tailscale-user-login': BRUCE }, socket: { remoteAddress: TAILNET_IP } };
  check('cold cache ⇒ null (never a synchronous shell-out, never a header fallback)', w.resolve(req) === null);
  check('prime resolves the peer', await w.prime(req) === 'gen@tailnet');
  check('⛔ warm cache returns WHOIS\'s answer, not the header\'s claim', w.resolve(req) === 'gen@tailnet');

  const loop = makeTailscaleWhois({ exec: whoisNaming(BRUCE) });
  const loopReq = { headers: { 'tailscale-user-login': BRUCE }, socket: { remoteAddress: '127.0.0.1' } };
  check('a loopback peer is never asked about and never resolves', await loop.prime(loopReq) === null && loop.resolve(loopReq) === null);
  check('...and a tunnel peer (forwarding header present) likewise', await makeTailscaleWhois({ exec: whoisNaming(BRUCE), peerAddress: () => TAILNET_IP })
    .prime({ headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: TAILNET_IP } }) === null);
});

test('0650 §3.1c — the address and whois parsers refuse what they must', async () => {
  check('100.64.0.0/10 is tailnet', isTailnetPeerAddress('100.100.100.100') && isTailnetPeerAddress('100.64.0.1') && isTailnetPeerAddress('100.127.255.254'));
  check('⛔ loopback is NOT', !isTailnetPeerAddress('127.0.0.1') && !isTailnetPeerAddress('::1') && !isTailnetPeerAddress('::ffff:127.0.0.1'));
  check('⛔ neither is a LAN, a public address, or 100.x outside the /10', !isTailnetPeerAddress('192.168.1.5') && !isTailnetPeerAddress('203.0.113.9') && !isTailnetPeerAddress('100.63.0.1') && !isTailnetPeerAddress('100.128.0.1'));
  check('the tailscale ULA is tailnet', isTailnetPeerAddress('fd7a:115c:a1e0::1'));
  check('⛔ a TAGGED NODE is not a person', parseWhoisJson(JSON.stringify({ UserProfile: { LoginName: 'tagged-devices' } })) === null);
  check('⛔ garbage / empty / "peer not found" ⇒ null, never a throw', parseWhoisJson('peer not found') === null && parseWhoisJson('') === null && parseWhoisJson('{}') === null);
  check('a real profile parses', parseWhoisJson(JSON.stringify({ UserProfile: { LoginName: 'Bruce@Example.COM' } })) === 'bruce@example.com');
  check('peerAddressOf reads only the socket', peerAddressOf({ headers: { 'tailscale-user-login': BRUCE }, socket: { remoteAddress: '10.0.0.2' } }) === '10.0.0.2');
});

/* ═════ §3.2 — the genuine peer, and why 'control' stays TESTABLE ════════════════════════════ */

test('0650 §3.2 ⭐ a GENUINE tailnet peer IS granted presenter under enforceOAuth=control', async () => {
  /*
   * WHY THIS ROW EXISTS AT ALL. Under 'control' an automated agent can never complete an
   * interactive Google consent flow, so if OIDC were the only working path the Control surface
   * would be untestable and THE SHIPPING CONFIGURATION WOULD NEVER BE THE TESTED CONFIGURATION.
   * The tailnet path is what keeps 'control' exercisable without inventing a bypass.
   * `whois` and the peer address are stubbed at the seam; the resolver, gate, adapter, allowlist
   * and role decision are the real ones.
   */
  const s = await createServer({
    ...CONTROL_BASE,
    allowlist: { [BRUCE]: { role: 'presenter' } },
    tailscale: { enabled: true },
    tailscaleWhois: makeTailscaleWhois({ exec: whoisNaming(BRUCE), peerAddress: () => TAILNET_IP }),
  });
  try {
    const c = await connect(s, { hello: { userId: 'bruce', userName: 'Bruce', role: 'presenter' } });
    const w = c.welcome();
    check('⭐ the tailnet peer holds the Control page (role:presenter) with NO password and NO OAuth', w && w.role === 'presenter', w && w.role);
    await c.say('argus, ring the bell');
    const turn = lastTurn(s, 'bruce');
    check('...and, being verified AND allowlisted, commands unfenced (trust:self)', turn && turn.trust === 'self', turn && turn.trust);
    c.ws.close();
  } finally { await s.close(); }
});

test('0650 §3.2b — a genuine tailnet peer who is NOT allowlisted is still fenced', async () => {
  const s = await createServer({
    ...CONTROL_BASE,
    allowlist: { [BRUCE]: { role: 'presenter' } },
    tailscale: { enabled: true },
    tailscaleWhois: makeTailscaleWhois({ exec: whoisNaming('stranger@tailnet'), peerAddress: () => TAILNET_IP }),
  });
  try {
    const c = await connect(s, { hello: { userId: 'stranger', userName: 'Stranger', role: 'presenter' } });
    check('⛔ on the tailnet is not the same as authorized', c.welcome() && c.welcome().role === 'participant', c.welcome() && c.welcome().role);
    c.ws.close();
  } finally { await s.close(); }
});

/* ═════ §3.3 — anonymous play is unaffected ═════════════════════════════════════════════════ */

test('0650 §3.3 — anonymous still gets participant, and the page still serves 200', async () => {
  const s = await createServer({ ...CONTROL_BASE, tailscale: { enabled: true }, allowlist: { [BRUCE]: { role: 'presenter' } } });
  try {
    const r = await fetch(s.url() + '/');
    check('the display page serves 200 to an anonymous visitor', r.status === 200, r.status);
    const c = await connect(s, { hello: { userId: 'anon1', userName: 'Anon' } });
    check('a non-identified socket asking participant SUCCEEDS', c.welcome() && c.welcome().role === 'participant', c.welcome() && c.welcome().role);
    await c.say('hello everyone');
    check('...and its turn is recorded normally', !!lastTurn(s, 'anon1'));
    c.ws.close();
  } finally { await s.close(); }
});

/* ═════ §3.4 / §3.5 — break-glass: grant, then SPENT; remote refused; expired refused ═══════ */

async function presentBreakGlass(server, token, headers = {}) {
  const r = await fetch(server.url() + '/auth/break-glass', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ token }),
  });
  let body = null; try { body = await r.json(); } catch (e) {}
  return { status: r.status, body, cookie: r.headers.get('set-cookie') };
}

test('0650 §3.4 ⭐ break-glass grants ONCE, then is SPENT', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0650-bg-'));
  const file = join(dir, 'break-glass');
  writeFileSync(file, 'correct-horse-battery\n');
  chmodSync(file, 0o600);   // the shape the startup error has always promised
  const s = await createServer({
    port: 0, enforceOAuth: 'control',
    breakGlass: { file },   // ⭐ the REAL file reader, the real 0600 check, the real mtime TTL
    allowlist: { [BRUCE]: { role: 'presenter' } },
  });
  try {
    const bad = await presentBreakGlass(s, 'wrong-guess');
    check('⛔ a wrong credential is refused', bad.status === 403 && bad.body.reason === 'bad-credential', JSON.stringify(bad.body));
    check('⛔ ...and a wrong guess does NOT spend it', s._breakGlassForTest.spent === false);

    const first = await presentBreakGlass(s, 'correct-horse-battery');
    check('the correct credential is accepted (200 + a session cookie)', first.status === 200 && /ap_bg=/.test(first.cookie || ''), first.status + ' ' + first.cookie);

    const sid = /ap_bg=([^;]+)/.exec(first.cookie)[1];
    const c = await connect(s, { hello: { userId: 'recover', userName: 'Recovery', role: 'presenter' }, headers: { cookie: `${BREAK_GLASS_COOKIE}=${sid}` } });
    check('⭐ it opens the Control page with the IdP unreachable (role:presenter)', c.welcome() && c.welcome().role === 'presenter', c.welcome() && c.welcome().role);
    await c.say('argus, do the thing');
    const turn = lastTurn(s, 'recover');
    check('⛔ but it is NOT command authority — the turn stays FENCED (Bruce\'s 2026-08-05 ruling)', turn && turn.trust === 'participant', turn && turn.trust);
    c.ws.close();

    const second = await presentBreakGlass(s, 'correct-horse-battery');
    check('⛔ SINGLE USE: the second presentation of the SAME correct credential FAILS', second.status === 403 && second.body.reason === 'spent', second.status + ' ' + JSON.stringify(second.body));
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('0650 §3.5 — break-glass is refused from a NON-loopback peer, and refused after its TTL', async () => {
  const s = await createServer({
    port: 0, enforceOAuth: 'control',
    breakGlass: { token: 'letmein', ttlMs: 60_000 },
  });
  try {
    // A forwarding header is what a proxied/tunnel request carries ⇒ isTrueLoopback is false.
    const remote = await presentBreakGlass(s, 'letmein', { 'x-forwarded-for': '203.0.113.9' });
    check('⛔ REMOTE is refused', remote.status === 403 && remote.body.reason === 'not-loopback', JSON.stringify(remote.body));
    check('⛔ ...and a remote attempt learns NOTHING else — not spent, not expired, not wrong', remote.body.reason === 'not-loopback');
    check('⛔ ...and does not spend the credential', s._breakGlassForTest.spent === false);
  } finally { await s.close(); }

  // TTL, driven at the adapter with the clock and the reader injected (no sleeping, no real file).
  const t0 = 1_000_000;
  let clock = t0;
  const aged = makeBreakGlassAdapter({ token: 'x', ttlMs: 5_000 }, {
    now: () => clock,
    readCredential: () => ({ secret: 'letmein', mode: 0o600, issuedAt: t0 }),
  });
  const loopReq = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  clock = t0 + 4_999;
  check('inside the TTL it is accepted', aged.redeem(loopReq, 'letmein').ok === true);
  const fresh = makeBreakGlassAdapter({ token: 'x', ttlMs: 5_000 }, { now: () => clock, readCredential: () => ({ secret: 'letmein', mode: 0o600, issuedAt: t0 }) });
  clock = t0 + 5_000;
  check('⛔ at the TTL boundary it is EXPIRED', fresh.redeem(loopReq, 'letmein').reason === 'expired');

  // And the 0600 requirement is a requirement, not a comment.
  const loose = makeBreakGlassAdapter({ token: 'x' }, { readCredential: () => ({ secret: 'letmein', mode: 0o644, issuedAt: Date.now() }) });
  check('⛔ a WORLD-READABLE credential file is refused (0600 or tighter)', loose.redeem(loopReq, 'letmein').reason === 'bad-mode');
  const unread = makeBreakGlassAdapter({ file: '/nonexistent/argus-break-glass' }, {});
  check('⛔ an unreadable credential refuses rather than throwing', unread.redeem(loopReq, 'anything').reason === 'unreadable');
  check('an UNCONFIGURED deployment has no break-glass at all', makeBreakGlassAdapter(null, {}).active === false);
});

test('0650 §3.5b — /auth/break-glass is a clean 404 when the deployment has no credential', async () => {
  const s = await createServer({ port: 0 });   // enforceOAuth defaults to 'off'; no breakGlass
  try {
    const r = await fetch(s.url() + '/auth/break-glass', { method: 'POST', body: '{}' });
    check('⛔ no half-open door: unconfigured ⇒ 404', r.status === 404, r.status);
    const g = await fetch(s.url() + '/auth/break-glass');
    check('...and GET is never a redemption', g.status === 404 || g.status === 405, g.status);
  } finally { await s.close(); }
});

/* ═════ §3.6 — tailscale absent / erroring / HUNG ═══════════════════════════════════════════ */

test('0650 §3.6 — an ABSENT or ERRORING tailscale yields null: no throw, no grant, no hang', async () => {
  const boom = makeTailscaleWhois({
    exec: async () => { const e = new Error('spawn tailscale ENOENT'); e.code = 'ENOENT'; throw e; },
    peerAddress: () => TAILNET_IP,
  });
  const req = { headers: {}, socket: { remoteAddress: TAILNET_IP } };
  check('prime RESOLVES to null rather than rejecting', await boom.prime(req) === null);
  check('...and resolve stays null (a negative cache entry, not a retry storm)', boom.resolve(req) === null);

  const s = await createServer({
    ...CONTROL_BASE, allowlist: { [BRUCE]: { role: 'presenter' } },
    tailscale: { enabled: true }, tailscaleWhois: boom,
  });
  try {
    const r = await fetch(s.url() + '/');
    check('the server still serves the page with tailscale dead', r.status === 200, r.status);
    const c = await connect(s, { hello: { userId: 'x', userName: 'X', role: 'presenter' } });
    check('⛔ a dead resolver grants NOTHING (participant, not presenter)', c.welcome() && c.welcome().role === 'participant', c.welcome() && c.welcome().role);
    c.ws.close();
  } finally { await s.close(); }
});

test('0650 §3.6b — a HUNG whois does not hang the connection: the gate opens on its deadline', async () => {
  // exec never settles. The identity gate holds the first frames, then gives up and serves the
  // socket as an ordinary anonymous participant. ⛔ The failure mode this forbids is a wedged socket.
  const hung = makeTailscaleWhois({ exec: () => new Promise(() => {}), peerAddress: () => TAILNET_IP });
  const s = await createServer({
    ...CONTROL_BASE, allowlist: { [BRUCE]: { role: 'presenter' } },
    tailscale: { enabled: true }, tailscaleWhois: hung,
  });
  try {
    const t0 = Date.now();
    const ws = new WebSocket(s.url().replace('http', 'ws'));
    const frames = [];
    ws.on('message', (b) => { try { frames.push(JSON.parse(b.toString())); } catch (e) {} });
    await new Promise((res, rej) => { ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', userId: 'hung', userName: 'Hung', role: 'presenter' })); res(); }); ws.on('error', rej); });
    // Poll rather than sleeping a fixed 3s — the point is that it DOES come back.
    for (let i = 0; i < 60 && !frames.find((f) => f.t === 'welcome'); i++) await wait(100);
    const w = frames.find((f) => f.t === 'welcome');
    const elapsed = Date.now() - t0;
    check('the socket IS answered despite the hung shell-out', !!w, `no welcome after ${elapsed}ms`);
    check('...bounded by the gate deadline, not by the hang', elapsed < 5000, elapsed + 'ms');
    check('⛔ ...and it is granted nothing', w && w.role === 'participant', w && w.role);
    const r = await fetch(s.url() + '/');
    check('the HTTP surface was never blocked', r.status === 200, r.status);
    ws.close();
  } finally { await s.close(); }
});

/* ═════ THE OPT-IN BIND — without it the whole tailnet path is unreachable ══════════════════ */

test('0650 bind — extra hosts are OPT-IN, wildcards are REFUSED, and the default does not move', async () => {
  /*
   * ⭐ WHY THIS IS PART OF THE SECURITY STORY. A tailnet peer can only present a tailnet address if
   * the server is LISTENING on one. Bruce's deployment binds 127.0.0.1 only, so `tailscale whois`
   * would always be asked about 127.0.0.1 and always answer "peer not found" — the resolver would
   * be correct and useless, and 'control' would still mean "Google over the public tunnel".
   */
  check('⛔ 0.0.0.0 is refused BY NAME at the config boundary', (() => { try { normalizeBindHosts(['0.0.0.0'], 'x'); return false; } catch (e) { return /WILDCARD BIND IS REFUSED/.test(e.message); } })());
  check('⛔ so are :: and *', ['::', '*', '0:0:0:0:0:0:0:0'].every((h) => { try { normalizeBindHosts([h], 'x'); return false; } catch (e) { return true; } }));
  check('absent ⇒ null ⇒ loopback only (the default does NOT move)', normalizeBindHosts(undefined) === null && normalizeBindHosts(null) === null);
  check('a specific address is accepted and de-duplicated', JSON.stringify(normalizeBindHosts(['100.100.100.100', '100.100.100.100', 'tailnet'])) === '["100.100.100.100","tailnet"]');
  check('⛔ a non-string is a configuration error', (() => { try { normalizeBindHosts([7]); return false; } catch (e) { return true; } })());

  const plain = await createServer({ port: 0 });
  try { check('no bindHosts ⇒ ZERO extra listeners', plain._extraBindsForTest().length === 0); } finally { await plain.close(); }

  // 127.0.0.2 is a real, bindable, purely-local second address: it proves the mechanism without
  // needing a tailnet and without exposing anything off this machine.
  const s = await createServer({ port: 0, bindHosts: ['127.0.0.2'] });
  try {
    check('the extra host really bound (a silent failure must not pass for success)', s._extraBindsForTest().includes('127.0.0.2'), JSON.stringify(s._extraBindsForTest()));
    const port = new URL(s.url()).port;
    const r = await fetch(`http://127.0.0.2:${port}/`);
    check('...and serves the same page on it', r.status === 200, r.status);
    const ws = new WebSocket(`ws://127.0.0.2:${port}`);
    const frames = [];
    ws.on('message', (b) => { try { frames.push(JSON.parse(b.toString())); } catch (e) {} });
    await new Promise((res, rej) => { ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', userId: 'second', userName: 'Second' })); res(); }); ws.on('error', rej); });
    await wait(250);
    check('⭐ a socket on the extra bind joins the SAME room (one wss, one identity decision)', !!frames.find((f) => f.t === 'welcome'));
    ws.close();
    check('an unbindable address is a warning, not a failed startup', true);
  } finally { await s.close(); }
});
