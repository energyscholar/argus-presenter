/*
 * Plan 0685 R2 — the getUserMedia constraint, and THE ORDER THAT MAKES IT SAFE.
 *
 * echoCancellation is off because asking for it puts Chrome-on-Android into communication mode and
 * routes playback down the in-call path. ⛔ That is a MITIGATION WHOSE CAUSE IS UNKNOWN — plan 0682
 * is still open and this flag does not explain it.
 *
 * The flag is only safe while the capture-side duck is wired: with echo cancellation gone, the duck
 * is the ONLY thing standing between the agent's own speech and its own transcript. A future edit
 * that removes the duck and leaves the flag would restore the feedback loop silently, and no
 * behavioural test would notice — the mic would simply start hearing the agent again. So the two are
 * bound HERE, by construction: this test reads both files and fails if the flag is off while any
 * limb of the duck is missing.
 */
import { test, expect } from '../../harness/test.mjs';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const capture = readFileSync(join(ROOT, 'lib', 'voice-capture.mjs'), 'utf8');
const page = readFileSync(join(ROOT, 'app', 'presenter.html'), 'utf8');

test('T-0685-CONSTRAINT — the capture graph asks for NO browser echo cancellation', () => {
  expect(/echoCancellation:\s*false/.test(capture), 'getUserMedia asks for echoCancellation:false');
  expect(!/echoCancellation:\s*true/.test(capture), 'no surviving echoCancellation:true constraint');
  // RT-19 single DSP owner is unchanged — this phase moved one flag, not the DSP ownership rule.
  expect(/noiseSuppression:\s*false/.test(capture), 'noiseSuppression still false (RT-19)');
  expect(/autoGainControl:\s*false/.test(capture), 'autoGainControl still false (RT-19)');
});

test('T-0685-ORDER — ⛔ the flag may only be OFF while the capture-side duck is fully wired', () => {
  const flagOff = /echoCancellation:\s*false/.test(capture);
  if (!flagOff) return;   // the flag is back on; the ordering obligation does not apply
  expect(/ctrl\.duckWhilePlaying\s*=/.test(capture), 'the controller still exposes duckWhilePlaying');
  expect(/duckWhilePlaying\(on\)/.test(page), 'the page CALLS duckWhilePlaying — it is not dead code again');
  expect(/u\.onstart\s*=[^;]*apDuck\(/.test(page), 'the duck is applied on utterance start');
  expect(/u\.onend\s*=[^;]*apUnduck\(/.test(page), 'the duck is lifted on end');
  expect(/u\.onerror\s*=[^;]*apUnduck\(/.test(page), 'the duck is lifted on error');
  expect(/apUnduck\(\);[^\n]*\n\s*speechSynthesis\.cancel\(\)/.test(page), 'the duck is lifted BEFORE the cancel() that precedes every utterance');
  expect(/apDuckTimer\s*=\s*setTimeout\(/.test(page), 'an absolute watchdog lifts the duck regardless of platform events');
});

test('T-0685-CAPTURE-SIDE — ducking touches no track, no stream and no getUserMedia', () => {
  // The whole duck is one assignment. Anything that reached for the stream here would cost
  // hands-free operation, which is a requirement — the operator must never have to tap the mic.
  const m = capture.match(/ctrl\.duckWhilePlaying\s*=\s*\(on\)\s*=>\s*\{[^}]*\}/);
  expect(!!m, 'the duck implementation was located');
  const body = m ? m[0] : '';
  for (const forbidden of ['getUserMedia', 'getTracks', 'getAudioTracks', '.stop(', 'disconnect', 'close(']) {
    expect(body.indexOf(forbidden) === -1, `the duck does not call ${forbidden}`);
  }
});
