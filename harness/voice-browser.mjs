/*
 * voice-browser.mjs — headless Chrome launch + a WAV fixture generator for the Plan 0470
 * inbound-voice browser tests. All CI runs use a FAKE audio device (no real mic) and the
 * stub ASR (no whisper). Not auto-discovered by the runner (lives under harness/).
 */
import puppeteer from 'puppeteer';
import { resolveChrome } from './browser.mjs';
import { writeFileSync } from 'fs';

/** Launch headless Chrome wired for fake-media capture. Pass a wavPath to feed fake audio. */
export async function launchVoice({ wavPath = null } = {}) {
  const exe = resolveChrome();
  const args = [
    '--no-sandbox', '--use-gl=swiftshader',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',                 // auto-grant the mic permission prompt in CI
    '--autoplay-policy=no-user-gesture-required',     // let the AudioContext start headless
  ];
  if (wavPath) args.push('--use-file-for-fake-audio-capture=' + wavPath);
  return puppeteer.launch(Object.assign({ headless: 'new', args }, exe ? { executablePath: exe } : {}));
}

/**
 * Write a mono 16-bit PCM WAV: `parts` is a list of {freq, secs, amp}; freq=0 -> silence.
 * Chrome loops the file through the fake device, so a tone bracketed by silence produces a
 * VAD-endpointed utterance.
 */
export function writeWav(path, parts, rate = 48000) {
  const samples = [];
  for (const p of parts) {
    const n = Math.round(p.secs * rate);
    for (let i = 0; i < n; i++) samples.push(p.freq ? (p.amp || 0.3) * Math.sin(2 * Math.PI * p.freq * i / rate) : 0);
  }
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) { let v = Math.max(-1, Math.min(1, samples[i])); data.writeInt16LE(Math.round(v * 32767), i * 2); }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
  return path;
}
