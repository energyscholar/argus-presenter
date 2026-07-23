/*
 * Plan 0493 Phase B — named comms modes (§6).
 *
 * Mode fixes the outbound channel mix and defaults to 'presenter' ("assume I am looking at Presenter").
 * It is reported by presenter_status AND carried on every delivered situation envelope, so each incoming
 * turn tells the agent how to answer. The set is CLOSED — an unknown value is refused and leaves the
 * mode unchanged (the invalid-enum tail-de-index trap). Mode is advisory; the server never enforces it.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { coreTools } from '../../mcp/tools.mjs';

const say = (s, text) => s._emitInboxForTest({ kind: 'voice', userId: 'bruce', userName: 'Bruce', role: 'presenter', text });

// S8 (default) — the standing mode is 'presenter' before anyone sets anything.
test('0493 S8: default comms mode is presenter', async () => {
  const s = await createServer({ port: 0 });
  try {
    expect(s.commsMode().mode === 'presenter', 'default mode is presenter', s.commsMode().mode);
    expect(s.pvsState().mode === 'presenter', 'pvsState reports the default even with no PVS open', s.pvsState().mode);
  } finally { await s.close(); }
});

// S8 (envelope) — the current mode rides on every delivered situation envelope.
test('0493 S8: mode is carried on every delivered envelope', async () => {
  const s = await createServer({ port: 0 });
  try {
    s.pvsStart({ consumer: 'argusmon' });
    say(s, 'hi');
    const env = await s.situation({ consumerId: 'pvs:argusmon' });
    expect(env.mode === 'presenter', 'the delivery envelope carries mode=presenter', env.mode);
    s.commsMode('pocket');
    say(s, 'again');
    const env2 = await s.situation({ consumerId: 'pvs:argusmon' });
    expect(env2.mode === 'pocket', 'a later envelope reflects the flipped mode', env2.mode);
  } finally { await s.close(); }
});

// S10 — flipping the mode (the effect a spoken "pocket mode" has after the agent maps it) is reflected
// in status; all three named modes are reachable and round-trip through presenter_status.
test('0493 S10: each named mode flips and is confirmed via status', async () => {
  const s = await createServer({ port: 0 });
  try {
    for (const m of ['pocket', 'terminal', 'presenter']) {
      const r = s.commsMode(m);
      expect(r.ok === true && r.mode === m, 'commsMode set to ' + m, JSON.stringify(r));
      expect(s.pvsState().mode === m, 'presenter_status reflects ' + m, s.pvsState().mode);
    }
  } finally { await s.close(); }
});

// Closed-set guard — an unknown value is REFUSED and the mode is left unchanged (never de-indexes).
test('0493 modes: an unknown mode is refused, the prior mode survives', async () => {
  const s = await createServer({ port: 0 });
  try {
    s.commsMode('terminal');
    const bad = s.commsMode('engineering');   // not in the closed set
    expect(bad.ok === false && bad.reason === 'unknown-mode', 'unknown mode refused', JSON.stringify(bad));
    expect(s.commsMode().mode === 'terminal', 'the prior mode is untouched', s.commsMode().mode);
  } finally { await s.close(); }
});

// pvsStart may carry an initial mode; the presenter_mode tool delegates to commsMode (wiring proven by
// the 0488 surface-coverage guard). Here we lock the api round-trip the tool rides on.
test('0493 modes: pvsStart accepts an initial mode; commsMode round-trips', async () => {
  const s = await createServer({ port: 0 });
  try {
    const started = s.pvsStart({ consumer: 'argusmon', mode: 'pocket' });
    expect(started.mode === 'pocket', 'pvsStart applied the initial mode', started.mode);
    expect(s.commsMode().mode === 'pocket', 'commsMode read agrees', s.commsMode().mode);
    expect(s.commsMode('presenter').mode === 'presenter', 'commsMode write took effect', s.commsMode().mode);
  } finally { await s.close(); }
});

// The presenter_mode tool is a real declared tool that delegates get/set to the api.
test('0493 modes: presenter_mode tool is declared and delegates', () => {
  const TOOL = Object.fromEntries(coreTools.map((t) => [t.name, t]));
  expect(!!TOOL.presenter_mode, 'presenter_mode tool exists');
  expect(TOOL.presenter_mode.input.properties.set, 'it accepts a `set` argument');
});
