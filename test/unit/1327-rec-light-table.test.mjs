/*
 * T1 (Plan 1327 P1) — the recording-light derivation is ONE total table over a closed input tuple.
 * Enumerates every input pair; non-boolean input is a TypeError, never a fourth state.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { REC_STATES, recState } from '../../lib/rec-light.mjs';

test('T1-1327 recState is the total 2x2 table', () => {
  const want = [
    [false, false, 'down'], [false, true, 'down'], [true, false, 'idle'], [true, true, 'rec'],
  ];
  for (const [connected, micOn, state] of want) {
    expect('recState(' + connected + ',' + micOn + ') = ' + state, recState({ connected, micOn }).state === state);
  }
  expect('exactly three states exist', Object.keys(REC_STATES).sort().join() === 'down,idle,rec');
});

test('T1-1327 words and colours are the owner-ruled ones', () => {
  expect('rec tooltip', REC_STATES.rec.tooltip === 'RECORDING NOW');
  expect('idle tooltip', REC_STATES.idle.tooltip === 'Not recording — mic off');
  expect('down tooltip', REC_STATES.down.tooltip === 'SERVER NOT CONNECTED');
  expect('rec red', REC_STATES.rec.color === '#e0303a');
  expect('idle green', REC_STATES.idle.color === '#22c55e');
  expect('down orange', REC_STATES.down.color === '#f59e0b');
  expect('rec has a different shape from the dots', REC_STATES.rec.shape !== REC_STATES.idle.shape && REC_STATES.idle.shape === REC_STATES.down.shape);
});

test('T1-1327 non-boolean input throws TypeError (never a fourth state)', () => {
  const bad = [undefined, null, 0, 1, 'true', {}, []];
  for (const v of bad) {
    for (const [a, b] of [[v, true], [true, v], [v, v]]) {
      let err = null; try { recState({ connected: a, micOn: b }); } catch (e) { err = e; }
      expect('TypeError for ' + JSON.stringify([a, b]), err instanceof TypeError);
    }
  }
  let e2 = null; try { recState(); } catch (e) { e2 = e; }
  expect('TypeError for no argument', e2 instanceof TypeError);
});
