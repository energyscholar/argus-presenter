/*
 * Plan 0493 Phase E — echo & hallucination hygiene (§10), grounded in S212 live failures.
 *
 * E1: Argus's own presenter_speak output, re-heard by the mic, is flagged echo:true and NOT delivered
 * as a Bruce turn (the S212 "three verbatim Bruce turns" bug). The suppression is SELECTIVE — a genuine
 * turn still arrives (never "nothing came, so it worked"). E2: near-silence boilerplate is flagged
 * (advisory) while ASR conf rides along. Both proven with positive observations.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hear = (s, text, conf = null) => s._emitInboxForTest({ kind: 'voice', userId: 'bruce', userName: 'Bruce', role: 'presenter', text, conf });

// E1 (flag + suppress on the poll path) — the loopback is flagged echo:true and absent from delivery,
// while a genuine turn IS delivered.
test('0493 S13: a TTS loopback is flagged echo:true and not delivered (poll path)', async () => {
  const s = await createServer({ port: 0 });
  try {
    s.pvsStart({ consumer: 'argusmon' });
    s.speak('The square root of sixteen is four.');   // Argus speaks
    const echoed = hear(s, 'the square root of sixteen is four');   // the mic re-hears it (verbatim-ish)
    const genuine = hear(s, 'now ring the bell please');            // a real, different turn
    expect(echoed.echo === true, 'the loopback entry is flagged echo:true', JSON.stringify(echoed.echo));
    expect(genuine.echo !== true, 'the genuine turn is NOT flagged echo', JSON.stringify(genuine.echo));
    const d = (await s.situation({ consumerId: 'pvs:argusmon' })).newSinceLastRead;
    const joined = d.turns.map((t) => t.text).join(' | ');
    expect(joined.includes('ring the bell'), 'the genuine turn IS delivered (selective, not silence)', joined);
    expect(!/square root of sixteen/.test(joined), 'the echo is NOT delivered as a Bruce turn', joined);
  } finally { await s.close(); }
});

// E1 (ws path) — the ws subscriber also never receives an echo turn, but does receive the genuine one.
test('0493 S13: the ws path skips echo loopbacks too', async () => {
  const s = await createServer({ port: 0 });
  let ws;
  try {
    s.pvsStart({ consumer: 'argusmon' });
    ws = new WebSocket(s.url().replace('http', 'ws'));
    const frames = [];
    ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) {} });
    await new Promise((res) => ws.on('open', () => { ws.send(JSON.stringify({ t: 'pvs_subscribe', consumer: 'argusmon' })); res(); }));
    await wait(100);
    s.speak('close the airlock');
    hear(s, 'close the airlock');       // echo
    hear(s, 'open the cargo bay');       // genuine
    await wait(120);
    const turns = frames.filter((f) => f.t === 'turn').map((f) => f.text);
    expect(turns.some((t) => /cargo bay/.test(t)), 'the genuine turn arrived over ws', JSON.stringify(turns));
    expect(!turns.some((t) => /close the airlock/.test(t)), 'the echo did NOT arrive over ws', JSON.stringify(turns));
  } finally { try { ws && ws.close(); } catch (e) {} await s.close(); }
});

// E1 window — a payload spoken long ago is NOT treated as an echo of a much later identical utterance
// is out of scope to time-travel in a unit test; instead prove a NON-matching prior speak does not
// suppress an unrelated turn (no false positives).
test('0493 E1: unrelated speech is never mistaken for an echo', async () => {
  const s = await createServer({ port: 0 });
  try {
    s.pvsStart({ consumer: 'argusmon' });
    s.speak('plotting a jump to Nyrthus');
    const turn = hear(s, 'what is the fuel situation');
    expect(turn.echo !== true, 'a clearly different turn is not flagged echo', JSON.stringify(turn.echo));
    const d = (await s.situation({ consumerId: 'pvs:argusmon' })).newSinceLastRead;
    expect(d.turns.map((t) => t.text).join(' ').includes('fuel situation'), 'and it is delivered', JSON.stringify(d.turns.map((t) => t.text)));
  } finally { await s.close(); }
});

// E2 — near-silence boilerplate is flagged (advisory) and ASR conf is carried; it is still delivered
// (the agent decides), unlike an echo which is suppressed.
test('0493 E2: near-silence boilerplate is flagged, conf carried, still delivered', async () => {
  const s = await createServer({ port: 0 });
  try {
    s.pvsStart({ consumer: 'argusmon' });
    const hall = hear(s, 'Thank you.', 0.2);   // low-conf whisper boilerplate
    expect(hall.suspectHallucination === true, 'the boilerplate turn is flagged suspectHallucination', JSON.stringify(hall.suspectHallucination));
    expect(hall.conf === 0.2, 'ASR conf rides along', String(hall.conf));
    expect(hall.echo !== true, 'boilerplate is NOT an echo (different mechanism)', JSON.stringify(hall.echo));
    const d = (await s.situation({ consumerId: 'pvs:argusmon' })).newSinceLastRead;
    expect(d.turns.map((t) => t.text.toLowerCase()).join(' ').includes('thank you'),
      'it is STILL delivered — the agent decides, the server only flags', JSON.stringify(d.turns.map((t) => t.text)));
  } finally { await s.close(); }
});
