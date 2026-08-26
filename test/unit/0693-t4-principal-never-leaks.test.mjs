/*
 * Plan 0693 T4/T5 — ⛔ THE PRINCIPAL IS FOR AUTHORISATION ONLY, AND IT NEVER LEAVES THE SERVER.
 *
 * Bruce, 2026-08-26: *"Dont reveal actual OAuth login info - privacy violation."* The verified
 * principal (email, `sub`, the IdP's `name` claim) decides whether a connection may command Argus
 * and nothing else. It must not appear in presence, attendance, a roster, a seat or station label,
 * the session log, a log line, or any client payload. What a human sees is the chosen name
 * (plan 0692); what a UI may learn is a BOOLEAN — `self` — which cannot become an identifier later.
 *
 * ⛔ AC6 IS ASSERTED BY SCANNING WHOLE FRAMES, NOT ONE FIELD. Checking `payload.email === undefined`
 * proves nothing about `payload.rows[3].meta.who`. Every outbound websocket frame this connection
 * receives, and every agent/HTTP surface reachable from it, is serialised and searched for the
 * three strings the IdP asserted.
 *
 * Also asserted here, UNCHANGED and deliberately so (the plan forbids touching deriveConnTrust):
 *   AC2 verified + allowlisted ⇒ self · AC3 verified, not allowlisted ⇒ fenced, WITH the reason
 *   AC4 break-glass ⇒ participant, never command authority · AC5 loopback and password-only fenced
 *   AC7 a signed-out browser is unaffected in every respect
 */
import { test, check, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';
import { generateKeyPairSync, createSign } from 'node:crypto';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function mintJwt(payload) {
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }));
  const p = b64url(JSON.stringify(payload));
  return `${h}.${p}.${b64url(createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey))}`;
}
const ISS = 'https://idp.example.invalid';
const AUD = 'client-0693-t4';
const OIDC = Object.freeze({
  clientId: AUD, clientSecret: 'not-a-real-secret', issuer: ISS,
  authEndpoint: ISS + '/authorize', tokenEndpoint: ISS + '/token', jwksUri: ISS + '/certs',
  redirectUri: 'https://presenter.example.invalid/auth/callback',
});
const holder = {};
const oidcDeps = { fetchJwks: async () => [JWK], exchangeCode: async () => ({ id_token: holder.__t }) };

/* The three strings the IdP asserts. NONE of them may appear anywhere a client or an agent reads. */
const PRINCIPAL = Object.freeze({
  email: 'oidc-principal-0693@example.invalid',
  sub: 'sub-0693-DO-NOT-LEAK',
  name: 'Principal Displayname 0693',
});
const OTHER = Object.freeze({
  email: 'unlisted-0693@example.invalid',
  sub: 'sub-0693-unlisted',
  name: 'Unlisted Person 0693',
});
const ALLOWLIST = Object.freeze({ [PRINCIPAL.email]: { role: 'presenter' } });
/** Every substring that would betray a principal. `sub` is minted from the email, so cover both. */
const SECRETS = [PRINCIPAL.email, PRINCIPAL.sub, PRINCIPAL.name, OTHER.email, OTHER.sub, OTHER.name];

