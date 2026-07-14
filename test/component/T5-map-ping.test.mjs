// T5 (Plan 0457) — radar-ping click indicator: a map/markers op renders a ~5 s
// ping (staggered expanding rings + bright dot + name tag), per-user tinted,
// content-anchored + counter-scaled (T2). Component idiom; timing-tolerant.
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';

test('T5 — a marker op renders an animated radar ping, tinted per user, content-anchored', async () => {
  const r = await drive({
    component: 'map', opts: { controllable: false, userId: 'me' },
    actions: [
      { host: { type: 'diff', diff: { 'map/markers': { id: 'm1', px: 0.25, py: 0.25, name: 'Uno' } } } },
      { host: { type: 'diff', diff: { 'map/markers': { id: 'm2', px: 0.6, py: 0.5, name: 'Dos' } } } },
      { wait: 150 }
    ],
    probe: () => {
      const mks = Array.from(document.querySelectorAll('.ap-map-click'));
      const ct = document.querySelector('.ap-map-content');
      const cr = ct.getBoundingClientRect();
      const first = mks[0];
      const ring = first && first.querySelector('.ap-map-click-ring');
      const rs = ring && getComputedStyle(ring);
      const mr = first && first.getBoundingClientRect();
      return {
        n: mks.length,
        rings: mks.map((m) => m.querySelectorAll('.ap-map-click-ring').length),
        anim: rs && { name: rs.animationName, state: rs.animationPlayState, iter: rs.animationIterationCount },
        ringColors: mks.map((m) => getComputedStyle(m.querySelector('.ap-map-click-ring')).borderTopColor),
        names: mks.map((m) => { const t = m.querySelector('.ap-map-click-name'); return t && t.textContent; }).sort(),
        hasDot: mks.every((m) => !!m.querySelector('.ap-map-click-dot')),
        inContent: mks.every((m) => m.parentElement === ct),
        cx: mr && mr.left + mr.width / 2, cy: mr && mr.top + mr.height / 2,
        ex: cr.left + 0.25 * cr.width, ey: cr.top + 0.25 * cr.height
      };
    }
  });
  const p = r.probe || {};
  expect('two pings rendered (one per user)', p.n === 2, JSON.stringify(p));
  expect('each ping has 2-3 rings', p.rings && p.rings.every((n) => n >= 2 && n <= 3), JSON.stringify(p.rings));
  expect('rings run the radar keyframes', p.anim && p.anim.name === 'apRadarPing' && p.anim.state === 'running', JSON.stringify(p.anim));
  expect('ring animation repeats for the lifetime', p.anim && p.anim.iter === 'infinite', JSON.stringify(p.anim));
  expect('ring tints differ per user', p.ringColors && p.ringColors[0] !== p.ringColors[1], JSON.stringify(p.ringColors));
  expect('name tags rendered', p.names && p.names.join(',') === 'Dos,Uno', JSON.stringify(p.names));
  expect('bright center dot present', p.hasDot === true, JSON.stringify(p));
  expect('pings live inside the content layer (T2 anchoring)', p.inContent === true, JSON.stringify(p));
  expect('ping x anchors the content point', Math.abs(p.cx - p.ex) < 2, `${p.cx} vs ${p.ex}`);
  expect('ping y anchors the content point', Math.abs(p.cy - p.ey) < 2, `${p.cy} vs ${p.ey}`);
});

test('T5 — ping still at full strength at ~3.5 s', async () => {
  const r = await drive({
    component: 'map', opts: { controllable: false, userId: 'me' },
    actions: [
      { host: { type: 'diff', diff: { 'map/markers': { id: 'm1', px: 0.5, py: 0.5, name: 'Uno' } } } },
      { wait: 3200 }
    ],
    probe: () => {
      const mk = document.querySelector('.ap-map-click');
      return { present: !!mk, fading: !!(mk && mk.classList.contains('is-fading')) };
    }
  });
  const p = r.probe || {};
  expect('ping still present at ~3.5 s', p.present === true, JSON.stringify(p));
  expect('ping not yet fading at ~3.5 s', p.fading === false, JSON.stringify(p));
});

test('T5 — ping fades over the last second and is removed by ~6 s', async () => {
  const r = await drive({
    component: 'map', opts: { controllable: false, userId: 'me' },
    actions: [
      { host: { type: 'diff', diff: { 'map/markers': { id: 'm1', px: 0.5, py: 0.5, name: 'Uno' } } } },
      { wait: 4600 }
    ],
    probe: async () => {
      const mk = document.querySelector('.ap-map-click');
      const midFade = { present: !!mk, fading: !!(mk && mk.classList.contains('is-fading')) };
      await new Promise((res) => setTimeout(res, 1400));   // -> ~6 s after the op
      return { midFade, leftAtEnd: document.querySelectorAll('.ap-map-click').length };
    }
  });
  const p = r.probe || {};
  expect('ping fading at ~4.7 s', p.midFade && p.midFade.present && p.midFade.fading, JSON.stringify(p.midFade));
  expect('ping removed by ~6 s', p.leftAtEnd === 0, String(p.leftAtEnd));
});
