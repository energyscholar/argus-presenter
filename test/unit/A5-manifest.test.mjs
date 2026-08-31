/*
 * A5 — the core component manifest lists every core component with its field
 * schema, and regenerates deterministically (matches the committed file).
 */
import { test, expect } from '../../harness/test.mjs';
import { generateManifest, coreComponentNames } from '../../harness/gen-manifest.mjs';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('A5 — manifest lists ALL core components, each with fields', () => {
  const m = generateManifest();
  const names = coreComponentNames();
  // The literal is a tripwire: a component may not join the registry without someone noticing.
  // It read 14 and dates from v0.1.0. Two components have joined since — `navmap` (S210) and
  // `prose` (0493) — and NEITHER tripped it, because navmap arrived first with no schema entry and
  // `generateManifest()` has thrown ever since, on the line above this one. One missing object key
  // hid the count AND hid a committed manifest two components out of date. Plan 0525 P5 restores
  // both; `t80` (test/unit/0525-p5-core-schema-coverage.test.mjs) is the assertion that now names a
  // schemaless component directly, so this literal can never again be shadowed by a throw.
  // 16 -> 17: `tokens` joined the registry with plan 0720 C3 (N draggable tokens over the map),
  // and it arrived with its schema entry, so this literal is the tripwire doing its job rather
  // than the throw hiding it.
  expect(m.components.length === names.length && names.length === 17, 'all 17 core components listed', `${m.components.length}/${names.length}`);
  for (const c of m.components) {
    expect(Array.isArray(c.fields) && c.fields.length >= 1, `${c.name} has a field schema`, c.name);
    expect(c.fields.every((f) => f.name && f.type), `${c.name} fields have name+type`);
  }
  expect(m.components.some((c) => c.name === 'choice' && c.fields.some((f) => f.name === 'options')), 'choice.options present');
});

test('A5 — regenerates deterministically and matches the committed file', () => {
  const a = JSON.stringify(generateManifest());
  const b = JSON.stringify(generateManifest());
  expect(a === b, 'two generations are identical');
  const file = join(ROOT, 'docs', 'component-manifest.json');
  expect(existsSync(file), 'committed manifest exists');
  const onDisk = JSON.stringify(JSON.parse(readFileSync(file, 'utf8')));
  expect(onDisk === a, 'committed manifest is up to date (re-run gen-manifest.mjs if this fails)');
});
