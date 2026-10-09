/*
 * Plan 0904 — ASR "ready" means the model ANSWERED a warm-up request (cold-start loss fix).
 *
 * The stub's AP_ASR_STUB_LOAD_MS simulates a slow model load. PRESENTER_ASR_TIMEOUT_MS is set
 * BELOW the load time, which is the production ratio that lost the first utterance: a request
 * written before the model is up used to time out while the model was still loading.
 *
 *   T0904-23a  the first utterance after a cold start with a 3 s model load is transcribed, not lost
 *   T0904-23b  ready is not reported (status, health, voice_status) before the warm-up answer
 *   T0904-23c  a warm-up failure (load past the bound; a worker that dies) yields a fault and never ready
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { useStubAsr, connect, speak, until, wait, frame, framesOf, STUB } from './_0904-voice.mjs';

const resultFor = (c, seq) => c.frames.find((f) => f.t === 'voice_result' && f.seq === seq);
const readyFrames = (c) => framesOf(c, 'voice_status').filter((f) => f.ready === true);
function clearWarmEnv() { delete process.env.PRESENTER_ASR_TIMEOUT_MS; delete process.env.PRESENTER_ASR_WARMUP_MS; delete process.env.AP_ASR_STUB_LOAD_MS; }

test('T0904-23a — the first utterance after a cold start (3 s model load) is transcribed, not lost', async () => {
  useStubAsr({ AP_ASR_STUB_LOAD_MS: '3000', PRESENTER_ASR_TIMEOUT_MS: '2000' });
  const s = await createServer({ port: 0, voiceEnabled: true });
  try {
    const c = await connect(s.url(), { userId: 'u1', userName: 'A' });
    speak(c, 1);   // the very first segment: it also starts the recognizer
    const r = await until(() => resultFor(c, 1), 'first result', { timeout: 10000 });
    expect(r.status === 'text' && r.text === 'hello world', 'the first utterance is recognised', JSON.stringify(r));
    expect(s.getTranscripts(0).transcripts.length === 1, 'and it reached the transcript', JSON.stringify(s.getTranscripts(0)));
    c.ws.close();
  } finally { await s.close(); clearWarmEnv(); }
});

test('T0904-23b — ready is not reported before the worker answers the warm-up request', async () => {
  useStubAsr({ AP_ASR_STUB_LOAD_MS: '3000' });
  const s = await createServer({ port: 0, voiceEnabled: true });
  try {
    const ctl = await connect(s.url(), { userId: 'ctl', userName: 'Ctl', role: 'presenter' });
    const c = await connect(s.url(), { userId: 'u1', userName: 'A' });
    speak(c, 1);
    const t0 = Date.now();
    await wait(1000);
    const h = s.health({});
    expect(h.asr === 'loading', 'health says loading while the model loads', JSON.stringify(h.asr));
    expect(readyFrames(ctl).length === 0, 'no voice_status ready frame before the warm-up answer', JSON.stringify(framesOf(ctl, 'voice_status')));
    await until(() => readyFrames(ctl).length > 0, 'ready frame', { timeout: 8000 });
    expect(Date.now() - t0 >= 2500, 'ready arrived only after the model load', String(Date.now() - t0));
    expect(s.health({}).asr === 'ready', 'health says ready after the warm-up answer', JSON.stringify(s.health({}).asr));
    ctl.ws.close(); c.ws.close();
  } finally { await s.close(); clearWarmEnv(); }
});

test('T0904-23c — a warm-up failure is a reported fault and never ready', async () => {
  // (i) the model load runs past the warm-up bound
  useStubAsr({ AP_ASR_STUB_LOAD_MS: '6000', PRESENTER_ASR_WARMUP_MS: '1000' });
  let s = await createServer({ port: 0, voiceEnabled: true });
  try {
    const ctl = await connect(s.url(), { userId: 'ctl', userName: 'Ctl', role: 'presenter' });
    const c = await connect(s.url(), { userId: 'u1', userName: 'A' });
    speak(c, 1);
    const fault = await until(() => frame(ctl, (f) => f.t === 'voice_fault' && f.code === 'asr-warmup-failed'), 'warm-up fault', { timeout: 4000 });
    expect(!!fault, 'the warm-up timeout is a reported fault', JSON.stringify(fault));
    const r = await until(() => resultFor(c, 1), 'held segment result', { timeout: 4000 });
    expect(r.status === 'failed', 'the held segment is answered FAILED by name, not lost', JSON.stringify(r));
    const h = s.health({});
    expect(h.asr === 'failed' && h.status === 'degraded', 'health says failed and degraded', JSON.stringify({ asr: h.asr, status: h.status }));
    expect(readyFrames(ctl).length === 0, 'ready was never announced', JSON.stringify(framesOf(ctl, 'voice_status')));
    ctl.ws.close(); c.ws.close();
  } finally { await s.close(); clearWarmEnv(); }

  // (ii) the worker dies on the warm-up request
  useStubAsr();
  process.env.PRESENTER_ASR_CMD = 'node ' + STUB + ' --die';
  s = await createServer({ port: 0, voiceEnabled: true });
  try {
    const ctl = await connect(s.url(), { userId: 'ctl', userName: 'Ctl', role: 'presenter' });
    const c = await connect(s.url(), { userId: 'u1', userName: 'A' });
    speak(c, 1);
    const fault = await until(() => frame(ctl, (f) => f.t === 'voice_fault' && f.code === 'asr-warmup-failed'), 'warm-up fault (dying worker)', { timeout: 4000 });
    expect(!!fault, 'a worker that dies during warm-up is a reported fault', JSON.stringify(fault));
    await wait(1200);   // several watchdog respawns, each dying on its warm-up
    expect(s.health({}).asr === 'failed', 'health stays failed across respawns', JSON.stringify(s.health({}).asr));
    expect(readyFrames(ctl).length === 0, 'ready was never announced', JSON.stringify(framesOf(ctl, 'voice_status')));
    ctl.ws.close(); c.ws.close();
  } finally { await s.close(); clearWarmEnv(); }
});
