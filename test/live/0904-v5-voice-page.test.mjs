/*
 * Plan 0904 V5 — the phone page GET /voice (R5: the GM's primary path). Headless Chrome, a fake mic
 * (a WAV the browser loops), the stub ASR, a LOCAL server.
 *
 *   T0904-01  with a valid speak cap the page streams; the entry carries userName = the cap's name and
 *             extRef = its ref; the address bar no longer carries the cap. (WER is a field measurement:
 *             the stub recogniser cannot score it — see the report.)
 *   T0904-02  no cap / an expired cap / a type-only cap ⇒ the page shows FAULT; the type-only refusal
 *             reaches an `observe` socket in the same world as a voice_fault.
 *   T0904-04  a wake lock is requested on Start and re-requested on visibilitychange (API stubbed).
 *   T0904-05  360×740: no horizontal scroll, Start ≥ 48 px tall, crossOriginIsolated === true, and it
 *             still streams.
 *   T0904-15  capture on → reload → ONE tap → the next utterance is recognised; voice_gap cause 'reload'
 *             is logged; the URL carries no cap.
 *   T0904-R9a-P  /voice?pair=<C> redeems once, stores the capability, strips the code, and streams.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import * as log from '../../app/log.mjs';
import { launchVoice, writeWav } from '../../harness/voice-browser.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { useStubAsr, mkCap, connect, until, wait, SECRET } from './_0904-voice.mjs';

function clip() {
  const wav = join(tmpdir(), 'ap-0904-v5-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.wav');
  writeWav(wav, [{ freq: 0, secs: 0.4 }, { freq: 440, secs: 0.9, amp: 0.35 }, { freq: 0, secs: 1.2 }]);
  return wav;
}
const status = (page) => page.evaluate(() => document.getElementById('status').dataset.s);
const WAKE_STUB = () => {
  window.__wake = 0;
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { window.__wake++; return { release: async () => {}, addEventListener() {} }; } } });
};

test('T0904-01 + T0904-05 — the page streams under a cap; mobile layout; cross-origin isolated', async () => {
  useStubAsr();
  const wav = clip();
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET });
  const b = await launchVoice({ wavPath: wav });
  try {
    const page = await b.newPage();
    page.on('pageerror', (e) => console.log('  PAGEERR ' + e.message));
    await page.setViewport({ width: 360, height: 740, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument(WAKE_STUB);
    const cap = mkCap({ ref: 'vtt:w1:u1', name: 'Seat One', nonce: 'v5-01' });
    await page.goto(s.url() + '/voice?cap=' + cap.token, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('start').disabled, { timeout: 8000 });
    expect(!/cap=/.test(page.url()), 'the cap is stripped from the URL', page.url());
    const lay = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, h: document.getElementById('start').getBoundingClientRect().height, coi: self.crossOriginIsolated, consent: document.getElementById('consent').textContent }));
    expect(lay.sw <= lay.cw, 'no horizontal scroll at 360 px', JSON.stringify(lay));
    expect(lay.h >= 48, 'Start is at least 48 px tall', String(lay.h));
    expect(lay.coi === true, 'the page is cross-origin isolated', String(lay.coi));
    expect(/recognised to text/.test(lay.consent), 'the consent sentence is shown before Start', lay.consent);
    await page.click('#start');
    const e = await until(() => s.getInbox().items.find((i) => i.extRef === 'vtt:w1:u1'), 'an entry from the page', { timeout: 12000 });
    expect(e.userName === 'Seat One' && e.extRef === 'vtt:w1:u1', 'userName = the cap name; extRef = the cap ref', JSON.stringify({ n: e.userName, r: e.extRef }));
    await until(async () => (await status(page)) === 'listening', 'status listening');
    await until(async () => /hello world/.test(await page.evaluate(() => document.getElementById('lastText').textContent)), 'last result line shows the text');
  } finally { await b.close(); await s.close(); try { unlinkSync(wav); } catch (e) {} }
});

test('T0904-02 — no cap, an expired cap, a type-only cap: FAULT on the page; the refusal reaches the GM', async () => {
  useStubAsr();
  const wav = clip();
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET });
  const b = await launchVoice({ wavPath: wav });
  try {
    const gm = await connect(s.url(), { cap: mkCap({ ref: 'vtt:w1:gm', scope: ['speak', 'observe'], nonce: 'v5-gm' }).token });
    const p1 = await b.newPage();
    await p1.goto(s.url() + '/voice', { waitUntil: 'domcontentloaded' });
    await until(async () => (await status(p1)) === 'fault', 'no cap ⇒ FAULT');
    const p2 = await b.newPage();
    const expired = mkCap({ ref: 'vtt:w1:x', nonce: 'v5-exp', exp: Math.floor(Date.now() / 1000) - 10 });
    await p2.goto(s.url() + '/voice?cap=' + expired.token, { waitUntil: 'domcontentloaded' });
    await until(async () => (await status(p2)) === 'fault', 'expired ⇒ FAULT');
    const p3 = await b.newPage();
    const typeOnly = mkCap({ ref: 'vtt:w1:t', scope: ['type'], nonce: 'v5-type' });
    await p3.goto(s.url() + '/voice?cap=' + typeOnly.token, { waitUntil: 'domcontentloaded' });
    await p3.waitForFunction(() => !document.getElementById('start').disabled, { timeout: 8000 });
    await p3.click('#start');
    await until(async () => (await status(p3)) === 'fault', 'type-only ⇒ FAULT', { timeout: 12000 });
    await until(() => gm.frames.find((f) => f.t === 'voice_fault' && f.code === 'denied' && f.ref === 'vtt:w1:t'), 'denied fault reached the observer');
    gm.ws.close();
  } finally { await b.close(); await s.close(); try { unlinkSync(wav); } catch (e) {} }
});

test('T0904-04 — the wake lock is requested on Start and again on visibilitychange', async () => {
  useStubAsr();
  const wav = clip();
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET });
  const b = await launchVoice({ wavPath: wav });
  try {
    const page = await b.newPage();
    await page.evaluateOnNewDocument(WAKE_STUB);
    await page.goto(s.url() + '/voice?cap=' + mkCap({ ref: 'vtt:w1:wl', nonce: 'v5-wl' }).token, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('start').disabled, { timeout: 8000 });
    await page.click('#start');
    await until(async () => (await page.evaluate(() => window.__wake)) === 1, 'requested on Start');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await until(async () => (await page.evaluate(() => window.__wake)) === 2, 're-requested on visibilitychange');
  } finally { await b.close(); await s.close(); try { unlinkSync(wav); } catch (e) {} }
});

test('T0904-15 — a reload with the mic on: one tap resumes, the hole is a reload gap, no cap in the URL', async () => {
  useStubAsr();
  log.clear();
  const wav = clip();
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET });
  const b = await launchVoice({ wavPath: wav });
  try {
    const page = await b.newPage();
    await page.evaluateOnNewDocument(WAKE_STUB);
    await page.goto(s.url() + '/voice?cap=' + mkCap({ ref: 'vtt:w1:rl', nonce: 'v5-rl' }).token, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('start').disabled, { timeout: 8000 });
    await page.click('#start');
    await until(() => s.getInbox().items.some((i) => i.extRef === 'vtt:w1:rl'), 'first utterance', { timeout: 12000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(!/cap=/.test(page.url()), 'the reloaded URL carries no cap', page.url());
    await page.waitForFunction(() => getComputedStyle(document.getElementById('resume')).display !== 'none', { timeout: 8000 });
    const n0 = s.getInbox().items.filter((i) => i.extRef === 'vtt:w1:rl').length;
    await page.waitForFunction(() => !document.getElementById('start').disabled, { timeout: 8000 });
    await page.click('#resumeBtn');
    await until(() => s.getInbox().items.filter((i) => i.extRef === 'vtt:w1:rl').length > n0, 'an utterance after the reload', { timeout: 12000 });
    await until(() => log.tail(500).some((e) => e.tag === 'voice' && e.msg === 'gap' && e.fields && e.fields.cause === 'reload'), 'reload gap logged');
  } finally { await b.close(); await s.close(); try { unlinkSync(wav); } catch (e) {} }
});

test('T0904-R9a-P — /voice?pair=<C> redeems once, strips the code, and streams', async () => {
  useStubAsr();
  const wav = clip();
  const TOKEN = 'ctl-v5-pair';
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET, controlToken: TOKEN });
  const b = await launchVoice({ wavPath: wav });
  try {
    const C = randomBytes(16).toString('hex');
    const reg = await fetch(s.url() + '/api/voice/pair/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-control-token': TOKEN }, body: JSON.stringify({ h: createHash('sha256').update(C).digest('hex'), ref: 'vtt:w1:qr', name: 'Phone Seat' }) });
    expect(reg.status === 200, 'registered', String(reg.status));
    const page = await b.newPage();
    await page.goto(s.url() + '/voice?pair=' + C, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('start').disabled, { timeout: 8000 });
    expect(!/pair=/.test(page.url()), 'the pairing code is stripped from the URL', page.url());
    await page.click('#start');
    const e = await until(() => s.getInbox().items.find((i) => i.extRef === 'vtt:w1:qr'), 'streamed after pairing', { timeout: 12000 });
    expect(e.userName === 'Phone Seat', 'named by the registration', e.userName);
    const again = await b.newPage();
    await again.goto(s.url() + '/voice?pair=' + C, { waitUntil: 'domcontentloaded' });
    await until(async () => (await status(again)) === 'fault', 'a reused pairing code shows FAULT');
  } finally { await b.close(); await s.close(); try { unlinkSync(wav); } catch (e) {} }
});
