/*
 * Plan 0685 R1 — THE ECHO GUARD, WIRED. `duckWhilePlaying` has existed in lib/voice-capture.mjs
 * since Plan 0470 (RT-5) and was called from NOWHERE, so the mitigation had never once run. These
 * tests are the proof that it now does, and — more importantly — the proof that it always LIFTS.
 *
 *   T-0685-DUCK       playback ducks capture: no segment opens, nothing is transcribed.
 *   T-0685-UNDUCK     `end` lifts it and capture resumes; the mic was never released.
 *   T-0685-WATCHDOG   ⭐ THE FORBIDDEN IMPLEMENTATION. A platform that reports neither `end` nor
 *                     `error` is exactly the "un-duck removed" case: the test WATCHES capture stay
 *                     dead across the whole window, and only then does the absolute watchdog lift
 *                     it. Without the watchdog this test hangs dead forever — which is the failure
 *                     it exists to forbid, because a stuck duck leaves the operator MUTE WITH NO
 *                     ERROR, worse than the echo the duck prevents.
 *   T-0685-WINS       ⭐ DUCKING WINS OVER BARGE-IN, asserted rather than left emergent. With
 *                     echoCancellation off (R2) the mic hears the agent's own TTS, so a segment
 *                     opened during playback is at least as likely to be the agent as the user.
 *                     While ducked NO segment is opened, so the server's speaking-state survives
 *                     playback intact — the agent cannot interrupt itself. It resumes on un-duck.
 *   T-0685-FENCE      the capture-side hook is INSIDE the AP-VOICE fence; the TTS side is not and
 *                     holds no reference to the audio-in runtime (T-ZERO-WHEN-OFF stays true).
 *
 * speechSynthesis is STUBBED: headless Chrome ships no local voice, and the point under test is the
 * lifecycle wiring (start/end/error/cancel/watchdog), not the platform's synthesiser.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer, renderPresenterPage } from '../../app/server.mjs';
import { launchVoice, writeWav } from '../../harness/voice-browser.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';

const STUB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'voice', 'asr-stub.mjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, label, { timeout = 20000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(100); }
  throw new Error('timeout ' + label);
}

// A looping tone/silence WAV: Chrome repeats the file through the fake device, so the VAD keeps
// endpointing utterances for as long as capture is live. "Capture is dead" is therefore observable
// as "the transcript count stopped growing", not merely as an internal flag.
const LOOP_SECS = 2.5;
function loopWav() {
  const p = join(tmpdir(), 'ap-0685-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.wav');
  return writeWav(p, [{ freq: 0, secs: 0.4 }, { freq: 440, secs: 0.9, amp: 0.35 }, { freq: 0, secs: 1.2 }]);
}

// Deterministic speechSynthesis: one local voice (so the OPSEC gate admits it) and a hand-driven
// utterance lifecycle. Installed BEFORE the page script runs — apPickVoice() reads it at load.
function installTtsStub() {
  const voices = [{ name: 'Test Local', lang: 'en-GB', localService: true }];
  const st = { spoken: 0, cancels: 0, last: null };
  window.__tts = st;
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      getVoices() { return voices; },
      addEventListener() {}, removeEventListener() {},
      cancel() { st.cancels++; },
      speak(u) { st.spoken++; st.last = u; },
    },
  });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    configurable: true,
    value: function (t) { this.text = t; this.voice = null; this.onstart = null; this.onend = null; this.onerror = null; },
  });
}

async function openVoicePage(s, b) {
  const page = await b.newPage();
  page.on('pageerror', (e) => console.log('  PAGEERR ' + e.message));
  await page.evaluateOnNewDocument(installTtsStub);
  await page.goto(s.url() + '/?role=participant&userId=spk&name=Speaker', { waitUntil: 'domcontentloaded' });
  await wait(200);
  const en = await page.evaluate(async () => { try { await window.APVoice.enable(); return 'ok'; } catch (e) { return 'ERR ' + (e && e.message || e); } });
  expect('voice enabled in the browser', en === 'ok', en);
  return page;
}

const ducked = (page) => page.evaluate(() => !!(window.APVoice.capture && window.APVoice.capture.ducked));
const suppressed = (page) => page.evaluate(() => (window.APVoice.capture && window.APVoice.capture.duckedSegs) || 0);
const micLive = (page) => page.evaluate(() => {
  const c = window.APVoice.capture;
  const tr = c && c.stream && c.stream.getAudioTracks && c.stream.getAudioTracks()[0];
  return !!(tr && tr.readyState === 'live') && !!document.getElementById('ap-voice-badge');
});
const nTx = (s) => s.getTranscripts(0).transcripts.length;

// ── T-0685-DUCK / T-0685-UNDUCK / T-0685-WINS: one run, because they are one lifecycle ───────────
test('T-0685-DUCK/UNDUCK/WINS — playback ducks capture, barge-in is suppressed, `end` lifts it', async () => {
  process.env.PRESENTER_ASR_CMD = 'node ' + STUB;
  delete process.env.AP_ASR_COUNT_FILE;
  const wav = loopWav();
  const s = await createServer({ port: 0, voiceEnabled: true });
  const b = await launchVoice({ wavPath: wav });
  try {
    const page = await openVoicePage(s, b);

    // (0) capture is ALIVE to begin with — otherwise "frozen" below would prove nothing.
    await until(() => nTx(s) >= 1, 'a transcript before any playback');
    expect('not ducked before playback', !(await ducked(page)));

    // (1) the server speaks; the client's apSpeak cancels, then queues the utterance.
    s.speak('this is the agent speaking a short reply aloud');
    await until(async () => (await page.evaluate(() => window.__tts.spoken)) === 1, 'apSpeak reached the synthesiser');
    expect('cancel() precedes every utterance (trap 3)', (await page.evaluate(() => window.__tts.cancels)) === 1);
    expect('queuing alone does NOT duck (the duck follows audio, not the queue)', !(await ducked(page)));

    // (2) audio begins ⇒ capture ducks.
    await page.evaluate(() => window.__tts.last.onstart());
    expect('capture is ducked once playback starts', await ducked(page));
    expect('⛔ the mic was NOT released — ducking is capture-side only', await micLive(page));

    // (3) WINS: while ducked, no segment opens, so the server never sees an interruption.
    s.setSpeaking(true);
    const txAtDuck = nTx(s), supAtDuck = await suppressed(page);
    await wait(LOOP_SECS * 1000 + 1500);        // long enough for at least one whole VAD utterance
    expect('nothing was transcribed while ducked (capture is dead)', nTx(s) === txAtDuck, nTx(s) + ' vs ' + txAtDuck);
    expect('the suppressed-segment counter rose (G6: the discard is counted, not silent)',
      (await suppressed(page)) > supAtDuck, supAtDuck + ' -> ' + (await suppressed(page)));
    expect('⭐ DUCKING WINS: no barge-in fired, speaking-state survives playback', s.isSpeaking() === true);

    // (4) `end` lifts the duck, unconditionally, and capture resumes.
    await page.evaluate(() => window.__tts.last.onend());
    expect('the duck lifted on end', !(await ducked(page)));
    await until(() => nTx(s) > txAtDuck, 'capture resumed after the duck lifted');
    // ...and barge-in resumes with it: the next real segment interrupts the still-speaking agent.
    expect('barge-in works again once the duck is lifted', s.isSpeaking() === false);
  } finally { await b.close(); await s.close(); try { unlinkSync(wav); } catch (e) {} }
});

// ── T-0685-WATCHDOG: the forbidden implementation ────────────────────────────────────────────────
test('T-0685-WATCHDOG — a TTS that never reports end leaves capture DEAD, and the watchdog rescues it', async () => {
  process.env.PRESENTER_ASR_CMD = 'node ' + STUB;
  delete process.env.AP_ASR_COUNT_FILE;
  const wav = loopWav();
  const s = await createServer({ port: 0, voiceEnabled: true });
  const b = await launchVoice({ wavPath: wav });
  try {
    const page = await openVoicePage(s, b);
    await until(() => nTx(s) >= 1, 'a transcript before any playback');

    // Short text ⇒ a short watchdog. The bound is read from the IMPLEMENTATION, never copied.
    const text = 'ok';
    const budget = await page.evaluate((t) => window.__apSpeakDuck.ms(t), text);
    expect('the watchdog bound is finite and bounded', budget > 0 && budget <= 30000, String(budget));

    s.speak(text);
    await until(async () => (await page.evaluate(() => window.__tts.spoken)) === 1, 'apSpeak reached the synthesiser');
    await page.evaluate(() => window.__tts.last.onstart());
    // ⛔ NEITHER onend NOR onerror IS EVER FIRED. This is the removed-un-duck case, reproduced.
    expect('ducked at playback start', await ducked(page));

    // WATCH IT STAY DEAD. A guard only ever seen to pass is untested: observe the failure it prevents.
    const txAtDuck = nTx(s);
    await wait(Math.max(0, budget - 800));
    expect('still ducked with no end event — capture stayed dead all through the window', await ducked(page));
    expect('nothing transcribed while the un-duck was missing', nTx(s) === txAtDuck, nTx(s) + ' vs ' + txAtDuck);

    // Only the absolute watchdog can lift it now.
    await until(async () => !(await ducked(page)), 'the watchdog lifted the duck', { timeout: 12000 });
    expect('the mic was still never released', await micLive(page));
    await until(() => nTx(s) > txAtDuck, 'capture resumed after the watchdog fired');
  } finally { await b.close(); await s.close(); try { unlinkSync(wav); } catch (e) {} }
});

// ── T-0685-FENCE: the OFF page still carries zero audio-in code ───────────────────────────────────
test('T-0685-FENCE — the capture-side duck hook is fenced; the TTS side survives stripping and is inert', () => {
  const on = renderPresenterPage(true);
  const off = renderPresenterPage(false);
  expect('the capture-side hook is defined when voice is ON', /window\.__apDuckCapture\s*=\s*function/.test(on));
  expect('the capture-side hook is STRIPPED when voice is OFF', !/window\.__apDuckCapture\s*=\s*function/.test(off));
  // The TTS half is audio OUT — never stripped — and must hold no reference to the audio-in runtime.
  expect('apSpeak survives stripping', /function apSpeak\(/.test(off));
  expect('the duck call survives stripping (inert without the hook)', /__apDuckCapture/.test(off));
  expect('the un-duck survives stripping', /function apUnduck\(/.test(off));
  expect('no audio-in runtime reference leaks into the OFF page', !/\bAPVoice\b/.test(off), 'APVoice leaked into the OFF page');
});
