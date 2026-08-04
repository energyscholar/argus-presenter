/*
 * Plan 0539 P1.7 (+ R2 amendment) — lib/breakdown.js, THE SHARED "SHOW THE ARITHMETIC" RENDERER.
 *
 * ⛓ WHAT THIS FILE IS ACTUALLY GUARDING, and it is not dice.
 *
 * The R2 amendment is the highest-value line in plan 0539: if the modifier shape lands as
 * `rollModifiers`, or the renderer lives inside dice-only code, the NEXT feature (a station's skill
 * level — `base + rank + equipment − damage`) builds a SECOND format for the same idea. So the
 * tests below are deliberately split: half of them never mention a die, and t0539-bd-generic is the
 * one that would go red the day somebody makes this module dice-aware.
 *
 * ⛔ These are UNIT tests over a browser-shaped file. It is loaded through its CommonJS export
 * (`module.exports`), which is the same object it assigns to `window.ArgusBreakdown` — so what is
 * tested here is the artifact the page loads, not a re-implementation of it.
 */
import { test, expect, check } from '../../harness/test.mjs';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'lib', 'breakdown.js'), 'utf8');

/** Evaluate the browser file in a bare CommonJS-ish shim and hand back its API. */
function load() {
  const module = { exports: {} };
  const self = {};
  // eslint-disable-next-line no-new-func
  new Function('module', 'self', SRC)(module, self);
  return module.exports;
}

test('t0539-bd-01 — the arithmetic adds up, and the shape is {label, value}', () => {
  const B = load();
  const n = B.normalize({ parts: [3, 4], modifiers: [{ label: 'skill', value: 2 }, { label: 'range', value: -1 }] });
  expect(n.partsSum === 7, 'parts sum', String(n.partsSum));
  expect(n.modsSum === 1, 'modifiers sum (2 − 1)', String(n.modsSum));
  expect(n.total === 8, 'total = parts + modifiers when none was supplied', String(n.total));
  expect(n.reconciles === true, 'and it reconciles');
  expect(n.modifiers[0].label === 'skill' && n.modifiers[0].value === 2, 'the modifier kept its REASON',
    JSON.stringify(n.modifiers));
});

test('t0539-bd-generic — the model is NOT roll-specific: a station-skill stack renders identically', () => {
  const B = load();
  /* ⭐ THE R2 ASSERTION. This is `base + rank + equipment − damage` — roadmap 0541's B-STATIONSKILL-1
   * — expressed in the SAME shape a roll uses, with no dice anywhere. If this file ever grows a
   * dice assumption (a `rolls` field, a `spec` string, an implicit "parts are dice"), this goes red.
   * ⛔ Do not "fix" that by special-casing: the point is that there is one format. */
  const model = {
    label: 'Sensors',
    parts: [],
    modifiers: [
      { label: 'base', value: 1 },
      { label: 'rank', value: 2 },
      { label: 'equipment', value: 1 },
      { label: 'damage', value: -2 },
    ],
  };
  const n = B.normalize(model);
  expect(n.total === 2, 'base 1 + rank 2 + equipment 1 − damage 2 = 2', String(n.total));
  const t = B.text(model);
  expect(/base/.test(t) && /equipment/.test(t) && /damage/.test(t), 'every reason survives into the readable line', t);
  expect(!/d6|dice|roll/i.test(t), 'and nothing dice-shaped leaks into a non-dice caller\'s output', t);
  // The module's own SOURCE must stay neutral too — this is the structural half of the same claim.
  expect(!/\brolls?\b|\bdice\b|\bdie\b|\bspec\b/i.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    'lib/breakdown.js carries NO dice vocabulary in its code (comments are exempt)',
    'a dice identifier appeared in the executable text');
});

test('t0539-bd-02 — an authoritative total that contradicts the shown arithmetic is SHOWN, not hidden', () => {
  const B = load();
  // A hand-entered total is exactly this case: the human typed 11, and the parts on record are 3+4.
  const n = B.normalize({ parts: [3, 4], modifiers: [], total: 11 });
  expect(n.total === 11, 'the authoritative number wins', String(n.total));
  expect(n.computed === 7, 'and the arithmetic it disagrees with is kept', String(n.computed));
  expect(n.reconciles === false, '⛓ the disagreement is a FLAG, not a silent reconciliation');
  expect(/11/.test(B.text({ parts: [3, 4], total: 11 })) && /7/.test(B.text({ parts: [3, 4], total: 11 })),
    'and the readable line says both numbers', B.text({ parts: [3, 4], total: 11 }));
});

test('t0539-bd-03 — an EMPTY modifier list degrades to the plain total (0539 P1.7: land the field now)', () => {
  const B = load();
  const n = B.normalize({ parts: [5, 6], modifiers: [], total: 11 });
  expect(n.explained === true, 'parts alone still explain something');
  const bare = B.normalize({ total: 11 });
  expect(bare.explained === false, 'a total with nothing behind it knows it explains nothing');
  expect(bare.total === 11, 'and still reports the total', String(bare.total));
});

test('t0539-bd-04 — garbage in the model degrades, never throws (this runs inside a live chat log)', () => {
  const B = load();
  for (const bad of [null, undefined, 'nonsense', 42, [], { modifiers: 'no' }, { parts: null, modifiers: [null, 3, { value: NaN }] }]) {
    let ok = true;
    try { B.normalize(bad); B.text(bad); B.rows(bad); } catch (e) { ok = false; }
    check(`normalize/text/rows survive ${JSON.stringify(bad)}`, ok);
  }
  const n = B.normalize({ modifiers: [null, 3, { value: 'x', label: 'junk' }] });
  expect(n.modifiers.length === 2 && n.modifiers[0].value === 3 && n.modifiers[0].label === null,
    'a bare number becomes an unlabelled modifier; a non-finite value becomes 0', JSON.stringify(n.modifiers));
});

test('t0539-bd-05 — a label is TEXT, never markup: text() has no HTML semantics and render() uses no innerHTML', () => {
  const B = load();
  const hostile = '<img src=x onerror=alert(1)>';
  const out = B.text({ modifiers: [{ label: hostile, value: 1 }], total: 1 });
  expect(out.indexOf(hostile) >= 0, 'text() returns the string VERBATIM — escaping is the DOM step, not this one', out);
  // The structural guarantee: the renderer never assigns innerHTML/outerHTML/insertAdjacentHTML.
  expect(!/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/.test(SRC),
    '⛔ lib/breakdown.js contains NO html-assignment sink at all',
    (SRC.match(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/g) || []).join(','));
});

test('t0539-bd-06 — signed rendering: a contribution reads as an operation, not a quantity', () => {
  const B = load();
  expect(B.signed(2) === '+2', 'positive carries its sign', B.signed(2));
  expect(B.signed(-1) === '−1', 'negative uses a real minus sign, not a hyphen', JSON.stringify(B.signed(-1)));
  const rows = B.rows({ parts: [3], modifiers: [{ label: 'skill', value: 2 }] });
  expect(rows[rows.length - 1].kind === 'total', 'the last row is the total', JSON.stringify(rows));
  expect(rows.some((r) => r.kind === 'modifier' && /skill/.test(r.text)), 'the reason is in the row text', JSON.stringify(rows));
});
