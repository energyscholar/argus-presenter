// Rep 01 — CHOICE. click, keyboard select, change-of-mind (LWW), identity, ready.
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';

test('rep 01 — choice: click / keyboard / change-of-mind / identity / ready', async () => {
  const USER = { userId: 'u1', userName: 'Alice' };
  const OPTS = { prompt: 'Would you like a demonstration?', promptId: 'p1', ...USER,
    options: [{ label: 'Yes', value: 'yes', style: 'ok' }, { label: 'No', value: 'no', style: 'danger' }] };

  let r = await drive({ component: 'choice', opts: OPTS, actions: [{ click: '[data-value="yes"]' }], shot: 'choice-yes.png' });
  let last = r.messages.filter(m => m.type === 'answer').pop();
  expect('click YES emits answer=yes', last && last.value === 'yes', JSON.stringify(r.messages));
  expect('answer carries promptId=p1', last && last.promptId === 'p1');
  expect('answer carries userId=u1', last && last.userId === 'u1');
  expect('answer carries userName=Alice', last && last.userName === 'Alice');
  expect('ready event emitted', r.messages.some(m => m.type === 'ready'));

  let r2 = await drive({ component: 'choice', opts: { ...OPTS, promptId: 'p2' },
    actions: [{ press: { sel: '[data-value="yes"]', key: 'ArrowRight' } }], shot: 'choice-kbd.png' });
  let k = r2.messages.filter(m => m.type === 'answer').pop();
  expect('ArrowRight selects+emits NO', k && k.value === 'no', JSON.stringify(r2.messages));

  let r3 = await drive({ component: 'choice', opts: { ...OPTS, promptId: 'p3' },
    actions: [{ click: '[data-value="no"]' }, { click: '[data-value="yes"]' }] });
  let a3 = r3.messages.filter(m => m.type === 'answer');
  expect('two answers on change', a3.length === 2, 'got ' + a3.length);
  expect('last answer wins = yes', a3.length && a3[a3.length - 1].value === 'yes');
});
