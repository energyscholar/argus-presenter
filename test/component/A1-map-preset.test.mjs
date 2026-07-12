// A1 — core map ships NO domain art (neutral grid default); the city-grid preset is
// available ONLY via the example plugin registered on window.ApMapPresets.
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('A1 — core map default is a neutral grid (no preset art)', async () => {
  const r = await drive({
    component: 'map', opts: { controllable: false, label: 'Grid' },
    probe: () => ({
      hasViewport: !!document.querySelector('.ap-map-viewport'),
      gridLines: document.querySelectorAll('.ap-map-grid-line').length,
      blocks: document.querySelectorAll('.ap-map-block').length,
      text: document.querySelector('.ap-map-viewport').textContent
    })
  });
  expect('map viewport renders', r.probe.hasViewport, JSON.stringify(r.probe));
  expect('neutral grid drawn (>=8 lines)', r.probe.gridLines >= 8, String(r.probe.gridLines));
  expect('no preset art in neutral default', r.probe.blocks === 0, String(r.probe.blocks));
  expect('no domain labels (no Market)', !/Market/.test(r.probe.text), r.probe.text.slice(0, 60));
});

test('A1 — city-grid renders ONLY via the example preset', async () => {
  const r = await drive({
    component: 'map', opts: { controllable: false, preset: 'city-grid', label: 'City Grid' },
    requires: ['example'],
    probe: () => ({
      blocks: document.querySelectorAll('.ap-map-block').length,
      hasPlaza: !!document.querySelector('.ap-map-plaza'),
      text: document.querySelector('.ap-map-viewport').textContent
    })
  });
  expect('preset renders 8 blocks', r.probe.blocks === 8, String(r.probe.blocks));
  expect('preset renders the plaza', r.probe.hasPlaza);
  expect('preset labels include Market', /Market/.test(r.probe.text), r.probe.text.slice(0, 80));
});

test('A1 — core map source contains no domain art; the plugin does', () => {
  const mapSrc = readFileSync(join(ROOT, 'components', 'map', 'map.js'), 'utf8');
  const mapCss = readFileSync(join(ROOT, 'components', 'map', 'map.css'), 'utf8');
  const pluginSrc = readFileSync(join(ROOT, 'plugins', 'example', 'map-presets.js'), 'utf8');
  expect('map.js has no cityGrid()', !/cityGrid/.test(mapSrc));
  expect('map.js has no block names', !/Market|Harbor/.test(mapSrc));
  expect('map.css has no preset classes', !/ap-map-block|ap-map-plaza|ap-map-ring/.test(mapCss));
  expect('plugin provides cityGrid + registers city-grid', /cityGrid/.test(pluginSrc) && /register\('city-grid'/.test(pluginSrc));
});
