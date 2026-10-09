/*
 * Plan 0904 — shared raw-socket helpers for the voice tests. Not a test file (no `.test.`), so the
 * runner does not discover it. Every server here is LOCAL (127.0.0.1); the ASR is the CI stub.
 */
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mintCapability } from '../../lib/capability.mjs';

export const STUB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'voice', 'asr-stub.mjs');
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const SECRET = 'cap-secret-0904-tests';

export function useStubAsr(extraEnv = {}) {
  process.env.PRESENTER_ASR_CMD = 'node ' + STUB;
  delete process.env.AP_ASR_COUNT_FILE;
  delete process.env.AP_ASR_STUB_MODE;
  delete process.env.AP_ASR_STUB_TEXT;
  delete process.env.AP_ASR_STUB_DELAY_MS;
  Object.assign(process.env, extraEnv);
}

export function mkCap(over = {}, secret = SECRET) {
  const payload = Object.assign({ v: 1, sid: 's', role: 'participant', scope: ['speak', 'type'], name: 'Seat',
    exp: Math.floor(Date.now() / 1000) + 600, nonce: 'n-' + Math.random().toString(36).slice(2, 10) }, over);
  return { token: mintCapability(payload, secret), payload };
}

/** Open a socket, send hello, resolve once `welcome` (or a close) arrives. */
export function connect(url, hello = {}, { headers = {}, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws'), { headers });
    const frames = [];
    let done = false;
    const finish = () => { if (done) return; done = true; resolve({ ws, frames, welcome: frames.find((f) => f.t === 'welcome') || null, closed: ws.readyState >= 2 }); };
    const t = setTimeout(finish, timeoutMs);
    ws.on('message', (b, bin) => { if (bin) return; let m; try { m = JSON.parse(b.toString()); } catch { return; } frames.push(m); if (m.t === 'welcome') { clearTimeout(t); finish(); } });
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('close', () => { clearTimeout(t); finish(); });
    ws.on('error', () => {});
  });
}

/** n samples of a 300 Hz tone at amplitude amp, as PCM16 LE. */
export function pcm(n, amp = 9000) { const a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = Math.round(amp * Math.sin(2 * Math.PI * 300 * i / 16000)); return Buffer.from(a.buffer); }

/** One whole segment: start, PCM, end. `samples` 8000 = 500 ms. */
export function speak(c, seq, { samples = 8000, startedAt, endedAt, chunk = 3200 } = {}) {
  c.ws.send(JSON.stringify(Object.assign({ t: 'voice_seg_start', seq }, startedAt != null ? { startedAt } : {})));
  const buf = pcm(samples);
  for (let o = 0; o < buf.length; o += chunk * 2) c.ws.send(buf.subarray(o, Math.min(buf.length, o + chunk * 2)));
  c.ws.send(JSON.stringify(Object.assign({ t: 'voice_seg_end', seq }, endedAt != null ? { endedAt } : {})));
}

export async function until(pred, label, { timeout = 5000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await pred(); if (v) return v; await wait(25); }
  throw new Error('timeout waiting for ' + label);
}
export const frame = (c, pred) => c.frames.find(pred);
export const framesOf = (c, t) => c.frames.filter((f) => f.t === t);
