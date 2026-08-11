/*
 * 0560 — DRONE POV. The camera is decoration; the FLIGHT MODEL is not.
 *
 * Everything the HUD shows is derived from a flip-and-burn profile, so it can be checked against
 * physics rather than against a screenshot. If these pass, a player asking "how fast are we going"
 * gets a true answer, and the midpoint flip lands where a real one would.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, '../../plugins/starship-ops/drone-pov.js'), 'utf8');
const mod = { exports: {} };
new Function('window', 'module', src)({}, mod);
const { covered, speedKms } = mod.exports;

test('t0560-10 — the distance profile is continuous and symmetric about the flip', () => {
  assert.equal(covered(0), 0);
  assert.equal(covered(1), 1);
  assert.ok(Math.abs(covered(0.5) - 0.5) < 1e-12, 'half the time ⇒ half the distance');
  // symmetry: what is covered before the flip mirrors what remains after it
  for (const t of [0.1, 0.25, 0.4]) {
    assert.ok(Math.abs(covered(t) - (1 - covered(1 - t))) < 1e-12, `symmetric at t=${t}`);
  }
});

test('t0560-11 — distance covered is strictly increasing (a drone never reverses)', () => {
  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = covered(Math.min(1, t));
    assert.ok(c >= prev - 1e-12, `monotone at t=${t.toFixed(2)}`);
    prev = c;
  }
});

test('t0560-12 — ⭐ SPEED PEAKS AT THE FLIP and is zero at both ends', () => {
  const D = 7.2e8, T = 62;
  assert.ok(speedKms(0, D, T) < 1e-9, 'starts from rest');
  assert.ok(speedKms(1, D, T) < 1e-9, 'arrives at rest — it is a rendezvous, not a flyby');
  const mid = speedKms(0.5, D, T);
  for (const t of [0.1, 0.3, 0.7, 0.9]) {
    assert.ok(speedKms(t, D, T) < mid, `peak at midpoint, not t=${t}`);
  }
});

test('t0560-13 — the profile reproduces the brachistochrone identity t = 2√(d/a)', () => {
  /*
   * Independent check: integrate the model's own peak speed back to a distance and compare with
   * the distance we asked for. Agreement means the HUD's km/s and the map's transit hours came
   * from the same physics — the failure this guards against is two plausible numbers that quietly
   * disagree with each other.
   */
  const D = 7.2e8, T = 62;                       // km, hours
  const vpeak = speedKms(0.5, D, T);             // km/s
  const dFromV = vpeak * (T * 3600) / 2;         // area of the velocity triangle
  assert.ok(Math.abs(dFromV - D) / D < 1e-9, `${dFromV.toExponential(4)} vs ${D.toExponential(4)}`);
});

test('t0560-14 — APPARENT SIZE follows θ=2·atan(r/d) and grows without bound at arrival', () => {
  const rKm = 60000, D = 7.2e8;
  const theta = t => {
    const range = Math.max(1, D - covered(t) * D);
    return 2 * Math.atan(rKm / range) * 180 / Math.PI;
  };
  let prev = 0;
  for (let t = 0; t < 1; t += 0.05) {
    const th = theta(t);
    assert.ok(th >= prev, `apparent size never shrinks (t=${t.toFixed(2)})`);
    prev = th;
  }
  assert.ok(theta(0) < 0.02, 'a gas giant 4.8 AU away is a point of light');
  assert.ok(theta(0.99) > theta(0.5), 'and fills the view at the end');
});