async function signIn(server, who) {
  const A = server._oidcAdapterForTest;
  const begin = A.beginLogin();
  holder.__t = mintJwt({
    iss: ISS, aud: AUD, sub: who.sub, email: who.email, name: who.name,
    nonce: A._pending.get(begin.state).nonce, exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const r = await A.completeLogin({ code: 'c', state: begin.state });
  expect(r.ok === true, 'the seam minted a session', JSON.stringify(r));
  return { sid: r.sid, cookie: `ap_sid=${r.sid}` };
}

/** A live socket that RECORDS EVERY FRAME it is sent — the raw material for the AC6 scan. */
async function connect(server, { hello = {}, headers = {} } = {}) {
  const ws = new WebSocket(server.url().replace('http', 'ws'), { headers });
  const raw = [];
  ws.on('message', (b) => raw.push(b.toString()));
  await new Promise((res, rej) => { ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', ...hello })); res(); }); ws.on('error', rej); });
  await wait(200);
  return {
    ws, raw,
    frames: () => raw.map((s) => { try { return JSON.parse(s); } catch { return {}; } }),
    welcome: () => raw.map((s) => { try { return JSON.parse(s); } catch { return {}; } }).find((f) => f.t === 'welcome'),
    say: async (text) => { ws.send(JSON.stringify({ t: 'chat', text })); await wait(150); },
  };
}
const text = async (url, opts) => fetch(url, opts).then((r) => r.text()).catch(() => '');

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * AC6 — the leak scan, over WHOLE frames and whole payloads.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0693 AC6 — no email, sub or account name appears in ANY outbound frame or agent payload', async () => {
  const server = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST });
  let self = null, unlisted = null;
  try {
    const me = await signIn(server, PRINCIPAL);
    const them = await signIn(server, OTHER);
    /* Both sign in AND join the room, so the scan covers the identity path AND the roster path.
       The chosen names below are what a human is meant to see — they are client-supplied. */
    self = await connect(server, { hello: { userId: 'seat-a', userName: 'Chosen Name A', role: 'presenter' }, headers: { cookie: me.cookie } });
    unlisted = await connect(server, { hello: { userId: 'seat-b', userName: 'Chosen Name B' }, headers: { cookie: them.cookie } });
    await self.say('argus, hello');
    await unlisted.say('hello everyone');
    await wait(200);

    /* ── (1) EVERY WEBSOCKET FRAME, whole, as bytes. Not one field. ────────────────────────── */
    const wire = self.raw.join('\n') + '\n' + unlisted.raw.join('\n');
    check('the scan has something to scan (frames really arrived)', self.raw.length > 0 && unlisted.raw.length > 0, `${self.raw.length}/${unlisted.raw.length}`);
    for (const secret of SECRETS) {
      check(`⛔ no websocket frame contains ${JSON.stringify(secret)}`, !wire.includes(secret), wire.slice(0, 400));
    }

    /* ── (2) EVERY HTTP SURFACE a browser or an agent can reach. ──────────────────────────── */
    const surfaces = {
      'auth-state (signed in)': await text(server.url() + '/api/auth-state', { headers: { cookie: me.cookie } }),
      'auth-state (unlisted)': await text(server.url() + '/api/auth-state', { headers: { cookie: them.cookie } }),
      'auth-state (anonymous)': await text(server.url() + '/api/auth-state'),
      'debug': await text(server.url() + '/api/debug'),
      'situation': await text(server.url() + '/api/situation?c=t4'),
      'presence (api)': JSON.stringify(server.presence()),
      'attendance (ai view)': JSON.stringify(server.attendance({ viewerRole: 'ai' })),
      'attendance (participant view)': JSON.stringify(server.attendance({ viewerRole: 'participant' })),
      'debugDump': JSON.stringify(server.debugDump('presenter')),
      'inbox': JSON.stringify(server.getInbox()),
    };
    for (const [where, body] of Object.entries(surfaces)) {
      for (const secret of SECRETS) {
        check(`⛔ ${where} does not contain ${JSON.stringify(secret)}`, !String(body).includes(secret), String(body).slice(0, 300));
      }
    }

    /* ── (3) THE LOG RING, which /api/debug serves — the surface the voice-denial line was on. ── */
    const ring = JSON.stringify(server.debugDump('presenter')) + (await text(server.url() + '/api/debug'));
    for (const secret of SECRETS) {
      check(`⛔ no log line carries ${JSON.stringify(secret)}`, !ring.includes(secret), ring.slice(0, 300));
    }
    /* ⛔ AND THE SESSION LOG. The plan names it explicitly; it must never become a principal store. */
    const slog = JSON.stringify(server.sessionLog.status());
    for (const secret of SECRETS) check(`⛔ the session log status does not carry ${JSON.stringify(secret)}`, !slog.includes(secret), slog);
  } finally {
    if (self) self.ws.close();
    if (unlisted) unlisted.ws.close();
    await server.close();
  }
});

test('0693 AC6 — the scan itself is real: a planted identifier WOULD be caught', async () => {
  // ⛔ A negative test that can never fail is not evidence. This proves the predicate has teeth.
  const wire = JSON.stringify({ t: 'presence', users: [{ userName: 'x', meta: { who: PRINCIPAL.email } }] });
  check('a principal buried three levels down IS detected', wire.includes(PRINCIPAL.email));
  check('...and the scan is over the WHOLE frame, not a top-level key', !('email' in JSON.parse(wire)));
});

