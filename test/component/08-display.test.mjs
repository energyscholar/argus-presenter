// Rep 08 — DISPLAY vocabulary: narration + card(reveal) + image.
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';

test('rep 08 — display: narration + card reveal + image', async () => {
  const IMG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140"><rect width="240" height="140" fill="#0f1a3d"/><circle cx="120" cy="70" r="46" fill="none" stroke="#00e5ff" stroke-width="3"/><circle cx="120" cy="70" r="10" fill="#00e5ff"/></svg>');

  const scene = {
    layout: 'grid', userId: 'u1', userName: 'Alice',
    items: [
      { component: 'narration', opts: { speaker: 'Guide', text: 'The workshop doors open onto a quiet studio.', cta: 'Continue', promptId: 'n1' } },
      { component: 'card', opts: { title: 'Dr. Lee', subtitle: 'Data Analyst', badges: ['Speaker', 'Featured'], image: IMG, body: 'A careful analyst who reads every dashboard closely.', reveal: { label: 'Facilitator note', body: 'Lead with the retention chart before the revenue slide.' }, promptId: 'c1' } },
      { component: 'image', opts: { src: IMG, caption: 'Site overview map', frame: true } }
    ]
  };

  const r = await drive({
    component: 'scene', opts: scene, shot: 'display.png',
    actions: [{ click: '.ap-narration-cta' }, { click: '.ap-card-revealbtn' }],
    probe: () => ({
      narration: document.querySelector('.ap-narration-text').textContent,
      revealShown: !document.querySelector('.ap-card-reveal').hidden,
      cardTitle: document.querySelector('.ap-card-title').textContent,
      imgCount: document.querySelectorAll('.ap-image-img, .ap-card-img').length
    })
  });
  const ev = r.messages;
  expect('narration continue emitted', ev.some((m) => m.type === 'continue' && m.value && m.value.promptId === 'n1'), JSON.stringify(ev.map((m) => m.type)));
  expect('card reveal emitted', ev.some((m) => m.type === 'reveal' && m.value && m.value.promptId === 'c1'), JSON.stringify(ev.map((m) => m.type)));
  expect('reveal content now shown', r.probe.revealShown === true, JSON.stringify(r.probe));
  expect('narration text rendered', /studio/.test(r.probe.narration), r.probe.narration);
  expect('card title rendered', r.probe.cardTitle === 'Dr. Lee', r.probe.cardTitle);
  expect('two images present (card + image)', r.probe.imgCount >= 2, String(r.probe.imgCount));
});
