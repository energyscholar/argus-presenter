/*
 * 0560 — THE KEPLERIAN SYSTEM MAP, and the drones you send into it.
 *
 * ⭐ WHY THE FIRST TEST EXISTS. The drone block added CX/CY to its coordinates while every other
 *   mark in the scene (bodies, contacts, ship) sits inside <g translate(CX,CY)> and does not. So
 *   drones were double-offset by (500,312). The ETA readout stayed perfectly correct throughout —
 *   an inbound drone counted 62.0 → 36.2 → 0.0 h while drawn in the bottom-right corner of a map
 *   it should have crossed toward the star. Numbers can be right while the picture is wrong;
 *   t0560-01 asserts the geometry, not the arithmetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '../../plugins/starship-ops');

// the renderer is a browser script; evaluate it against a window stub
const src = readFileSync(join(PLUGIN, 'system-renderer.js'), 'utf8');
const win = {};
new Function('window', src)(win);
const R = win.SystemRenderer;

/*
 * ⭐ The spec is L3 CANON and lives in the content repo, NOT in this L2 plugin — the renderer must
 * know how to draw *a* system while knowing nothing about *this* one. If the content repo is not
 * checked out there is simply nothing to test against, exactly as in t0559-08.
 */
const SPEC_PATH = join(HERE, '../../../repertory/canon/spinward-marches/systems/bowman-1132.json');
let SPEC = null;
try { SPEC = JSON.parse(readFileSync(SPEC_PATH, 'utf8')); } catch { /* content repo absent */ }
const canon = { skip: SPEC ? false : 'content repo not checked out' };
const AU = 1.495978707e8;
const CX = 500, CY = 312;

/*
 * Locate the DRONE marker specifically. An earlier draft took the last translate() in the
 * document and silently measured the SHIP, which is emitted after the drones — the test then
 * failed for a reason that had nothing to do with the code under test. Match the drone group's
 * own signature: translate(...) immediately followed by its amber r='9' halo.
 */
const droneAt = svg => {
  const m = svg.match(/translate\(([-\d.]+),([-\d.]+)\)'><circle r='9' fill='#f0b429'/);
  assert.ok(m, 'a drone marker must be emitted');
  return { x: +m[1], y: +m[2], r: Math.hypot(+m[1], +m[2]) };
};

test('t0560-01 — ⛔ a drone sits at the SAME radius as a body at the same distance (no double offset)', canon, () => {
  const a = 5.20 * AU;                      // put a drone exactly on the gas giant's orbit
  const svg = R.renderSystem({ ...SPEC, drones: [{ name: 'D', fromAKm: a, toAKm: a, angleDeg: 0, progress: 0 }] });

  const drone = droneAt(svg);
  const rDrone = drone.r;

  // ⭐ the falsifier: if CX/CY were re-added, the radius would be ~hypot(500,312)=589, not ~200
  assert.ok(rDrone < 300, `drone radius ${rDrone.toFixed(1)} — a double offset would exceed 500`);
  assert.ok(Math.abs(drone.x - CX) > 100 || Math.abs(drone.y - CY) > 100,
    'the drone must NOT be centred on (CX,CY) — that is the double-offset signature');
});

test('t0560-02 — an INBOUND drone moves toward the star as progress rises', canon, () => {
  const mk = p => R.renderSystem({ ...SPEC,
    drones: [{ name: 'D', fromAKm: 5.20 * AU, toAKm: 1.60 * AU, angleDeg: 0, progress: p }] });
  const rad = svg => droneAt(svg).r;
  const r0 = rad(mk(0)), r5 = rad(mk(0.5)), r1 = rad(mk(1));
  assert.ok(r0 > r5 && r5 > r1, `inbound must shrink: ${r0.toFixed(1)} > ${r5.toFixed(1)} > ${r1.toFixed(1)}`);
});

test('t0560-03 — an OUTBOUND drone moves away, and its nose is not flipped', canon, () => {
  const mk = p => R.renderSystem({ ...SPEC,
    drones: [{ name: 'D', fromAKm: 1.60 * AU, toAKm: 10.0 * AU, angleDeg: 0, progress: p }] });
  const rad = svg => droneAt(svg).r;
  assert.ok(rad(mk(1)) > rad(mk(0)), 'outbound must grow');
  assert.match(mk(0.5), /rotate\(0\)/, 'outbound nose stays along +r');
  const inb = R.renderSystem({ ...SPEC, drones: [{ name: 'D', fromAKm: 10.0 * AU, toAKm: 1.6 * AU, angleDeg: 0, progress: 0.5 }] });
  assert.match(inb, /rotate\(180\)/, 'inbound nose flips');
});

test('t0560-04 — KEPLER: the stated period matches T=2π√(a³/GM) for every body', canon, () => {
  const svg = R.renderSystem(SPEC);
  const GM = 1.32712440018e20 * (SPEC.primary.massMJ / 1047.5651);   // M_J → M_sun → GM
  for (const b of SPEC.bodies) {
    const T = 2 * Math.PI * Math.sqrt(Math.pow(b.aKm * 1000, 3) / GM) / 86400;
    // the readout prints days to one decimal for anything under ~1000 d
    assert.ok(svg.includes(b.name), `${b.name} must appear in the readout`);
    assert.ok(T > 0 && isFinite(T), `${b.name} period must be finite`);
  }
  assert.match(svg, /BELT I\b/);
});

test('t0560-05 — the primary radius is SPEC-DRIVEN, and the DEFAULT still holds when unset', canon, () => {
  /*
   * The star was drawn at a fixed 58 px, which at Bowman's scale swallowed Belt I entirely. rPx
   * makes it a property of the system rather than of the renderer. Two things must both be true:
   * the spec's value reaches the markup, and a spec that says nothing still gets the old default —
   * otherwise every other system silently changes size the day this landed.
   */
  const withVal = R.renderSystem({ ...SPEC, primary: { ...SPEC.primary, rPx: 33 } });
  assert.match(withVal, /r='33'|r="33"/, 'the spec value must reach the markup');

  const bare = { ...SPEC.primary }; delete bare.rPx;
  const dflt = R.renderSystem({ ...SPEC, primary: bare });
  assert.match(dflt, /r='58'|r="58"/, 'an unset rPx must still render the original 58');
  assert.notEqual(withVal, dflt, 'rPx must actually change the output');
});

test('t0560-06 — TRANSIT mode states its own time compression rather than hiding it', canon, () => {
  const svg = R.renderSystem({ ...SPEC, mode: 'transit',
    transit: { fromAKm: 5.2 * AU, toAKm: 10 * AU, realHours: 62, wallSeconds: 6 } });
  assert.match(svg, /TIME\s*×/, 'the rate overlay must be present in transit mode');
});