test('0693 AC6 — the VOICE DENIAL line used to carry an email; the ring is scanned directly', async () => {
  /*
   * ⛔ THE ONE THAT ALMOST GOT AWAY. `voiceAllowedFor` logged `{ key: ctx.verified.email }` on every
   * denial for a signed-in person — added deliberately on 2026-08-25 because "the failure mode is
   * almost always that it is not the one on the list". The log ring is served (api.debugDump →
   * opLog → presenter_debug), so that put a live principal on a client-reachable surface.
   * ⭐ THE DIAGNOSTIC IS KEPT WITHOUT THE IDENTIFIER: a short one-way fingerprint an operator can
   *   reproduce with `printf %s "$email" | sha256sum`, plus the booleans that say which half failed.
   * This test reads log.tail() DIRECTLY, so it cannot be satisfied by a redaction one layer up.
   */
  const logmod = await import('../../app/log.mjs');
  const server = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST });
  try {
    const me = await signIn(server, PRINCIPAL);
    logmod.clear();
    const st = await fetch(server.url() + '/api/auth-state', { headers: { cookie: me.cookie } }).then((r) => r.json());
    check('the person IS signed in and allowlisted, but has no voice grant', st.self === true && st.voice === false, JSON.stringify(st));
    const ring = logmod.tail(200);
    const denial = ring.find((e) => e.tag === 'voice' && e.msg === 'not-granted');
    check('the denial really was logged (this scan is not vacuous)', !!denial, JSON.stringify(ring.map((e) => e.tag + '/' + e.msg)));
    const raw = JSON.stringify(ring);
    for (const secret of SECRETS) check(`⛔ the log ring does not carry ${JSON.stringify(secret)}`, !raw.includes(secret), raw.slice(0, 400));
    check('⭐ ...and the diagnostic survives: a fingerprint plus which half is wrong',
      denial && typeof denial.fields.keyFingerprint === 'string' && denial.fields.keyPresent === true
      && denial.fields.allowed === true && denial.fields.voiceFlag === false, JSON.stringify(denial && denial.fields));
    check('⛔ the fingerprint is short and one-way, not an identifier',
      denial && /^[0-9a-f]{8}$/.test(denial.fields.keyFingerprint), JSON.stringify(denial && denial.fields));
  } finally { await server.close(); }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * AC8 / AC9 / T5 — what a payload MAY say: a chosen name, and a boolean.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0693 AC8/AC9 — presence and attendance carry the CHOSEN name and a `self` boolean, never who', async () => {
  const server = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST });
  let a = null, b = null;
  try {
    const me = await signIn(server, PRINCIPAL);
    const them = await signIn(server, OTHER);
    a = await connect(server, { hello: { userId: 'seat-a', userName: 'Chosen Name A' }, headers: { cookie: me.cookie } });
    b = await connect(server, { hello: { userId: 'seat-b', userName: 'Chosen Name B' }, headers: { cookie: them.cookie } });
    await wait(150);

    const pres = server.presence();
    const rowA = pres.find((r) => r.userId === 'seat-a');
    const rowB = pres.find((r) => r.userId === 'seat-b');
    check('AC8 — presence shows the CHOSEN name', rowA && rowA.userName === 'Chosen Name A', JSON.stringify(rowA));
    check('AC8 — ⛔ ...and never the IdP name claim', rowA && rowA.userName !== PRINCIPAL.name, JSON.stringify(rowA));
    check('AC9/T5 — presence says WHETHER the connection is self', rowA && rowA.self === true, JSON.stringify(rowA));
    check('AC9/T5 — ...and false for one that is fenced', rowB && rowB.self === false, JSON.stringify(rowB));
    check('AC9 — ⛔ ...and carries no identifier key at all',
      rowA && ['email', 'sub', 'principal', 'sid'].every((k) => !(k in rowA)), JSON.stringify(Object.keys(rowA || {})));

    const att = server.attendance({ viewerRole: 'ai' }).roster;
    const attA = att.find((r) => r.userId === 'seat-a');
    check('AC9 — attendance reports self:true|false', attA && attA.self === true, JSON.stringify(attA));
    check('AC9 — ⛔ ...and no identifier', attA && ['email', 'sub', 'principal', 'sid'].every((k) => !(k in attA)), JSON.stringify(Object.keys(attA || {})));

    /* ⛔ THE PARTICIPANT VIEW DELIBERATELY DOES NOT SAY WHO IS AN ADMIN. `self` rides the
       CONTROL rows (like ip/socketId), because a roster that names the room's authorized accounts
       to everyone in it is a different disclosure than the one this row exists for. */
    const seen = server.attendance({ viewerRole: 'participant' }).roster.find((r) => r.userId === 'seat-a');
    check('⛔ the participant-redacted roster does not publish who holds command authority',
      seen && !('self' in seen), JSON.stringify(seen));
  } finally { if (a) a.ws.close(); if (b) b.ws.close(); await server.close(); }
});

