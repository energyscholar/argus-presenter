// Rep 03 — SCENE (Composite): choice + text-input on one surface; validation gates.
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';

test('rep 03 — scene: multi-component surface + validation', async () => {
  const scene = {
    layout: 'grid', title: 'Session Feedback', userId: 'u1', userName: 'Alice',
    items: [
      { component: 'choice', opts: { prompt: 'How was it?', promptId: 'q1', options: [{ label: 'Good', value: 'good', style: 'ok' }, { label: 'Bad', value: 'bad', style: 'danger' }] } },
      { component: 'text-input', opts: { prompt: 'Comments?', promptId: 'q2', placeholder: 'Type…', validate: 'required', submitLabel: 'Send' } }
    ]
  };

  let r = await drive({ component: 'scene', opts: scene, shot: 'scene.png', actions: [
    { click: '[data-value="good"]' },
    { type: { sel: '#q2-input', text: 'Nice work' } },
    { click: '.ap-textfield-submit' }
  ] });
  let ans = r.messages.filter((m) => m.type === 'answer');
  expect('choice emitted good', ans.some((m) => m.promptId === 'q1' && m.value === 'good'), JSON.stringify(ans));
  expect('text emitted value', ans.some((m) => m.promptId === 'q2' && m.value === 'Nice work'), JSON.stringify(ans));
  expect('both identity-stamped u1', ans.length >= 2 && ans.every((m) => m.userId === 'u1'));
  expect('two distinct components on one surface', new Set(ans.map((m) => m.promptId)).size === 2);

  let r2 = await drive({ component: 'scene', opts: scene, actions: [{ click: '.ap-textfield-submit' }] });
  let a2 = r2.messages.filter((m) => m.type === 'answer' && m.promptId === 'q2');
  expect('empty required submit blocked', a2.length === 0, JSON.stringify(r2.messages.map((m) => m.type + ':' + m.promptId)));
});
