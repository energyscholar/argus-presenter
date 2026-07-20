/* selftest-s206.mjs — S206 voice-capture pipeline self-test. Drives the REAL client
 * (headless Chrome + fake mic) against the live :4300 server so the S1..S10 tracer can be
 * watched climbing. Temporary debug harness; delete after the pipeline is verified. */
import { launchVoice, writeWav } from './voice-browser.mjs';

const SP = process.env.SP || '/tmp';
// WAV=<path> injects a real speech file (verifies S9/S10 recognition). Otherwise a tone sweep.
const wav = process.env.WAV || (SP + '/selftest-tone.wav');
if (!process.env.WAV)
// Amplitude sweep so the level meter (raw/nrm RMS) can be read against the 0.012 VAD threshold:
// LOUD (should trip S2) → QUIET (sub-threshold, should NOT) → MID. Silence brackets each for clean
// VAD endpointing. Chrome loops the file through the fake device.
writeWav(wav, [
  { freq: 0, secs: 0.5 },
  { freq: 320, secs: 0.9, amp: 0.30 },   // loud
  { freq: 0, secs: 0.8 },
  { freq: 440, secs: 0.9, amp: 0.015 },  // quiet (near threshold)
  { freq: 0, secs: 0.8 },
  { freq: 520, secs: 0.9, amp: 0.06 },   // mid
  { freq: 0, secs: 1.0 },
]);

const url = 'http://127.0.0.1:4300/?role=participant&userId=selftest&name=SelfTest';
console.log('[selftest] launching headless chrome with fake mic:', wav);
const browser = await launchVoice({ wavPath: wav });
const page = await browser.newPage();
page.on('console', (m) => { const t = m.text(); if (/voice|mic|apvoice|error|seg|worklet/i.test(t)) console.log('[page]', t); });
page.on('pageerror', (e) => console.log('[pageerror]', e && e.message));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 900));   // let the WS open before enabling
const res = await page.evaluate(async () => {
  try { await window.APVoice.enable(); return 'enabled=' + (!!(window.APVoice && window.APVoice.enabled)); }
  catch (e) { return 'ENABLE_ERROR: ' + (e && e.message || e); }
});
console.log('[selftest] enable ->', res);
console.log('[selftest] capturing for 14s (watch presenter_debug for S5/S6/S7 voice logs)...');
await new Promise((r) => setTimeout(r, 14000));
await browser.close();
console.log('[selftest] done');
