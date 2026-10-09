/*
 * Plan 0904 R9a — COMMIT-REVEAL DEVICE PAIRING (the device-code idea, adapted to a host app that broadcasts
 * everything). The device that will speak holds a random secret C; only H = SHA-256(C) travels through
 * the shared channel; a trusted relay registers H → seat with AP; the device redeems C once and receives
 * its capability. Anyone who saw H holds nothing usable.
 *
 *   T0904-R9a-1  register (control credential) + redeem C ⇒ a capability: speak, ref, TTL 8 h; it streams
 *   T0904-R9a-2  a planted client that saw only H cannot pair (redeeming H, or a guess, is refused)
 *   T0904-R9a-3  a reused C is refused (single use)
 *   T0904-R9a-4  an expired registration is refused
 *   T0904-R9a-5  registering without the control credential is refused; a malformed H is refused
 *   T0904-R9a-6  a `pair`-scoped capability may register over its own socket, for its OWN world only
 *   T0904-R9a-7  a cross-origin redeem from a listed client origin passes the CORS preflight; others do not
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { verifyCapability } from '../../lib/capability.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { useStubAsr, mkCap, connect, speak, until, wait, frame, SECRET } from './_0904-voice.mjs';

const TOKEN = 'ctl-0904-r9a';
const sha = (c) => createHash('sha256').update(c, 'utf8').digest('hex');
const newC = () => randomBytes(16).toString('hex');
async function post(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j, headers: r.headers };
}
const register = (s, h, ref, extra = {}) => post(s.url() + '/api/voice/pair/register', Object.assign({ h, ref, name: 'Seat' }, extra), { 'x-control-token': TOKEN });
const redeem = (s, c) => post(s.url() + '/api/voice/pair/redeem', { c });

test('T0904-R9a-1 — register H, redeem C once: a speak capability with the seat ref and an 8 h TTL, and it streams', async () => {
  useStubAsr();
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET, controlToken: TOKEN });
  try {
    const C = newC();
    const reg = await register(s, sha(C), 'vtt:w1:u1', { name: 'Seat One' });
    expect(reg.status === 200 && reg.body.ok === true, 'registration accepted', JSON.stringify(reg));
    const t0 = Math.floor(Date.now() / 1000);
    const red = await redeem(s, C);
    expect(red.status === 200 && typeof red.body.cap === 'string', 'redeem returns a capability', JSON.stringify(red));
    const v = verifyCapability(red.body.cap, SECRET);
    expect(v.ok && v.payload.ref === 'vtt:w1:u1' && v.payload.scope.includes('speak') && v.payload.name === 'Seat One', 'it carries the seat ref, speak, and the name', JSON.stringify(v.payload));
    const ttl = v.payload.exp - t0;
    expect(Math.abs(ttl - 8 * 3600) <= 5, 'the TTL is 8 hours', String(ttl));
    expect(red.body.ref === 'vtt:w1:u1' && typeof red.body.nonce === 'string' && red.body.exp === v.payload.exp, 'redeem echoes ref, nonce, exp', JSON.stringify(red.body));
    const c = await connect(s.url(), { cap: red.body.cap });
    speak(c, 1);
    await until(() => s.getInbox().items.find((i) => i.extRef === 'vtt:w1:u1'), 'the paired device streams');
    c.ws.close();
  } finally { await s.close(); }
});

test('T0904-R9a-2 — a client that saw only H cannot pair', async () => {
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET, controlToken: TOKEN });
  try {
    const C = newC(); const H = sha(C);
    await register(s, H, 'vtt:w1:u2');
    const withH = await redeem(s, H);
    expect(withH.status === 404 && !withH.body.cap, 'redeeming H itself is refused', JSON.stringify(withH));
    const guess = await redeem(s, newC());
    expect(guess.status === 404 && !guess.body.cap, 'a guess is refused', JSON.stringify(guess));
    const real = await redeem(s, C);
    expect(real.status === 200 && real.body.cap, 'the holder of C still pairs afterwards', JSON.stringify(real.status));
  } finally { await s.close(); }
});

test('T0904-R9a-3 — a reused C is refused', async () => {
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET, controlToken: TOKEN });
  try {
    const C = newC();
    await register(s, sha(C), 'vtt:w1:u3');
    const first = await redeem(s, C), second = await redeem(s, C);
    expect(first.status === 200 && first.body.cap, 'first redeem pairs');
    expect(second.status === 404 && !second.body.cap, 'the second is refused (single use)', JSON.stringify(second));
  } finally { await s.close(); }
});

test('T0904-R9a-4 — an expired registration is refused', async () => {
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET, controlToken: TOKEN, voicePairRegistrationMs: 150 });
  try {
    const C = newC();
    await register(s, sha(C), 'vtt:w1:u4');
    await wait(300);
    const r = await redeem(s, C);
    expect(r.status === 404 && !r.body.cap, 'expired ⇒ refused', JSON.stringify(r));
  } finally { await s.close(); }
});

test('T0904-R9a-5 — registration needs the control credential and a well-formed H', async () => {
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET, controlToken: TOKEN });
  try {
    const C = newC();
    const anon = await post(s.url() + '/api/voice/pair/register', { h: sha(C), ref: 'vtt:w1:u5' });
    expect(anon.status === 403, 'no credential ⇒ 403', JSON.stringify(anon));
    const bad = await register(s, 'not-a-hash', 'vtt:w1:u5');
    expect(bad.status === 400, 'a malformed H ⇒ 400', JSON.stringify(bad));
    const noref = await register(s, sha(C), '');
    expect(noref.status === 400, 'a missing ref ⇒ 400', JSON.stringify(noref));
    const r = await redeem(s, C);
    expect(r.status === 404, 'nothing was registered', JSON.stringify(r));
  } finally { await s.close(); }
  const open = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET });
  try {
    const r = await post(open.url() + '/api/voice/pair/register', { h: sha(newC()), ref: 'vtt:w1:u5' });
    expect(r.status === 403, 'a server with NO control credential refuses (fails closed)', JSON.stringify(r));
  } finally { await open.close(); }
});

test('T0904-R9a-6 — a pair-scoped capability registers for its own world only, over its own socket', async () => {
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET, controlToken: TOKEN });
  try {
    const gm = await connect(s.url(), { cap: mkCap({ ref: 'vtt:w1:gm', scope: ['speak', 'type', 'observe', 'pair'], nonce: 'pair-gm' }).token });
    const pl = await connect(s.url(), { cap: mkCap({ ref: 'vtt:w1:p9', scope: ['speak'], nonce: 'pair-pl' }).token });
    const C1 = newC(), C2 = newC(), C3 = newC();
    gm.ws.send(JSON.stringify({ t: 'voice_pair_register', h: sha(C1), ref: 'vtt:w1:p1', name: 'P1' }));
    gm.ws.send(JSON.stringify({ t: 'voice_pair_register', h: sha(C2), ref: 'vtt:w2:p1', name: 'X' }));
    pl.ws.send(JSON.stringify({ t: 'voice_pair_register', h: sha(C3), ref: 'vtt:w1:p9', name: 'Self' }));
    await until(() => gm.frames.filter((f) => f.t === 'voice_pair_registered').length >= 2, 'gm answers');
    await until(() => frame(pl, (f) => f.t === 'voice_pair_registered'), 'seat answer');
    const answers = gm.frames.filter((f) => f.t === 'voice_pair_registered');
    expect(answers.find((a) => a.ref === 'vtt:w1:p1' && a.ok === true), 'same world: accepted', JSON.stringify(answers));
    expect(answers.find((a) => a.ref === 'vtt:w2:p1' && a.ok === false), 'another world: refused', JSON.stringify(answers));
    expect(frame(pl, (f) => f.t === 'voice_pair_registered').ok === false, 'a cap without pair scope: refused');
    expect((await redeem(s, C1)).status === 200, 'the accepted one redeems');
    expect((await redeem(s, C2)).status === 404 && (await redeem(s, C3)).status === 404, 'the refused ones do not');
    gm.ws.close(); pl.ws.close();
  } finally { await s.close(); }
});

test('T0904-R9a-7 — cross-origin redeem: CORS preflight for listed origins only', async () => {
  const listed = 'http://127.0.0.1:59998';
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET, controlToken: TOKEN, voiceClientOrigins: [listed] });
  try {
    const pre = await fetch(s.url() + '/api/voice/pair/redeem', { method: 'OPTIONS', headers: { origin: listed, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    expect(pre.status === 204 && pre.headers.get('access-control-allow-origin') === listed && /POST/.test(pre.headers.get('access-control-allow-methods') || ''), 'listed origin preflight passes', `${pre.status} ${pre.headers.get('access-control-allow-origin')}`);
    const other = await fetch(s.url() + '/api/voice/pair/redeem', { method: 'OPTIONS', headers: { origin: 'http://elsewhere.invalid', 'access-control-request-method': 'POST' } });
    expect(other.headers.get('access-control-allow-origin') === null, 'an unlisted origin gets no allowance', String(other.headers.get('access-control-allow-origin')));
    const regPre = await fetch(s.url() + '/api/voice/pair/register', { method: 'OPTIONS', headers: { origin: listed, 'access-control-request-method': 'POST' } });
    expect(regPre.headers.get('access-control-allow-origin') === null, 'register is NEVER callable from a browser origin', String(regPre.headers.get('access-control-allow-origin')));
  } finally { await s.close(); }
});
