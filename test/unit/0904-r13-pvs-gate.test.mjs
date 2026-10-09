/*
 * Plan 0904 R13 — THE TRANSCRIPT SUBSCRIBER FAILS CLOSED.
 *
 * `pvs_subscribe` turned any socket into a reader of the whole transcript feed, with no credential
 * at all: the handler checked no role, token or capability. The feed carries every participant's
 * words, so it is gated exactly like the other control-role readers (the `transcript` frame to
 * presenter/ai, /api/situation): a subscriber must be a CONTROL principal.
 *
 * Granted iff ONE of:
 *   1. the frame carries the control credential (`token`), or
 *   2. this socket already said `hello` and was GRANTED a control role (presenter/ai) by the one
 *      role gate, or
 *   3. the role gate would grant a control role to this socket right now (the same function, so
 *      there is no second policy) — on an ungated server that is the documented LAN default.
 * A capability holder (GUEST) is never a control principal.
 * Refused ⇒ `{t:'pvs_refused'}`, the socket stays a non-subscriber, and NO turn reaches it.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { mintCapability } from '../../lib/capability.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = 'ctl-token-for-0904-r13';
const SECRET = 'cap-secret-for-0904-r13';
const say = (s, text) => s._emitInboxForTest({ kind: 'voice', userId: 'u-op', userName: 'Op', role: 'presenter', text });

function open(s) {
  const ws = new WebSocket(s.url().replace('http', 'ws'));
  const frames = [];
  ws.on('message', (b, bin) => { if (bin) return; try { frames.push(JSON.parse(b.toString())); } catch (e) {} });
  return new Promise((res, rej) => { ws.on('open', () => res({ ws, frames })); ws.on('error', rej); });
}
const sendJ = (ws, m) => ws.send(JSON.stringify(m));
async function settle(frames, pred, ms = 1500) { for (let i = 0; i < ms / 20 && !frames.some(pred); i++) await wait(20); return frames.find(pred); }

test('T0904-R13a — gated server: an anonymous pvs_subscribe is REFUSED and receives no turn', async () => {
  const s = await createServer({ port: 0, controlToken: TOKEN });
  const sock = await open(s);
  try {
    sendJ(sock.ws, { t: 'pvs_subscribe', consumer: 'probe' });
    const r = await settle(sock.frames, (f) => f.t === 'pvs_refused' || f.t === 'pvs_subscribed');
    expect(r && r.t === 'pvs_refused', 'the subscribe is refused by name', JSON.stringify(sock.frames.map((f) => f.t)));
    expect(s.getPvsSubscriberCount() === 0, 'no subscriber was registered', String(s.getPvsSubscriberCount()));
    say(s, 'a private sentence');
    await wait(150);
    expect(!sock.frames.some((f) => f.t === 'turn' || f.t === 'transcript'), 'no transcript text reached the anonymous socket', JSON.stringify(sock.frames.map((f) => f.t)));
  } finally { sock.ws.close(); await s.close(); }
});

test('T0904-R13b — gated server: a wrong token is refused; the right token subscribes and receives turns', async () => {
  const s = await createServer({ port: 0, controlToken: TOKEN });
  const bad = await open(s), good = await open(s);
  try {
    sendJ(bad.ws, { t: 'pvs_subscribe', consumer: 'bad', token: 'nope' });
    sendJ(good.ws, { t: 'pvs_subscribe', consumer: 'good', token: TOKEN });
    const rb = await settle(bad.frames, (f) => f.t === 'pvs_refused' || f.t === 'pvs_subscribed');
    const rg = await settle(good.frames, (f) => f.t === 'pvs_refused' || f.t === 'pvs_subscribed');
    expect(rb && rb.t === 'pvs_refused', 'wrong token refused', JSON.stringify(rb));
    expect(rg && rg.t === 'pvs_subscribed', 'control token subscribes', JSON.stringify(rg));
    say(s, 'hello operator');
    const turn = await settle(good.frames, (f) => f.t === 'turn');
    expect(turn && turn.text === 'hello operator', 'the credentialed subscriber receives the turn', JSON.stringify(turn));
    expect(!bad.frames.some((f) => f.t === 'turn'), 'the refused socket receives nothing');
  } finally { bad.ws.close(); good.ws.close(); await s.close(); }
});

test('T0904-R13c — a capability holder (GUEST) can never subscribe, even after hello', async () => {
  const s = await createServer({ port: 0, controlToken: TOKEN, capSecret: SECRET });
  const g = await open(s);
  try {
    const cap = mintCapability({ v: 1, sid: 's', role: 'participant', scope: ['speak', 'type', 'observe'], name: 'Guest', exp: Math.floor(Date.now() / 1000) + 300, nonce: 'r13-guest' }, SECRET);
    sendJ(g.ws, { t: 'hello', cap, role: 'ai' });
    await settle(g.frames, (f) => f.t === 'welcome');
    sendJ(g.ws, { t: 'pvs_subscribe', consumer: 'guest' });
    const r = await settle(g.frames, (f) => f.t === 'pvs_refused' || f.t === 'pvs_subscribed');
    expect(r && r.t === 'pvs_refused', 'a guest is refused', JSON.stringify(g.frames.map((f) => f.t)));
    say(s, 'not for guests');
    await wait(150);
    expect(!g.frames.some((f) => f.t === 'turn' || f.t === 'transcript'), 'no transcript reaches the guest');
  } finally { g.ws.close(); await s.close(); }
});

test('T0904-R13d — a socket granted a control role at hello may subscribe; a denied one may not', async () => {
  const s = await createServer({ port: 0, controlToken: TOKEN });
  const ok = await open(s), no = await open(s);
  try {
    sendJ(ok.ws, { t: 'hello', role: 'ai', token: TOKEN, userId: 'agent' });
    sendJ(no.ws, { t: 'hello', role: 'ai', token: 'wrong', userId: 'pretender' });
    await settle(ok.frames, (f) => f.t === 'welcome'); await settle(no.frames, (f) => f.t === 'welcome');
    sendJ(ok.ws, { t: 'pvs_subscribe', consumer: 'agent' });
    sendJ(no.ws, { t: 'pvs_subscribe', consumer: 'pretender' });
    const ro = await settle(ok.frames, (f) => f.t === 'pvs_refused' || f.t === 'pvs_subscribed');
    const rn = await settle(no.frames, (f) => f.t === 'pvs_refused' || f.t === 'pvs_subscribed');
    expect(ro && ro.t === 'pvs_subscribed', 'granted control role subscribes', JSON.stringify(ro));
    expect(rn && rn.t === 'pvs_refused', 'denied role is refused', JSON.stringify(rn));
  } finally { ok.ws.close(); no.ws.close(); await s.close(); }
});

test('T0904-R13e — enforceOAuth:control: anonymous refused; the control token still subscribes', async () => {
  const s = await createServer({ port: 0, controlToken: TOKEN, enforceOAuth: 'control', breakGlass: { token: 'bg-r13', loopbackOnly: true } });
  const a = await open(s), t = await open(s);
  try {
    sendJ(a.ws, { t: 'pvs_subscribe', consumer: 'anon' });
    sendJ(t.ws, { t: 'pvs_subscribe', consumer: 'tok', token: TOKEN });
    const ra = await settle(a.frames, (f) => f.t === 'pvs_refused' || f.t === 'pvs_subscribed');
    const rt = await settle(t.frames, (f) => f.t === 'pvs_refused' || f.t === 'pvs_subscribed');
    expect(ra && ra.t === 'pvs_refused', 'anonymous refused under enforceOAuth', JSON.stringify(ra));
    expect(rt && rt.t === 'pvs_subscribed', 'control token subscribes under enforceOAuth', JSON.stringify(rt));
  } finally { a.ws.close(); t.ws.close(); await s.close(); }
});

test('T0904-R13f — a refused socket cannot ack, and is still refused on a second try', async () => {
  const s = await createServer({ port: 0, controlToken: TOKEN });
  const sock = await open(s);
  try {
    sendJ(sock.ws, { t: 'pvs_subscribe', consumer: 'probe' });
    await settle(sock.frames, (f) => f.t === 'pvs_refused');
    sendJ(sock.ws, { t: 'pvs_ack', seq: 99 });
    const ack = await settle(sock.frames, (f) => f.t === 'pvs_acked');
    expect(ack && ack.ok === false, 'ack from a non-subscriber is refused', JSON.stringify(ack));
    sendJ(sock.ws, { t: 'pvs_subscribe', consumer: 'probe' });
    await wait(150);
    expect(sock.frames.filter((f) => f.t === 'pvs_refused').length === 2, 'refused again', JSON.stringify(sock.frames.map((f) => f.t)));
  } finally { sock.ws.close(); await s.close(); }
});
