/*
 * Plan 0904 A152 — THE PAIRING SHORT CODE, a short hash of the QR's own secret C, on the SAME registration.
 *
 * The device computes code = CROCKFORD32(SHA-256("argus-pair-code|" + C))[0..6) and registers, beside H, only the
 * SLOW commitment k = PBKDF2-SHA256(code, salt = H as 64-hex, 200000, 32 bytes). The server never sees C or the
 * code at registration; it checks a typed code by recomputing k against each pending registration that has one.
 *
 *   A152-1  register (h, k) → redeem by code ⇒ a capability with the registration's ref
 *   A152-2  single use: the code twice ⇒ 404; C after the code was used ⇒ 404
 *   A152-3  expiry: after the registration window the code ⇒ 404
 *   A152-4  an observer holding H and k but not C cannot pair: codes derived from H ⇒ 404
 *   A152-5  rate limit: the 11th attempt in a minute from one address ⇒ 429 and no PBKDF2 runs; the server-wide cap
 *   A152-6  normalisation: abc-def / ABCDEF / ABC DEF redeem; O≡0, I≡1, L≡1
 *   A152-7  the cross-implementation vector (the same literals are in the console's test)
 *   A152-9  register with a malformed k ⇒ 400; {c} and {code} together ⇒ 400
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { verifyCapability } from '../../lib/capability.mjs';
import { createHash, randomBytes, pbkdf2Sync } from 'node:crypto';
import { wait, SECRET } from './_0904-voice.mjs';

const TOKEN = 'ctl-0904-a152';
const ITER = 200000;
const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const sha = (c) => createHash('sha256').update(c, 'utf8').digest('hex');
const newC = () => randomBytes(16).toString('hex');
/** The rule, written out again here on purpose (an independent implementation of the code). */
function crock6(buf) {
  let out = '', acc = 0, bits = 0;
  for (const b of buf) { acc = (acc << 8) | b; bits += 8; while (bits >= 5 && out.length < 6) { out += ALPHA[(acc >> (bits - 5)) & 31]; bits -= 5; } acc &= (1 << bits) - 1; if (out.length === 6) break; }
  return out;
}
const codeOf = (c) => crock6(createHash('sha256').update('argus-pair-code|' + c, 'utf8').digest());
const kOf = (code, h) => pbkdf2Sync(code, h, ITER, 32, 'sha256').toString('hex');
const dash = (code) => code.slice(0, 3) + '-' + code.slice(3);

const VEC = {
  C: '00112233445566778899aabbccddeeff',
  code: 'Q5NNC4',
  H: '5947d7c33d783f94b3b4c1a96ebc8991ed28f1b069b71e03376cba8caa98a720',
  k: 'be77d36a06341a6360e39c2bd06467feff6f340e37bf2163b331a372f9a5ab9f',
};

