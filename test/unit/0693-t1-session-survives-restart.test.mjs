/*
 * Plan 0693 T1/T3 — A SIGN-IN MUST SURVIVE A RESTART, AND THE CONTROL TOKEN MUST TOO.
 *
 * ⛔ THE ROOT CAUSE, MEASURED (§1 of the plan). `app/identity.mjs` held its OIDC sessions in
 * `const sessions = new Map()`. Measured on jill 2026-08-26: 13 restarts, 10 deploys, ZERO sessions
 * surviving a restart. jill auto-deploys on every push, so the owner of the deployment was being
 * signed out minutes after each sign-in — by his own pushes — and the Control page then refused him
 * outright. Two earlier diagnoses were WRONG and are recorded in the plan so nobody repeats them:
 * "the login is failing" (there has never been a success log line to be absent) and "the principal
 * never reaches the socket" (it does; there was simply no session left to find).
 *
 * Acceptance criteria proved here: 1 (survives a restart), 1b (verified ⇒ authCtx.verified at the
 * socket), 10 (expiry still yields reauth), 12 (expired/corrupt entries dropped, server starts),
 * 13 (mode 0600, contents in no log), 14 (a configured control token survives; absent ⇒ minted),
 * and the 0696 F9 red-team amendment (a persisted session is a CREDENTIAL AT REST: the session id
 * itself is never written, only sha256 of it).
 */
import { test, check, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { createSessionStore, parseSessionDoc, sessionKey, SESSION_STORE_FORMAT } from '../../lib/session-store.mjs';
import { controlTokenConfig, CONFIG_BASENAME } from '../../lib/deployment-config.mjs';
import { WebSocket } from 'ws';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = () => mkdtempSync(join(tmpdir(), 'ap-0693-'));

/* ── A local IdP: a real RS256 keypair, no network anywhere in this file. ─────────────────────── */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function mintJwt(payload) {
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }));
  const p = b64url(JSON.stringify(payload));
  return `${h}.${p}.${b64url(createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey))}`;
}
const ISS = 'https://idp.example.invalid';
const AUD = 'client-0693';
const OIDC = Object.freeze({
  clientId: AUD, clientSecret: 'not-a-real-secret-0693', issuer: ISS,
  authEndpoint: ISS + '/authorize', tokenEndpoint: ISS + '/token', jwksUri: ISS + '/certs',
  redirectUri: 'https://presenter.example.invalid/auth/callback',
});
const holder = {};
const oidcDeps = { fetchJwks: async () => [JWK], exchangeCode: async () => ({ id_token: holder.__t }) };
const ALLOWED = 'bruce@example.invalid';
const ALLOWLIST = Object.freeze({ [ALLOWED]: { role: 'presenter' } });

/** Complete a login through the server's OWN adapter (the 0543 seam). Returns { sid, cookie }. */
async function signIn(server, { email = ALLOWED, name = 'Signed In Person', expSec = null } = {}) {
  const A = server._oidcAdapterForTest;
  const begin = A.beginLogin();
  holder.__t = mintJwt({
    iss: ISS, aud: AUD, sub: 'sub-of-' + email, email, name,
    nonce: A._pending.get(begin.state).nonce,
    exp: expSec || (Math.floor(Date.now() / 1000) + 3600),
  });
  const r = await A.completeLogin({ code: 'c', state: begin.state });
  expect(r.ok === true, 'the test seam minted a session', JSON.stringify(r));
  return { sid: r.sid, cookie: `ap_sid=${r.sid}` };
}
const authState = (server, cookie) =>
  fetch(server.url() + '/api/auth-state', { headers: cookie ? { cookie } : {}, cache: 'no-store' }).then((r) => r.json());

