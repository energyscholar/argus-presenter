// T4 (Plan 0457) — fullscreen map: the pushed map fills the display (full width,
// full height minus only the label bar), the SVG sizes from its INTRINSIC viewBox
// aspect, and the initial view is ZOOM-TO-FIT (contain, centered). Component idiom.
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';

// Wide art, same aspect as a real survey overlay (1680×1050 = 1.6).
const WIDE = '<svg viewBox="0 0 1680 1050">'
  + '<rect x="0" y="0" width="1680" height="1050" fill="#0b1026"/>'
  + '<circle cx="840" cy="525" r="40" fill="#8ac"/>'
  + '</svg>';

test('T4 — map viewport fills the display (full-bleed host, label bar only)', async () => {
  const r = await drive({
    component: 'map', opts: { controllable: false, svg: WIDE, label: 'Survey' },
    probe: () => {
      const vp = document.querySelector('.ap-map-viewport').getBoundingClientRect();
      const mount = document.getElementById('ap-mount');
      return {
        vw: window.innerWidth, vh: window.innerHeight, w: vp.width, h: vp.height,
        fullbleed: !!(mount && mount.classList.contains('ap-fullbleed'))
      };
    }
  });
  const p = r.probe || {};
  expect('host content container is full-bleed for the map', p.fullbleed === true, JSON.stringify(p));
  expect('viewport width >= 98% of the window', p.w >= 0.98 * p.vw, `${p.w} vs ${p.vw}`);
  expect('viewport height >= 92% of the window', p.h >= 0.92 * p.vh, `${p.h} vs ${p.vh}`);
});

test('T4 — initial view is zoom-to-fit (contain): whole SVG visible at intrinsic aspect', async () => {
  const r = await drive({
    component: 'map', opts: { controllable: false, svg: WIDE, label: 'Survey' },
    probe: () => {
      const vp = document.querySelector('.ap-map-viewport').getBoundingClientRect();
      const ct = document.querySelector('.ap-map-content').getBoundingClientRect();
      return { vp: { l: vp.left, t: vp.top, r: vp.right, b: vp.bottom, w: vp.width, h: vp.height },
               ct: { l: ct.left, t: ct.top, r: ct.right, b: ct.bottom, w: ct.width, h: ct.height } };
    }
  });
  const p = r.probe || {};
  const vp = p.vp || {}, ct = p.ct || {};
  const inX = ct.l >= vp.l - 1.5 && ct.r <= vp.r + 1.5;
  const inY = ct.t >= vp.t - 1.5 && ct.b <= vp.b + 1.5;
  expect('whole content box inside the viewport (contain)', inX && inY, JSON.stringify(p));
  expect('content keeps the intrinsic 1.6 aspect', ct.h && Math.abs(ct.w / ct.h - 1.6) < 0.02, String(ct.w / ct.h));
  const fill = Math.max(ct.w / vp.w, ct.h / vp.h);
  expect('at least one axis ~fills the viewport', fill >= 0.98, String(fill));
  // Centered: the slack axis has equal margins.
  const dx = Math.abs((ct.l - vp.l) - (vp.r - ct.r));
  const dy = Math.abs((ct.t - vp.t) - (vp.b - ct.b));
  expect('fit is centered', dx < 2 && dy < 2, `dx=${dx} dy=${dy}`);
});

test('T4 — neutralGrid fallback still renders, sized square, contained', async () => {
  const r = await drive({
    component: 'map', opts: { controllable: false },
    probe: () => {
      const vp = document.querySelector('.ap-map-viewport').getBoundingClientRect();
      const ct = document.querySelector('.ap-map-content').getBoundingClientRect();
      return {
        gridLines: document.querySelectorAll('.ap-map-grid-line').length,
        vp: { l: vp.left, t: vp.top, r: vp.right, b: vp.bottom },
        ct: { l: ct.left, t: ct.top, r: ct.right, b: ct.bottom, w: ct.width, h: ct.height }
      };
    }
  });
  const p = r.probe || {};
  const vp = p.vp || {}, ct = p.ct || {};
  expect('neutral grid drawn (>=8 lines)', p.gridLines >= 8, String(p.gridLines));
  expect('grid content box is square', ct.h && Math.abs(ct.w / ct.h - 1) < 0.02, String(ct.w / ct.h));
  expect('grid contained in the viewport', ct.l >= vp.l - 1.5 && ct.r <= vp.r + 1.5 && ct.t >= vp.t - 1.5 && ct.b <= vp.b + 1.5, JSON.stringify(p));
});
