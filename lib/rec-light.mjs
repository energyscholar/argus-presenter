/*
 * rec-light.mjs — Plan 1327. The ONE derivation of the always-visible recording light.
 *
 * Structure, not control: the light is a pure function from a CLOSED input tuple
 * { connected: boolean, micOn: boolean } to exactly one of three states, written as a total
 * table. No event handler ever paints a colour; every event changes an input and the light is
 * re-derived here. A wrong colour (red while the mic is closed, green while audio is leaving the
 * device) therefore has no code path. Non-boolean input is a programming error (TypeError),
 * never a fourth state.
 *
 * Plain ES module, no DOM. Served at /lib/rec-light.mjs (NOT under the voice fence: with voice
 * off the light still exists and simply derives with micOn:false).
 *
 *   connected micOn  state
 *   false     false  down   orange, "SERVER NOT CONNECTED"
 *   false     true   down   (nothing reaches the server whatever the mic does)
 *   true      false  idle   green,  "Not recording — mic off"
 *   true      true   rec    red record mark, "RECORDING NOW"
 */
export const REC_STATES = Object.freeze({
  rec:  Object.freeze({ state: 'rec',  color: '#e0303a', shape: 'mark', tooltip: 'RECORDING NOW' }),
  idle: Object.freeze({ state: 'idle', color: '#22c55e', shape: 'dot',  tooltip: 'Not recording — mic off' }),
  down: Object.freeze({ state: 'down', color: '#f59e0b', shape: 'dot',  tooltip: 'SERVER NOT CONNECTED' }),
});

// Total over the 2 x 2 boolean inputs: TABLE[connected][micOn].
const TABLE = Object.freeze({
  false: Object.freeze({ false: REC_STATES.down, true: REC_STATES.down }),
  true:  Object.freeze({ false: REC_STATES.idle, true: REC_STATES.rec }),
});

export function recState(input) {
  if (input === null || typeof input !== 'object') throw new TypeError('recState: expected { connected, micOn }');
  const { connected, micOn } = input;
  if (typeof connected !== 'boolean' || typeof micOn !== 'boolean') {
    throw new TypeError('recState: connected and micOn must be booleans');
  }
  return TABLE[connected][micOn];
}
