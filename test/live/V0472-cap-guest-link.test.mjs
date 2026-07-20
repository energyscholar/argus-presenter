/*
 * Plan 0472 Phase 4 — permissioned guest capability link (SECURITY-SENSITIVE).
 *
 * A signed, scoped, revocable `/?cap=<token>` link grants a GUEST a `participant` identity that may
 * talk/type into the session (input flows to the unified inbox, ATTRIBUTED) but may NEVER drive any
 * presenter effect — Argus mediates every effect. These tests are the red-team acceptance surface:
 *   T-CAP-VERIFY   valid/unexpired/unrevoked ⇒ role=participant + encoded scope + name; input reaches inbox.
 *   T-CAP-TAMPER   any payload edit / bad HMAC ⇒ NO grant (and no crash on garbage).
 *   T-CAP-EXPIRY   exp in the past ⇒ rejected.
 *   T-CAP-REVOKE   revoked nonce ⇒ rejected though otherwise valid.
 *   T-CAP-SCOPE    guest may speak/type but push/poll/reload/drive is REFUSED; cannot claim presenter (#4,#7).
 *   T-CAP-NOSECRET no PRESENTER_CAP_SECRET configured ⇒ ALL cap tokens rejected (links disabled).
 *
 * Raw-WS (no browser) so the hello frame — including a forged/tampered `cap` — is crafted directly.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { until, wait } from '../../harness/multi.mjs';
import { mintCapability } from '../../lib/capability.mjs';
import { WebSocket } from 'ws';

const SECRET = 'test-cap-secret-do-not-use-in-prod';
const future = () => Math.floor(Date.now() / 1000) + 300;
const past = () => Math.floor(Date.now() / 1000) - 30;

// MINT helper: a valid token given the secret. `over` overrides any payload field.
function mkTok(over = {}, secret = SECRET) {
  const payload = Object.assign(
    { v: 1, sid: 's1', role: 'participant', scope: ['speak', 'type'], name: 'Dana', exp: future(), nonce: 'n-' + Math.random().toString(36).slice(2, 8) },
    over,
  );
  return { token: mintCapability(payload, secret), payload };
}

// Open a WS, send hello, resolve on `welcome`. Returns { ws, msgs, welcome }.
function connect(wsUrl, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const msgs = [];
    const to = setTimeout(() => reject(new Error('no welcome (server may have crashed on hello)')), 5000);
    ws.on('message', (b, bin) => {
      if (bin) return;
      let m; try { m = JSON.parse(b.toString()); } catch { return; }
      msgs.push(m);
      if (m.t === 'welcome') { clearTimeout(to); resolve({ ws, msgs, welcome: m }); }
    });
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

test('T-CAP-VERIFY — valid unexpired unrevoked token grants role=participant + scope + name; input reaches inbox (attributed)', async () => {
  const server = await createServer({ port: 0, capSecret: SECRET });
  const wsUrl = server.url().replace('http', 'ws');
  try {
    const { token, payload } = mkTok({ scope: ['speak', 'type'], name: 'Dana', nonce: 'verify-1' });
    const g = await connect(wsUrl, { cap: token });

    expect(g.welcome.role === 'participant', 'welcome grants participant', g.welcome.role);
    expect(g.welcome.guest === true, 'welcome marks the connection as a guest', g.welcome.guest);
    expect(JSON.stringify(g.welcome.scope) === JSON.stringify(['speak', 'type']), 'welcome carries the encoded scope', JSON.stringify(g.welcome.scope));
    await until(() => server.presence().some((u) => u.userName === 'Dana' && u.role === 'participant'), { label: 'presence shows the token name as a participant', timeout: 4000 });

    // Guest types → lands in the unified inbox, attributed to the TOKEN identity (not client-claimed).
    g.ws.send(JSON.stringify({ t: 'chat', text: 'hi from guest' }));
    await until(() => server.getInbox(0).items.some((i) => i.text === 'hi from guest'), { label: 'guest text reached the inbox', timeout: 4000 });
    const item = server.getInbox(0).items.find((i) => i.text === 'hi from guest');
    expect(item.role === 'participant' && item.userName === 'Dana' && item.userId === 'guest:' + payload.nonce,
      'inbox item is attributed to the guest capability identity', JSON.stringify(item));

    // NO-ESCALATE: a token whose payload claims role:'ai' (and a hello also claiming ai) is STILL participant.
    const evil = mkTok({ role: 'ai', name: 'Mallory', nonce: 'verify-evil' }).token;
    const g2 = await connect(wsUrl, { cap: evil, role: 'ai' });
    expect(g2.welcome.role === 'participant', 'payload role:ai + hello role:ai is HARD-FORCED to participant', g2.welcome.role);
    g.ws.close(); g2.ws.close();
  } finally { await server.close(); }
});

test('T-CAP-TAMPER — any payload edit / bad HMAC ⇒ no grant; garbage tokens do not crash the connection', async () => {
  const server = await createServer({ port: 0, capSecret: SECRET });
  const wsUrl = server.url().replace('http', 'ws');
  try {
    const { token } = mkTok({ nonce: 'tamper-1' });
    const [p, s] = token.split('.');
    // Flip one payload char (breaks the HMAC).
    const flipped = p.slice(0, -1) + (p.slice(-1) === 'A' ? 'B' : 'A') + '.' + s;
    const g = await connect(wsUrl, { cap: flipped, userId: 'x', userName: 'X' });
    expect(g.welcome.guest !== true && g.welcome.scope == null, 'tampered payload grants NO guest identity', JSON.stringify(g.welcome));
    expect(g.welcome.userId !== 'guest:tamper-1', 'tampered token does not adopt the token identity', g.welcome.userId);

    // Swapped/garbage signature.
    const badSig = p + '.' + 'AAAA';
    const g2 = await connect(wsUrl, { cap: badSig });
    expect(g2.welcome.guest !== true, 'bad signature ⇒ no grant', JSON.stringify(g2.welcome));

    // Total garbage — must NOT throw/crash the connection (welcome still arrives).
    const g3 = await connect(wsUrl, { cap: 'not-a-real-token' });
    expect(g3.welcome && g3.welcome.role === 'participant', 'garbage cap handled cleanly, plain participant', JSON.stringify(g3.welcome));
    const g4 = await connect(wsUrl, { cap: '....' });
    expect(g4.welcome && g4.welcome.guest !== true, 'malformed cap handled cleanly', JSON.stringify(g4.welcome));
    g.ws.close(); g2.ws.close(); g3.ws.close(); g4.ws.close();
  } finally { await server.close(); }
});

test('T-CAP-EXPIRY — a token whose exp is in the past is rejected', async () => {
  const server = await createServer({ port: 0, capSecret: SECRET });
  const wsUrl = server.url().replace('http', 'ws');
  try {
    const { token } = mkTok({ exp: past(), nonce: 'exp-1' });
    const g = await connect(wsUrl, { cap: token });
    expect(g.welcome.guest !== true && g.welcome.scope == null, 'expired token grants nothing', JSON.stringify(g.welcome));
    g.ws.close();
  } finally { await server.close(); }
});

test('T-CAP-REVOKE — a revoked nonce is rejected even though HMAC + exp are valid', async () => {
  const server = await createServer({ port: 0, capSecret: SECRET });
  const wsUrl = server.url().replace('http', 'ws');
  try {
    const { token, payload } = mkTok({ nonce: 'revoke-1' });
    // Before revocation the token WORKS (proves it is otherwise valid).
    const g0 = await connect(wsUrl, { cap: token });
    expect(g0.welcome.guest === true, 'token is valid before revocation', JSON.stringify(g0.welcome));
    g0.ws.close();

    // Revoke via the server API, then the SAME token is rejected.
    server.revokeCap(payload.nonce);
    expect(server.isCapRevoked(payload.nonce) === true, 'server records the revoked nonce');
    const g1 = await connect(wsUrl, { cap: token });
    expect(g1.welcome.guest !== true && g1.welcome.scope == null, 'revoked token grants nothing', JSON.stringify(g1.welcome));
    g1.ws.close();
  } finally { await server.close(); }
});

test('T-CAP-SCOPE — guest may speak/type but push/poll/reload/drive is REFUSED, and a cap never bypasses the control gate', async () => {
  // GATED server (role password set): proves the capability path is INDEPENDENT of the control gate (#7).
  const server = await createServer({ port: 0, capSecret: SECRET, rolePassword: 'pw' });
  const wsUrl = server.url().replace('http', 'ws');
  try {
    const { token } = mkTok({ scope: ['speak', 'type'], name: 'Guest', nonce: 'scope-1' });
    // Guest ALSO tries to claim presenter with a WRONG password — must stay participant.
    const g = await connect(wsUrl, { cap: token, role: 'presenter', token: 'wrong-hash' });
    expect(g.welcome.role === 'participant', 'guest cap cannot become presenter even claiming role + wrong token (#4/#7)', g.welcome.role);

    // A second, ordinary participant to observe whether a guest drive-attempt reaches anyone.
    const victim = await connect(wsUrl, { userId: 'v1', userName: 'V1' });
    const victimReloads = () => victim.msgs.filter((m) => m.t === 'reload').length;
    const reloadsBefore = victimReloads();

    // ALLOWED: guest types → inbox item.
    g.ws.send(JSON.stringify({ t: 'chat', text: 'guest speaks' }));
    await until(() => server.getInbox(0).items.some((i) => i.text === 'guest speaks'), { label: 'guest text reached the inbox', timeout: 4000 });

    // REFUSED: guest tries to drive the presenter — open_poll, push_component, reload_clients.
    g.ws.send(JSON.stringify({ t: 'control', action: 'open_poll', args: { promptId: 'p1', prompt: '?', options: ['a', 'b'] } }));
    g.ws.send(JSON.stringify({ t: 'control', action: 'push_component', args: { target: 'all', component: 'note', opts: { text: 'pwn' } } }));
    g.ws.send(JSON.stringify({ t: 'control', action: 'reload_clients', args: { target: 'all' } }));
    await wait(250);
    expect(server.store.get('polls/p1/spec') === undefined, 'guest open_poll REFUSED (no poll created)', server.store.get('polls/p1/spec'));
    expect(server.getPoll('p1').count === 0, 'no poll tally for the guest-attempted poll', server.getPoll('p1').count);
    expect(victimReloads() === reloadsBefore, 'guest reload_clients REFUSED (victim received no reload)', victimReloads());

    g.ws.close(); victim.ws.close();
  } finally { await server.close(); }
});

test('T-CAP-NOSECRET — with no PRESENTER_CAP_SECRET configured, ALL cap tokens are rejected (links disabled)', async () => {
  const saved = process.env.PRESENTER_CAP_SECRET;
  delete process.env.PRESENTER_CAP_SECRET;
  const server = await createServer({ port: 0 });   // NO capSecret option, NO env ⇒ disabled
  const wsUrl = server.url().replace('http', 'ws');
  try {
    expect(server.capEnabled() === false, 'capability links report DISABLED with no secret');
    const { token } = mkTok({ nonce: 'nosecret-1' });   // a perfectly-signed token (some secret)
    const g = await connect(wsUrl, { cap: token, userId: 'z', userName: 'Z' });
    expect(g.welcome.guest !== true && g.welcome.scope == null, 'cap ignored entirely when links are disabled', JSON.stringify(g.welcome));
    expect(g.welcome.userId === 'z', 'connection is a plain participant, not the token identity', g.welcome.userId);
    g.ws.close();
  } finally {
    await server.close();
    if (saved !== undefined) process.env.PRESENTER_CAP_SECRET = saved;
  }
});