test('0693 T5 — /api/auth-state says WHETHER this connection is self, and never WHO', async () => {
  const server = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST });
  try {
    const me = await signIn(server, PRINCIPAL);
    const them = await signIn(server, OTHER);
    const mine = await fetch(server.url() + '/api/auth-state', { headers: { cookie: me.cookie } }).then((r) => r.json());
    const theirs = await fetch(server.url() + '/api/auth-state', { headers: { cookie: them.cookie } }).then((r) => r.json());
    const anon = await fetch(server.url() + '/api/auth-state').then((r) => r.json());
    check('allowlisted ⇒ self:true', mine.self === true && mine.trust === 'self', JSON.stringify(mine));
    check('fenced ⇒ self:false', theirs.self === false && theirs.trust === 'participant', JSON.stringify(theirs));
    check('anonymous ⇒ self:false', anon.self === false, JSON.stringify(anon));
    check('⛔ `self` is a BOOLEAN, never an identifier', typeof mine.self === 'boolean' && typeof theirs.self === 'boolean');
    check('⛔ and the payload has no name/email/sub key at all',
      ['name', 'email', 'sub', 'sid', 'principal'].every((k) => !(k in mine) && !(k in theirs) && !(k in anon)),
      JSON.stringify(Object.keys(mine)));
  } finally { await server.close(); }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * AC2–AC5 — deriveConnTrust is UNCHANGED by this plan, and that is asserted rather than assumed.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0693 AC2/AC3 — verified+allowlisted ⇒ self; verified and NOT ⇒ fenced, with the reason', async () => {
  const server = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST });
  let a = null, b = null;
  try {
    const me = await signIn(server, PRINCIPAL);
    const them = await signIn(server, OTHER);
    a = await connect(server, { hello: { userId: 'ok' }, headers: { cookie: me.cookie } });
    b = await connect(server, { hello: { userId: 'no' }, headers: { cookie: them.cookie } });
    check('AC2 — verified AND allowlisted ⇒ TRUST.SELF', a.welcome().trust === 'self', JSON.stringify(a.welcome()));
    check('AC3 — verified and NOT allowlisted ⇒ participant', b.welcome().trust === 'participant', JSON.stringify(b.welcome()));
    check('AC3 — ...with reason "signed in, not authorized"', b.welcome().authReason === 'signed in, not authorized', JSON.stringify(b.welcome()));
  } finally { if (a) a.ws.close(); if (b) b.ws.close(); await server.close(); }
});

test('0693 AC4 — BREAK-GLASS opens the Control page and is STILL never command authority', async () => {
  const server = await createServer({
    port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST,
    breakGlass: { token: 'break-glass-secret-0693', ttlMs: 60_000 },
  });
  let c = null;
  try {
    // The test connects from 127.0.0.1 with no forwarding header ⇒ a TRUE loopback caller.
    const res = await fetch(server.url() + '/auth/break-glass', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'break-glass-secret-0693' }),
    });
    check('the credential was accepted', res.status === 200, `status ${res.status}`);
    const setCookie = res.headers.get('set-cookie') || '';
    const bg = setCookie.split(';')[0];
    check('...and it set a break-glass cookie', /^ap_bg=/.test(bg), setCookie);

    c = await connect(server, { hello: { userId: 'bg' }, headers: { cookie: bg } });
    check('AC4 — break-glass ⇒ TRUST.PARTICIPANT, unchanged', c.welcome().trust === 'participant', JSON.stringify(c.welcome()));
    check('AC4 — ...and it says so: control page only, never command authority',
      /break-glass/.test(c.welcome().authReason || ''), JSON.stringify(c.welcome()));
    const st = await fetch(server.url() + '/api/auth-state', { headers: { cookie: bg } }).then((r) => r.json());
    check('AC4 — ...and auth-state agrees: signed in, self FALSE', st.signedIn === true && st.self === false, JSON.stringify(st));
    check('⛔ ...and the break-glass secret is nowhere in the payload', !JSON.stringify(st).includes('break-glass-secret-0693'), JSON.stringify(st));
  } finally { if (c) c.ws.close(); await server.close(); }
});

