/*
 * T-E2E-SR (Plan 0470, Phase A) — STUBBED end-to-end. Headless Chrome plays a fake-audio WAV
 * (a tone bracketed by silence) through getUserMedia -> the client DSP/VAD worklet -> the binary
 * PCM lane -> the server WARM ASR seam (STUB, echoes "hello world") -> a transcript reaches AP.
 * No real microphone, no whisper, no network. The real-whisper live smoke (a labelled utterance
 * against faster-whisper) is DEFERRED to the human's environment (hardware not present in CI).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launchVoice, writeWav } from '../../harness/voice-browser.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';

const STUB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'voice', 'asr-stub.mjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, label, { timeout = 12000 } = {}) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(100); } throw new Error('timeout ' + label); }

test('T-E2E-SR (stubbed) fake-audio WAV -> client DSP/VAD -> WARM stub ASR -> transcript in AP', async () => {
  process.env.PRESENTER_ASR_CMD = 'node ' + STUB;
  delete process.env.AP_ASR_COUNT_FILE;
  const wav = join(tmpdir(), 'ap-e2e-' + Date.now() + '.wav');
  writeWav(wav, [{ freq: 0, secs: 0.4 }, { freq: 440, secs: 0.9, amp: 0.35 }, { freq: 0, secs: 1.2 }]);
  const s = await createServer({ port: 0, voiceEnabled: true });
  const b = await launchVoice({ wavPath: wav });
  try {
    const page = await b.newPage();
    page.on('pageerror', (e) => console.log('  PAGEERR ' + e.message));
    await page.goto(s.url() + '/?role=participant&userId=spk&name=Speaker', { waitUntil: 'domcontentloaded' });
    await wait(200);
    const en = await page.evaluate(async () => { try { await window.APVoice.enable(); return 'ok'; } catch (e) { return 'ERR ' + (e && e.message || e); } });
    expect('voice enabled in the browser', en === 'ok', en);
    await until(() => s.getTranscripts(0).transcripts.length >= 1, 'transcript from fake audio');
    const t = s.getTranscripts(0).transcripts[0];
    expect('a non-empty transcript reached AP', !!(t && t.text === 'hello world'), JSON.stringify(t));
    expect('transcript attributed to the speaker connection', t.userId === 'spk', t.userId);
  } finally { await b.close(); await s.close(); try { unlinkSync(wav); } catch (e) {} }
});
