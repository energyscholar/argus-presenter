/*
 * Plan 0522 P8 — CONSOLIDATE CONTROL-PAGE SPACE.
 *
 * Two things are being defended here, and they pull in opposite directions (the plan's own red
 * team says so): the Live Preview grows 20%, while the columns around it are asked to give up
 * less space, not more. Both are Bruce's requests, so the phase only holds if the enlargement is
 * measured against the layout rather than asserted about the CSS.
 *
 *   t49 — the Ad-hoc push panel renders CLOSED on first load, and whatever the operator does to
 *         it STICKS. P8.1 converts a plain <h2> into a <details>; P8.3 persists the open/closed
 *         state of EVERY accordion on the page — including the outline's per-section tiers, which
 *         renderOutline() destroys and rebuilds on every single beat change. A collapse that
 *         springs back open on the next beat is not a collapse.
 *   t50 — at 1366×768 the enlarged dock does NOT overlap in-flow content, asserted from a
 *         SCREENSHOT. A fixed dock that overlaps reads fine in source and wrong on screen, which
 *         is exactly how #btn-present spent months sitting 52px inside the preview (TF1) with the
 *         CSS looking perfectly reasonable. The pixels are the witness, not the rule set.
 *
 * t50 also guards the BUG CLASS that P8.2 (R16) exists to kill. Five constants used to be
 * hand-synchronised — box, iframe scale, vertical clearance, horizontal clearance, button offset
 * — and Plan 0508 updated four of them. They are derived from --pv-scale now, but two things
 * still cannot be expressed in CSS: how wide the fixed button row actually renders, and whether
 * the reservation made for it is still big enough. t50 measures both and fails if the reservation
 * has fallen behind, so the next person to widen a button label finds out from a test rather than
 * from a screenshot at 20:05.
 *
 * Browser tier: viewport geometry, computed style, and screenshot pixels. Screenshots land in
 * test/screenshots/, the directory the other browser tests already use.
 *
 * ⛔ modules/*.json is gitignored and has no version history. Nothing here reads, writes, or names
 * the repo's modules/ directory — the deck is injected through the existing __gm.setModule hook
 * (§ANNEAL E).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Plan 0529 P2: the content catalogue is control-credentialed and FAILS CLOSED, so a test
// that drives the GM panel must run a gated server and hand the page a token — exactly as a
// real deployment does. Nothing else about these tests changed.
const CTL_TOKEN = 'ap-test-control-token';

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const DECK = {
  title: 'P8 fixture',
  id: 'p8-fixture',
  beats: [
    { id: 'p8a', component: 'card', opts: { title: 'First' } },
    { id: 'p8b', component: 'card', opts: { title: 'Second' } },
    { id: 'p8c', component: 'card', opts: { title: 'Third' } },
  ],
  sections: [
    { title: 'Opening', beatIds: ['p8a', 'p8b'] },
    { title: 'Closing', beatIds: ['p8c'] },
  ],
};

async function openControl(browser, server, { width, height } = {}) {
  const pg = await browser.newPage();
  pg.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
  if (width && height) await pg.setViewport({ width, height });
  await pg.goto(`${server.url()}/control?userId=op&role=presenter&name=Op&token=${CTL_TOKEN}`, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => typeof window.__control === 'function' && !!document.getElementById('adhoc-details'));
  await until(() => server.presence().some((u) => u.role === 'presenter'), { label: 'presenter connected' });
  return pg;
}

async function loadDeck(pg, server) {
  server.setModule(JSON.parse(JSON.stringify(DECK)));
  await pg.evaluate((d) => window.__gm.setModule(d), DECK);
  await pg.waitForFunction(() => document.querySelectorAll('#outline .sec').length >= 2);
}

/**
 * Is an element actually shown? ⚠ NOT a rect test: Chrome renders a closed <details> with
 * `content-visibility:hidden`, so its controls keep a non-zero getBoundingClientRect() and a
 * getClientRects() entry while being completely unpaintable and unfocusable. checkVisibility()
 * is the one API that tells the truth here — and the truth is what P8.1 is claiming.
 */
const rendered = (pg, sel) => pg.evaluate((s) => {
  const e = document.querySelector(s);
  return !!e && e.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true });
}, sel);

