/*
 * Plan 0692 AC9 — ⛔ THE ACCOUNT NAME LABELS NOBODY, ANYWHERE.
 *
 * ⛔ Bruce, 2026-08-26: "Dont reveal actual OAuth login info - privacy violation."
 *
 * ⭐ THE DISTINCTION THAT MAKES THIS A DESIGN AND NOT A REDACTION: the identity provider
 *   AUTHORISES; it does not LABEL. A verified principal decides what a connection may DO, and stays
 *   server-side. The name a room sees is one a human CHOSE and typed. Plan 0693 already took the
 *   name claim out of `/api/auth-state`; plan 0692 is what fills the gap it left — and the whole
 *   value of that is lost the moment the account name is offered back as a convenient default.
 *
 * ⇒ THE PROHIBITION IS ON EVERY SURFACE AT ONCE, so this test looks at all of them for one
 *   signed-in fixture: the rendered page, the name FIELD, its PLACEHOLDER, the presence roster,
 *   the server's own debug view, and the durable session log on disk.
 *
 * ⚠ The fixture's `name` claim is the string 'Should Never Render' precisely so that a single grep
 *   over each surface is a complete assertion.
 */
import { test, check, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, wait } from '../../harness/multi.mjs';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function mintJwt(payload) {
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }));
  const p = b64url(JSON.stringify(payload));
  return `${h}.${p}.${b64url(createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey))}`;
}
const ISS = 'https://idp.example.invalid';
const AUD = 'client-0692-ac9';
const OIDC = Object.freeze({
  clientId: AUD, clientSecret: 'not-a-real-secret', issuer: ISS,
  authEndpoint: ISS + '/authorize', tokenEndpoint: ISS + '/token', jwksUri: ISS + '/certs',
  redirectUri: 'https://presenter.example.invalid/auth/callback',
});
const holder = {};
const oidcDeps = { fetchJwks: async () => [JWK], exchangeCode: async () => ({ id_token: holder.__t }) };

/* ⛔ Both of these are account facts, and NEITHER may become a label. */
const ACCOUNT_NAME = 'Should Never Render';
const ACCOUNT_EMAIL = 'bruce@example.invalid';
const ALLOWLIST = Object.freeze({ [ACCOUNT_EMAIL]: { role: 'presenter' } });

async function signIn(server) {
  const A = server._oidcAdapterForTest;
  const begin = A.beginLogin();
  holder.__t = mintJwt({
    iss: ISS, aud: AUD, sub: 'sub-of-' + ACCOUNT_EMAIL, email: ACCOUNT_EMAIL, name: ACCOUNT_NAME,
    nonce: A._pending.get(begin.state).nonce, exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const r = await A.completeLogin({ code: 'c', state: begin.state });
  expect(r.ok === true, 'the seam minted a session', JSON.stringify(r));
  return r.sid;
}

/** Every file the session log left on disk, concatenated. Empty string when it wrote nothing. */
function readSessionLog(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const abs = join(d, e);
      if (statSync(abs).isDirectory()) walk(abs); else out.push(readFileSync(abs, 'utf8'));
    }
  };
  try { walk(dir); } catch { /* nothing written is a legitimate outcome */ }
  return out.join('\n');
}

