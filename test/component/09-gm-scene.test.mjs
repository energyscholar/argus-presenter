// Rep 09 — GM/PRESENTER SCENE: narration + card (facilitator reveal) + dice + choice.
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';

test('rep 09 — gm scene: narration + card + dice + choice', async () => {
  const MAP = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="150"><rect width="240" height="150" fill="#0f1a3d"/><path d="M30 120 L120 40 L210 120" fill="none" stroke="#00e5ff" stroke-width="3"/><circle cx="120" cy="40" r="7" fill="#00e5ff"/></svg>');

  const scene = {
    layout: 'grid', title: 'Session — Breakout Room 7', userId: 'u1', userName: 'Sam',
    items: [
      { component: 'narration', opts: { speaker: 'Facilitator', text: 'The room is quiet. One participant lingers by the whiteboard, thinking it over.', promptId: 'nar' } },
      { component: 'card', opts: { title: 'Volunteer', subtitle: 'Unsure', badges: ['Guest'], image: MAP, body: 'They keep glancing back at the exercise prompt.', reveal: { label: 'Facilitator only', body: 'Offer the optional hint before moving on.' }, promptId: 'npc' } },
      { component: 'dice', opts: { label: 'Confidence roll (Sam)', dice: '2d6+2', target: 8, promptId: 'recon' } },
      { component: 'choice', opts: { prompt: 'How does Sam respond?', options: [{ label: 'Push back', value: 'pushback', style: 'danger' }, { label: 'Encourage', value: 'encourage', style: 'ok' }, { label: 'Observe', value: 'observe' }], promptId: 'approach' } }
    ]
  };

  const r = await drive({
    component: 'scene', opts: scene, shot: 'gm-scene.png', viewport: { width: 1300, height: 920 },
    actions: [{ click: '.ap-dice .ap-btn' }, { wait: 700 }, { click: '[data-value="observe"]' }],
    probe: () => ({ diceTotal: document.querySelector('.ap-dice-result').getAttribute('data-total') })
  });
  const ev = r.messages;
  const recon = ev.find((m) => m.type === 'answer' && m.promptId === 'recon');
  expect('dice rolled + emitted answer', recon && typeof recon.value === 'number', JSON.stringify(ev.filter((m) => m.type === 'answer').map((m) => m.promptId)));
  expect('dice total in 2d6+2 range (4-14)', recon && recon.value >= 4 && recon.value <= 14, JSON.stringify(recon));
  expect('dice success flag matches target', recon && recon.success === (recon.value >= 8), JSON.stringify(recon));
  expect('choice approach=observe', ev.some((m) => m.type === 'answer' && m.promptId === 'approach' && m.value === 'observe'));
  expect('dice result displayed', /\d/.test(r.probe.diceTotal || ''), r.probe.diceTotal);
});