/**
 * PIXELS, NOT SELECTORS (the comparator P6 established, kept identical so the two phases report
 * comparable numbers). Two base64 PNGs are decoded on a canvas inside the page — a data: URL does
 * not taint it — and compared numerically. No pngjs, no image dependency.
 */
function comparePixels(pg, aB64, bB64) {
  return pg.evaluate(async (a, b) => {
    const load = (b64) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = 'data:image/png;base64,' + b64; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
    const data = (im) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, w, h).data; };
    const A = data(ia), B = data(ib);
    let differing = 0; const n = w * h;
    for (let i = 0; i < A.length; i += 4) {
      if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 24) differing++;
    }
    return { w, h, differing, differingFraction: differing / n };
  }, aB64, bB64);
}

test('0522 t49 — Ad-hoc push is CLOSED on first load, and every accordion remembers what the operator did', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const ctl = await openControl(browser, server);

    // ── P8.1. Not "has the attribute": the controls must genuinely not be laid out, because the
    // whole point is the column height they were costing.
    expect('Ad-hoc push is a <details>, not a plain heading',
      await ctl.evaluate(() => document.getElementById('adhoc-details').tagName === 'DETAILS'));
    expect('Ad-hoc push renders CLOSED on first load',
      (await ctl.evaluate(() => document.getElementById('adhoc-details').open)) === false);
    expect('its controls are not laid out while it is closed', (await rendered(ctl, '#pc-push')) === false);
    expect('its heading text survived the conversion',
      /ad-hoc push/i.test(await ctl.$eval('#adhoc-details > summary', (el) => el.textContent)),
      await ctl.$eval('#adhoc-details > summary', (el) => el.textContent));
    // The panel must still be reachable — closed by default is a default, not a removal.
    await ctl.click('#adhoc-details > summary');
    await ctl.waitForSelector('#pc-push', { visible: true, timeout: 3000 });
    expect('clicking the summary opens it and its controls appear', await rendered(ctl, '#pc-push'));

    // ── P8.3, static panels. Collapse Module too, so the reload proves both directions at once:
    // one accordion the operator OPENED and one the operator CLOSED.
    await ctl.evaluate(() => { document.getElementById('mod-details').open = false; });
    await wait(120);
    await ctl.reload({ waitUntil: 'domcontentloaded' });
    await ctl.waitForFunction(() => typeof window.__control === 'function' && !!document.getElementById('adhoc-details'));
    expect('the OPENED Ad-hoc panel is still open after reload',
      await ctl.evaluate(() => document.getElementById('adhoc-details').open));
    expect('the CLOSED Module panel is still closed after reload',
      (await ctl.evaluate(() => document.getElementById('mod-details').open)) === false);

    // Put Ad-hoc back to closed and confirm THAT persists too — a mechanism that only ever
    // remembers "open" is a mechanism that cannot give the space back.
    await ctl.evaluate(() => { document.getElementById('adhoc-details').open = false; });
    await wait(120);
    await ctl.reload({ waitUntil: 'domcontentloaded' });
    await ctl.waitForFunction(() => typeof window.__control === 'function' && !!document.getElementById('adhoc-details'));
    expect('a re-closed Ad-hoc panel stays closed after reload',
      (await ctl.evaluate(() => document.getElementById('adhoc-details').open)) === false);

    // ── P8.3, the outline tiers. These are the ones that matter in play: renderOutline() rebuilds
    // them from scratch on every beat change, and they were hard-coded open, so a GM who collapsed
    // a finished section watched it reappear on the very next beat.
    await loadDeck(ctl, server);
    const secOpen = (i) => ctl.evaluate((n) => document.querySelectorAll('#outline .sec')[n].open, i);
    expect('outline sections default to OPEN with nothing stored', (await secOpen(0)) === true);
    await ctl.evaluate(() => { document.querySelectorAll('#outline .sec')[0].open = false; });
    await wait(120);
    server.showBeat(2);                                     // forces a full renderOutline()
    await until(async () => (await ctl.evaluate(() => window.__gm.cur())) === 2, { label: 'panel followed the beat change' });
    await ctl.waitForFunction(() => document.querySelectorAll('#outline .sec').length >= 2);
    expect('the collapsed section STAYS collapsed across a beat-change re-render', (await secOpen(0)) === false);
    expect('the section the operator did not touch is still open', (await secOpen(1)) === true);

    // ...and across a reload, once the deck is back.
    await ctl.reload({ waitUntil: 'domcontentloaded' });
    await ctl.waitForFunction(() => typeof window.__control === 'function');
    await loadDeck(ctl, server);
    expect('the collapsed section is still collapsed after a full reload', (await secOpen(0)) === false);
    expect('and the untouched section is still open after a full reload', (await secOpen(1)) === true);

    await ctl.close();
  } finally { await browser.close(); await server.close(); }
});

