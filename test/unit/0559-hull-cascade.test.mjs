/*
 * 0559 — THE HULL CASCADE, and the alert region it exists to prove.
 *
 * Plan 0559 D5: generic machine factory → starship factory → hull class → instance.
 * The tests that matter are the NEGATIVE ones: a level must not know about the level below it,
 * or the layer above it cannot be reused by anyone else (plan 0556 UC2/UC3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChart } from '../../plugins/starship-ops/ship-machine.mjs';
import { makeMachineFactory, makeStarshipFactory, commissionFromChart } from '../../plugins/starship-ops/hull-factory.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '../../plugins/starship-ops');
const HULL = JSON.parse(readFileSync(join(PLUGIN, 'hulls/subsidised-liner.json'), 'utf8'));
const INSTANCE = {
  shipId: 'test-hull', name: 'TNS Nobody', hullClass: 'subsidised-liner', tonnage: 600,
};
const ship = () => commissionFromChart(loadChart(), HULL, INSTANCE);

test('t0559-01 — YELLOW ALERT IS REACHABLE (it was not: `elevated` had no transition into it)', () => {
  const s = ship();
  assert.equal(s.state().alert, 'normal');
  assert.equal(s.send('general-quarters').ok, true);
  assert.equal(s.state().alert, 'elevated', 'general-quarters must reach elevated');
});

test('t0559-02 — all three orders, and each lands on its own state', () => {
  const s = ship();
  for (const [order, want] of [['battle-stations', 'action'], ['stand-down', 'normal'], ['general-quarters', 'elevated']]) {
    s.send(order);
    assert.equal(s.state().alert, want, `${order} -> ${want}`);
  }
});

test('t0559-03 — the DISPLAY LABEL comes from the chart, not a second table (D7)', () => {
  const s = ship();
  const seen = {};
  for (const [order, label] of [['stand-down', 'GREEN'], ['general-quarters', 'YELLOW'], ['battle-stations', 'RED']]) {
    s.send(order);
    const d = s.describe('alert');
    assert.equal(d.label, label);
    assert.ok(/^#[0-9a-f]{6}$/i.test(d.colour), 'a colour travels with the state');
    seen[label] = d.colour;
  }
  assert.equal(new Set(Object.values(seen)).size, 3, 'three distinct colours');
});

test('t0559-04 — ORTHOGONALITY: an alert order disturbs neither power nor nav', () => {
  const s = ship();
  const before = s.state();
  s.send('battle-stations');
  assert.equal(s.state().power, before.power);
  assert.equal(s.state().nav, before.nav);
});

test('t0559-05 — sending produces STORE OPS, and the factory never touches the wire', () => {
  const s = ship();
  const r = s.send('general-quarters');
  assert.deepEqual(r.ops, [{ path: 'ship/alert', verb: 'set', value: 'elevated' }]);
});

test('t0559-06 — an unknown event is refused, never thrown, and changes nothing', () => {
  const s = ship();
  const before = s.state();
  const r = s.send('make-the-tea');
  assert.equal(r.ok, false);
  assert.deepEqual(s.state(), before);
});

test('t0559-07 — ⭐ data-* MIRROR: state is readable with nothing rendered (D1/D8)', () => {
  const s = ship();
  s.send('battle-stations');
  const d = s.dataAttrs();
  assert.equal(d['data-alert'], 'action');
  assert.equal(d['data-alert-label'], 'RED');
  assert.equal(d['data-ship'], 'test-hull');
  assert.equal(d['data-hull'], 'subsidised-liner');
  for (const v of Object.values(d)) assert.equal(typeof v, 'string', 'attributes are strings');
});

test('t0559-08 — ⛔ LAYERING: the RULES level names no ship and no setting (0556 UC2/UC3)', () => {
  const rules = readFileSync(join(PLUGIN, 'hull-factory.mjs'), 'utf8');
  const hull = JSON.stringify(HULL);
  const banned = /astral dawn|amishi|delleron|raschev|bowman|spinward|imperium|marina|von sydo/i;
  assert.equal(banned.test(rules.replace(/\/\*[\s\S]*?\*\//g, '')), false,
    'hull-factory.mjs CODE must not name our campaign — a second group reuses this file verbatim');
  assert.equal(banned.test(hull), false,
    'the Subsidised Liner template is a PUBLISHED class and must name nobody');
});

test('t0559-09 — a hull class refuses to commission without an id, and a factory without a chart', () => {
  assert.throws(() => makeMachineFactory(null), /chart\.regions required/);
  const f = makeStarshipFactory(makeMachineFactory(loadChart()));
  assert.throws(() => f.defineHullClass({}), /classId required/);
  assert.throws(() => f.defineHullClass(HULL).commission({}), /shipId required/);
});

test('t0559-10 — the starship level VALIDATES that a chart is a ship at all', () => {
  const f = makeStarshipFactory(makeMachineFactory(loadChart()));
  assert.deepEqual(f.validate(), { ok: true, missing: [] });
  const thin = makeStarshipFactory(makeMachineFactory({ regions: { alert: { initial: 'normal', states: { normal: {} } } }, transitions: [] }));
  assert.deepEqual(thin.validate().missing, ['power', 'nav']);
});
