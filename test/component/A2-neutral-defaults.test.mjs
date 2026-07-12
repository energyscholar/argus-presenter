// A2 — every core component renders a domain-NEUTRAL default with empty opts.
// (choice = Yes/No per the plan; others render a sensible neutral placeholder.)
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';

const CORE = ['choice', 'text-input', 'slider', 'dice', 'form', 'poll-results',
  'narration', 'card', 'image', 'map', 'svg-reactive', 'stepper', 'scene', 'crud'];

test('A2 — each core component renders with empty opts (neutral default, no crash)', async () => {
  for (const c of CORE) {
    const r = await drive({ component: c, opts: {}, probe: () => ({ n: document.getElementById('ap-mount').childElementCount }) });
    expect(`${c} renders a neutral default`, r.probe && r.probe.n >= 1, `${c} produced no DOM`);
  }
});

test('A2 — choice neutral default is Yes/No', async () => {
  const r = await drive({ component: 'choice', opts: {}, probe: () => document.querySelector('#ap-mount').textContent });
  expect('choice default offers Yes', /Yes/.test(r.probe), r.probe);
  expect('choice default offers No', /No/.test(r.probe), r.probe);
});
