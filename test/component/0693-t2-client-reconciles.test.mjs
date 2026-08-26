/*
 * Plan 0693 T2 — ⭐ A DEAD SESSION IS VISIBLE, NOT SILENT (and ⛔ 0696 F10: NOT A LOGOUT STORM).
 *
 * ⭐ THE DEFECT BRUCE ACTUALLY EXPERIENCED was not the lost session. His phone said
 * "Bruce Stephenson" while the socket said `userId:"anon-…", role:"participant"` and attendance
 * said `Guest`. The page was asserting an identity the server had never heard of, because that
 * state is CLIENT-SIDE and nothing was telling it otherwise. Persistence (T1) does not fix that on
 * its own — the next unrelated restart proves it — so the client must reconcile with
 * /api/auth-state on connect AND on reconnect, which is exactly when a restart is observable here.
 *
 * ⛔ AND THE RED-TEAM AMENDMENT (0696 F10). A client that signs people out because ONE fetch failed
 * is a logout storm waiting for a flaky minute of wifi. Only an AUTHORITATIVE SERVED NEGATIVE — a
 * 200 that says signedIn:false — counts. A network error or a non-2xx leaves the last known state
 * standing, and the reconciliation is debounced so a reconnect storm produces ONE request.
 *
 * The browser test below is one page across four servers on the SAME port. Phases 2 and 3 put the
 * server in the IDENTICAL state (a store that has never heard of this session) and differ only in
 * whether the reconcile request is allowed to complete — which is precisely the F10 distinction.
 */
import { test, check, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, wait } from '../../harness/multi.mjs';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
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
const AUD = 'client-0693-t2';
const OIDC = Object.freeze({
  clientId: AUD, clientSecret: 'not-a-real-secret', issuer: ISS,
  authEndpoint: ISS + '/authorize', tokenEndpoint: ISS + '/token', jwksUri: ISS + '/certs',
  redirectUri: 'https://presenter.example.invalid/auth/callback',
});
const holder = {};
const oidcDeps = { fetchJwks: async () => [JWK], exchangeCode: async () => ({ id_token: holder.__t }) };
const ALLOWED = 'bruce@example.invalid';
const ALLOWLIST = Object.freeze({ [ALLOWED]: { role: 'presenter' } });