test('0692 AC9 — a SIGNED-IN visitor is still unnamed, and the account name is on no surface at all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0692-ac9-'));
  const logDir = join(dir, 'sessionlog');
  const browser = await launch();
  let server = null, page = null;
  try {
    server = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST, sessionLogDir: logDir });
    const sid = await signIn(server);

    page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setCookie({ url: server.url(), name: 'ap_sid', value: sid, path: '/' });
    await page.goto(server.url() + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__apIdentity && document.getElementById('led').classList.contains('on'), { timeout: 20000 });
    /* Let the sign-in pill reconcile — the point of the fixture is that the page KNOWS it is signed
       in and STILL has no name to show. Without the wait this would pass for the wrong reason. */
    await page.waitForFunction(() => document.getElementById('ap-signin').classList.contains('in'), { timeout: 20000 })
      .catch(() => {});
    await wait(400);

    const signedIn = await page.evaluate(() => document.getElementById('ap-signin').classList.contains('in'));
    check('the fixture really is signed in (otherwise this test proves nothing)', signedIn === true, String(signedIn));

    /* ── 1. THE IDENTITY ITSELF. Signing in does not name you. ─────────────────────────────── */
    const id = await page.evaluate(() => ({
      userId: window.__apIdentity.userId(), userName: window.__apIdentity.userName(),
      named: window.__apIdentity.named(), hint: window.__apIdentity.hint(),
    }));
    check('⭐ AC9 — a SIGNED-IN visitor is still UNNAMED: the IdP authorises, it does not label',
      id.named === false && !id.userName, JSON.stringify(id));
    check('⛔ AC9 — the account name is not the userName', id.userName !== ACCOUNT_NAME, String(id.userName));
    check('⛔ AC9 — nor is the email', id.userName !== ACCOUNT_EMAIL, String(id.userName));

    /* ── 2. THE FIELD AND ITS PLACEHOLDER. Never prefilled, never offered. ─────────────────── */
    await page.evaluate(() => window.__apNameEditor.begin());
    const ed = await page.evaluate(() => ({
      value: document.getElementById('cfg-name-input').value,
      placeholder: document.getElementById('cfg-name-input').placeholder,
      readout: window.__apNameEditor.readout(),
    }));
    check('⛔ AC9 — the name field opens EMPTY, not prefilled with the account name', ed.value === '', ed.value);
    check('⛔ AC9 — and its placeholder is the neutral uid-derived hint, not a real name',
      ed.placeholder === 'Guest ' + id.userId.slice(-4), ed.placeholder);
    check('⛔ AC9 — the placeholder is not the account name or email',
      ed.placeholder !== ACCOUNT_NAME && ed.placeholder !== ACCOUNT_EMAIL, ed.placeholder);
    check('⛔ AC9 — and the row does not read it out either',
      ed.readout.indexOf(ACCOUNT_NAME) < 0 && ed.readout.indexOf(ACCOUNT_EMAIL) < 0, ed.readout);

    /* ── 3. THE WHOLE RENDERED PAGE — including chrome, tooltips and title attributes. ─────── */
    const html = await page.content();
    check('⛔ AC9 — the account NAME appears nowhere in the served/rendered page',
      html.indexOf(ACCOUNT_NAME) < 0, 'the account name rendered');
    check('⛔ AC9 — and the EMAIL appears nowhere either', html.indexOf(ACCOUNT_EMAIL) < 0, 'the email rendered');

    /* ── 4. PRESENCE — the roster everybody else reads. ────────────────────────────────────── */
    const roster = JSON.stringify(server.presence());
    check('⛔ AC9 — presence carries neither the account name nor the email',
      roster.indexOf(ACCOUNT_NAME) < 0 && roster.indexOf(ACCOUNT_EMAIL) < 0, roster);

    /* ── 5. AND AFTER NAMING YOURSELF, the chosen name is what travels. ────────────────────── */
    await page.evaluate(() => window.__apIdentity.setName('A Name I Chose'));
    await wait(400);
    const roster2 = JSON.stringify(server.presence());
    check('⭐ AC9 — the roster shows the CHOSEN name', roster2.indexOf('A Name I Chose') >= 0, roster2);
    check('⛔ AC9 — and still not the account name', roster2.indexOf(ACCOUNT_NAME) < 0, roster2);

    /* ── 6. THE DURABLE SESSION LOG. The surface that outlives the session. ────────────────── */
    await server.close(); server = null;      // flush
    const log = readSessionLog(logDir);
    check('⛔ AC9 — the session log on disk carries neither the account name nor the email',
      log.indexOf(ACCOUNT_NAME) < 0 && log.indexOf(ACCOUNT_EMAIL) < 0,
      log.slice(0, 400));

    check('⛔ and nothing threw while proving all that', errors.length === 0, errors.join(' · '));
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
