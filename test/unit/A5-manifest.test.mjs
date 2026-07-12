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
  expect(m.components.length === names.length && names.length === 14, 'all 14 core components listed', `${m.components.length}/${names.length}`);
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
