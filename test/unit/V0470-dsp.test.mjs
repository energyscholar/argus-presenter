/*
 * T-WORKLET / T-VAD / T-SECURE (Plan 0470, Phase A). The worklet DSP is factored into PURE
 * functions (RT-13) so the realtime math runs off-thread in Node against fixture buffers.
 * T-SECURE drives the Tier-0 stub gate with a mocked insecure global (no browser, no mic).
 */
import { test, expect } from '../../harness/test.mjs';
import { runChain, segmentSignal, rms, normalizeConservative } from '../../lib/voice-worklet.js';

function sine(freq, secs, rate, amp = 0.3) {
  const n = Math.round(secs * rate), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * freq * i / rate);
  return out;
}
function concat(...arrs) {
  const n = arrs.reduce((s, a) => s + a.length, 0), out = new Float32Array(n);
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out;
}
const silence = (secs, rate) => new Float32Array(Math.round(secs * rate));

// ---- T-WORKLET (RT-2/3/11) ----

test('T-WORKLET resamples 48k -> 16k (output length ~ input * 16/48)', () => {
  const inp = sine(1000, 1.0, 48000);            // 48000 samples
  const { samples16k } = runChain(inp, 48000, { enabled: false });
  const ratio = samples16k.length / inp.length;
  console.log(`  in=${inp.length} out=${samples16k.length} ratio=${ratio.toFixed(4)}`);
  expect(Math.abs(ratio - 1 / 3) < 0.01, 'output rate is ~16 kHz', ratio);
});

test('T-WORKLET DC / <80 Hz is removed (high-pass)', () => {
  const dc = new Float32Array(48000).fill(0.5);   // pure DC offset
  const { samples16k } = runChain(dc, 48000, { enabled: false });
  // ignore the filter's startup transient
  const tail = samples16k.subarray(2000);
  expect(rms(tail) < 0.02, 'DC removed to near-zero', rms(tail));
});

test('T-WORKLET content above ~7.5 kHz is attenuated before decimation (anti-alias)', () => {
  const lo = runChain(sine(1000, 0.5, 48000), 48000, { enabled: false });   // in-band
  const hi = runChain(sine(11000, 0.5, 48000), 48000, { enabled: false });  // above LPF corner
  const rl = rms(lo.samples16k.subarray(1000)), rh = rms(hi.samples16k.subarray(1000));
  console.log(`  rms(1k)=${rl.toFixed(4)} rms(11k)=${rh.toFixed(4)} ratio=${(rh / rl).toFixed(3)}`);
  expect(rh < rl * 0.35, '11 kHz strongly attenuated vs 1 kHz', (rh / rl).toFixed(3));
});

test('T-WORKLET conservative normalize pulls level toward target RMS (RT-18)', () => {
  const quiet = sine(1000, 0.5, 48000, 0.05);    // RMS ~0.035, above the 0.01 floor
  const { samples16k } = runChain(quiet, 48000, { targetRms: 0.12, noiseFloor: 0.01, maxGain: 4 });
  const r = rms(samples16k.subarray(1000));
  console.log(`  normalized rms=${r.toFixed(4)}`);
  expect(r > 0.08 && r <= 0.14, 'normalized toward ~0.12', r);
});

test('T-WORKLET normalize applies NO gain below the noise floor (silence stays silent)', () => {
  const z = new Float32Array(1600);              // silence
  const out = normalizeConservative(z, { targetRms: 0.12, noiseFloor: 0.01 });
  expect(rms(out) === 0, 'no amplification of sub-floor silence');
});

// ---- T-VAD (RT-12/20) ----

test('T-VAD one speech burst between silence -> exactly one segment', () => {
  const sig = concat(silence(0.5, 16000), sine(300, 0.6, 16000, 0.3), silence(0.8, 16000));
  const segs = segmentSignal(sig, { outRate: 16000 });
  console.log(`  segments=${JSON.stringify(segs)}`);
  expect(segs.length === 1, 'exactly one segment', segs.length);
  expect(segs[0].start > 0 && segs[0].end > segs[0].start, 'plausible boundaries', JSON.stringify(segs[0]));
});

test('T-VAD a <300ms blip yields NO segment (hallucination guard)', () => {
  const sig = concat(silence(0.5, 16000), sine(300, 0.1, 16000, 0.3), silence(0.8, 16000));
  const segs = segmentSignal(sig, { outRate: 16000 });
  expect(segs.length === 0, 'blip suppressed', segs.length);
});

// ---- T-SECURE (RT-1) ----

test('T-SECURE enable() rejects on an insecure context and never reaches getUserMedia', async () => {
  const prevWin = globalThis.window, prevAW = globalThis.AudioWorklet, prevGum = globalThis.__gumCalled;
  globalThis.window = { isSecureContext: false };
  globalThis.AudioWorklet = function () {};      // present -> so the secure-context gate is what fires
  globalThis.__gumCalled = false;
  try {
    await import('../../lib/voice-stub.js?secure=' + Date.now());   // cache-bust so the IIFE re-runs
    let err = null;
    try { await globalThis.window.APVoice.enable(); } catch (e) { err = e; }
    expect(!!err, 'enable() rejected', err);
    expect(err && /secure context/i.test(err.message), 'clear secure-context error', err && err.message);
    expect(globalThis.__gumCalled === false, 'getUserMedia was never called');
  } finally { globalThis.window = prevWin; globalThis.AudioWorklet = prevAW; globalThis.__gumCalled = prevGum; }
});

test('T-SECURE (RT-23) enable() errors clearly when AudioWorklet is absent, no capture', async () => {
  const prevWin = globalThis.window, prevAW = globalThis.AudioWorklet;
  globalThis.window = { isSecureContext: true };
  delete globalThis.AudioWorklet;                // simulate a browser without AudioWorklet
  try {
    await import('../../lib/voice-stub.js?aw=' + Date.now());
    let err = null;
    try { await globalThis.window.APVoice.enable(); } catch (e) { err = e; }
    expect(err && /AudioWorklet/i.test(err.message), 'clear AudioWorklet error', err && err.message);
  } finally { globalThis.window = prevWin; globalThis.AudioWorklet = prevAW; }
});
