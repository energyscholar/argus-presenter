/*
 * A4 — plugin.json manifests parse and declare the correct components/requires.
 *
 * ⭐ Plan 0569 M2 — THIS SUITE TESTS THE MECHANISM, NOT ANY REAL PLUGIN.
 *
 * It used to read `example` and `ai-train-the-trainer` out of the engine's own `plugins/`
 * directory. That was the coupling that put teaching content inside a PUBLIC, domain-neutral
 * engine repo: the engine's tests needed those plugins present, so the plugins could not leave.
 *
 * `ai-train-the-trainer` is teaching content and now lives in repertory (private) — it is no
 * longer this repo's business at all. `example` is what it always actually was, an authoring
 * reference exercising manifest + component + preset, and now lives in test/fixtures/plugins/.
 *
 * ⛔ Do not point these tests at a real plugin again. The engine must not know any plugin's name.
 */
import { test, expect } from '../../harness/test.mjs';
import { loadManifests, readManifest } from '../../harness/plugins.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// pluginsDir() resolves PER CALL, so redirecting it here is enough — no loader change needed.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'plugins');

function withFixtures(fn) {
  const prev = process.env.PRESENTER_PLUGINS_DIR;
  process.env.PRESENTER_PLUGINS_DIR = FIXTURES;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.PRESENTER_PLUGINS_DIR;
    else process.env.PRESENTER_PLUGINS_DIR = prev;
  }
}

test('A4 — a manifest parses; components + requires + preset correct', () => {
  withFixtures(() => {
    const m = readManifest('example');
    expect(!!m, 'fixture manifest present');
    expect(JSON.stringify(m.components) === JSON.stringify(['weather']), 'components = [weather]', JSON.stringify(m.components));
    expect(Array.isArray(m.requires) && m.requires.length === 0, 'requires is empty', JSON.stringify(m.requires));
    expect(m.presets && Array.isArray(m.presets.map) && m.presets.map.includes('city-grid'), 'declares city-grid map preset', JSON.stringify(m.presets));
    expect(m.fieldSchemas['weather'] && Array.isArray(m.fieldSchemas['weather'].fields), 'weather field schema present');
  });
});

test('A4 — loadManifests() keys manifests by name', () => {
  withFixtures(() => {
    const all = loadManifests();
    expect(!!all['example'], 'fixture manifest loaded', Object.keys(all).join(','));
  });
});

test('A4 — an absent plugin reads as absent, it does not throw', () => {
  withFixtures(() => {
    expect(!readManifest('no-such-plugin-exists'), 'missing plugin returns falsy rather than raising');
  });
});
