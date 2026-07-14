// T2 (Plan 0457) — content-anchored markers + per-user cursors (component idiom).
// Emission and render both use CONTENT-space fractions so markers/cursors stay
// pinned to map features under pan/zoom; cursors are per-user, tinted, self-suppressed.
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';

test('T2 — click + pointer emit CONTENT-space fractions under pan+zoom', async () => {
  const r = await drive({
    component: 'map',
    opts: { controllable: false, userId: 'me', userName: 'Me', x: 40, y: -20, scale: 2 },
    probe: () => {
      const vp = document.querySelector('.ap-map-viewport');
      const ct = document.querySelector('.ap-map-content');
      const cr = ct.getBoundingClientRect();
      const at = (fx, fy) => ({ clientX: cr.left + fx * cr.width, clientY: cr.top + fy * cr.height, bubbles: true });
      vp.dispatchEvent(new MouseEvent('mousemove', at(0.08, 0.12)));   // non-presenter cursor emission
      vp.dispatchEvent(new MouseEvent('mousedown', at(0.05, 0.1)));
      vp.dispatchEvent(new MouseEvent('click', at(0.05, 0.1)));
      const msgs = window.__apMsgs || [];
      const mk = msgs.filter((m) => m.type === 'op' && m.path === 'map/markers').pop() || null;
      const ptr = msgs.filter((m) => m.type === 'op' && m.path === 'map/pointer/me').pop() || null;
      return { mk, ptr, w: cr.width };
    }
  });
  const p = r.probe || {};
  const mv = p.mk && p.mk.value, pv = p.ptr && p.ptr.value;
  expect('content box is the scaled 800px box', p.w && Math.abs(p.w - 1600) < 2, String(p.w));
  expect('click op emitted', !!mv, JSON.stringify(p.mk));
  expect('click px is the content fraction (0.05)', mv && Math.abs(mv.px - 0.05) < 0.005, mv && String(mv.px));
  expect('click py is the content fraction (0.10)', mv && Math.abs(mv.py - 0.10) < 0.005, mv && String(mv.py));
  expect('non-presenter pointer op emitted (cursors default all)', !!pv, JSON.stringify(p.ptr));
  expect('pointer px/py are content fractions', pv && Math.abs(pv.px - 0.08) < 0.005 && Math.abs(pv.py - 0.12) < 0.005,
    pv && JSON.stringify(pv));
  expect('pointer op carries the user name', pv && pv.name === 'Me', pv && String(pv.name));
});

test('T2 — per-user cursors: two peers render tinted + named, self suppressed', async () => {
  const r = await drive({
    component: 'map', opts: { controllable: false, userId: 'me', userName: 'Me' },
    actions: [
      { host: { type: 'diff', diff: { 'map/pointer/u1': { px: 0.3, py: 0.3, name: 'Uno' } } } },
      { host: { type: 'diff', diff: { 'map/pointer/u2': { px: 0.6, py: 0.4, name: 'Dos' } } } },
      { host: { type: 'diff', diff: { 'map/pointer/me': { px: 0.5, py: 0.5, name: 'Me' } } } },
      { wait: 120 }
    ],
    probe: () => {
      const els = Array.from(document.querySelectorAll('.ap-map-cursor'));
      return {
        n: els.length,
        uids: els.map((e) => e.getAttribute('data-uid')).sort(),
        names: els.map((e) => { const t = e.querySelector('.ap-map-cursor-name'); return t && t.textContent; }).sort(),
        tints: els.map((e) => { const d = e.querySelector('.ap-map-cursor-dot'); return d && getComputedStyle(d).backgroundColor; }),
        inContent: els.every((e) => e.parentElement.classList.contains('ap-map-content'))
      };
    }
  });
  const p = r.probe || {};
  expect('exactly two cursor elements', p.n === 2, JSON.stringify(p));
  expect('cursors keyed by the op path suffix', p.uids && p.uids.join(',') === 'u1,u2', JSON.stringify(p.uids));
  expect('name tags rendered', p.names && p.names.join(',') === 'Dos,Uno', JSON.stringify(p.names));
  expect('tints differ per user', p.tints && p.tints[0] && p.tints[1] && p.tints[0] !== p.tints[1], JSON.stringify(p.tints));
  expect('self cursor NOT rendered', p.uids && !p.uids.includes('me'), JSON.stringify(p.uids));
  expect('cursors live inside the content layer', p.inContent === true, JSON.stringify(p));
});

test('T2 — cursors:"off" renders none and skips non-presenter emission', async () => {
  const r = await drive({
    component: 'map', opts: { controllable: false, userId: 'me', cursors: 'off' },
    actions: [
      { host: { type: 'diff', diff: { 'map/pointer/u1': { px: 0.3, py: 0.3, name: 'Uno' } } } },
      { wait: 100 }
    ],
    probe: () => {
      const vp = document.querySelector('.ap-map-viewport');
      vp.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 200, bubbles: true }));
      return {
        cursors: document.querySelectorAll('.ap-map-cursor').length,
        ptrOps: (window.__apMsgs || []).filter((m) => m.type === 'op' && /^map\/pointer\//.test(m.path)).length
      };
    }
  });
  expect('no cursor elements with cursors:off', r.probe && r.probe.cursors === 0, JSON.stringify(r.probe));
  expect('no pointer emission with cursors:off', r.probe && r.probe.ptrOps === 0, JSON.stringify(r.probe));
});

test('T2 — markers stay pinned to the content point under pan/zoom, constant size', async () => {
  const r = await drive({
    component: 'map', opts: { controllable: false, userId: 'me' },
    actions: [
      { host: { type: 'diff', diff: { 'map/markers': { px: 0.25, py: 0.25, name: 'Peer' } } } },
      { host: { type: 'diff', diff: { 'map/view': { x: 60, y: 25, scale: 2 } } } },
      { wait: 150 }
    ],
    probe: () => {
      const mk = document.querySelector('.ap-map-click');
      const ct = document.querySelector('.ap-map-content');
      if (!mk) return { missing: true };
      const mr = mk.getBoundingClientRect(), cr = ct.getBoundingClientRect();
      const dot = mk.querySelector('.ap-map-click-dot').getBoundingClientRect();
      return {
        cx: mr.left + mr.width / 2, cy: mr.top + mr.height / 2,
        ex: cr.left + 0.25 * cr.width, ey: cr.top + 0.25 * cr.height,
        dotW: dot.width, inContent: mk.parentElement === ct,
        name: (mk.querySelector('.ap-map-click-name') || {}).textContent
      };
    }
  });
  const p = r.probe || {};
  expect('marker rendered', !p.missing, JSON.stringify(p));
  expect('marker is a child of the content layer', p.inContent === true, JSON.stringify(p));
  expect('marker x tracks the content point after zoom', Math.abs(p.cx - p.ex) < 2, `${p.cx} vs ${p.ex}`);
  expect('marker y tracks the content point after zoom', Math.abs(p.cy - p.ey) < 2, `${p.cy} vs ${p.ey}`);
  expect('marker dot apparent size constant under zoom (counter-scale)', Math.abs(p.dotW - 18) < 2, String(p.dotW));
  expect('marker keeps the clicker name', p.name === 'Peer', String(p.name));
});
