/*
 * Contact Plot — a shared tactical display, and the first demo with CONTINUOUS shared state.
 * The assertions that matter are about the throttle: a drag must not flood the store, and the
 * RELEASE must never be swallowed by it.
 *
 * Run: node examples/contact-plot/run.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, launch, connectUser, waitContentFrame, wait,
         shot, act, readAll, reporter } from '../_lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(HERE, 'page.html'), 'utf8');
const ok = reporter();

const server = await createServer({ port: 0 });
const browser = await launch();
try {
  const P = {};
  for (const [id, nm] of [['ann','Ann'],['ben','Ben'],['cal','Cal']])
    P[id] = await connectUser(browser, server, { userId: id, userName: nm });
  await wait(400);
  server.pushPage('all', PAGE);
  await wait(1300);
  const F = {}; for (const k of Object.keys(P)) F[k] = await waitContentFrame(P[k]);
  const seat = (s) => server.store.lockOwnerFor('shared/cp/seats/' + s);

  const probe = () => ({
    tokens: document.querySelectorAll('#tokens .tok').length,
    mine: document.querySelectorAll('#tokens .tok.mine').length,
    range: document.getElementById('r-range')?.textContent,
    bearing: document.getElementById('r-bearing')?.textContent,
    aPos: (() => { const g = document.querySelector('[data-seat="A"] .dot');
      return g ? { x: +g.getAttribute('cx'), y: +g.getAttribute('cy') } : null; })(),
  });
  const snap = () => readAll(F, probe);

  await P.ann.bringToFront(); await act(F.ann, '#join-A', e => e.click()); await wait(600);
  await P.ben.bringToFront(); await act(F.ben, '#join-B', e => e.click()); await wait(700);
  ok('both contacts are seated', seat('A') === 'ann' && seat('B') === 'ben', `${seat('A')}/${seat('B')}`);

  let s = await snap();
  ok('every viewer renders BOTH contacts', Object.keys(P).every(k => s[k].tokens === 2),
     JSON.stringify(Object.fromEntries(Object.keys(P).map(k => [k, s[k].tokens]))));
  ok('only your own contact is marked draggable', s.ann.mine === 1 && s.cal.mine === 0,
     `ann=${s.ann.mine} cal=${s.cal.mine}`);
  ok('range and bearing are computed', /\d+ u/.test(s.cal.range) && /\d+°/.test(s.cal.bearing),
     `${s.cal.range} / ${s.cal.bearing}`);
  for (const k of Object.keys(P)) await shot(P[k], `cp-1-seated-${k}.png`);

  // ── THE THROTTLE. Drive 40 pointer moves and count the ops that actually landed. ──
  const before = server.store.version();
  await P.ann.bringToFront();
  await F.ann.evaluate(async () => {
    const svg = document.getElementById('plot');
    const r = svg.getBoundingClientRect();
    const fire = (type, nx, ny) => {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true,
        clientX: r.left + nx * r.width, clientY: r.top + ny * r.height });
      (type === 'mousedown' ? document.querySelector('[data-seat="A"] .dot') : window).dispatchEvent(ev);
    };
    fire('mousedown', 0.3, 0.5);
    for (let i = 0; i < 40; i++) {
      fire('mousemove', 0.3 + i * 0.01, 0.5 + i * 0.005);
      await new Promise(r2 => setTimeout(r2, 12));
    }
    fire('mouseup', 0.70, 0.70);
  });
  await wait(900);
  const ops = server.store.version() - before;
  /* ⛔ ASSERT THE PROPERTY, NOT A NUMBER. The first version of this pinned `ops <= 14` and flaked
     roughly 2 runs in 5 (observed 14, 15, 16) — because the op count is derived from ELAPSED TIME
     against the throttle window, not from the frame count, so it moves with machine load. The
     throttle was never wrong; the assertion was. What matters is that a 40-frame drag costs far
     fewer than 40 writes, and that it is not zero. */
  ok('40 drag frames produced FAR fewer store ops (throttled)', ops > 0 && ops < 24,
     `ops=${ops} (40 frames; bound is a property, not a pinned count)`);

  const finalPos = server.store.get('shared/cp/pos/A');
  ok('the RELEASE position landed exactly, not a throttled stale one',
     Math.abs(finalPos.x - 0.70) < 0.02 && Math.abs(finalPos.y - 0.70) < 0.02, JSON.stringify(finalPos));

  s = await snap();
  const positions = Object.keys(P).map(k => JSON.stringify(s[k].aPos));
  ok('EVERY viewer shows contact A in the same place', new Set(positions).size === 1, positions.join(' | '));
  ok('...and that place is where it was dropped',
     Math.abs(s.cal.aPos.x - 280) < 8 && Math.abs(s.cal.aPos.y - 280) < 8, JSON.stringify(s.cal.aPos));
  for (const k of Object.keys(P)) await shot(P[k], `cp-2-dragged-${k}.png`);

  // An observer cannot move anyone.
  const held = JSON.stringify(server.store.get('shared/cp/pos/A'));
  await P.cal.bringToFront();
  await F.cal.evaluate(() => {
    const d = document.querySelector('[data-seat="A"] .dot');
    d.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 20 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 20, clientY: 20 }));
  });
  await wait(700);
  ok('an observer cannot drag a contact', JSON.stringify(server.store.get('shared/cp/pos/A')) === held);
} finally {
  await browser.close(); await server.close();
}
process.exit(ok.done());
