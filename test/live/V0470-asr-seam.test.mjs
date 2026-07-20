/*
 * T-ASR-SEAM / T-ASR-WARM / T-BINARY / T-RECONNECT (Plan 0470, Phase A).
 * Drives the server's inbound-voice lane with a raw Node WebSocket client and the CI STUB
 * ASR worker (no whisper, no browser, no network). Exercises the binary PCM lane, the WARM
 * persistent worker, the durable-op-cap exemption, byte-rate cap, and open-segment timeout.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { WebSocket } from 'ws';
import * as log from '../../app/log.mjs';
import { createServer } from '../../app/server.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';

const STUB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'voice', 'asr-stub.mjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws'));
    const msgs = [];
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('message', (d, isBin) => { if (isBin) return; let m; try { m = JSON.parse(d.toString()); } catch (e) { return; } msgs.push(m); if (m.t === 'welcome') resolve({ ws, msgs }); });
  });
}
// 16 kHz PCM16 mono buffer of a 300 Hz tone (energy well above the VAD floor).
function pcm(nSamples, amp = 9000) {
  const a = new Int16Array(nSamples);
  for (let i = 0; i < nSamples; i++) a[i] = Math.round(amp * Math.sin(2 * Math.PI * 300 * i / 16000));
  return Buffer.from(a.buffer);
}
async function speak(spk, seq, nSamples = 8000) {
  spk.ws.send(JSON.stringify({ t: 'voice_seg_start', seq }));
  spk.ws.send(pcm(nSamples));   // binary frame (>= 9600 bytes when nSamples>=4800)
  spk.ws.send(JSON.stringify({ t: 'voice_seg_end', seq }));
}
async function until(pred, label, { timeout = 5000, every = 50 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(every); }
  throw new Error('timeout waiting for ' + label);
}

test('T-ASR-SEAM completed segment -> {t:transcript} to presenter + AP ring (stub ASR)', async () => {
  process.env.PRESENTER_ASR_CMD = 'node ' + STUB;
  delete process.env.AP_ASR_COUNT_FILE;
  const s = await createServer({ port: 0 });
  try {
    const pres = await client(s.url(), { userId: 'gm', userName: 'GM', role: 'presenter' });
    const spk = await client(s.url(), { userId: 'u1', userName: 'Alice', role: 'participant' });
    await speak(spk, 1);
    await until(() => pres.msgs.some((m) => m.t === 'transcript' && m.text === 'hello world' && m.final === true), 'transcript to presenter');
    const t = pres.msgs.find((m) => m.t === 'transcript');
    expect('transcript carries authoritative speaker identity', t.userId === 'u1', t.userId);
    const got = s.getTranscripts(0);
    expect('stored in cursored ring', got.transcripts.length === 1 && got.transcripts[0].text === 'hello world', JSON.stringify(got));
    pres.ws.close(); spk.ws.close();
  } finally { await s.close(); }
});

test('T-ASR-WARM worker spawned ONCE, serves >=3 segments without re-spawning', async () => {
  const countFile = join(tmpdir(), 'ap-asr-count-' + Date.now());
  writeFileSync(countFile, '0');
  process.env.PRESENTER_ASR_CMD = 'node ' + STUB;
  process.env.AP_ASR_COUNT_FILE = countFile;
  const s = await createServer({ port: 0 });
  try {
    const pres = await client(s.url(), { userId: 'gm', userName: 'GM', role: 'presenter' });
    const spk = await client(s.url(), { userId: 'u1', userName: 'A', role: 'participant' });
    for (let seq = 1; seq <= 3; seq++) {
      await speak(spk, seq);
      await until(() => pres.msgs.filter((m) => m.t === 'transcript').length >= seq, 'transcript ' + seq);
    }
    const starts = parseInt(readFileSync(countFile, 'utf8'), 10);
    expect('ASR worker spawned exactly once across 3 segments (WARM, not cold-per-segment)', starts === 1, 'starts=' + starts);
    pres.ws.close(); spk.ws.close();
  } finally { await s.close(); delete process.env.AP_ASR_COUNT_FILE; try { unlinkSync(countFile); } catch (e) {} }
});

test('T-BINARY gated by active session, exempt from durable-op cap, byte-rate capped (RT-6/7)', async () => {
  process.env.PRESENTER_ASR_CMD = 'node ' + STUB;
  delete process.env.AP_ASR_COUNT_FILE;
  log.clear();
  const s = await createServer({ port: 0 });
  try {
    const pres = await client(s.url(), { userId: 'gm', userName: 'GM', role: 'presenter' });
    const spk = await client(s.url(), { userId: 'u1', userName: 'A', role: 'participant' });

    // 1) stray binary with NO active session -> ignored + logged, no transcript.
    spk.ws.send(pcm(4000));
    await wait(200);
    expect('stray binary (no session) ignored + logged', log.tail(300).some((e) => e.tag === 'voice' && e.msg === 'binary-no-session'));
    expect('no transcript from stray binary', s.getTranscripts(0).transcripts.length === 0);

    // 2) exempt from the 50 durable-ops/sec cap: blast 120 binary frames in a session -> no throttle.
    spk.ws.send(JSON.stringify({ t: 'voice_seg_start', seq: 1 }));
    for (let i = 0; i < 120; i++) spk.ws.send(pcm(80));
    spk.ws.send(JSON.stringify({ t: 'voice_seg_end', seq: 1 }));
    await until(() => s.getTranscripts(0).transcripts.length >= 1, 'session-1 finalized');
    expect('binary frames never counted against the durable-op rate cap', s.telemetry().ops.throttled === 0, 'throttled=' + s.telemetry().ops.throttled);

    // 3) token-bucket flood control (F1): a burst EXCEEDING one full segment's capacity (>960 KB)
    //    throttles the overflow AND surfaces it (rate-drop log + a voice_dropped frame) — never silent.
    spk.ws.send(JSON.stringify({ t: 'voice_seg_start', seq: 2 }));
    for (let i = 0; i < 11; i++) spk.ws.send(pcm(50000));   // 11 * 100 KB = 1.1 MB > 960 KB capacity
    spk.ws.send(JSON.stringify({ t: 'voice_seg_end', seq: 2 }));
    await until(() => spk.msgs.some((m) => m.t === 'voice_dropped'), 'flood surfaced to speaker');
    expect('over-capacity flood throttled + logged (rate-drop)', log.tail(400).some((e) => e.tag === 'voice' && e.msg === 'rate-drop'));
    expect('drop SURFACED to the speaker (never silent)', spk.msgs.some((m) => m.t === 'voice_dropped' && m.reason === 'rate'));
    pres.ws.close(); spk.ws.close();
  } finally { await s.close(); }
});

test('T-LONG-UTTERANCE (F1) a >2s burst arrives WHOLE (no truncation); force-cut still bounds a 30s+ babble', async () => {
  process.env.PRESENTER_ASR_CMD = 'node ' + STUB;
  delete process.env.AP_ASR_COUNT_FILE;
  log.clear();
  const s = await createServer({ port: 0 });
  try {
    const spk = await client(s.url(), { userId: 'u1', userName: 'A', role: 'participant' });
    await client(s.url(), { userId: 'gm', userName: 'GM', role: 'presenter' });

    // A single final-only burst of ~128 KB (~4s of 16 kHz PCM16) — well over the old 64 KB window cap,
    // well under the 960 KB force-cut. It MUST be accumulated whole.
    const N = 128 * 1024;                       // 128 KB total
    const samples = N / 2;                       // 65536 samples
    spk.ws.send(JSON.stringify({ t: 'voice_seg_start', seq: 1 }));
    // send in 8 frames of 16 KB (8192 samples) — mirrors the worklet's 100ms batches
    for (let i = 0; i < 8; i++) spk.ws.send(pcm(8192));
    spk.ws.send(JSON.stringify({ t: 'voice_seg_end', seq: 1 }));
    await until(() => s.getTranscripts(0).transcripts.length >= 1, 'long segment recognized');
    // BYTE INTEGRITY (the F1 regression): the finalized segment must carry ALL 128 KB — the old
    // per-second cap truncated any >2s utterance to ~64000 B.
    const fin = log.tail(400).find((e) => e.tag === 'voice' && e.msg === 'seg-final');
    expect('segment finalized with the FULL byte count (no ~2s truncation)', fin && fin.fields.bytes === N, 'bytes=' + (fin && fin.fields.bytes) + ' expected=' + N);
    // No throttle/force-cut fired for a legit sub-capacity utterance.
    expect('no voice_dropped for a legit >2s utterance (F1 fixed)', !spk.msgs.some((m) => m.t === 'voice_dropped'), JSON.stringify(spk.msgs.filter((m) => m.t === 'voice_dropped')));
    expect('no force-cut for a 128 KB (~4s) utterance', !log.tail(400).some((e) => e.tag === 'voice' && e.msg === 'seg-forcecut'));

    // (b) a burst EXCEEDING one segment's capacity is bounded by the FORCE-CUT, NOT silently bucket-dropped.
    log.clear();
    spk.ws.send(JSON.stringify({ t: 'voice_seg_start', seq: 2 }));
    for (let i = 0; i < 10; i++) spk.ws.send(pcm(48000));   // 10 * 96000 B = 960000 B = VOICE_SEG_MAX_BYTES
    spk.ws.send(JSON.stringify({ t: 'voice_seg_end', seq: 2 }));
    await until(() => log.tail(400).some((e) => e.tag === 'voice' && e.msg === 'seg-forcecut'), 'force-cut bounds the over-capacity segment');
    expect('over-capacity segment bounded by force-cut, not silently bucket-dropped', !spk.msgs.some((m) => m.t === 'voice_dropped'));
    spk.ws.close();
  } finally { await s.close(); }
});

test('T-RECONNECT open segment starved of frames is flushed/discarded + logged; state resets (RT-14)', async () => {
  process.env.PRESENTER_ASR_CMD = 'node ' + STUB;
  delete process.env.AP_ASR_COUNT_FILE;
  process.env.PRESENTER_VOICE_SEG_TIMEOUT_MS = '250';
  log.clear();
  const s = await createServer({ port: 0 });
  try {
    const pres = await client(s.url(), { userId: 'gm', userName: 'GM', role: 'presenter' });
    const spk = await client(s.url(), { userId: 'u1', userName: 'A', role: 'participant' });
    // open a segment with too little audio, then STOP -> timeout flushes/discards it.
    spk.ws.send(JSON.stringify({ t: 'voice_seg_start', seq: 1 }));
    spk.ws.send(pcm(1000));   // 2000 B < 9600 B min -> discarded as too-short on timeout
    await until(() => log.tail(400).some((e) => e.tag === 'voice' && e.msg === 'seg-timeout'), 'segment timed out');
    expect('starved open segment flushed/discarded with a log', log.tail(400).some((e) => e.tag === 'voice' && (e.msg === 'seg-too-short' || e.msg === 'seg-timeout')));
    // server-side state reset: a fresh full segment on the SAME conn still recognizes.
    await speak(spk, 2);
    await until(() => s.getTranscripts(0).transcripts.length >= 1, 'post-timeout segment recognized');
    pres.ws.close(); spk.ws.close();
  } finally { await s.close(); delete process.env.PRESENTER_VOICE_SEG_TIMEOUT_MS; }
});
