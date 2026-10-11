/*
 * Plan 0941 A2 — a voice-OFF presenter page fetches NO speech code on load, imports lib/speak.mjs on its
 * FIRST spoken line, and while it loads holds only the LATEST line (replace-don't-queue).
 *
 *   T0941-A2  load: zero /lib/speak.mjs requests; two lines in one tick: the module is fetched once and
 *             only the second line is spoken.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launchVoice } from '../../harness/voice-browser.mjs';
import { until, wait } from './_0904-voice.mjs';

function ttsStub() {
  const st = { texts: [], cancels: 0 };
  window.__tts = st;
  const voices = [{ name: 'Test Local', lang: 'en-GB', localService: true }];
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    getVoices() { return voices; }, addEventListener() {}, removeEventListener() {},
    cancel() { st.cancels++; }, speak(u) { st.texts.push(u.text); } } });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true,
    value: function (t) { this.text = t; this.voice = null; } });
}

test('T0941-A2 — the voice-OFF page loads speech on its first line and speaks only the latest', async () => {
  const s = await createServer({ port: 0, voiceEnabled: false });
  const b = await launchVoice({});
  try {
    const page = await b.newPage();
    const urls = [];
    page.on('request', (r) => urls.push(r.url()));
    await page.evaluateOnNewDocument(ttsStub);
    await page.goto(s.url() + '/?role=participant&userId=viewer&name=Viewer', { waitUntil: 'domcontentloaded' });
    await wait(800);
    expect(!urls.some((u) => /\/lib\/speak\.mjs/.test(u)), 'no speech module fetched on load', urls.filter((u) => /lib\//.test(u)).join(','));
    s.speak('first line, superseded');
    s.speak('second line, the latest');
    await until(async () => (await page.evaluate(() => window.__tts.texts.length)) >= 1, 'a line was spoken', { timeout: 8000 });
    await wait(300);
    const t = await page.evaluate(() => window.__tts.texts);
    expect(JSON.stringify(t) === JSON.stringify(['second line, the latest']), 'only the latest line was spoken', JSON.stringify(t));
    expect(urls.filter((u) => /\/lib\/speak\.mjs/.test(u)).length === 1, 'the module was fetched once, on demand', String(urls.filter((u) => /speak/.test(u)).length));
  } finally { await b.close(); await s.close(); }
});
