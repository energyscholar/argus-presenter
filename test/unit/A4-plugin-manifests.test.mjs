/*
 * A4 — plugin.json manifests parse and declare the correct components/requires.
 */
import { test, expect } from '../../harness/test.mjs';
import { loadManifests, readManifest } from '../../harness/plugins.mjs';

test('A4 — example manifest parses; components + requires + preset correct', () => {
  const m = readManifest('example');
  expect(!!m, 'example manifest present');
  expect(JSON.stringify(m.components) === JSON.stringify(['weather']), 'components = [weather]', JSON.stringify(m.components));
  expect(Array.isArray(m.requires) && m.requires.length === 0, 'requires is empty', JSON.stringify(m.requires));
  expect(m.presets && Array.isArray(m.presets.map) && m.presets.map.includes('city-grid'), 'declares city-grid map preset', JSON.stringify(m.presets));
  expect(m.fieldSchemas['weather'] && Array.isArray(m.fieldSchemas['weather'].fields), 'weather field schema present');
});

test('A4 — ai-train-the-trainer manifest parses; pure content (no components)', () => {
  const m = readManifest('ai-train-the-trainer');
  expect(!!m, 'att manifest present');
  expect(Array.isArray(m.components) && m.components.length === 0, 'no new components', JSON.stringify(m.components));
  expect(Array.isArray(m.requires) && m.requires.length === 0, 'requires is empty');
});

test('A4 — loadManifests() returns both plugins keyed by name', () => {
  const all = loadManifests();
  expect(!!all['example'] && !!all['ai-train-the-trainer'], 'both manifests loaded', Object.keys(all).join(','));
});
