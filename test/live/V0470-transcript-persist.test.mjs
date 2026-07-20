/*
 * T-TRANSCRIPT-PERSIST (Plan 0470, Phase A, RT-26). Recognized text is EPHEMERAL BY DEFAULT
 * (bounded ring only, nothing on disk); opt-in PRESENTER_TRANSCRIPT_PERSIST appends one JSONL
 * line per final transcript to a STABLE file that survives restart; clients are TOLD the flag;
 * audio segment WAVs are ALWAYS discarded after ASR regardless of the flag.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs';

const STUB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'voice', 'asr-stub.mjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws'));
    const msgs = [];
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('message', (d, b) => { if (b) return; let m; try { m = JSON.parse(d.toString()); } catch (e) { return; } msgs.push(m); if (m.t === 'welcome') resolve({ ws, msgs, welcome: m }); });
  });
}
function pcm(n, amp = 9000) { const a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = Math.round(amp * Math.sin(2 * Math.PI * 300 * i / 16000)); return Buffer.from(a.buffer); }
async function speak(c, seq) { c.ws.send(JSON.stringify({ t: 'voice_seg_start', seq })); c.ws.send(pcm(8000)); c.ws.send(JSON.stringify({ t: 'voice_seg_end', seq })); }
async function until(pred, label, { timeout = 5000 } = {}) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(50); } throw new Error('timeout ' + label); }

test('T-TRANSCRIPT-PERSIST OFF=ephemeral / ON=opt-in JSONL survives restart / audio never persists (RT-26)', async () => {
  process.env.PRESENTER_ASR_CMD = 'node ' + STUB;
  delete process.env.AP_ASR_COUNT_FILE;
  const dir = join(tmpdir(), 'ap-tp-' + Date.now());
  const file = join(dir, 'transcripts.jsonl');
  const wavDir = join(tmpdir(), 'ap-asr');
  const wavBefore = existsSync(wavDir) ? readdirSync(wavDir).filter((f) => f.endsWith('.wav')).length : 0;

  // ---- OFF (default): ephemeral only ----
  delete process.env.PRESENTER_TRANSCRIPT_PERSIST;
  process.env.PRESENTER_TRANSCRIPT_DIR = dir;
  let s = await createServer({ port: 0 });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'A', role: 'participant' });
    expect('OFF: welcome reports transcriptPersisting=false', c.welcome.transcriptPersisting === false, JSON.stringify(c.welcome));
    await speak(c, 1);
    await until(() => s.getTranscripts(0).transcripts.length >= 1, 'off transcript');
    expect('OFF: ring still serves the transcript', s.getTranscripts(0).transcripts[0].text === 'hello world');
    expect('OFF: nothing written to disk', !existsSync(file));
    c.ws.close();
  } finally { await s.close(); }
  // a fresh instance carries NO history (ring is in-memory; loss on restart is intended)
  s = await createServer({ port: 0 });
  expect('OFF: a fresh instance has no history', s.getTranscripts(0).transcripts.length === 0);
  await s.close();

  // ---- ON: opt-in JSONL ----
  process.env.PRESENTER_TRANSCRIPT_PERSIST = '1';
  process.env.PRESENTER_TRANSCRIPT_DIR = dir;
  s = await createServer({ port: 0 });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'A', role: 'participant' });
    expect('ON: welcome reports transcriptPersisting=true (consent surface)', c.welcome.transcriptPersisting === true, JSON.stringify(c.welcome));
    await speak(c, 1);
    await until(() => existsSync(file) && readFileSync(file, 'utf8').trim().length > 0, 'on jsonl written');
    const lines1 = readFileSync(file, 'utf8').trim().split('\n');
    expect('ON: exactly one JSONL line written', lines1.length === 1, 'lines=' + lines1.length);
    const rec = JSON.parse(lines1[0]);
    expect('ON: JSONL line carries the RT-26 fields', rec.text === 'hello world' && rec.userId === 'u1' && typeof rec.ts === 'number' && 'seq' in rec && 'conf' in rec, JSON.stringify(rec));
    c.ws.close();
  } finally { await s.close(); }
  // restart APPENDS to the same stable file (history survives)
  s = await createServer({ port: 0 });
  try {
    const c = await client(s.url(), { userId: 'u2', userName: 'B', role: 'participant' });
    await speak(c, 1);
    await until(() => readFileSync(file, 'utf8').trim().split('\n').length >= 2, 'append after restart');
    const lines2 = readFileSync(file, 'utf8').trim().split('\n');
    expect('ON: restart APPENDS (prior history preserved)', lines2.length === 2, 'lines=' + lines2.length);
    c.ws.close();
  } finally { await s.close(); }

  // ---- audio never persists, either mode ----
  const wavAfter = existsSync(wavDir) ? readdirSync(wavDir).filter((f) => f.endsWith('.wav')).length : 0;
  expect('audio segments are discarded after ASR (no net lingering WAV)', wavAfter <= wavBefore, 'before=' + wavBefore + ' after=' + wavAfter);

  try { rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  delete process.env.PRESENTER_TRANSCRIPT_PERSIST; delete process.env.PRESENTER_TRANSCRIPT_DIR;
});
