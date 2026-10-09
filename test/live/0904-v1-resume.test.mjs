/*
 * Plan 0904 V1.4 / V1.5 — resume after a dropped socket, and takeover between two devices.
 *
 *   T0904-03  the socket is killed MID-SEGMENT; the client reconnects with hello.resume, gets
 *             welcome.resumed:true, replays the whole segment, and it is recognised ONCE; a voice_gap
 *             with cause 'resume' is logged; ZERO speech lost (the stub returns the byte count).
 *   T0904-03b a replay of an ALREADY-recognised segment returns the cached result, never a second entry.
 *   T0904-03c a hello.resume after the 60 s grace (or for a stranger) gets resumed:false.
 *   T0904-12  one token on two sockets: the newer streams, the older receives voice_moved, and one
 *             utterance heard by both yields exactly one entry.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import * as log from '../../app/log.mjs';
import { useStubAsr, mkCap, connect, speak, until, wait, frame, pcm, SECRET } from './_0904-voice.mjs';

const resultFor = (c, seq) => c.frames.find((f) => f.t === 'voice_result' && f.seq === seq);
const entriesOf = (s, uid) => s.getInbox().items.filter((i) => i.kind === 'voice' && i.userId === uid);

test('T0904-03 — a socket killed mid-segment loses ZERO speech: resume, replay, recognised once', async () => {
  useStubAsr({ AP_ASR_STUB_MODE: 'bytes' });
  log.clear();
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET });
  try {
    const cap = mkCap({ ref: 'vtt:w1:u1', nonce: 'resume-1' });
    const a = await connect(s.url(), { cap: cap.token });
    // Segment 1 completes normally (acked by its result).
    speak(a, 1, { samples: 8000 });
    await until(() => resultFor(a, 1), 'seg 1 result');
    // Segment 2: start + HALF the PCM, then the socket dies.
    const t0 = Date.now();
    a.ws.send(JSON.stringify({ t: 'voice_seg_start', seq: 2, stream: 'st-A', startedAt: t0 - 800 }));
    a.ws.send(pcm(12800).subarray(0, 12800));
    await wait(60);
    a.ws.terminate();
    await wait(150);
    // Reconnect within the grace, resume, and replay the WHOLE un-acked segment.
    const t1 = Date.now();
    const b = await connect(s.url(), { cap: cap.token, resume: { lastAckedSeq: 1 } });
    expect(b.welcome && b.welcome.resumed === true, 'welcome.resumed:true', JSON.stringify(b.welcome && b.welcome.resumed));
    expect(Date.now() - t1 < 5000, 'reconnected within 5 s');
    b.ws.send(JSON.stringify({ t: 'voice_seg_start', seq: 2, stream: 'st-A', startedAt: t0 - 800 }));
    b.ws.send(pcm(12800));
    b.ws.send(JSON.stringify({ t: 'voice_seg_end', seq: 2, endedAt: t0 }));
    const r = await until(() => resultFor(b, 2), 'replayed seg 2 result');
    expect(r.status === 'text' && r.text === 'bytes:25600', 'the replayed segment is recognised WHOLE (zero speech lost)', JSON.stringify(r));
    await wait(150);
    const es = entriesOf(s, 'guest:resume-1');
    expect(es.length === 2, 'exactly two entries: seg 1 and seg 2, once each', JSON.stringify(es.map((e) => e.text)));
    expect(log.tail(500).some((e) => e.tag === 'voice' && e.msg === 'gap' && e.fields && e.fields.cause === 'resume'), 'a voice_gap with cause resume was logged',
      JSON.stringify(log.tail(500).filter((e) => e.tag === 'voice' && e.msg === 'gap')));
    b.ws.close();
  } finally { await s.close(); }
});

test('T0904-03b — a replay of a recognised segment returns the cached result, never a second entry', async () => {
  useStubAsr();
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET });
  try {
    const cap = mkCap({ nonce: 'replay-1' });
    const a = await connect(s.url(), { cap: cap.token });
    a.ws.send(JSON.stringify({ t: 'voice_seg_start', seq: 5, stream: 'st-B' })); a.ws.send(pcm(8000)); a.ws.send(JSON.stringify({ t: 'voice_seg_end', seq: 5 }));
    await until(() => resultFor(a, 5), 'first');
    a.ws.close(); await wait(80);
    // The client did not see the result (say), reconnects and replays.
    const b = await connect(s.url(), { cap: cap.token, resume: { lastAckedSeq: 4 } });
    b.ws.send(JSON.stringify({ t: 'voice_seg_start', seq: 5, stream: 'st-B' })); b.ws.send(pcm(8000)); b.ws.send(JSON.stringify({ t: 'voice_seg_end', seq: 5 }));
    const r = await until(() => resultFor(b, 5), 'replayed');
    expect(r.status === 'text' && r.replayed === true, 'the cached result is returned, marked replayed', JSON.stringify(r));
    await wait(100);
    expect(entriesOf(s, 'guest:replay-1').length === 1, 'still exactly one entry');
    // A legacy client (no stream) reusing a seq after a reload is NOT deduplicated.
    b.ws.send(JSON.stringify({ t: 'voice_seg_start', seq: 5 })); b.ws.send(pcm(8000)); b.ws.send(JSON.stringify({ t: 'voice_seg_end', seq: 5 }));
    await until(() => entriesOf(s, 'guest:replay-1').length === 2, 'legacy segment recognised');
    b.ws.close();
  } finally { await s.close(); }
});

test('T0904-03c — resumed:false for a stranger; absent resume ⇒ no resumed field', async () => {
  useStubAsr();
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET });
  try {
    const plain = await connect(s.url(), { userId: 'p', userName: 'P' });
    expect(plain.welcome && plain.welcome.resumed === undefined, 'no resume asked ⇒ no resumed field');
    const stranger = await connect(s.url(), { cap: mkCap({ nonce: 'never-seen' }).token, resume: { lastAckedSeq: 3 } });
    expect(stranger.welcome && stranger.welcome.resumed === false, 'nothing to resume ⇒ resumed:false', JSON.stringify(stranger.welcome && stranger.welcome.resumed));
    plain.ws.close(); stranger.ws.close();
  } finally { await s.close(); }
});

test('T0904-12 — one token on two devices: the newer streams, the older is told, one utterance ⇒ one entry', async () => {
  useStubAsr();
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET });
  try {
    const cap = mkCap({ ref: 'vtt:w1:u7', nonce: 'two-dev' });
    const older = await connect(s.url(), { cap: cap.token });
    speak(older, 1);
    await until(() => resultFor(older, 1), 'older first segment');
    const newer = await connect(s.url(), { cap: cap.token });
    speak(newer, 1);
    await until(() => resultFor(newer, 1), 'newer first segment');
    const moved = await until(() => frame(older, (f) => f.t === 'voice_moved'), 'voice_moved to the older');
    expect(moved && typeof moved.to === 'string', 'the older device is told where the mic went', JSON.stringify(moved));
    // Both devices hear the next utterance.
    const n0 = entriesOf(s, 'guest:two-dev').length;
    speak(older, 2); speak(newer, 2);
    await until(() => resultFor(older, 2) && resultFor(newer, 2), 'both results');
    await wait(150);
    expect(entriesOf(s, 'guest:two-dev').length === n0 + 1, 'exactly ONE entry for the shared utterance', String(entriesOf(s, 'guest:two-dev').length - n0));
    expect(resultFor(older, 2).status === 'dropped' && resultFor(older, 2).reason === 'moved', 'the older device gets a dropped/moved result', JSON.stringify(resultFor(older, 2)));
    older.ws.close(); newer.ws.close();
  } finally { await s.close(); }
});
