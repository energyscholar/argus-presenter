// Rep 11 — PLUGINS: the plugin MECHANISM, exercised against a test fixture.
//
// ⭐ Plan 0569 M2 — this used to import ../../plugins/{example,ai-train-the-trainer}/scenes.mjs
// directly out of the engine's own plugins/ directory. `ai-train-the-trainer` was teaching
// content and now lives in repertory (private); the engine no longer knows it exists. `example`
// is an authoring reference and now lives in test/fixtures/plugins/.
//
// What is under test is that a plugin can contribute a COMPONENT, a PRESET and a SCENE and have
// them render and round-trip answers — not that any particular plugin exists.
import { test, check as expect } from '../../harness/test.mjs';
import { forecastScene } from '../fixtures/plugins/example/scenes.mjs';
import { drive } from '../../harness/drive.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'plugins');

test('rep 11 — a plugin contributes a component and a scene that round-trips', async () => {
  const prev = process.env.PRESENTER_PLUGINS_DIR;
  process.env.PRESENTER_PLUGINS_DIR = FIXTURES;
  try {
    const r = await drive({
      component: 'scene', opts: forecastScene({ userId: 'u1', userName: 'Alex' }), shot: 'plugin-example.png',
      requires: ['example'],
      viewport: { width: 1200, height: 820 },
      actions: [{ host: { type: 'weather-update', metrics: { humidity: 100 } } }, { wait: 300 }, { click: '[data-value="umbrella"]' }],
      probe: () => ({
        hasWeather: !!document.querySelector('.ap-weather'),
        vals: [...document.querySelectorAll('.ap-wx-val')].map((e) => e.getAttribute('data-key') + '=' + e.textContent)
      })
    });
    expect('plugin component weather rendered', r.probe.hasWeather, JSON.stringify(r.probe));
    expect('weather-update raised humidity to 100%', r.probe.vals.includes('humidity=100%'), JSON.stringify(r.probe.vals));
    expect('forecast choice = umbrella', r.messages.some((m) => m.type === 'answer' && m.promptId === 'wx-choice' && m.value === 'umbrella'));
  } finally {
    if (prev === undefined) delete process.env.PRESENTER_PLUGINS_DIR;
    else process.env.PRESENTER_PLUGINS_DIR = prev;
  }
});
