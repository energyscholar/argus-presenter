/*
 * voice-worklet.js — Tier 1 DSP (Plan 0470, inbound voice). PURE JS, dependency-free.
 *
 * Runs in the AudioWorklet realtime thread. Per 128-sample quantum at the context rate
 * (usually 48 kHz) it runs the ASR-optimized chain:
 *   1. DC-block / high-pass  ~80 Hz     (biquad)          [accuracy]
 *   2. anti-alias low-pass   ~7.5 kHz   (biquad)          [accuracy — BEFORE decimation, RT-11]
 *   3. resample ctx-rate -> 16 kHz mono                    [accuracy + server load, RT-3]
 *   4. CONSERVATIVE level normalize toward a target RMS    [accuracy — gentle, gated, RT-18]
 *   5. energy + hangover VAD -> speech-segment boundaries  [latency + server load, RT-20]
 * then postMessages 16 kHz PCM16 frames + segment-boundary events to the main thread
 * (a COPY via transfer, NEVER SharedArrayBuffer — RT-4).
 *
 * DUAL-USE FILE (RT-13 + testability). The worklet cannot import app code, so all DSP lives
 * here as dependency-free pure functions that are ALSO importable in Node (this is an ESM
 * module; the repo is type:module). The AudioWorkletProcessor subclass is defined only when
 * the worklet globals exist (guarded), so `import()` in Node loads just the pure functions
 * (T-WORKLET / T-VAD run off-thread against fixture buffers). No WebAssembly is referenced.
 */

// ---- Biquad (RBJ cookbook), Direct-Form-I, stateful ----

/** High-pass coefficients (normalized by a0). Q≈0.707 (Butterworth). */
export function hpfCoeffs(fc, fs, Q = 0.7071) {
  const w0 = 2 * Math.PI * fc / fs, cw = Math.cos(w0), sw = Math.sin(w0), alpha = sw / (2 * Q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cw) / 2) / a0, b1: (-(1 + cw)) / a0, b2: ((1 + cw) / 2) / a0,
    a1: (-2 * cw) / a0, a2: (1 - alpha) / a0,
  };
}

/** Low-pass coefficients (normalized by a0). Q≈0.707 (Butterworth). */
export function lpfCoeffs(fc, fs, Q = 0.7071) {
  const w0 = 2 * Math.PI * fc / fs, cw = Math.cos(w0), sw = Math.sin(w0), alpha = sw / (2 * Q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cw) / 2) / a0, b1: (1 - cw) / a0, b2: ((1 - cw) / 2) / a0,
    a1: (-2 * cw) / a0, a2: (1 - alpha) / a0,
  };
}

/** A stateful biquad. `process(x)` returns the filtered sample. */
export function makeBiquad(c) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return {
    process(x) {
      const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      return y;
    },
    reset() { x1 = x2 = y1 = y2 = 0; },
  };
}

// ---- Linear resampler (streaming), ctx-rate -> 16 kHz ----

/** Streaming linear-interpolation resampler. Anti-aliasing is done UPSTREAM by the LPF (RT-11). */
export function makeResampler(inRate, outRate) {
  const step = inRate / outRate;   // input samples consumed per output sample
  let pos = 0;                     // fractional read position within [prev, cur]
  let prev = 0;                    // last input sample of the previous block (continuity)
  let primed = false;
  return {
    /** Feed a Float32Array block; returns a Float32Array of ~len*outRate/inRate samples. */
    process(input) {
      const out = [];
      for (let i = 0; i < input.length; i++) {
        const cur = input[i];
        // Emit every output sample whose read position falls within [i-1, i].
        while (pos <= 1) {
          if (!primed) { primed = true; pos += step; continue; }
          out.push(prev + (cur - prev) * pos);
          pos += step;
        }
        pos -= 1;
        prev = cur;
      }
      return Float32Array.from(out);
    },
    reset() { pos = 0; prev = 0; primed = false; },
  };
}

// ---- Conservative level normalize (RT-18: NOT auto-riding AGC) ----

/** RMS of a Float32Array. */
export function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return buf.length ? Math.sqrt(s / buf.length) : 0;
}

