// Rep 11 — PLUGINS: example (weather + forecast scene) + ai-train-the-trainer.
import { test, check as expect } from '../../harness/test.mjs';
import { forecastScene } from '../../plugins/example/scenes.mjs';
import { exerciseCheckpoint } from '../../plugins/ai-train-the-trainer/scenes.mjs';
import { drive } from '../../harness/drive.mjs';

test('rep 11 — plugins: example forecast + train-the-trainer checkpoint', async () => {
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

  const r2 = await drive({
    component: 'scene', opts: exerciseCheckpoint({ userId: 's1', userName: 'Student' }),
    actions: [{ click: '[data-value="yes"]' }, { click: '.ap-card-revealbtn' }]
  });
  expect('checkpoint answered = yes', r2.messages.some((m) => m.type === 'answer' && m.promptId === 'ex-check' && m.value === 'yes'));
  expect('checkpoint hint revealed', r2.messages.some((m) => m.type === 'reveal' && m.value && m.value.promptId === 'ex-hint'));
});
