/*
 * TOC-jump (Plan 0456 P2) — section/sequence jump buttons in the control-page outline.
 * Each section <summary> and sequence <summary> carries a small ⏵ button that fires
 * control('show_beat',{index: first resolvable beat of that tier}) via the same path as
 * beat rows. The button must NOT disturb the <details> open/close state (stopPropagation
 * + preventDefault); plain summary clicks still toggle. A tier with zero resolvable
 * beats renders NO jump button.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until } from '../../harness/multi.mjs';

const MODULE = {
  title: 'TOC demo',
  beats: [
    { id: 'b1', component: 'card', opts: { title: 'One' } },
    { id: 'b2', component: 'card', opts: { title: 'Two' } },
    { id: 'b3', component: 'card', opts: { title: 'Three' } },
    { id: 'b4', component: 'card', opts: { title: 'Four' } },
  ],
  sections: [
    { title: 'Sec 1', beatIds: ['b1', 'b2'] },
    { title: 'Sec 2', sequences: [
      { title: 'Seq A', beatIds: ['b3'] },
      { title: 'Seq B', beatIds: ['b4'] },
    ] },
    { title: 'Sec 3', beatIds: ['ghost'] },   // beat id that resolves to nothing → no jump button
    { title: 'Sec 4', beatIds: [] },          // empty tier → no jump button
  ],
};

test('TOC1 — outline section/sequence jump buttons: show_beat + details state untouched + empty tiers', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const ctl = await browser.newPage();
    ctl.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
    await ctl.goto(`${server.url()}/control?userId=op&role=presenter`, { waitUntil: 'domcontentloaded' });
    await ctl.waitForFunction(() => typeof window.__control === 'function' && window.__gm && typeof window.__gm.setModule === 'function');
    await until(() => server.presence().some((u) => u.role === 'presenter'), { label: 'presenter connected' });

    // Load the SAME module server-side and into the panel (renders the outline).
    server.setModule(MODULE);
    await ctl.evaluate((m) => window.__gm.setModule(m), MODULE);

    const cur = () => ctl.evaluate(() => window.__gm.cur());
    const atBeat = (i, label) => until(async () => (await cur()) === i && server.store.get('module/current') === i, { label });

    server.showBeat(1);
    await atBeat(1, 'panel+server at beat 1');

    // Section-level jump: click Sec 1's ⏵ and, SYNCHRONOUSLY in the same evaluate, verify the
    // <details> open-state did not flip (before any diff-driven re-render can repaint it open).
    const secClick = await ctl.evaluate(() => {
      const det = document.querySelectorAll('#outline .sec')[0];
      const before = det.open;
      det.querySelector('summary .tocjump').click();
      return { before, after: det.open };
    });
    expect('Sec 1 details open before jump click', secClick.before === true);
    expect('Sec 1 details open-state unchanged by jump click', secClick.after === true);
    await atBeat(0, 'Sec 1 jump fired show_beat with its first beat (index 0)');

    // Section with sequences: the section-level ⏵ targets the first resolvable beat overall (b3 → 2).
    await ctl.evaluate(() => document.querySelectorAll('#outline .sec')[1].querySelector(':scope > summary .tocjump').click());
    await atBeat(2, 'Sec 2 jump fired show_beat with first beat of its first sequence (index 2)');

    // Sequence-level jump: Seq B's ⏵ → b4 (index 3); its own <details> state also untouched.
    const seqClick = await ctl.evaluate(() => {
      const qdet = document.querySelectorAll('#outline .sec')[1].querySelectorAll('.seq')[1];
      const before = qdet.open;
      qdet.querySelector('summary .tocjump').click();
      return { before, after: qdet.open };
    });
    expect('Seq B details open-state unchanged by jump click', seqClick.before === true && seqClick.after === true);
    await atBeat(3, 'Seq B jump fired show_beat with its first beat (index 3)');

    // Collapse behavior unbroken: a plain summary click (not on the button) still toggles.
    const toggle = await ctl.evaluate(() => {
      const det = document.querySelectorAll('#outline .sec')[0];
      det.querySelector('summary > span').click();
      const closed = det.open === false;
      det.querySelector('summary > span').click();
      return { closed, reopened: det.open === true };
    });
    expect('summary click still collapses the section', toggle.closed);
    expect('summary click still re-expands the section', toggle.reopened);

    // Tiers with zero resolvable beats render NO jump button.
    const empties = await ctl.evaluate(() => {
      const secs = document.querySelectorAll('#outline .sec');
      return {
        s3: !!secs[2].querySelector('.tocjump'),   // unresolvable beat id
        s4: !!secs[3].querySelector('.tocjump'),   // no beats at all
      };
    });
    expect('unresolvable-only section has no jump button', empties.s3 === false);
    expect('empty section has no jump button', empties.s4 === false);

    await ctl.close();
  } finally { await browser.close(); await server.close(); }
});