/**
 * Gentle, gated normalize toward `targetRms`. NO gain applied below `noiseFloor`
 * (so we never amplify room hiss/silence into whisper hallucinations) and gain is
 * hard-capped at `maxGain`. Returns a NEW Float32Array. `toggle:false` = passthrough.
 */
export function normalizeConservative(buf, opts = {}) {
  const { targetRms = 0.12, noiseFloor = 0.01, maxGain = 4, enabled = true } = opts;
  if (!enabled) return buf.slice();
  const r = rms(buf);
  if (r < noiseFloor || r === 0) return buf.slice();          // below floor -> leave as-is
  let g = targetRms / r;
  if (g > maxGain) g = maxGain;                                // ceiling on applied gain
  if (g < 1 / maxGain) g = 1 / maxGain;
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    let v = buf[i] * g;
    if (v > 1) v = 1; else if (v < -1) v = -1;                 // clamp, don't wrap
    out[i] = v;
  }
  return out;
}

/** Float32 [-1,1] -> Int16 PCM (whisper's native input). */
export function floatToPcm16(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    let v = buf[i];
    if (v > 1) v = 1; else if (v < -1) v = -1;
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

// ---- Energy + hangover VAD (streaming state machine) ----

/**
 * Streaming VAD. `push(frameRms)` is called once per fixed-length frame (frameMs) and
 * returns an event string: 'start' (speech onset), 'end' (endpoint reached after
 * min-silence), or null. Endpoint requires `minSilenceMs` of continuous sub-threshold
 * energy (RT-20: too eager fragments utterances). A segment shorter than `minSpeechMs`
 * of accumulated speech is suppressed (RT-12: no whisper hallucinations on blips).
 */
export function makeVad(opts = {}) {
  const { frameMs = 20, threshold = 0.02, minSilenceMs = 600, minSpeechMs = 300 } = opts;
  const silenceFramesToEnd = Math.max(1, Math.round(minSilenceMs / frameMs));
  const minSpeechFrames = Math.max(1, Math.round(minSpeechMs / frameMs));
  let inSpeech = false;
  let silenceRun = 0;
  let speechFrames = 0;
  return {
    push(frameRms) {
      const voiced = frameRms >= threshold;
      if (!inSpeech) {
        if (voiced) { inSpeech = true; silenceRun = 0; speechFrames = 1; return 'start'; }
        return null;
      }
      // in speech
      if (voiced) { speechFrames++; silenceRun = 0; return null; }
      silenceRun++;
      if (silenceRun >= silenceFramesToEnd) {
        const enough = speechFrames >= minSpeechFrames;
        inSpeech = false; silenceRun = 0; const spoke = speechFrames; speechFrames = 0;
        return enough ? 'end' : 'abort';   // 'abort' = too short -> caller discards the segment
      }
      return null;
    },
    reset() { inSpeech = false; silenceRun = 0; speechFrames = 0; },
    get active() { return inSpeech; },
  };
}

// ---- Batch helpers (pure, for tests) ----

/**
 * Run the full DSP chain on one Float32 buffer (fresh state) — HPF -> LPF -> resample
 * -> conservative normalize. Returns { samples16k: Float32Array, pcm16: Int16Array }.
 * (T-WORKLET drives this against fixture signals; the realtime processor uses the same
 * primitives incrementally.)
 */
export function runChain(input, inRate, opts = {}) {
  const hpf = makeBiquad(hpfCoeffs(opts.hpfHz || 80, inRate));
  const lpf = makeBiquad(lpfCoeffs(opts.lpfHz || 7500, inRate));
  const res = makeResampler(inRate, opts.outRate || 16000);
  const filt = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) filt[i] = lpf.process(hpf.process(input[i]));
  const down = res.process(filt);
  const norm = normalizeConservative(down, opts);
  return { samples16k: norm, pcm16: floatToPcm16(norm) };
}

/**
 * Batch VAD segmentation for tests: returns [{start,end}] sample indices (at outRate)
 * for a 16 kHz signal. Mirrors the streaming makeVad state machine.
 */
