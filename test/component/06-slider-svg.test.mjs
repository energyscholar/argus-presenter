// Rep 06 — SLIDER drives an animated SVG-REACTIVE gauge (in-page bus).
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';

test('rep 06 — slider -> svg-reactive via in-page bus', async () => {
  const scene = {
    layout: 'grid', userId: 'u1', userName: 'Alice',
    items: [
      { component: 'slider', opts: { prompt: 'Reactor output', promptId: 'lvl', min: 0, max: 100, step: 5, value: 20, unit: '%' } },
      { component: 'svg-reactive', opts: { label: 'Core', watch: 'lvl', min: 0, max: 100, value: 20 } }
    ]
  };

  const probe = () => ({
    svg: document.querySelector('.ap-svgr-svg').getAttribute('data-value'),
    slider: document.querySelector('.ap-slider-thumb').getAttribute('aria-valuenow'),
    valuetext: document.querySelector('.ap-slider-thumb').getAttribute('aria-valuetext')
  });

  let r = await drive({ component: 'scene', opts: scene, shot: 'slider-svg.png',
    actions: [{ press: { sel: '.ap-slider-thumb', key: 'End' } }, { wait: 400 }], probe });
  let ans = r.messages.filter((m) => m.type === 'answer' && m.promptId === 'lvl');
  expect('slider emitted answer', ans.length >= 1, JSON.stringify(r.messages.map((m) => m.type)));
  expect('slider aria-valuenow=100', r.probe.slider === '100', r.probe.slider);
  expect('slider aria-valuetext has unit', /100 %/.test(r.probe.valuetext), r.probe.valuetext);
  expect('SVG reacted to 100', r.probe.svg === '100', r.probe.svg);

  let r2 = await drive({ component: 'scene', opts: scene,
    actions: [{ press: { sel: '.ap-slider-thumb', key: 'ArrowLeft' } }, { wait: 200 }], probe });
  expect('ArrowLeft steps slider to 15', r2.probe.slider === '15', r2.probe.slider);
  expect('SVG followed to 15', r2.probe.svg === '15', r2.probe.svg);
});
