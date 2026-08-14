/*
 * 0559 — THE HULL CASCADE, and the alert region it exists to prove.
 *
 * Plan 0559 D5: generic machine factory → starship factory → hull class → instance.
 * The tests that matter are the NEGATIVE ones: a level must not know about the level below it,
 * or the layer above it cannot be reused by anyone else (plan 0556 UC2/UC3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
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
  // 0575 P1c — a freshly commissioned hull boots at `unknown`, not `normal`.
  assert.equal(s.state().alert, 'unknown');
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
  /*
   * ⛔ 0581 PHASE E — THIS ASSERTION USED TO PIN A DEAD PATH. It read `ship/alert`, the pre-0575
   * singleton namespace, and after the rename NOTHING READS THAT PREFIX. So the test passed
   * BECAUSE the write went nowhere: it asserted the defect and therefore could never fail.
   * ⭐ It is UPDATED, not deleted. Deleting it would have removed the only thing that can ever
   * catch the path going wrong again; asserting the namespaced form keeps the test able to fail.
   * The id is INSTANCE-SCOPED — `test-hull` is INSTANCE.shipId above, so this also proves the op
   * carries the hull it came from and a second commissioned ship cannot land on the first's key.
   */
  const s = ship();
  const r = s.send('general-quarters');
  assert.deepEqual(r.ops, [{ path: `ships/${INSTANCE.shipId}/alert`, verb: 'set', value: 'elevated' }]);
  assert.equal(r.ops[0].path, 'ships/test-hull/alert', 'spelled out, so a wrong template literal is visible');
});

/*
 * t0575-01 — ⛔ NO STORE PATH BEGINS `ship/`. Plan 0575 §6, finally enforced rather than checked
 * by hand once. This is the guard that `t0559-05` above could not be, because a single deepEqual
 * only sees the op it was handed; this reads the SOURCE and so covers the paths no test calls.
 *
 * ⚠ COMMENTS DO NOT COUNT and that is a deliberate exemption, not a loophole. Two of the four
 * historical hits (`alert-band.js`, `stations/stations.py`) are prose explaining the OLD name and
 * why it still resolves — deleting that prose to satisfy a grep would destroy the memory that
 * stops the prefix coming back, exactly as 0574's log records for the alert-band bus guard. What
 * is scanned is code: a literal `ship/` reachable by the runtime.
 *
 * ⭐ PROVEN ABLE TO FAIL, and MEASURED, not asserted: on 2026-08-14 the pre-0581 literal was
 * re-inserted into the installed artifact's `send` and this test went RED, printing
 *   hull-factory.mjs:79: const ops = changes.map(c => ({ path: `ship/${c.region}`, ... }));
 * alongside `t0559-05`. ⚠ The line number is the ARTIFACT's, not the source's — the two differ by
 * this file's own comment block, which is why it is quoted from the run rather than from reading.
 * It has now been seen in BOTH states, which `t0559-05` alone never had been.
 */
test('t0575-01 — no store path begins `ship/` anywhere in the plugin (the singleton is gone)', () => {
  const exts = new Set(['.mjs', '.js', '.json', '.html', '.py', '.css', '.md']);
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (exts.has(extname(e.name))) files.push(p);
    }
  })(PLUGIN);
  assert.ok(files.length > 10, `the plugin must actually be present to scan (found ${files.length})`);

  // Strip comments so the exemption above is applied by construction, not by an allow-list of
  // file:line pairs that would rot the moment either file is edited.
  const decomment = (text, ext) => {
    let t = text;
    if (ext === '.html') t = t.replace(/<!--[\s\S]*?-->/g, '');
    if (ext === '.py') t = t.replace(/^\s*#.*$/gm, '');
    else t = t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '');
    return t;
  };

  // `ships/` does NOT contain `ship/`, so the plural namespace is not a false positive. The
  // leading class stops `starship/` and `airship/` counting as the singleton root.
  const SINGLETON = /(^|[^A-Za-z0-9_-])ship\//;
  const hits = [];
  for (const f of files) {
    const body = decomment(readFileSync(f, 'utf8'), extname(f));
    body.split('\n').forEach((line, i) => {
      if (SINGLETON.test(line)) hits.push(`${f.slice(PLUGIN.length + 1)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], `store paths still beginning \`ship/\`:\n  ${hits.join('\n  ')}`);
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

test('t0559-08 — ⛔ LAYERING: the RULES level names nothing from the CAMPAIGN level (0556 UC2/UC3)', () => {
  /*
   * The forbidden vocabulary is READ FROM THE CAMPAIGN INSTANCE, never written here. Two reasons,
   * and the second is the interesting one:
   *   1. this file then carries no campaign vocabulary, so t0531-01 stays green — the first draft
   *      spelled the words out and the neutrality guard failed the repo on its own guard list;
   *   2. it is a BETTER test. It asserts "the rules level does not name whatever ship we actually
   *      commissioned", so it keeps working when the campaign changes ships — which is exactly the
   *      reuse property the layering exists to provide.
   */
  const instPath = join(HERE, '../../../repertory/campaigns/campaign-a/ships/astral-dawn.json');
  let inst = null;
  try { inst = JSON.parse(readFileSync(instPath, 'utf8')); } catch { /* content repo absent */ }
  if (!inst) return;                       // no campaign checked out ⇒ nothing to leak

  const words = [inst.name, inst.wasNamed, inst.shipId]
    .filter(Boolean)
    .flatMap(w => String(w).split(/[\s·]+/))
    .filter(w => w.length > 4 && !/^(iss|the|class|type)$/i.test(w));
  assert.ok(words.length >= 2, 'the instance must supply words worth guarding against');

  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const [what, text] of [
    ['hull-factory.mjs', strip(readFileSync(join(PLUGIN, 'hull-factory.mjs'), 'utf8'))],
    ['the published hull template', JSON.stringify(HULL)],
  ]) {
    for (const w of words) {
      assert.equal(new RegExp(w, 'i').test(text), false,
        `${what} must not name "${w}" — a second group reuses this file verbatim`);
    }
  }
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