test('0522 t50 — at 1366×768 the enlarged dock does not overlap in-flow content (asserted from a screenshot)', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const ctl = await openControl(browser, server, { width: 1366, height: 768 });
    await loadDeck(ctl, server);
    await ctl.evaluate(() => { document.getElementById('btn-start').disabled = false; });
    await wait(200);

    const geo = await ctl.evaluate(() => {
      const R = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const px = (v) => parseFloat(getComputedStyle(document.getElementById('topframe')).getPropertyValue(v));
      // --tf-btns-w resolves through a real property so a calc() string never has to be parsed.
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--tf-btns-w)';
      document.body.appendChild(probe);
      const reserved = probe.getBoundingClientRect().width;
      probe.remove();
      return {
        vw: innerWidth, vh: innerHeight,
        preview: R('#preview'), dock: R('#pvdock'), btnrow: R('#tf-btnrow'), present: R('#btn-present'),
        led: R('#led-btn'), topframe: R('#topframe'), sections: R('#tf-sections'),
        padRight: px('padding-right'), minH: px('min-height'), reserved,
        scale: getComputedStyle(document.querySelector('#preview iframe')).transform,
        pe: getComputedStyle(document.querySelector('#preview iframe')).pointerEvents,
      };
    });

    // ── The enlargement actually happened, and it happened via the scale (nothing re-renders).
    expect('the viewport really is 1366×768', geo.vw === 1366 && geo.vh === 768, geo.vw + '×' + geo.vh);
    expect('the preview box is the enlarged 432×282 (±2 for its border)',
      Math.abs(geo.preview.width - 432) <= 2 && Math.abs(geo.preview.height - 282) <= 3,
      geo.preview.width + '×' + geo.preview.height);
    expect('the enlargement is a transform on the SAME 600×392 source frame',
      /matrix\(0\.72,/.test(geo.scale), geo.scale);
    // §ANNEAL G — P7 made this surface interactive. P8.2 rewrites the very rule that used to make
    // it inert, so the regression is one careless paste away and is asserted here as well.
    expect('P7 survives: the preview iframe still takes pointer events', geo.pe !== 'none', geo.pe);

    // ── The coupled constants still agree. This is TF1's invariant, restated where the resize
    // happens, so a future resize fails in the phase that caused it.
    expect('the presenter-screen button sits LEFT of the preview dock',
      geo.present.right <= geo.dock.left,
      'btn.right=' + geo.present.right + ' dock.left=' + geo.dock.left);
    expect('the preview still sits LEFT of the green settings dot',
      geo.preview.right <= geo.led.left, 'preview.right=' + geo.preview.right + ' led.left=' + geo.led.left);
    expect('the top frame reserves enough VERTICAL room for the dock',
      geo.minH >= geo.dock.height, 'min-height=' + geo.minH + ' dock.height=' + geo.dock.height);
    // The one thing CSS cannot derive: how wide the button row renders. If a label grows, this is
    // the assertion that notices before a human does.
    expect('--tf-btns-w still covers the button row it reserves space for',
      geo.reserved >= geo.btnrow.width, 'reserved=' + geo.reserved + ' rendered=' + geo.btnrow.width);
    // The top frame's CONTENT box (its right edge less its reserved padding) must stop left of
    // BOTH fixed things. This is the clearance Plan 0508 left half-done.
    const contentRight = geo.topframe.right - geo.padRight;
    expect('the top frame\'s content box clears the button row',
      contentRight <= geo.btnrow.left, 'contentRight=' + contentRight + ' btnrow.left=' + geo.btnrow.left);
    expect('the top frame\'s content box clears the preview dock',
      contentRight <= geo.dock.left, 'contentRight=' + contentRight + ' dock.left=' + geo.dock.left);
    expect('and its laid-out sections actually stay inside that box',
      geo.sections.right <= geo.btnrow.left && geo.sections.right <= geo.dock.left,
      'sections.right=' + geo.sections.right + ' btnrow.left=' + geo.btnrow.left);

    // ⚠ FOUND BY THIS TEST, and it is why the pixels are checked and not just the rule set:
    // #mod-select carries `flex:1 1 auto` and a flex item's automatic minimum size, so on a wide
    // viewport it OVERFLOWS its own <section> (554 → ~791) and reaches well past the padding the
    // top frame reserves. Nothing is occluded today — the dock starts at 836 — but the true right
    // edge of in-flow paint is the select's, not the section's, and that is the number a future
    // enlargement will collide with. Measured over every in-flow descendant, deepest first.
    const inflowRight = await ctl.evaluate(() => {
      const d = document.getElementById('pvdock').getBoundingClientRect();
      let max = 0, who = '(nothing reaches the dock\'s rows)';
      document.querySelectorAll('#topframe *, .col *').forEach((e) => {
        const p = getComputedStyle(e).position;
        if (p === 'fixed' || p === 'absolute') return;
        if (!e.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true })) return;
        const r = e.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        if (r.bottom <= d.top || r.top >= d.bottom) return;   // only the rows the dock actually occupies
        if (r.right > max) { max = r.right; who = e.tagName + '#' + e.id; }
      });
      return { max, who };
    });
    expect('the RIGHTMOST in-flow pixel — overflow included — still clears the dock',
      inflowRight.max <= geo.dock.left,
      'rightmost=' + Math.round(inflowRight.max) + ' (' + inflowRight.who + ') dock.left=' + geo.dock.left);

    // ── THE SCREENSHOT. Everything above is still a rule about rectangles. This is the pixels.
    //
    // Photograph the exact rectangles the two fixed things occupy — separately, because their
    // union is mostly empty page and an overlap there would be no overlap at all — with the fixed
    // things themselves hidden, in two states: (A) the page as it is, (B) the page with ALL
    // in-flow content hidden too. If any in-flow element painted one pixel where the dock or the
    // button row sits, A and B differ there. If the clearance is real, both are bare background.
    const rects = await ctl.evaluate(() => {
      const R = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) }; };
      return { dock: R('pvdock'), btnrow: R('tf-btnrow') };
    });
    await ctl.screenshot({ path: join(SHOTS, '0522-t50-control-1366x768.png') });

    const hide = (sel) => ctl.evaluate((s) => { document.querySelectorAll(s).forEach((e) => { e.style.visibility = 'hidden'; }); }, sel);
    await hide('#pvdock, #tf-btnrow, #led-btn, #livepreview-lbl');
    await wait(120);
    const withContent = {};
    for (const k of ['dock', 'btnrow']) {
      withContent[k] = await ctl.screenshot({ clip: rects[k], encoding: 'base64' });
      writeFileSync(join(SHOTS, '0522-t50-under-the-' + k + '.png'), Buffer.from(withContent[k], 'base64'));
    }
    await hide('#topframe, .col');                       // now nothing in-flow paints at all
    await wait(120);
    for (const k of ['dock', 'btnrow']) {
      const bare = await ctl.screenshot({ clip: rects[k], encoding: 'base64' });
      writeFileSync(join(SHOTS, '0522-t50-bare-' + k + '.png'), Buffer.from(bare, 'base64'));
      const diff = await comparePixels(ctl, withContent[k], bare);
      expect('the photographed ' + k + ' region is the real one', diff.w >= 250 && diff.h >= 25,
        JSON.stringify({ w: diff.w, h: diff.h, clip: rects[k] }));
      expect('NOT ONE PIXEL of in-flow content is painted under the ' + k,
        diff.differing === 0,
        'differing=' + diff.differing + ' of ' + (diff.w * diff.h) + ' (' + (diff.differingFraction * 100).toFixed(3) + '%)');
    }

    await ctl.close();
  } finally { await browser.close(); await server.close(); }
});
