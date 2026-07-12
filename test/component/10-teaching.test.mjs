// Rep 10 — TEACHING SEGMENT via the stepper (same vocabulary as the GM scene).
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';

test('rep 10 — teaching stepper: lesson -> concept -> knowledge check', async () => {
  const flow = {
    promptId: 'lesson', userId: 's1', userName: 'Student', showProgress: true,
    steps: [
      { component: 'narration', opts: { speaker: 'Lesson 1', text: 'A critical point is where a system changes qualitatively — small cause, system-wide effect.', promptId: 'l1' } },
      { component: 'card', opts: { title: 'Universality', body: 'Different systems share the same exponents near a critical point.', reveal: { label: 'Why it matters', body: 'You can transfer results across domains that look unrelated.' }, promptId: 'l2' } },
      { component: 'choice', opts: { prompt: 'Check: what does universality mean?', options: [{ label: 'Shared critical exponents', value: 'shared', style: 'ok' }, { label: 'Everything is random', value: 'random', style: 'danger' }], promptId: 'q1' } }
    ]
  };

  const r = await drive({
    component: 'stepper', opts: flow, shot: 'teaching.png', viewport: { width: 1000, height: 720 },
    actions: [
      { click: '.ap-stepper-next' },
      { click: '.ap-card-revealbtn' },
      { click: '.ap-stepper-next' },
      { click: '[data-value="shared"]' },
      { click: '.ap-stepper-next' }
    ]
  });
  const ev = r.messages;
  const steps = ev.filter((m) => m.type === 'step').map((m) => m.value.index);
  expect('visited steps 0,1,2', steps.includes(0) && steps.includes(1) && steps.includes(2), JSON.stringify(steps));
  expect('concept reveal fired', ev.some((m) => m.type === 'reveal' && m.value && m.value.promptId === 'l2'), JSON.stringify(ev.map((m) => m.type)));
  expect('knowledge check answered = shared', ev.some((m) => m.type === 'answer' && m.promptId === 'q1' && m.value === 'shared'));
  expect('flow completed', ev.some((m) => m.type === 'flow-complete'), JSON.stringify(ev.map((m) => m.type)));
});
