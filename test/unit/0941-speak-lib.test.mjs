/*
 * Plan 0941 §1 / T3a — the ONE speech implementation, lib/speak.mjs, with speechSynthesis faked.
 *
 *   T0941-T3a  no local voice (only a network voice) ⇒ the outcome is {spoken:false, reason:'no-local-voice', text}
 *              and synth.speak is NEVER called (the OPSEC guard drops, it never falls back) — the caller can
 *              therefore show the line and the reason instead of nothing.
 *   T0941-LIB  with a local voice: cancel() precedes speak(), the local voice is chosen, start ducks, end
 *              un-ducks; prime() queues the zero-length unlock utterance.
 */
import { test, expect } from '../../harness/test.mjs';
import { createSpeaker, pickLocalVoice } from '../../lib/speak.mjs';

const quiet = { log() {}, warn() {} };
function fakeSynth(voices) {
  const st = { calls: [], spoken: [] };
  const synth = {
    getVoices: () => voices,
    addEventListener() {},
    cancel() { st.calls.push('cancel'); },
    speak(u) { st.calls.push('speak'); st.spoken.push(u); },
  };
  function Utterance(t) { this.text = t; this.voice = null; this.onstart = null; this.onend = null; this.onerror = null; }
  return { synth, Utterance, st };
}

test('T0941-T3a — no local voice: dropped with a reason, synth.speak never called', () => {
  const { synth, Utterance, st } = fakeSynth([{ name: 'Network Voice', lang: 'en-US', localService: false }]);
  const seen = [];
  const sp = createSpeaker({ synth, Utterance, log: quiet, onOutcome: (o) => seen.push(o) });
  const o = sp.speak('the door is open');
  expect(JSON.stringify(o) === JSON.stringify({ spoken: false, text: 'the door is open', reason: 'no-local-voice' }), 'the outcome names the reason and keeps the text', JSON.stringify(o));
  expect(st.calls.indexOf('speak') === -1, 'synth.speak was never called', JSON.stringify(st.calls));
  expect(seen.length === 1 && seen[0] === o, 'the outcome is reported to the caller', JSON.stringify(seen));
  expect(pickLocalVoice([{ name: 'x', localService: false }]) === null, 'a network voice is never picked');
});

test('T0941-LIB — a local voice speaks; cancel first; duck on start, un-duck on end; prime unlocks', () => {
  const { synth, Utterance, st } = fakeSynth([{ name: 'Network', lang: 'en-GB', localService: false }, { name: 'Local One', lang: 'en-GB', localService: true }]);
  const ducks = [];
  const sp = createSpeaker({ synth, Utterance, log: quiet, duck: (on) => ducks.push(on) });
  const o = sp.speak('hello there');
  expect(o.spoken === true && o.voice === 'Local One', 'spoken on the local voice', JSON.stringify(o));
  expect(st.calls.join(',') === 'cancel,speak', 'cancel() precedes speak()', st.calls.join(','));
  const u = st.spoken[0];
  expect(u.voice && u.voice.name === 'Local One', 'the utterance carries the local voice');
  u.onstart(); expect(ducks[ducks.length - 1] === true, 'start ducks capture');
  u.onend(); expect(ducks[ducks.length - 1] === false, 'end un-ducks capture');
  sp.prime();
  expect(st.spoken.length === 2 && st.spoken[1].text === '', 'prime() queues the zero-length unlock utterance');
  expect(sp.duckMs('ok') > 0 && sp.duckMs('x'.repeat(10000)) === 30000, 'the watchdog bound is finite and capped');
});
