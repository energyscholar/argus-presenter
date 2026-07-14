// T1 (Plan 0457) — styled map tooltips driven by data-tip attributes on the
// supplied overlay DOM (component idiom: drive/DOM level, no live frames).
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';

const FIXTURE = '<svg viewBox="0 0 100 100">'
  + '<rect id="plain" x="2" y="2" width="10" height="10" fill="#345"></rect>'
  + '<g id="n1" data-tip="Alpha Station&#10;Depth 40 m&#10;Crew 12"><circle cx="30" cy="30" r="6" fill="#6cf"/></g>'
  + '<g id="n2" data-tip="Beacon Two"><title>Beacon Two legacy</title><circle cx="70" cy="70" r="6" fill="#fc6"/></g>'
  + '</svg>';

test('T1 — data-tip nodes drive the shared styled tooltip', async () => {
  const r = await drive({
    component: 'map', opts: { controllable: false, svg: FIXTURE, label: 'Tips' },
    probe: () => {
      const out = {};
      const tip = document.querySelector('.ap-map-tip');
      const vp = document.querySelector('.ap-map-viewport').getBoundingClientRect();
      const n1 = document.getElementById('n1'), n2 = document.getElementById('n2'), plain = document.getElementById('plain');
      const ev = (el, type, x, y) => el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: type === 'mousemove' }));
      out.tipExists = !!tip;
      out.hiddenAtStart = tip && tip.style.display === 'none';
      ev(n1, 'mouseenter', vp.left + 60, vp.top + 50);
      out.shownOnEnter = tip.style.display !== 'none';
      out.lineCount = tip.children.length;
      out.firstLine = tip.firstElementChild && tip.firstElementChild.textContent;
      out.firstLineWeight = tip.firstElementChild ? getComputedStyle(tip.firstElementChild).fontWeight : null;
      const before = { l: tip.style.left, t: tip.style.top };
      ev(n1, 'mousemove', vp.left + 140, vp.top + 110);
      out.repositioned = tip.style.left !== before.l || tip.style.top !== before.t;
      ev(n1, 'mouseleave', 0, 0);
      out.hiddenOnLeave = tip.style.display === 'none';
      ev(plain, 'mouseenter', vp.left + 20, vp.top + 20);
      out.plainNoTip = tip.style.display === 'none';
      out.titleGone = !n2.querySelector('title');
      out.ariaLabel = n2.getAttribute('aria-label');
      ev(n2, 'mouseenter', vp.left + 90, vp.top + 80);
      out.n2First = tip.firstElementChild && tip.firstElementChild.textContent;
      return out;
    }
  });
  const p = r.probe || {};
  expect('shared tooltip exists and starts hidden', p.tipExists && p.hiddenAtStart, JSON.stringify(p));
  expect('mouseenter shows instantly', p.shownOnEnter);
  expect('multiline: one div per line (3)', p.lineCount === 3, String(p.lineCount));
  expect('first line text is the first data-tip line', p.firstLine === 'Alpha Station', String(p.firstLine));
  expect('first line is bold', p.firstLineWeight === '700' || p.firstLineWeight === 'bold', String(p.firstLineWeight));
  expect('mousemove repositions the tooltip', p.repositioned);
  expect('mouseleave hides the tooltip', p.hiddenOnLeave);
  expect('no tooltip on nodes without data-tip', p.plainNoTip);
  expect('<title> child removed when data-tip present', p.titleGone);
  expect('aria-label keeps the old title text', p.ariaLabel === 'Beacon Two legacy', String(p.ariaLabel));
  expect('tooltip works for the second node', p.n2First === 'Beacon Two', String(p.n2First));
  expect('zero new ops (purely client-side)', !r.messages.some((m) => m.type === 'op'),
    JSON.stringify(r.messages.filter((m) => m.type === 'op')));
});

test('T1 — tooltip hides on pan/zoom start', async () => {
  const r = await drive({
    component: 'map', opts: { controllable: true, svg: FIXTURE },
    probe: () => {
      const tip = document.querySelector('.ap-map-tip');
      const vp = document.querySelector('.ap-map-viewport');
      const vr = vp.getBoundingClientRect();
      const n1 = document.getElementById('n1');
      n1.dispatchEvent(new MouseEvent('mouseenter', { clientX: vr.left + 60, clientY: vr.top + 50 }));
      const shown = tip.style.display !== 'none';
      vp.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true }));
      return { shown, hiddenAfterZoom: tip.style.display === 'none' };
    }
  });
  expect('tooltip shown before zoom', r.probe && r.probe.shown, JSON.stringify(r.probe));
  expect('tooltip hidden on zoom start', r.probe && r.probe.hiddenAfterZoom, JSON.stringify(r.probe));
});