/** Open a real socket with the given upgrade headers and return its `welcome` frame. */
async function welcomeOf(server, headers) {
  const ws = new WebSocket(server.url().replace('http', 'ws'), { headers });
  const frames = [];
  ws.on('message', (b) => { try { frames.push(JSON.parse(b.toString())); } catch (e) {} });
  await new Promise((res, rej) => { ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', userId: 'u1', userName: 'U' })); res(); }); ws.on('error', rej); });
  await wait(200);
  ws.close();
  return frames.find((f) => f.t === 'welcome') || null;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * AC1 — ⭐ THE WHOLE POINT.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0693 AC1 — a signed-in session SURVIVES a server restart (the defect, directly)', async () => {
  const dir = scratch();
  const file = join(dir, 'oidc-sessions.json');
  let a = null, b = null;
  try {
    a = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST, sessionStoreFile: file });
    const { cookie } = await signIn(a);
    const before = await authState(a, cookie);
    check('before the restart: signed in and self', before.signedIn === true && before.self === true, JSON.stringify(before));
    await a.close(); a = null;

    // ⭐ A DIFFERENT PROCESS-EQUIVALENT: a brand new server object, sharing only the FILE.
    b = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST, sessionStoreFile: file });
    const after = await authState(b, cookie);
    check('⭐ after the restart: STILL signed in — this is the whole plan', after.signedIn === true, JSON.stringify(after));
    check('...and still trust:self (AC2 across a restart)', after.trust === 'self' && after.self === true, JSON.stringify(after));
    check('...a restored session is INDISTINGUISHABLE from a live one', JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
  } finally { if (a) await a.close(); if (b) await b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('0693 — the OLD behaviour is what the file buys: no store file ⇒ the session is GONE', async () => {
  // The falsifier for AC1. Without a store the restart loses the sign-in — which is the measured
  // defect, reproduced here so the passing test above is known to be testing something.
  let a = null, b = null;
  try {
    a = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST });   // in-memory, as before
    const { cookie } = await signIn(a);
    check('signed in on the first server', (await authState(a, cookie)).signedIn === true);
    await a.close(); a = null;
    b = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST });
    const after = await authState(b, cookie);
    check('⛔ with no store, the restart destroys it — the bug, still reproducible on demand',
      after.signedIn === false, JSON.stringify(after));
  } finally { if (a) await a.close(); if (b) await b.close(); }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * AC1b — the principal reaches the SOCKET, before and after a restart.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0693 AC1b — a valid OIDC session opens a socket with authCtx.verified set (⇒ welcome.trust self)', async () => {
  const dir = scratch();
  const file = join(dir, 'oidc-sessions.json');
  let a = null, b = null;
  try {
    a = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST, sessionStoreFile: file });
    const { cookie } = await signIn(a);
    const w1 = await welcomeOf(a, { cookie });
    check('the socket sees the verified principal (welcome.trust === self)', w1 && w1.trust === 'self', JSON.stringify(w1 && { trust: w1.trust, reason: w1.authReason }));
    await a.close(); a = null;

    b = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST, sessionStoreFile: file });
    const w2 = await welcomeOf(b, { cookie });
    check('⭐ and it STILL does after a restart', w2 && w2.trust === 'self', JSON.stringify(w2 && { trust: w2.trust, reason: w2.authReason }));
  } finally { if (a) await a.close(); if (b) await b.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * AC13 + 0696 F9 — A PERSISTED SESSION IS A CREDENTIAL AT REST.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0693 AC13/F9 — the session file is 0600, holds sha256(sid) and NEVER the sid itself', async () => {
  const dir = scratch();
  const file = join(dir, 'oidc-sessions.json');
  let a = null;
  try {
    a = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST, sessionStoreFile: file });
    const { sid } = await signIn(a);
    check('the store wrote a file', existsSync(file), file);
    const mode = statSync(file).mode & 0o777;
    check('AC13 — mode is 0600', mode === 0o600, '0' + mode.toString(8));
    const raw = readFileSync(file, 'utf8');
    check('⛔ F9 — the SESSION ID is not in the file (a hash is not replayable as a cookie)',
      !raw.includes(sid), 'the raw session id was written to disk');
    check('...the key really is sha256(sid)', raw.includes(sessionKey(sid)), raw.slice(0, 200));
    const doc = JSON.parse(raw);
    check('...and the document declares its format', doc.format === SESSION_STORE_FORMAT, JSON.stringify(doc.format));

    // ⛔ AC13's other half: nothing about the session reaches the log ring a debug endpoint serves.
    const logged = JSON.stringify(a.debugDump ? (a.logRing ? a.logRing() : []) : []);
    void logged;   // the ring is asserted from the served endpoint below, which is the reachable one
    const dbg = await fetch(a.url() + '/api/debug').then((r) => (r.ok ? r.text() : '')).catch(() => '');
    check('⛔ no session id in anything /api/debug serves', !dbg.includes(sid), dbg.slice(0, 300));
    check('⛔ no principal in anything /api/debug serves', !dbg.includes(ALLOWED), dbg.slice(0, 300));
  } finally { if (a) await a.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * AC12 — an expired or corrupt persisted entry is DROPPED, never repaired.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0693 AC12 — expired / malformed / unknown-format entries are dropped and the server starts', async () => {
  const dir = scratch();
  const now = Date.now();
  const cases = [
    ['truncated JSON', '{"format":1,"sessions":['],
    ['a JSON scalar', '42'],
    ['an unknown format', JSON.stringify({ format: 999, sessions: [{ k: sessionKey('x'), exp: now + 1e6, principal: { sub: 's' } }] })],
    ['sessions not an array', JSON.stringify({ format: 1, sessions: { a: 1 } })],
    ['an entry with no expiry', JSON.stringify({ format: 1, sessions: [{ k: sessionKey('x'), principal: { sub: 's' } }] })],
    ['an entry with a bad key shape', JSON.stringify({ format: 1, sessions: [{ k: 'not-a-hash', exp: now + 1e6, principal: { sub: 's' } }] })],
    ['an EXPIRED entry', JSON.stringify({ format: 1, sessions: [{ k: sessionKey('x'), exp: now - 1, principal: { sub: 's' } }] })],
  ];
  try {
    for (const [label, body] of cases) {
      const file = join(dir, `case-${label.replace(/\W+/g, '-')}.json`);
      writeFileSync(file, body);
      const store = createSessionStore({ file });
      check(`${label} ⇒ dropped, store empty`, store.size === 0, JSON.stringify(store.stats()));
      check(`${label} ⇒ the session id it named does NOT resolve`, store.get('x') === null);
    }
    // ...and a server really starts on one of them, rather than merely a store.
    const file = join(dir, 'server-corrupt.json');
    writeFileSync(file, '{"format":1,"sessions":[{"k":"nope"}');
    const s = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST, sessionStoreFile: file });
    try {
      const st = await authState(s);
      check('AC12 — the server started normally on a corrupt store', st.oidcActive === true && st.signedIn === false, JSON.stringify(st));
    } finally { await s.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('0693 — the store DROPS, never repairs, and is BOUNDED', async () => {
  const now = () => 1_000_000;
  const doc = JSON.stringify({
    format: 1,
    sessions: [
      { k: sessionKey('live'), exp: 2_000_000, principal: { provider: 'oidc', sub: 'a' } },
      { k: sessionKey('dead'), exp: 900_000, principal: { provider: 'oidc', sub: 'b' } },
      { k: 'short', exp: 2_000_000, principal: { provider: 'oidc', sub: 'c' } },
    ],
  });
  const parsed = parseSessionDoc(doc, now());
  check('only the live, well-formed entry survives a parse', parsed.entries.length === 1, JSON.stringify(parsed));
  check('...and the drops are COUNTED (so a warning can say how many, never which)', parsed.dropped === 2, String(parsed.dropped));

  const dir = scratch();
  try {
    const file = join(dir, 'bounded.json');
    const store = createSessionStore({ file, max: 3 });
    for (let i = 0; i < 10; i++) store.set('sid-' + i, { principal: { provider: 'oidc', sub: 's' + i }, exp: Date.now() + 60_000 + i });
    check('⚠ the store is bounded — an append-only credential file is a slow leak', store.size === 3, String(store.size));
    check('...and it kept the LATEST (furthest from expiring)', store.get('sid-9') !== null && store.get('sid-0') === null);
    const reloaded = createSessionStore({ file });
    check('...and the bound survives a reload', reloaded.size === 3, String(reloaded.size));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * AC10 — expiry still yields reauth:true, never a silent fence. (Unchanged behaviour, asserted.)
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0693 AC10 — a session that expires WHILE THE SERVER RUNS still prompts re-auth', async () => {
  const dir = scratch();
  const file = join(dir, 'oidc-sessions.json');
  let s = null;
  try {
    // A 300ms TTL: the session is minted live and lapses under the running server.
    s = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST, sessionStoreFile: file, oidcSessionTtlMs: 300 });
    const { cookie } = await signIn(s);
    check('freshly signed in', (await authState(s, cookie)).signedIn === true);
    await wait(450);
    const st = await authState(s, cookie);
    check('AC10 — expired ⇒ signedIn false', st.signedIn === false, JSON.stringify(st));
    check('AC10 — ...and reauth:true, never a SILENT fence', st.reauth === true, JSON.stringify(st));
    check('AC10 — ...with the reason said out loud', st.reason === 're-authentication required', JSON.stringify(st));
  } finally { if (s) await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('0693 — a sign-OUT is also durable: revoking writes through', async () => {
  const dir = scratch();
  const file = join(dir, 'oidc-sessions.json');
  let a = null, b = null;
  try {
    a = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST, sessionStoreFile: file });
    const { cookie } = await signIn(a);
    await fetch(a.url() + '/auth/logout', { headers: { cookie }, redirect: 'manual' });
    check('signed out on this server', (await authState(a, cookie)).signedIn === false);
    await a.close(); a = null;
    b = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST, sessionStoreFile: file });
    check('⛔ and STILL signed out after a restart — a sign-out a restart undoes is not a sign-out',
      (await authState(b, cookie)).signedIn === false);
  } finally { if (a) await a.close(); if (b) await b.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * AC14 — T3: a configured control token survives a restart unchanged; absent ⇒ still minted.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0693 AC14 — a DECLARED control token is read from env and from the config file', async () => {
  const dir = scratch();
  const cfg = join(dir, CONFIG_BASENAME);
  const prevCfg = process.env.PRESENTER_CONFIG_FILE;
  const prevTok = process.env.PRESENTER_CONTROL_TOKEN;
  try {
    writeFileSync(cfg, JSON.stringify({ presenterPort: 0, controlToken: 'from-the-config-file' }));
    process.env.PRESENTER_CONFIG_FILE = cfg;
    delete process.env.PRESENTER_CONTROL_TOKEN;
    let d = controlTokenConfig();
    check('the config file declares it', d.controlToken === 'from-the-config-file' && d.controlTokenSource === 'config', JSON.stringify(d));

    process.env.PRESENTER_CONTROL_TOKEN = 'from-the-environment';
    d = controlTokenConfig();
    check('...and the env var WINS (the documented order)', d.controlToken === 'from-the-environment' && d.controlTokenSource === 'env', JSON.stringify(d));

    delete process.env.PRESENTER_CONTROL_TOKEN;
    writeFileSync(cfg, JSON.stringify({ presenterPort: 0 }));
    d = controlTokenConfig();
    check('...and absent everywhere ⇒ null, so the caller still MINTS one (the fallback stays)',
      d.controlToken === null && d.controlTokenSource === null, JSON.stringify(d));
  } finally {
    if (prevCfg == null) delete process.env.PRESENTER_CONFIG_FILE; else process.env.PRESENTER_CONFIG_FILE = prevCfg;
    if (prevTok == null) delete process.env.PRESENTER_CONTROL_TOKEN; else process.env.PRESENTER_CONTROL_TOKEN = prevTok;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('0693 AC14 — presenter_start PINS a declared token and MINTS when there is none', async () => {
  /*
   * The load-bearing half. The mint lives in presenter_start, and it is what made the operator's
   * fallback credential change on every deploy. ⛔ The fallback must survive: a deployment that
   * declares nothing still gets a token, or the module write-back ships open (P12/R15).
   */
  const dir = scratch();
  const cfg = join(dir, CONFIG_BASENAME);
  const prevCfg = process.env.PRESENTER_CONFIG_FILE;
  const prevTok = process.env.PRESENTER_CONTROL_TOKEN;
  const DECLARED = 'pinned-token-0693';
  let T = null;
  try {
    delete process.env.PRESENTER_CONTROL_TOKEN;
    // (a) DECLARED — pinned, and never returned or printed.
    writeFileSync(cfg, JSON.stringify({ presenterPort: 0, controlToken: DECLARED }));
    process.env.PRESENTER_CONFIG_FILE = cfg;
    T = await import(`../../mcp/tools.mjs?p0693a=${Date.now()}`);
    let tools = T.toolMap({ voiceEnabled: false });
    let started = await tools.presenter_start.handler({ port: 0, voice: false, tunnel: false });
    check('presenter_start succeeded', started.ok === true, JSON.stringify(started.error || ''));
    check('AC14 — the session is gated by the DECLARED token', started.gated === true, JSON.stringify(started));
    check('AC14 — ...and it is reported as PINNED (it will not change on the next deploy)',
      started.controlTokenPinned === true && started.controlTokenSource === 'config', JSON.stringify(started));
    check('⛔ ...and nothing minted a replacement', !started.controlTokenMinted, JSON.stringify(started));
    check('⛔ ...and the declared token is NOT in the tool result (never printed, never returned)',
      !JSON.stringify(started).includes(DECLARED), JSON.stringify(started));
    // It really gates: the declared value opens the module surface, a wrong one does not.
    const good = await fetch(started.url + '/api/modules/?token=' + encodeURIComponent(DECLARED));
    const bad = await fetch(started.url + '/api/modules/?token=nope');
    check('...the DECLARED token really is the credential the server checks', good.status !== 403 && bad.status === 403, `good ${good.status} / bad ${bad.status}`);
    await tools.presenter_stop.handler({ tunnel: false });
    T._resetForTests(); T = null;

    // (b) ABSENT — still minted, exactly as before.
    writeFileSync(cfg, JSON.stringify({ presenterPort: 0 }));
    T = await import(`../../mcp/tools.mjs?p0693b=${Date.now()}`);
    tools = T.toolMap({ voiceEnabled: false });
    started = await tools.presenter_start.handler({ port: 0, voice: false, tunnel: false });
    check('AC14 — absent ⇒ STILL MINTED (the write-back never ships open)',
      started.controlTokenMinted === true && typeof started.controlToken === 'string' && started.controlToken.length >= 16, JSON.stringify(started));
    check('...and a minted token is NOT reported as pinned', started.controlTokenPinned !== true, JSON.stringify(started));
    await tools.presenter_stop.handler({ tunnel: false });
  } finally {
    if (T && T._resetForTests) { try { await T.toolMap({ voiceEnabled: false }).presenter_stop.handler({ tunnel: false }); } catch {} T._resetForTests(); }
    if (prevCfg == null) delete process.env.PRESENTER_CONFIG_FILE; else process.env.PRESENTER_CONFIG_FILE = prevCfg;
    if (prevTok == null) delete process.env.PRESENTER_CONTROL_TOKEN; else process.env.PRESENTER_CONTROL_TOKEN = prevTok;
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * 0696 F9 — ...AND IT IS EXCLUDED FROM EVERY BACKUP AND ARTIFACT.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0693 F9 — the session store lands in the state dir, never in the checkout or a shipped tree', async () => {
  const { resolveSessionLogDir, isInsideRepoCheckout } = await import('../../lib/session-log.mjs');
  const { REPO_ROOT } = await import('../../lib/deployment-config.mjs');
  const target = resolveSessionLogDir();
  check('the state dir resolves', !!target.sessionLogDir, JSON.stringify(target));
  check('⛔ ...and is OUTSIDE the checkout, which is what keeps a credential out of `git add -A`',
    !isInsideRepoCheckout(target.sessionLogDir, REPO_ROOT), target.sessionLogDir);

  /*
   * ⛔ THE COUPLING IS BY PATH, SO ASSERT THE PATH. `pipeline/backup.sh` in the pinion repo tars
   * `$SRV/shared` and excludes `state/logs`; the deployment's sessionLogDir IS
   * /srv/argus/shared/state/logs. Putting the store file in THAT directory is what keeps it out of
   * every backup archive — so the filename both launch paths derive is asserted here, in the repo
   * that chooses it, rather than trusted to a comment.
   */
  const cliSrc = readFileSync(new URL('../../app/server.mjs', import.meta.url), 'utf8');
  const mcpSrc = readFileSync(new URL('../../mcp/tools.mjs', import.meta.url), 'utf8');
  for (const [name, src] of [['the CLI self-run', cliSrc], ['presenter_start', mcpSrc]]) {
    check(`${name} derives sessionStoreFile from the session-log dir (the directory backups exclude)`,
      /sessionStoreFile\s*[:=]\s*join\([\w.]+\.sessionLogDir \|\| defaultSessionLogDir\(\), 'oidc-sessions\.json'\)/.test(src),
      'the store path is not derived from the state dir');
  }
  // And nothing ever writes it into the repo: a bare library call persists nothing at all.
  const s = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST });
  try {
    await signIn(s);
    check('⛔ a bare createServer() writes NO credential file (the whole suite included)',
      s._oidcAdapterForTest.sessionStoreStats().persistent === false, JSON.stringify(s._oidcAdapterForTest.sessionStoreStats()));
  } finally { await s.close(); }
});