test('0693 AC5 — loopback alone and password-only are STILL fenced', async () => {
  const server = await createServer({ port: 0, controlToken: 'sekret-0693', oidc: OIDC, oidcDeps, allowlist: ALLOWLIST });
  let local = null, pw = null, remote = null;
  try {
    // (a) LOOPBACK. This test process connects from 127.0.0.1 with no forwarding header.
    local = await connect(server, { hello: { userId: 'local' } });
    check('AC5 — loopback alone NEVER grants self', local.welcome().trust === 'participant', JSON.stringify(local.welcome()));

    // (b) PASSWORD-ONLY, locally: the control token opens the Control page and grants no authority.
    pw = await connect(server, { hello: { userId: 'pw', role: 'presenter', token: 'sekret-0693' } });
    check('...the credential DID open the Control page', pw.welcome().role === 'presenter', JSON.stringify(pw.welcome()));
    check('AC5 — ...and its command trust is STILL participant', pw.welcome().trust === 'participant', JSON.stringify(pw.welcome()));

    // (c) PASSWORD-ONLY, remote (through the tunnel): the same, with a forwarding header present.
    remote = await connect(server, { hello: { userId: 'remote', role: 'presenter', token: 'sekret-0693' }, headers: { 'x-forwarded-for': '203.0.113.9' } });
    check('AC5 — ...remote password-only is fenced too', remote.welcome().trust === 'participant', JSON.stringify(remote.welcome()));
    check('...and presence marks none of them self', server.presence().every((r) => r.self === false), JSON.stringify(server.presence()));
  } finally { for (const c of [local, pw, remote]) if (c) c.ws.close(); await server.close(); }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * AC7 — a signed-out browser is unaffected in every respect.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0693 AC7 — a signed-out browser is unaffected: same trust, same page, same payload shape', async () => {
  const server = await createServer({ port: 0, oidc: OIDC, oidcDeps, allowlist: ALLOWLIST });
  let anon = null;
  try {
    anon = await connect(server, { hello: { userId: 'anon', userName: 'Anonymous' } });
    const w = anon.welcome();
    check('AC7 — welcome arrives normally', !!w && w.userId === 'anon', JSON.stringify(w));
    check('AC7 — ...fenced participant, exactly as before', w.trust === 'participant' && !w.authReason, JSON.stringify(w));
    check('AC7 — ...and no re-auth prompt (there was no session to lapse)', !w.reauth, JSON.stringify(w));
    const st = await fetch(server.url() + '/api/auth-state').then((r) => r.json());
    check('AC7 — auth-state: oidcActive true, signedIn false, self false, and NOTHING else new',
      st.oidcActive === true && st.signedIn === false && st.self === false && !('reauth' in st), JSON.stringify(st));
    const row = server.presence().find((r) => r.userId === 'anon');
    check('AC7 — presence row is the ordinary one, with self:false', row && row.self === false && row.userName === 'Anonymous', JSON.stringify(row));
    const html = await text(server.url() + '/');
    check('AC7 — the display page still serves', html.includes('id="ap-signin"'), html.slice(0, 120));
  } finally { if (anon) anon.ws.close(); await server.close(); }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⛔ THE NEGATIVE CONSTRAINT GUARD (§5): deriveConnTrust's LOGIC and ORDER are untouched.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0693 §5 — deriveConnTrust still fences break-glass BEFORE the allowlist, and reads no client claim', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../../app/server.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function deriveConnTrust'), src.indexOf('function deriveConnTrust') + 2000);
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 5);
  check('the function is still there to read', body.includes('deriveConnTrust'), body.slice(0, 80));
  const iCap = body.indexOf('capGrant ||');
  const iBg = body.indexOf("provider === 'break-glass'");
  const iAllow = body.indexOf('AUTH_ALLOWLIST.lookup');
  const iExpired = body.indexOf('sessionExpired');
  check('⛓ ORDER UNCHANGED: cap ⇒ guest, then break-glass, then the allowlist, then expiry',
    iCap > -1 && iBg > iCap && iAllow > iBg && iExpired > iAllow, JSON.stringify({ iCap, iBg, iAllow, iExpired }));
  check('⛔ it reads NO header, NO password and NO role', !/headers|rolePassword|CONTROL_TOKEN/.test(body), body);
  check('⛔ and being signed in is still not being authorized (the lookup survives)',
    /al\.allowed/.test(body), body);
});
