/*
 * Plan 0904 A152 follow-up — decisions D1..D3 and the /voice code-form gap.
 *
 *   A152-D1  at most 16 pending registrations carry a k: the 17th evicts the oldest, and one attempt runs <= 16 PBKDF2
 *   A152-D2  the client-address headers count only when the socket peer is loopback (the tunnel); a direct peer is
 *            limited by its own address however it forges them
 *   A152-D3  a failed ?pair= offers the code form, like an expired capability does
 *   A152-G1  /voice with no capability: the code form, a wrong code, then the right one (typed lowercase with a dash)
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launchVoice } from '../../harness/voice-browser.mjs';
import { createHash, randomBytes, pbkdf2Sync } from 'node:crypto';
import { useStubAsr, SECRET } from './_0904-voice.mjs';

const TOKEN = 'ctl-0904-a152-fu';
const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const sha = (c) => createHash('sha256').update(c, 'utf8').digest('hex');
const newC = () => randomBytes(16).toString('hex');
function crock6(buf) {
  let out = '', acc = 0, bits = 0;
  for (const b of buf) { acc = (acc << 8) | b; bits += 8; while (bits >= 5 && out.length < 6) { out += ALPHA[(acc >> (bits - 5)) & 31]; bits -= 5; } acc &= (1 << bits) - 1; if (out.length === 6) break; }
  return out;
}
const codeOf = (c) => crock6(createHash('sha256').update('argus-pair-code|' + c, 'utf8').digest());
const kOf = (code, h) => pbkdf2Sync(code, h, 200000, 32, 'sha256').toString('hex');
async function post(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
const srv = (extra = {}) => createServer(Object.assign({ port: 0, voiceEnabled: true, capSecret: SECRET, controlToken: TOKEN }, extra));
async function pairFor(s, ref) {
  const C = newC(), H = sha(C), code = codeOf(C);
  const r = await post(s.url() + '/api/voice/pair/register', { h: H, ref, name: 'Seat', k: kOf(code, H) }, { 'x-control-token': TOKEN });
  expect(r.status === 200, 'registration accepted', JSON.stringify(r));
  return { C, H, code };
}
const byCode = (s, code, headers) => post(s.url() + '/api/voice/pair/redeem', { code }, headers);

test('A152-D1 — the 17th k-registration evicts the oldest; one attempt runs at most 16 PBKDF2', async () => {
  const s = await srv();
  try {
    const all = [];
    for (let i = 0; i < 17; i++) all.push(await pairFor(s, 'vtt:w1:d1-' + i));
    const r0 = s._voicePairCodeStatsForTest().kdfRuns;
    const miss = await byCode(s, 'ZZZZZZ');
    expect(miss.status === 404, 'a wrong code is a plain miss', JSON.stringify(miss));
    const ran = s._voicePairCodeStatsForTest().kdfRuns - r0;
    expect(ran <= 16, 'one attempt runs at most 16 PBKDF2', String(ran));
    expect(ran === 16, 'and exactly 16 are pending', String(ran));
    const oldest = await byCode(s, all[0].code);
    expect(oldest.status === 404 && !oldest.body.cap, 'the oldest registration was evicted: its code ⇒ 404', JSON.stringify(oldest));
    const newest = await byCode(s, all[16].code);
    expect(newest.status === 200 && newest.body.ref === 'vtt:w1:d1-16', 'the 17th registration pairs', JSON.stringify(newest));
    const evictedC = await post(s.url() + '/api/voice/pair/redeem', { c: all[0].C });
    expect(evictedC.status === 404, 'the evicted registration is gone for C as well', JSON.stringify(evictedC));
  } finally { await s.close(); }
});

