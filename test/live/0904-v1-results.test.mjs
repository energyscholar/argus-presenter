/*
 * Plan 0904 V1.1 / V1.7 / V1.8 — every segment gets exactly one result; entries carry timing; the
 * worker takes bytes; a failing engine falls back WITH a fault.
 *
 *   T0904-14a  the ASR worker killed mid-session ⇒ the next segment's voice_result is failed/(worker-exit|no-worker)
 *   T0904-14b  queue of 8 saturated ⇒ the NEWEST gets `dropped` (reason queue); the oldest completes
 *   T0904-10   a 200 ms blip ⇒ `too-short`, no transcript
 *   T0904-14c  a blank recognition ⇒ `empty`, no transcript
 *   T0904-20   hello without `voice` ⇒ no welcome.voice; with it ⇒ the negotiated answer; voice_text ⇒
 *              failed/mode; entries carry startedAt, endedAt, durationMs, asrMs, recognizer, codec, source
 *   T0904-21   a 35 s segment by its timestamps is cut at the ms cap though its PCM is small;
 *              a 200 ms segment by its timestamps is too-short though its PCM is long enough
 *   T0904-22   no WAV file is written; the worker receives the bytes; after 3 failures the fallback
 *              engages and a voice_fault asr-fallback is reported
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { useStubAsr, connect, speak, until, wait, frame, framesOf, STUB } from './_0904-voice.mjs';

const results = (c) => framesOf(c, 'voice_result');
const resultFor = (c, seq) => c.frames.find((f) => f.t === 'voice_result' && f.seq === seq);

test('T0904-14a — a dead ASR worker yields a FAILED result, never silence', async () => {
  useStubAsr();
  const s = await createServer({ port: 0, voiceEnabled: true });
  try {
    const c = await connect(s.url(), { userId: 'u1', userName: 'A' });
    speak(c, 1);
    await until(() => resultFor(c, 1), 'first result');
    expect(resultFor(c, 1).status === 'text', 'first segment recognised', JSON.stringify(resultFor(c, 1)));
    const pid = s._voiceAsrPidForTest();
    expect(typeof pid === 'number', 'the worker pid is observable', String(pid));
    process.kill(pid, 'SIGKILL');
    await wait(30);
    speak(c, 2);
    const r = await until(() => resultFor(c, 2), 'second result');
    expect(r.status === 'failed' && (r.reason === 'worker-exit' || r.reason === 'no-worker'), 'the next segment is FAILED by name', JSON.stringify(r));
    expect(s.getTranscripts(0).transcripts.length === 1, 'and no transcript was invented for it');
    c.ws.close();
  } finally { await s.close(); }
});

test('T0904-14b — a saturated queue drops the NEWEST (reported) and completes the oldest', async () => {
  useStubAsr({ AP_ASR_STUB_DELAY_MS: '400' });
  const s = await createServer({ port: 0, voiceEnabled: true });
  try {
    const c = await connect(s.url(), { userId: 'u1', userName: 'A' });
    for (let q = 1; q <= 10; q++) speak(c, q);
    await until(() => results(c).length >= 10, 'ten results', { timeout: 12000 });
    const by = Object.fromEntries(results(c).map((r) => [r.seq, r]));
    expect(by[1].status === 'text', 'the oldest completes', JSON.stringify(by[1]));
    expect(by[10].status === 'dropped' && by[10].reason === 'queue', 'the newest is dropped, by name', JSON.stringify(by[10]));
    expect(results(c).every((r) => r.status === 'text' || (r.status === 'dropped' && r.reason === 'queue')), 'every segment got one result', JSON.stringify(results(c).map((r) => r.seq + ':' + r.status)));
    expect(new Set(results(c).map((r) => r.seq)).size === 10, 'exactly one result per segment');
    c.ws.close();
  } finally { await s.close(); }
});

test('T0904-10 — a 200 ms blip is still dropped, with a too-short result', async () => {
  useStubAsr();
  const s = await createServer({ port: 0, voiceEnabled: true });
  try {
    const c = await connect(s.url(), { userId: 'u1', userName: 'A' });
    speak(c, 1, { samples: 3200 });
    const r = await until(() => resultFor(c, 1), 'blip result');
    expect(r.status === 'too-short', 'too-short result', JSON.stringify(r));
    await wait(100);
    expect(s.getTranscripts(0).transcripts.length === 0, 'no transcript');
    c.ws.close();
  } finally { await s.close(); }
});

test('T0904-14c — a blank recognition is EMPTY, not silent', async () => {
  useStubAsr({ AP_ASR_STUB_TEXT: '   ' });
  const s = await createServer({ port: 0, voiceEnabled: true });
  try {
    const c = await connect(s.url(), { userId: 'u1', userName: 'A' });
    speak(c, 1);
    const r = await until(() => resultFor(c, 1), 'result');
    expect(r.status === 'empty', 'empty result', JSON.stringify(r));
    expect(s.getTranscripts(0).transcripts.length === 0, 'no transcript');
    c.ws.close();
  } finally { await s.close(); }
});

test('T0904-20 — negotiation hooks, voice_text refused by name, entries carry timing + recognizer', async () => {
  useStubAsr();
  const s = await createServer({ port: 0, voiceEnabled: true });
  try {
    const plain = await connect(s.url(), { userId: 'u1', userName: 'A' });
    expect(plain.welcome && plain.welcome.voice === undefined, 'no voice field when hello carried none', JSON.stringify(plain.welcome && plain.welcome.voice));
    const neg = await connect(s.url(), { userId: 'u2', userName: 'B', voice: { modes: ['pcm', 'text'], codecs: ['opus', 'pcm16'] } });
    expect(neg.welcome && neg.welcome.voice && neg.welcome.voice.mode === 'pcm' && neg.welcome.voice.codec === 'pcm16' && Array.isArray(neg.welcome.voice.recognizers) && neg.welcome.voice.recognizers.length === 0,
      'welcome.voice answers pcm/pcm16 with no client recognisers', JSON.stringify(neg.welcome && neg.welcome.voice));
    neg.ws.send(JSON.stringify({ t: 'voice_text', seq: 7, text: 'a client recognised this' }));
    const rt = await until(() => resultFor(neg, 7), 'voice_text result');
    expect(rt.status === 'failed' && rt.reason === 'mode', 'voice_text is refused by name', JSON.stringify(rt));
    const t0 = Date.now();
    speak(plain, 1, { startedAt: t0 - 1500, endedAt: t0 });
    const r = await until(() => resultFor(plain, 1), 'result');
    expect(r.status === 'text' && typeof r.asrMs === 'number' && typeof r.startedAt === 'number' && typeof r.endedAt === 'number', 'the result carries timing', JSON.stringify(r));
    const e = s.getInbox().items.find((i) => i.kind === 'voice' && i.userId === 'u1');
    expect(e && typeof e.startedAt === 'number' && typeof e.endedAt === 'number' && e.endedAt >= e.startedAt, 'entry has startedAt/endedAt', JSON.stringify(e));
    expect(e.durationMs === 1500, 'durationMs from the client stamps', String(e.durationMs));
    expect(typeof e.asrMs === 'number', 'entry has asrMs', String(e.asrMs));
    expect(e.recognizer && e.recognizer.side === 'server', 'entry has recognizer.side:server', JSON.stringify(e.recognizer));
    expect(e.codec === 'pcm16' && e.source === 'tap', 'entry has codec + source', JSON.stringify({ c: e.codec, s: e.source }));
    // A legacy segment (no stamps) still gets a duration, from its PCM.
    speak(plain, 2);
    await until(() => resultFor(plain, 2), 'legacy result');
    const e2 = s.getInbox().items.filter((i) => i.kind === 'voice' && i.userId === 'u1').pop();
    expect(e2.durationMs === 500, 'a legacy segment is timed from its PCM (8000 samples = 500 ms)', String(e2.durationMs));
    plain.ws.close(); neg.ws.close();
  } finally { await s.close(); }
});

test('T0904-21 — the ms caps are enforced on the timestamps, not only on the bytes', async () => {
  useStubAsr();
  const s = await createServer({ port: 0, voiceEnabled: true });
  try {
    const c = await connect(s.url(), { userId: 'u1', userName: 'A' });
    const t0 = Date.now();
    speak(c, 1, { startedAt: t0 - 35000, endedAt: t0 });   // 500 ms of PCM, 35 s by the clock
    const r = await until(() => resultFor(c, 1), 'long result');
    expect(r.cut === 'max-ms', 'cut at the ms cap', JSON.stringify(r));
    const e = s.getInbox().items.find((i) => i.kind === 'voice');
    expect(e && e.durationMs === 30000, 'the recorded duration is the cap', String(e && e.durationMs));
    speak(c, 2, { startedAt: t0 - 200, endedAt: t0 });     // 500 ms of PCM, 200 ms by the clock
    const r2 = await until(() => resultFor(c, 2), 'short result');
    expect(r2.status === 'too-short', 'too-short by the clock', JSON.stringify(r2));
    c.ws.close();
  } finally { await s.close(); }
});

test('T0904-22 — bytes, not paths; the fallback engages after 3 failures and SAYS so', async () => {
  const wavDir = join(tmpdir(), 'ap-asr');
  const before = existsSync(wavDir) ? readdirSync(wavDir).length : 0;
  useStubAsr({ AP_ASR_STUB_MODE: 'bytes' });
  let s = await createServer({ port: 0, voiceEnabled: true });
  try {
    const c = await connect(s.url(), { userId: 'u1', userName: 'A' });
    speak(c, 1);
    const r = await until(() => resultFor(c, 1), 'bytes result');
    expect(r.status === 'text' && r.text === 'bytes:16000', 'the worker received the whole segment as bytes', JSON.stringify(r));
    const after = existsSync(wavDir) ? readdirSync(wavDir).length : 0;
    expect(after === before, 'no WAV file was written to disk', `before=${before} after=${after}`);
    c.ws.close();
  } finally { await s.close(); }

  useStubAsr();
  process.env.PRESENTER_ASR_CMD = 'node ' + STUB + ' --die';
  process.env.PRESENTER_ASR_FALLBACK_CMD = 'node ' + STUB + ' --text=fallback-engaged';
  s = await createServer({ port: 0, voiceEnabled: true });
  try {
    const ctl = await connect(s.url(), { userId: 'ctl', userName: 'Ctl', role: 'presenter' });
    const c = await connect(s.url(), { userId: 'u1', userName: 'A' });
    for (let q = 1; q <= 3; q++) {
      speak(c, q);
      const rq = await until(() => resultFor(c, q), 'failing result ' + q);
      expect(rq.status === 'failed', 'primary failure ' + q + ' is reported', JSON.stringify(rq));
      await wait(350);   // let the watchdog respawn so the next one is a fresh failure
    }
    const fault = await until(() => frame(ctl, (f) => f.t === 'voice_fault' && f.code === 'asr-fallback'), 'asr-fallback fault');
    expect(!!fault, 'the switch is a reported fault', JSON.stringify(fault));
    speak(c, 4);
    const r4 = await until(() => resultFor(c, 4), 'fallback result');
    expect(r4.status === 'text' && r4.text === 'fallback-engaged', 'the fallback recognises', JSON.stringify(r4));
    ctl.ws.close(); c.ws.close();
  } finally { await s.close(); delete process.env.PRESENTER_ASR_FALLBACK_CMD; }
});
