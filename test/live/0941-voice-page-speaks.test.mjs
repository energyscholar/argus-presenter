/*
 * Plan 0941 A5 — the /voice page speaks through the ONE shared module and SHOWS every line it is sent.
 * Headless Chrome, speechSynthesis stubbed (headless ships no local voice), a LOCAL server.
 *
 *   T0941-T5a  an observe-scoped page receives a line: it is spoken on the local voice (cancel first) and
 *              shown in #heardText.
 *   T0941-T5b  the same page with NO local voice: nothing is synthesised, and the line is still shown with
 *              the reason "no local voice" — never a silent drop.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launchVoice } from '../../harness/voice-browser.mjs';
import { useStubAsr, mkCap, until, SECRET } from './_0904-voice.mjs';

function ttsStub(local) {
  const st = { spoken: 0, cancels: 0, texts: [] };
  window.__tts = st;
  const voices = [{ name: 'Test Voice', lang: 'en-GB', localService: local }];
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    getVoices() { return voices; }, addEventListener() {}, removeEventListener() {},
    cancel() { st.cancels++; }, speak(u) { st.spoken++; st.texts.push(u.text); } } });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true,
    value: function (t) { this.text = t; this.voice = null; this.onstart = null; this.onend = null; this.onerror = null; } });
}

async function pageWith(s, b, local, nonce) {
  const page = await b.newPage();
  page.on('pageerror', (e) => console.log('  PAGEERR ' + e.message));
  await page.evaluateOnNewDocument(ttsStub, local);
  const cap = mkCap({ scope: ['speak', 'type', 'observe'], ref: 'ext:w:' + nonce, name: 'Seat', nonce });
  await page.goto(s.url() + '/voice?cap=' + cap.token, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('start').disabled, { timeout: 8000 });
  return page;
}
const shown = (page) => page.evaluate(() => document.getElementById('heardText').textContent);

test('T0941-T5 — /voice speaks a line on a local voice, and shows a dropped one with its reason', async () => {
  useStubAsr();
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET });
  const b = await launchVoice({});
  try {
    const a = await pageWith(s, b, true, 't5-local');
    s.speak('first line for the device', 'guest:t5-local');
    await until(async () => (await shown(a)) === 'first line for the device', 'the line is shown', { timeout: 8000 });
    const tts = await a.evaluate(() => window.__tts);
    expect(tts.spoken === 1 && tts.texts[0] === 'first line for the device' && tts.cancels === 1, 'spoken once, on the local voice, after cancel()', JSON.stringify(tts));

    const n = await pageWith(s, b, false, 't5-none');
    s.speak('second line for the device', 'guest:t5-none');
    await until(async () => /second line for the device/.test(await shown(n)), 'the dropped line is shown', { timeout: 8000 });
    const line = await shown(n);
    expect(/no local voice/.test(line), 'the reason is shown with the line', line);
    expect((await n.evaluate(() => window.__tts.spoken)) === 0, 'nothing was synthesised on a network-only device');
  } finally { await b.close(); await s.close(); }
});