export function segmentSignal(samples16k, opts = {}) {
  const { frameMs = 20, outRate = 16000 } = opts;
  const frameLen = Math.max(1, Math.round(outRate * frameMs / 1000));
  const vad = makeVad({ ...opts, frameMs });
  const segs = [];
  let segStart = 0;
  for (let f = 0; f * frameLen < samples16k.length; f++) {
    const frame = samples16k.subarray(f * frameLen, (f + 1) * frameLen);
    const ev = vad.push(rms(frame));
    if (ev === 'start') segStart = f * frameLen;
    else if (ev === 'end') segs.push({ start: segStart, end: (f + 1) * frameLen });
    // 'abort' -> drop (too short); null -> continue
  }
  return segs;
}

// ---- Realtime processor (guarded so Node import loads only the pure fns above) ----

if (typeof AudioWorkletProcessor !== 'undefined' && typeof registerProcessor === 'function') {
  const OUT_RATE = 16000;
  const FRAME_MS = 20;
  const FRAME_LEN = Math.round(OUT_RATE * FRAME_MS / 1000);   // 320 samples @16k

  class VoiceWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const o = (options && options.processorOptions) || {};
      // `sampleRate` is a global in AudioWorkletGlobalScope (the context rate).
      this.inRate = (typeof sampleRate === 'number' && sampleRate) || 48000;
      this.hpf = makeBiquad(hpfCoeffs(o.hpfHz || 80, this.inRate));
      this.lpf = makeBiquad(lpfCoeffs(o.lpfHz || 7500, this.inRate));
      this.res = makeResampler(this.inRate, OUT_RATE);
      this.vad = makeVad({ frameMs: FRAME_MS, threshold: o.vadThreshold || 0.02,
        minSilenceMs: o.minSilenceMs || 600, minSpeechMs: o.minSpeechMs || 300 });
      this.normOpts = { targetRms: o.targetRms || 0.12, noiseFloor: o.noiseFloor || 0.01,
        maxGain: o.maxGain || 4, enabled: o.normalize !== false };
      this.acc = new Float32Array(FRAME_LEN);
      this.accLen = 0;
      this.seq = 0;
      this.speaking = false;
      this.pending = [];   // normalized frames buffered from onset until (or unless) confirmed speech
      this.port.onmessage = (e) => { if (e.data && e.data.type === 'stop') this.stopped = true; };
    }
    emit(msg, transfer) { this.port.postMessage(msg, transfer || []); }
    process(inputs) {
      if (this.stopped) return false;
      const ch = inputs[0] && inputs[0][0];
      if (!ch) return true;
      // HPF -> LPF per input sample, then resample the block to 16k.
      const filt = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) filt[i] = this.lpf.process(this.hpf.process(ch[i]));
      const down = this.res.process(filt);
      for (let i = 0; i < down.length; i++) {
        this.acc[this.accLen++] = down[i];
        if (this.accLen === FRAME_LEN) { this.flushFrame(); this.accLen = 0; }
      }
      return true;
    }
    flushFrame() {
      const frame = normalizeConservative(this.acc.subarray(0, FRAME_LEN), this.normOpts);
      const ev = this.vad.push(rms(frame));
      if (ev === 'start') {
        this.seq++; this.speaking = true; this.pending = [frame];
      } else if (ev === 'end') {
        this.commitSegment(frame);                 // confirmed (>= minSpeech): bracket + flush
      } else if (ev === 'abort') {
        this.speaking = false; this.pending = [];  // too short -> discard, never sent
      } else if (this.speaking) {
        this.pending.push(frame);
        // Safety force-cut so a very long utterance can't grow the buffer unbounded
        // (~30 s). The server also caps segment length (RT-8/22); this is the client twin.
        if (this.pending.length >= 1500) { this.vad.reset(); this.commitSegment(null); }
      }
    }
    // Emit a whole buffered utterance as ONE bracketed segment (final-only latency is an
    // accepted MVP limitation). Main thread batches the PCM burst at ~100 ms.
    commitSegment(lastFrame) {
      this.emit({ type: 'seg-start', seq: this.seq });
      for (const f of this.pending) this.postPcm(f);
      if (lastFrame) this.postPcm(lastFrame);
      this.emit({ type: 'seg-end', seq: this.seq });
      this.speaking = false; this.pending = [];
    }
    postPcm(frame) {
      const pcm = floatToPcm16(frame);
      this.emit({ type: 'pcm', seq: this.seq, pcm }, [pcm.buffer]);
    }
  }
  registerProcessor('voice-worklet', VoiceWorkletProcessor);
}
