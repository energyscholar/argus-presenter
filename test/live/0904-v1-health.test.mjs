/*
 * Plan 0904 V1.6 — the per-person voice HEALTH record, the silence-vs-broken detectors, and the
 * GM-only fault channel.
 *
 *   T0904-18   exact digital zeros on a live track ⇒ lastLevelTs fresh, zeroRuns ≥ 1, a `silent-track`
 *              fault; levels stop ⇒ the record says the level is STALE; quiet-but-real noise ⇒ no fault;
 *              a floor collapse > 20 dB below the session baseline ⇒ `floor-collapse`; a client-reported
 *              ended track ⇒ `track-ended`.
 *   T0904-19   a player cap (no observe) never receives another seat's fault; the observe cap in the
 *              SAME world does; an observe cap in ANOTHER world does not; control roles do.
 *   T0904-18b  the record is exposed to control viewers (presence, attendance, api.voiceHealth) and
 *              never to a participant roster.
 *   T0904-27   a client that never answers ping is shown stale within 3 missed pings; one that answers stays fresh.
 *   T0904-LR   the log ring size is a server option (logRingMax).
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import * as log from '../../app/log.mjs';
import { WebSocket } from 'ws';
import { useStubAsr, mkCap, connect, until, wait, frame, framesOf, SECRET } from './_0904-voice.mjs';

const level = (c, raw, zeroRunMs = 0) => c.ws.send(JSON.stringify({ t: 'voice_level', raw, nrm: raw, zeroRunMs, ts: Date.now() }));
const faults = (c, code) => c.frames.filter((f) => f.t === 'voice_fault' && (!code || f.code === code));

test('T0904-18 — silence vs broken: zeros fault, quiet does not, stale is visible, collapse and ended are faults', async () => {
  useStubAsr();
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET, voiceBaselineMs: 600 });
  try {
    const ctl = await connect(s.url(), { userId: 'ctl', userName: 'Ctl', role: 'presenter' });
    const quiet = await connect(s.url(), { cap: mkCap({ ref: 'vtt:w1:q', nonce: 'h-quiet' }).token });
    const dead = await connect(s.url(), { cap: mkCap({ ref: 'vtt:w1:d', nonce: 'h-dead' }).token });
    for (let i = 0; i < 4; i++) { level(quiet, 0.006, 0); level(dead, 0, i ? 2500 : 900); await wait(40); }
    await until(() => faults(ctl, 'silent-track').length, 'silent-track fault');
    const hd = s.voiceHealth().find((r) => r.userId === 'guest:h-dead');
    expect(hd && hd.levelFresh === true && hd.zeroRuns >= 1, 'dead mic: level fresh, zeroRuns counted', JSON.stringify(hd));
    expect(faults(ctl, 'silent-track').length === 1, 'one fault per episode, not one per level frame', String(faults(ctl, 'silent-track').length));
    expect(faults(ctl, 'silent-track')[0].ref === 'vtt:w1:d', 'the fault names the seat by ref', JSON.stringify(faults(ctl)[0]));
    const hq = s.voiceHealth().find((r) => r.userId === 'guest:h-quiet');
    expect(hq && hq.zeroRuns === 0 && !faults(ctl).some((f) => f.ref === 'vtt:w1:q'), 'quiet-but-real noise is NOT a fault', JSON.stringify(hq));
    // Floor collapse: baseline at 0.05 for the (shortened) baseline window, then 30 dB down.
    const loud = await connect(s.url(), { cap: mkCap({ ref: 'vtt:w1:l', nonce: 'h-loud' }).token });
    for (let i = 0; i < 6; i++) { level(loud, 0.05); await wait(120); }
    for (let i = 0; i < 6; i++) { level(loud, 0.0015); await wait(120); }
    await until(() => faults(ctl, 'floor-collapse').some((f) => f.ref === 'vtt:w1:l'), 'floor-collapse fault');
    // Track ended, reported by the client.
    quiet.ws.send(JSON.stringify({ t: 'voice_client_fault', code: 'track-ended', detail: 'track readyState ended' }));
    await until(() => faults(ctl, 'track-ended').some((f) => f.ref === 'vtt:w1:q'), 'track-ended fault');
    // An unknown client code is not relayed (the vocabulary is the server's).
    quiet.ws.send(JSON.stringify({ t: 'voice_client_fault', code: 'anything-goes' }));
    await wait(150);
    expect(!faults(ctl, 'anything-goes').length, 'unknown client fault codes are not relayed');
    // Stale: levels stop.
    await wait(3200);
    const hs = s.voiceHealth().find((r) => r.userId === 'guest:h-dead');
    expect(hs && hs.levelFresh === false && typeof hs.levelAgeMs === 'number' && hs.levelAgeMs >= 3000, 'a silent worklet shows as STALE', JSON.stringify(hs));
    for (const c of [ctl, quiet, dead, loud]) c.ws.close();
  } finally { await s.close(); }
});

test('T0904-19 — faults reach control roles and same-world observe caps only', async () => {
  useStubAsr();
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET });
  try {
    const ctl = await connect(s.url(), { userId: 'ctl', userName: 'Ctl', role: 'presenter' });
    const gm1 = await connect(s.url(), { cap: mkCap({ ref: 'vtt:w1:gm', scope: ['speak', 'type', 'observe'], nonce: 'f-gm1' }).token });
    const p1 = await connect(s.url(), { cap: mkCap({ ref: 'vtt:w1:p1', scope: ['speak', 'type'], nonce: 'f-p1' }).token });
    const gm2 = await connect(s.url(), { cap: mkCap({ ref: 'vtt:w2:gm', scope: ['speak', 'type', 'observe'], nonce: 'f-gm2' }).token });
    const p2 = await connect(s.url(), { cap: mkCap({ ref: 'vtt:w1:p2', scope: ['speak'], nonce: 'f-p2' }).token });
    p2.ws.send(JSON.stringify({ t: 'voice_client_fault', code: 'track-ended' }));
    p2.ws.send(JSON.stringify({ t: 'voice_gap', fromTs: Date.now() - 4000, toTs: Date.now(), cause: 'reload' }));
    await until(() => faults(gm1).length && framesOf(gm1, 'voice_gap').length, 'gm1 got fault + gap');
    await until(() => faults(ctl).length, 'control got the fault');
    await wait(200);
    expect(faults(gm1)[0].ref === 'vtt:w1:p2' && framesOf(gm1, 'voice_gap')[0].cause === 'reload', 'same-world observer receives fault and gap', JSON.stringify(gm1.frames.filter((f) => /voice_/.test(f.t))));
    expect(!faults(p1).length && !framesOf(p1, 'voice_gap').length, 'a player cap without observe receives nothing', JSON.stringify(p1.frames.map((f) => f.t)));
    expect(!faults(gm2).length && !framesOf(gm2, 'voice_gap').length, 'an observer in ANOTHER world receives nothing', JSON.stringify(gm2.frames.map((f) => f.t)));
    for (const c of [ctl, gm1, p1, gm2, p2]) c.ws.close();
  } finally { await s.close(); }
});

test('T0904-18b — the health record reaches control viewers only', async () => {
  useStubAsr();
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET });
  try {
    const a = await connect(s.url(), { cap: mkCap({ ref: 'vtt:w1:a', nonce: 'v-a' }).token });
    level(a, 0.02);
    a.ws.send(JSON.stringify({ t: 'voice_settings', sampleRate: 48000, echoCancellation: false, noiseSuppression: false, autoGainControl: false, label: 'Headset Mic' }));
    await wait(200);
    const row = s.presence().find((r) => r.userId === 'guest:v-a');
    expect(row && row.voice && row.voice.levelFresh === true && row.voice.settings && row.voice.settings.sampleRate === 48000, 'presence carries the voice record', JSON.stringify(row));
    const ctlRoster = s.attendance({ viewerRole: 'ai' }).roster.find((r) => r.userId === 'guest:v-a');
    expect(ctlRoster && ctlRoster.voice && ctlRoster.voice.extRef === 'vtt:w1:a', 'the control roster carries it', JSON.stringify(ctlRoster));
    const pRoster = s.attendance({ viewerRole: 'participant' }).roster.find((r) => r.userId === 'guest:v-a');
    expect(pRoster && pRoster.voice === undefined, 'a participant roster does not', JSON.stringify(pRoster));
    a.ws.close();
  } finally { await s.close(); }
});

test('T0904-27 — a client that never answers ping goes stale within 3 missed pings; a ponging one stays fresh', async () => {
  const s = await createServer({ port: 0 });
  try {
    const mute = await connect(s.url(), { userId: 'mute', userName: 'Mute' });   // never pongs
    const live = await connect(s.url(), { userId: 'live', userName: 'Live' });
    live.ws.on('message', (b) => { try { const m = JSON.parse(b.toString()); if (m.t === 'ping') live.ws.send(JSON.stringify({ t: 'pong', ts: m.ts })); } catch {} });
    await wait(16500);
    const roster = s.attendance({ viewerRole: 'ai' }).roster;
    const rm = roster.find((r) => r.userId === 'mute'), rl = roster.find((r) => r.userId === 'live');
    expect(rm && rm.connected === false, 'the non-ponging client is stale', JSON.stringify(rm));
    expect(rl && rl.connected === true, 'the ponging client is fresh', JSON.stringify(rl));
    mute.ws.close(); live.ws.close();
  } finally { await s.close(); }
});

test('T0904-LR — logRingMax sets the log ring size', async () => {
  const s = await createServer({ port: 0, logRingMax: 1234 });
  try {
    expect(log.ringMax() === 1234, 'ring max follows the option', String(log.ringMax()));
  } finally { await s.close(); log.setRingMax(500); }
});
