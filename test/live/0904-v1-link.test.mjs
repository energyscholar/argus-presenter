/*
 * Plan 0904 §4.2 / V1.6 — the client side of resume, driven in Node against a LOCAL server.
 *
 *   T0904-LINK-a  lib/voice-link.mjs: a segment is KEPT until its voice_result; the socket killed in the
 *                 middle of a segment reconnects by itself, replays it, and it is recognised WHOLE, once.
 *   T0904-LINK-b  the kept set is bounded (10 segments): the oldest is evicted and COUNTED.
 *   T0904-LINK-c  the link answers the server's ping (the server sees RTT samples).
 *   T0904-ZR      the worklet's exact-zero meter: 0.5 s of digital zeros reads ≈ 500 ms; real noise reads 0.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { createVoiceLink, MAX_SEGS } from '../../lib/voice-link.mjs';
import { makeZeroRunMeter } from '../../lib/voice-worklet.js';
import { WebSocket } from 'ws';
import { useStubAsr, mkCap, until, wait, SECRET } from './_0904-voice.mjs';

function tone(n) { const a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = Math.round(9000 * Math.sin(2 * Math.PI * 300 * i / 16000)); return a; }

test('T0904-LINK-a — kept until acked; a mid-segment socket death is replayed whole, once', async () => {
  useStubAsr({ AP_ASR_STUB_MODE: 'bytes' });
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET });
  const results = [], states = [];
  const link = createVoiceLink({ wsUrl: s.url().replace('http', 'ws'), cap: mkCap({ ref: 'vtt:w:u', nonce: 'link-a' }).token, WebSocketImpl: WebSocket,
    onResult: (r) => results.push(r), onState: (st) => states.push(st) });
  try {
    await until(() => link.state === 'live', 'live');
    const sink = link.sink();
    sink.onSegStart({ seq: 1, durMs: 500 }); sink.onPcm(tone(8000)); sink.onSegEnd({ seq: 1 });
    await until(() => results.find((r) => r.seq === 1), 'result 1');
    expect(link.kept === 0, 'an acked segment is released', String(link.kept));
    // Segment 2: half the PCM, then the socket dies under it.
    sink.onSegStart({ seq: 2, durMs: 800 }); sink.onPcm(tone(6400));
    await wait(40);
    link._socket().terminate();
    sink.onPcm(tone(6400));            // speech continues while the link is down: kept, not sent
    sink.onSegEnd({ seq: 2 });
    expect(link.kept === 1, 'the unacked segment is kept while down', String(link.kept));
    await until(() => results.find((r) => r.seq === 2), 'result 2 after reconnect', { timeout: 8000 });
    const r2 = results.find((r) => r.seq === 2);
    expect(r2.status === 'text' && r2.text === 'bytes:25600', 'the whole segment was recognised (zero speech lost)', JSON.stringify(r2));
    expect(states.includes('reconnecting') && link.counts.reconnects === 1, 'it reconnected by itself', JSON.stringify({ states, c: link.counts }));
    await wait(150);
    const es = s.getInbox().items.filter((i) => i.userId === 'guest:link-a');
    expect(es.length === 2, 'two utterances, two entries — no duplicate', JSON.stringify(es.map((e) => e.text)));
    expect(link.kept === 0, 'nothing left unacked', String(link.kept));
  } finally { link.close(); await s.close(); }
});

test('T0904-LINK-b — the kept set is bounded and eviction is counted', async () => {
  const link = createVoiceLink({ wsUrl: 'ws://127.0.0.1:9/', cap: 'x', WebSocketImpl: WebSocket });
  try {
    const sink = link.sink();
    for (let q = 1; q <= MAX_SEGS + 2; q++) { sink.onSegStart({ seq: q, durMs: 100 }); sink.onPcm(tone(1600)); sink.onSegEnd({ seq: q }); }
    expect(link.kept === MAX_SEGS, 'kept at the bound', String(link.kept));
    expect(link.counts.evicted === 2, 'the two oldest were evicted, counted', JSON.stringify(link.counts));
  } finally { link.close(); }
});

test('T0904-LINK-c — the link answers ping', async () => {
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET });
  const link = createVoiceLink({ wsUrl: s.url().replace('http', 'ws'), cap: mkCap({ nonce: 'link-c' }).token, WebSocketImpl: WebSocket });
  try {
    await until(() => link.state === 'live', 'live');
    await until(() => s.telemetry().rtt.samples > 0, 'an RTT sample (pong) reached the server');
  } finally { link.close(); await s.close(); }
});

test('T0904-ZR — exact zeros are measured; real noise is not', () => {
  const m = makeZeroRunMeter(48000);
  m.push(new Float32Array(24000));                                  // 0.5 s of digital zeros
  expect(Math.abs(m.takeMaxMs() - 500) <= 1, 'zeros read ≈ 500 ms');
  const noise = new Float32Array(48000); for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() - 0.5) * 0.002;
  m.push(noise);
  expect(m.takeMaxMs() === 0, 'quiet-but-real noise reads 0');
});