async function post(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
const register = (s, body) => post(s.url() + '/api/voice/pair/register', Object.assign({ name: 'Seat' }, body), { 'x-control-token': TOKEN });
const byCode = (s, code, headers) => post(s.url() + '/api/voice/pair/redeem', { code }, headers);
const byC = (s, c) => post(s.url() + '/api/voice/pair/redeem', { c });
const srv = (extra = {}) => createServer(Object.assign({ port: 0, voiceEnabled: true, capSecret: SECRET, controlToken: TOKEN }, extra));
/** Register a fresh pairing secret with its code commitment; returns { C, H, code }. */
async function pairFor(s, ref) {
  const C = newC(), H = sha(C), code = codeOf(C);
  const r = await register(s, { h: H, ref, k: kOf(code, H) });
  expect(r.status === 200, 'registration with k accepted', JSON.stringify(r));
  return { C, H, code };
}

test('A152-1 — register (h, k), redeem by the short code: a capability with the registration ref', async () => {
  const s = await srv();
  try {
    const { code } = await pairFor(s, 'vtt:w1:c1');
    const red = await byCode(s, dash(code));
    expect(red.status === 200 && typeof red.body.cap === 'string', 'redeem by code returns a capability', JSON.stringify(red));
    const v = verifyCapability(red.body.cap, SECRET);
    expect(v.ok && v.payload.ref === 'vtt:w1:c1' && v.payload.scope.includes('speak'), 'it carries the ref and speak', JSON.stringify(v.payload));
    expect(red.body.ref === 'vtt:w1:c1', 'redeem echoes the ref', JSON.stringify(red.body));
  } finally { await s.close(); }
});

test('A152-2 — single use: the code twice is refused, and C after the code is refused', async () => {
  const s = await srv();
  try {
    const { C, code } = await pairFor(s, 'vtt:w1:c2');
    const first = await byCode(s, code), second = await byCode(s, code);
    expect(first.status === 200 && first.body.cap, 'first redeem by code pairs', JSON.stringify(first.status));
    expect(second.status === 404 && !second.body.cap && second.body.error === 'no such pairing', 'the same code again ⇒ 404', JSON.stringify(second));
    const viaC = await byC(s, C);
    expect(viaC.status === 404 && !viaC.body.cap, 'the same registration by C after its code was used ⇒ 404', JSON.stringify(viaC));
    const other = await pairFor(s, 'vtt:w1:c2b');
    expect((await byC(s, other.C)).status === 200, 'C first …');
    const late = await byCode(s, other.code);
    expect(late.status === 404 && !late.body.cap, '… then its code ⇒ 404 (one registration, one use)', JSON.stringify(late));
  } finally { await s.close(); }
});

test('A152-3 — after the registration window the code is refused', async () => {
  const s = await srv({ voicePairRegistrationMs: 400 });
  try {
    const live = await pairFor(s, 'vtt:w1:c3a');
    const { code } = await pairFor(s, 'vtt:w1:c3');
    const inWindow = await byCode(s, live.code);
    expect(inWindow.status === 200 && inWindow.body.cap, 'control: inside the window a code redeems', JSON.stringify(inWindow));
    await wait(600);
    const r = await byCode(s, code);
    expect(r.status === 404 && !r.body.cap && r.body.error === 'no such pairing', 'expired ⇒ 404', JSON.stringify(r));
  } finally { await s.close(); }
});

test('A152-4 — an observer holding H and k, but not C, cannot pair', async () => {
  const s = await srv();
  try {
    const { H, code } = await pairFor(s, 'vtt:w1:c4');
    const Hb = Buffer.from(H, 'hex');
    // Every 6-character code an observer can derive from what crossed the shared channel (H), never from C.
    const fromH = [...new Set([
      codeOf(H),                                   // the rule applied to H instead of C
      crock6(Hb),                                  // H's own leading bits
      crock6(createHash('sha256').update(Hb).digest()),
      crock6(createHash('sha256').update(H, 'utf8').digest()),
      H.slice(0, 6).toUpperCase(),
      H.slice(-6).toUpperCase(),
      codeOf(sha(H)),
    ])].filter((x) => x !== code);
    expect(fromH.length >= 6, 'enough derived candidates', String(fromH.length));
    for (const guess of fromH) {
      const r = await byCode(s, guess);
      expect(r.status === 404 && !r.body.cap, `a code derived from H (${guess}) ⇒ 404`, JSON.stringify(r));
    }
    const real = await byCode(s, code);
    expect(real.status === 200 && real.body.cap, 'the holder of C (who can compute the code) still pairs', JSON.stringify(real.status));
  } finally { await s.close(); }
});

test('A152-5 — rate limit: the 11th attempt from one address in a minute ⇒ 429 and no PBKDF2 runs; and a server-wide cap', async () => {
  const s = await srv();
  try {
    await pairFor(s, 'vtt:w1:c5');                                   // one pending registration with k ⇒ one PBKDF2 per attempt
    const runs0 = s._voicePairCodeStatsForTest().kdfRuns;
    for (let i = 0; i < 10; i++) {
      const r = await byCode(s, 'ZZZZZ' + i);
      expect(r.status === 404, `attempt ${i + 1} is a plain miss`, JSON.stringify(r));
    }
    const runs10 = s._voicePairCodeStatsForTest().kdfRuns;
    expect(runs10 - runs0 === 10, 'the spy sees one PBKDF2 per allowed attempt', String(runs10 - runs0));
    const over = await byCode(s, 'ZZZZZZ');
    expect(over.status === 429 && !over.body.cap, 'the 11th attempt ⇒ 429', JSON.stringify(over));
    expect(s._voicePairCodeStatsForTest().kdfRuns === runs10, 'and no PBKDF2 ran for it', String(s._voicePairCodeStatsForTest().kdfRuns - runs10));
  } finally { await s.close(); }
  const g = await srv();
  try {
    await pairFor(g, 'vtt:w1:c5g');
    let last = null;
    for (let i = 0; i < 61; i++) last = await byCode(g, 'ZZZZZ1', { 'x-forwarded-for': '198.51.100.' + (i % 60 + 1) });
    expect(last.status === 429, 'the 61st attempt server-wide ⇒ 429, whatever address it claims', JSON.stringify(last));
  } finally { await g.close(); }
});

test('A152-6 — normalisation: dashes, spaces and case; O≡0, I≡1, L≡1', async () => {
  const s = await srv();
  try {
    const typed = [['ABCDEF', 'abc-def'], ['ABCDEF', 'ABCDEF'], ['ABCDEF', 'ABC DEF'], ['A0B0C0', 'aob-oco'], ['A1B1C1', 'AIB lCl']];
    let n = 0;
    for (const [code, form] of typed) {
      const C = newC(), H = sha(C), ref = 'vtt:w1:n' + (++n);
      expect((await register(s, { h: H, ref, k: kOf(code, H) })).status === 200, 'registered ' + code);
      const r = await byCode(s, form);
      expect(r.status === 200 && r.body.ref === ref, `"${form}" redeems the registration for ${code}`, JSON.stringify(r));
    }
  } finally { await s.close(); }
});

test('A152-7 — the cross-implementation vector: Node crypto gives the same code and k as the console', async () => {
  expect(sha(VEC.C) === VEC.H, 'H = SHA-256(C)');
  expect(codeOf(VEC.C) === VEC.code, 'the code from C', codeOf(VEC.C));
  expect(kOf(VEC.code, VEC.H) === VEC.k, 'k = PBKDF2(code, H)', kOf(VEC.code, VEC.H));
  const s = await srv();
  try {
    expect((await register(s, { h: VEC.H, ref: 'vtt:w1:vec', k: VEC.k })).status === 200, 'the vector registers');
    const r = await byCode(s, 'q5n-nc4');
    expect(r.status === 200 && r.body.ref === 'vtt:w1:vec', 'the server accepts the vector code against the vector k', JSON.stringify(r));
  } finally { await s.close(); }
});

test('A152-9 — a malformed k is refused at registration; {c} with {code} is refused', async () => {
  const s = await srv();
  try {
    const C = newC(), H = sha(C);
    for (const k of ['xyz', kOf(codeOf(C), H).toUpperCase(), 'ab'.repeat(33), 12, null]) {
      const r = await register(s, { h: H, ref: 'vtt:w1:m1', k });
      expect(r.status === 400 && r.body.ok === false, `k = ${JSON.stringify(k)} ⇒ 400`, JSON.stringify(r));
    }
    expect((await byC(s, C)).status === 404, 'nothing was registered');
    expect((await register(s, { h: H, ref: 'vtt:w1:m1' })).status === 200, 'without k it still registers (the QR path)');
    const both = await post(s.url() + '/api/voice/pair/redeem', { c: C, code: codeOf(C) });
    expect(both.status === 400 && !(both.body && both.body.cap), '{c} and {code} together ⇒ 400', JSON.stringify(both));
    expect((await byC(s, C)).status === 200, 'and it did not consume the registration');
  } finally { await s.close(); }
});
