/*
 * voice-capture.mjs — Tier 1 controller (Plan 0470, inbound voice). Loaded ONLY via
 * dynamic import() from the Tier-0 stub's enable() — never statically (RT-10 / T-LAZY).
 *
 * Responsibilities:
 *  - create the AudioContext AFTER a user gesture (the mic-enable click doubles as it, RT-2)
 *  - getUserMedia with SINGLE-DSP-OWNER constraints (RT-19): noiseSuppression:false,
 *    autoGainControl:false, echoCancellation:true (echo guard for a co-located 0469 TTS, RT-5)
 *  - addModule('/lib/voice-worklet.js') + wire the realtime DSP node
 *  - batch ~100 ms of 16 kHz PCM16 per binary WS message, bracketing each utterance with
 *    {t:'voice_seg_start',seq} · <binary frames> · {t:'voice_seg_end',seq}  (RT-6)
 *  - render a persistent on-air badge + one-click local stop/mute (RT-9)
 *  - expose duckWhilePlaying(bool) so a client also running 0469 mutes capture during
 *    local TTS playback (RT-5)
 *  - Tier-2 enhancers (opts.denoise / opts.vad==='silero') = flag-gated dynamic-import
 *    SCAFFOLD ONLY in MVP (no real WASM assets wired — Phase B).
 */

const BATCH_SAMPLES = 1600;   // 100 ms @ 16 kHz (Int16) ≈ 3.2 KB per WS message (RT-6)

/**
 * Start capturing. `socket` is the page's live WebSocket (binary lane shares it).
 * Returns a controller: { stop(), duckWhilePlaying(bool), badgeEl, node, context }.
 */
export async function startCapture({ getSocket, socket, opts = {} } = {}) {
  // BUGFIX 2026-07-20 (S206): resolve the page's CURRENT socket on every send. Previously the
  // socket was captured by value at enable() — null-at-start or dead-after-reconnect meant every
  // PCM frame was silently dropped at the readyState guard. getSocket() (APVoiceHost.getSocket)
  // always returns the live ws.
  const resolveSocket = (typeof getSocket === 'function') ? getSocket : (() => socket);
  if (typeof AudioWorklet === 'undefined' && !(window.AudioContext || window.webkitAudioContext))
    throw new Error('voice: Web Audio unavailable');

  const AC = window.AudioContext || window.webkitAudioContext;
  const context = new AC();                       // created post-gesture (enable click, RT-2)
  if (context.state === 'suspended') { try { await context.resume(); } catch (e) {} }
  if (!context.audioWorklet) { try { context.close(); } catch (e) {} throw new Error('voice: AudioWorklet unavailable (RT-23)'); }

  // Uncoerceable mic prompt (RT-9). SINGLE DSP OWNER (RT-19): we do HPF/AGC ourselves.
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) { try { context.close(); } catch (_) {} throw new Error('voice: mic permission denied or unavailable — ' + (e && e.message || e)); }

  await context.audioWorklet.addModule('/lib/voice-worklet.js');
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'voice-worklet', {
    numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
    processorOptions: {
      hpfHz: opts.hpfHz, lpfHz: opts.lpfHz, vadThreshold: opts.vadThreshold,
      minSilenceMs: opts.minSilenceMs, minSpeechMs: opts.minSpeechMs,
      targetRms: opts.targetRms, noiseFloor: opts.noiseFloor, maxGain: opts.maxGain,
      normalize: opts.normalize,
    },
  });
  source.connect(node);
  // Keep the graph pulling without audible output: route to a muted gain -> destination.
  const sink = context.createGain(); sink.gain.value = 0;
  node.connect(sink); sink.connect(context.destination);

  const ctrl = {
    context, node, stream, socket,
    ducked: false, stopped: false, segOpen: false, curSeq: 0,
    batch: [], batchLen: 0, sent: 0, dropped: 0,
    badgeEl: null,
  };

  // ---- WS framing (binary lane) ----
  const sendJson = (o) => { try { const s = resolveSocket(); if (s && s.readyState === 1) s.send(JSON.stringify(o)); } catch (e) {} };
  const sendBinary = (int16) => { try { const s = resolveSocket(); if (s && s.readyState === 1) { s.send(int16.buffer); ctrl.sent++; } else { ctrl.dropped++; } } catch (e) {} };
  // TEMP STAGE-TRACER (S206 debug; strip once verified) — report client pipeline transitions to
  // the server over the live chat lane so they surface in presenter_situation. Low-noise: one line
  // per transition per utterance (S3 fires once, at the first successful flush).
  const trace = (tag, extra) => { try { const s = resolveSocket(); if (s && s.readyState === 1) s.send(JSON.stringify({ t: 'voicedbg', tag: tag, data: extra || null })); } catch (e) {} };
  function flushBatch() {
    if (!ctrl.batchLen) return;
    const merged = new Int16Array(ctrl.batchLen);
    let off = 0;
    for (const f of ctrl.batch) { merged.set(f, off); off += f.length; }
    ctrl.batch = []; ctrl.batchLen = 0;
    sendBinary(merged);
  }

  node.port.onmessage = (e) => {
    const d = e.data; if (!d || ctrl.stopped) return;   // BUGFIX (S206): gate ONLY pcm on duck, never brackets
    if (d.type === 'level') { trace('L level', { raw: +Number(d.raw).toFixed(4), nrm: +Number(d.nrm).toFixed(4) }); return; }   // S206 meter
    if (d.type === 'seg-start') { ctrl.curSeq = d.seq; ctrl.segOpen = true; ctrl.sent = 0; ctrl.dropped = 0; sendJson({ t: 'voice_seg_start', seq: d.seq }); trace('S2 seg-start', { seq: d.seq, rs: (resolveSocket() || {}).readyState }); }
    else if (d.type === 'pcm') {
      if (ctrl.ducked) return;              // drop audio only while ducked; keep the bracket intact
      const f = new Int16Array(d.pcm);      // transferred buffer
      ctrl.batch.push(f); ctrl.batchLen += f.length;
      if (ctrl.batchLen >= BATCH_SAMPLES) { const before = ctrl.sent; flushBatch(); if (before === 0 && ctrl.sent === 1) trace('S3 pcm-flush', { seq: ctrl.curSeq, rs: (resolveSocket() || {}).readyState }); }
    } else if (d.type === 'seg-end') {
      flushBatch();
      if (ctrl.segOpen) sendJson({ t: 'voice_seg_end', seq: d.seq });
      ctrl.segOpen = false;
      trace('S4 seg-end', { seq: d.seq, sent: ctrl.sent, dropped: ctrl.dropped });
    }
  };

  // ---- on-air badge + local stop/mute (RT-9) ----
  renderBadge(ctrl);
  try { const tr = (stream.getAudioTracks && stream.getAudioTracks()[0]) || null; trace('S1 mic-open', { label: tr && tr.label, rs: (resolveSocket() || {}).readyState, ctx: context.state, sr: context.sampleRate }); } catch (e) {}

  // ---- Tier-2 enhancer SCAFFOLD (Phase B; flag-gated dynamic import, NOT wired here) ----
  if (opts.denoise) {
    // Phase B (2a): main-thread RNNoise WASM denoise before VAD. ~150 KB own lazy chunk.
    try { const m = await import('/lib/voice-denoise-rnnoise.js').catch(() => null); if (m && m.attach) m.attach(ctrl); }
    catch (e) { /* scaffold: real asset ships in a later plan */ }
  }
  if (opts.vad === 'silero') {
    // Phase B (2b): single-thread onnxruntime-web + silero model. Own multi-MB lazy chunk.
    try { const m = await import('/lib/voice-vad-silero.js').catch(() => null); if (m && m.attach) m.attach(ctrl); }
    catch (e) { /* scaffold: real asset ships in a later plan */ }
  }

  ctrl.duckWhilePlaying = (on) => { ctrl.ducked = !!on; };   // RT-5
  ctrl.stop = () => stopCapture(ctrl, flushBatch, sendJson);
  return ctrl;
}