async function signIn(server) {
  const A = server._oidcAdapterForTest;
  const begin = A.beginLogin();
  holder.__t = mintJwt({
    iss: ISS, aud: AUD, sub: 'sub-of-' + ALLOWED, email: ALLOWED, name: 'Should Never Render',
    nonce: A._pending.get(begin.state).nonce, exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const r = await A.completeLogin({ code: 'c', state: begin.state });
  expect(r.ok === true, 'the seam minted a session', JSON.stringify(r));
  return r.sid;
}

/** What the page currently BELIEVES: the pill's classes and its readout. */
const pillState = (page) => page.evaluate(() => {
  const el = document.getElementById('ap-signin');
  const who = document.getElementById('ap-signin-who');
  const link = document.getElementById('ap-signin-link');
  return {
    shown: !!el && el.classList.contains('show'),
    signedIn: !!el && el.classList.contains('in'),
    readout: who ? who.textContent.trim() : null,
    offersSignIn: !!link && link.style.display !== 'none',
  };
});

/** Poll the page until `pred(state)` holds, or give up. Returns the last state either way. */
async function untilPill(page, pred, { timeout = 20000, label = 'pill' } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await pillState(page).catch(() => last);
    if (last && pred(last)) return last;
    await wait(250);
  }
  return last;
}

test('0693 AC11/AC1/F10 — one page, four servers: survives, ignores a blip, and shows signed-out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0693-t2-'));
  const keptStore = join(dir, 'kept.json');       // the store that REMEMBERS the sign-in
  const emptyStore = join(dir, 'empty.json');     // a store that has never heard of it
  const browser = await launch();
  let server = null, page = null;
  const boot = (opts) => createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST, ...opts });
  const reboot = async (port, sessionStoreFile) => {
    await server.close();
    server = await createServer({ port, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST, sessionStoreFile });
    return server;
  };
  try {
    /* ── PHASE 0 — signed in, on a page that is looking at it. ──────────────────────────────── */
    server = await boot({ sessionStoreFile: keptStore });
    const PORT = Number(new URL(server.url()).port);
    const sid = await signIn(server);

    page = await browser.newPage();
    page.on('pageerror', (e) => console.log('T2 PAGEERR', e.message));
    await page.setCookie({ url: server.url(), name: 'ap_sid', value: sid, path: '/' });
    await page.goto(server.url() + '/?userId=bruce&name=Chosen%20Name', { waitUntil: 'domcontentloaded' });

    let st = await untilPill(page, (s) => s.shown && s.signedIn, { timeout: 10000 });
    check('the page starts SIGNED IN', st && st.shown && st.signedIn, JSON.stringify(st));
    check('...and reads ✓ (authorized), not a name', st && st.readout === '✓', JSON.stringify(st));
    check('⛔ ...and the account name is nowhere on the page',
      !(await page.content()).includes('Should Never Render'), 'the account name rendered');

    /* ── PHASE 1 — A RESTART WITH THE STORE KEPT. AC1, through a real browser. ──────────────── */
    await reboot(PORT, keptStore);
    // Wait for the socket to come back (the LED is this page's own liveness readout).
    await page.waitForFunction(() => document.getElementById('led').classList.contains('on'), { timeout: 20000 }).catch(() => {});
    await wait(2500);   // past the reconcile debounce
    st = await pillState(page);
    check('⭐ AC1 — after a restart that KEPT the store, the page is still signed in', st.signedIn === true, JSON.stringify(st));
    check('...and still authorized', st.readout === '✓', JSON.stringify(st));

    /* ── PHASE 2 — ⛔ F10. The server no longer knows this session, but the page cannot ASK. ── */
    await page.setRequestInterception(true);
    const block = (req) => { if (req.url().includes('/api/auth-state')) req.abort().catch(() => {}); else req.continue().catch(() => {}); };
    page.on('request', block);
    await reboot(PORT, emptyStore);
    await page.waitForFunction(() => document.getElementById('led').classList.contains('on'), { timeout: 20000 }).catch(() => {});
    await wait(4000);
    st = await pillState(page);
    check('⛔ F10 — a REFUSED reconcile is NOT a logout: the page keeps its last known state',
      st.signedIn === true, JSON.stringify(st));

    /* ── PHASE 3 — AC11. Same server state; the only change is that the answer gets through. ── */
    page.off('request', block);
    await page.setRequestInterception(false);
    await reboot(PORT, emptyStore);
    await page.waitForFunction(() => document.getElementById('led').classList.contains('on'), { timeout: 20000 }).catch(() => {});
    st = await untilPill(page, (s) => s.signedIn === false, { timeout: 20000 });
    check('⭐ AC11 — a session the server does not recognise shows SIGNED OUT, promptly',
      st && st.signedIn === false, JSON.stringify(st));
    check('...and the sign-in link is offered again', st && st.offersSignIn === true, JSON.stringify(st));
    check('⛔ ...never a stale "signed in as …"', !(await page.content()).includes('Should Never Render'), 'a stale identity survived');
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * The SOURCE-LEVEL guards. Deterministic, and they hold even if the browser phase above flakes.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0693 T2/F10 — BOTH clients reconcile on (re)connect, debounced, and never log out on a failure', async () => {
  const files = [['presenter.html', readFileSync(join(APP, 'presenter.html'), 'utf8')],
                 ['control.html', readFileSync(join(APP, 'control.html'), 'utf8')]];
  for (const [name, src] of files) {
    check(`${name} reconciles from the socket's onopen — the ONLY place a restart is observable`,
      /onopen[\s\S]{0,600}?scheduleAuthReconcile\(\)/.test(src), 'ws.onopen does not reconcile');
    check(`${name} DEBOUNCES it (a reconnect storm must not become a request storm)`,
      /AUTH_RECONCILE_MIN_MS/.test(src) && /authPending/.test(src), 'no debounce');
    check(`⛔ ${name} treats a NON-2xx as a failure, not as an answer`,
      /if\s*\(\s*!r\.ok\s*\)\s*throw/.test(src), 'a 500 is being read as "signed out"');
    check(`⛔ ${name} — a FAILED request re-renders the LAST state, never null`,
      /\.catch\(function\(\)\s*\{[^}]*renderSignIn\(authStateLast\)/.test(src), 'a failed fetch signs the user out');
    check(`⛔ ${name} no longer renders the OIDC name claim`, !/\bst\.name\b/.test(src), 'the account name is still rendered');
    check(`${name} reads the \`self\` boolean instead`, /st\.self/.test(src), 'the client never reads the self boolean');
  }
});