function renderBadge(ctrl) {
  const doc = window.document;
  let el = doc.getElementById('ap-voice-badge');
  if (!el) {
    el = doc.createElement('div');
    el.id = 'ap-voice-badge';
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;top:10px;right:12px;z-index:99999;display:flex;align-items:center;gap:8px;' +
      'background:#7a1020;color:#fff;padding:6px 10px;border-radius:14px;font:600 13px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4)';
    el.innerHTML = '<span aria-hidden="true" style="width:9px;height:9px;border-radius:50%;background:#ff4d5e;box-shadow:0 0 6px #ff4d5e"></span>' +
      '<span>Mic on-air</span><button id="ap-voice-stop" type="button" style="margin-left:4px;background:#fff;color:#7a1020;border:0;border-radius:8px;padding:2px 8px;font:600 12px system-ui;cursor:pointer">Stop</button>';
    doc.body.appendChild(el);
    const btn = doc.getElementById('ap-voice-stop');
    if (btn) btn.addEventListener('click', () => { if (ctrl.stop) ctrl.stop(); });
  }
  ctrl.badgeEl = el;
}

function stopCapture(ctrl, flushBatch, sendJson) {
  if (ctrl.stopped) return;
  ctrl.stopped = true;
  try { ctrl.node && ctrl.node.port && ctrl.node.port.postMessage({ type: 'stop' }); } catch (e) {}
  flushBatch();
  if (ctrl.segOpen) { sendJson({ t: 'voice_seg_end', seq: ctrl.curSeq }); ctrl.segOpen = false; }
  try { ctrl.stream && ctrl.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  try { ctrl.node && ctrl.node.disconnect(); } catch (e) {}
  try { ctrl.context && ctrl.context.close(); } catch (e) {}
  try { const el = window.document.getElementById('ap-voice-badge'); if (el) el.remove(); } catch (e) {}
  if (window.APVoice) { window.APVoice.enabled = false; window.APVoice.capture = null; }
  if (window.__apVoicePaint) { try { window.__apVoicePaint(); } catch (e) {} }   // RT-27: reflect stop in the Settings row
}
