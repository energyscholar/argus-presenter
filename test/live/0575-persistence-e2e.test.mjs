/*
 * Plan 0575 PHASE 9 — PERSISTENCE, PAINTED. THE STRONGEST GATE IN THIS RUN.
 *
 * ⭐⭐ BRUCE'S SENTENCE, AS A TEST (2026-08-13): "captain need only ever set CONDITION GREEN once,
 * then it will stick for all time unless changed."
 *
 * ⛔⛔ AND ITS CONVERSE, WHICH MATTERS MORE: a ship at BATTLE STATIONS survives a restart still at
 * battle stations. Until this phase it silently stood down — the board did not go blank, it made a
 * confident, safe-sounding, FALSE claim, and thirteen green stations look exactly like a real
 * stand-down.
 *
 * ⛔ NO SHORTCUTS, per 0565's rule and plan 0575 §4b.1: a real server, a REAL RESTART (the first
 * server is CLOSED and a second one is started), a real seat link, a real browser, a real click,
 * and the verdict read off the DOM — the literal `data-alert` attribute AND the pip's COMPUTED
 * fill colour AND a non-zero bounding box. Every layer but the last one passed for P0a, and P0a
 * shipped broken.
 *
 * ⭐ THE SECOND SEAT IS A DIFFERENT STATION on purpose. Reading the state back on the console that
 * set it would pass for a client that merely remembered; a Pilot who was never present for the
 * order can only be showing what the SERVER came up holding.
 *
 * ⚠ RESOURCES: 6.4 GB, ZERO SWAP, 36 prior OOM kills. One browser at a time, closed before the
 * next is opened, and `assertResources` is called before each launch.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { assertResources } from '../../harness/resources.mjs';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/*
 * ⭐ THE EVIDENCE. A painted check that leaves no image is a claim; one that leaves an image is a
 * record somebody else can disagree with. Shots land in the gitignored test/screenshots/ and are
 * named so they are interpretable WITHOUT this file's narration — the reviewer sees them as a
 * batch, out of context, and a shot that needs a caption has failed its job.
 */
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
async function shoot(page, name) {
  try {
    mkdirSync(SHOTS, { recursive: true });
    const file = join(SHOTS, name);
    await page.screenshot({ path: file });
    console.log(`      [shot] ${file}`);
    return file;
  } catch (e) { console.log(`      [shot] FAILED ${name} — ${e && e.message}`); return null; }
}

/** Seat a real browser at a station, exactly as a player's link does (same recipe as 0565). */
async function seat(browser, server, uid, name) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 800 });
  await p.goto(`${server.url()}/?stationUID=${uid}&n=${encodeURIComponent(name)}`,
               { waitUntil: 'domcontentloaded' });
  await wait(1200);
  await p.evaluate(() => document.getElementById('cfg-station')?.click());   // "show my station"
  await wait(1500);
  return p;
}

const frameOf = (p) => p.frames().find((f) => f !== p.mainFrame()) || null;

/**
 * ⭐ THE PAINTED READ. Not `data-alert` alone: the attribute could be right while nothing is drawn
 * (a component mounted at 1004×0 is the estate's own worst case). So this also takes the pip's
 * COMPUTED fill — which arrives from the chart, through the store, through the diff, onto the
 * element — and its bounding box.
 *
 * ⭐⭐ 0571 — AND THE BAND IT USED TO READ NO LONGER EXISTS. Bruce, 2026-08-13: "Alert Status is a
 * SMALL FEATURE and should take up SMALL SPACE." The bordered band at the top right of all
 * thirteen screens is gone; the display is `#apAlertPip`, the 5.5 x 5.5 unit square the station
 * art has always drawn immediately left of the ship's name, repainted from outside. `bandGone` is
 * asserted alongside the colour, because "the new thing works" and "the old thing was removed" are
 * two claims and this plan is mostly the second one.
 */
const paintedBand = (p) =>
  frameOf(p).evaluate(() => {
    const b = document.querySelector('#apAlertPip');
    if (!b) return null;
    const br = b.getBoundingClientRect();
    const t = b.querySelector('title');
    return {
      alert: b.getAttribute('data-alert'),
      label: b.getAttribute('data-alert-label'),
      colourAttr: b.getAttribute('data-alert-colour'),
      tooltipAttr: b.getAttribute('data-alert-tooltip'),
      titleText: t ? (t.textContent || '') : null,
      pipFill: getComputedStyle(b).fill,
      pipBox: [Math.round(br.width), Math.round(br.height)],
      // ⛔ the removals, read as literal DOM facts rather than believed
      bandGone: !document.querySelector('.ap-alertband'),
      dotGone: !document.querySelector('.ap-ab-dot'),
      buttonsGone: document.querySelectorAll('.ap-order').length === 0,
    };
  });

const clickOrder = (p, ev) =>
  frameOf(p).evaluate((e) => {
    const b = document.querySelector(`.ap-order[data-order="${e}"]`);
    if (!b) return false;
    b.click();
    return true;
  }, ev);

/** Every literal DOM value this file read, printed so the run report can quote it verbatim. */
function report(tag, v) { console.log(`      [painted] ${tag} ${JSON.stringify(v)}`); }

/**
 * Start a server, seat ONE browser, do `fn`, and shut both down. The browser is closed before the
 * server so a page cannot reconnect into a closing socket.
 */
async function withSeat(uid, name, fn) {
  const server = await createServer({ port: 0 });
  let browser = null;
  try {
    if (!server.stations().stations.length) return 'no-stations';
    assertResources({ needMB: 900, label: '0575 P9 painted check' });
    browser = await launch();
    const page = await seat(browser, server, uid, name);
    return await fn({ server, page });
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
}

test('t0575-09b — ⛔⛔ A SHIP AT BATTLE STATIONS SURVIVES A RESTART, STILL AT BATTLE STATIONS', async () => {
  // ── run 1: the Captain gives the order, on his own screen, with a real click ──────────────
  const first = await withSeat(1, 'Captain Probe', async ({ page }) => {
    const before = await paintedBand(page);
    report('boot (fresh state dir)', before);
    expect('a freshly booted hull reads UNKNOWN, not GREEN', before && before.alert === 'unknown', JSON.stringify(before));
    expect('the button exists and was clicked', await clickOrder(page, 'battle-stations'), 'no button');
    await until(async () => { const b = await paintedBand(page); return b && b.alert === 'action'; },
      { timeout: 8000, label: 'the band goes RED on the Captain’s own screen' });
    const after = await paintedBand(page);
    report('after the order', after);
    await shoot(page, 'p9-alert-BEFORE-restart-captain-seat-RED.png');
    return after;
  });
  if (first === 'no-stations') { expect('skipped — no station plugin on this deployment', true, 'skipped'); return; }
  expect('the order landed on the glass', first && first.alert === 'action', JSON.stringify(first));

  // ── ⛔ THE RESTART. The server above is CLOSED. Nothing is in flight; nothing is cached. ───
  await wait(400);

  // ── run 2: a DIFFERENT seat, a NEW server, a NEW browser ──────────────────────────────────
  const after = await withSeat(2, 'Pilot Probe', async ({ page }) => {
    const b = await paintedBand(page);
    report('AFTER RESTART, a different seat', b);
    await shoot(page, 'p9-alert-AFTER-restart-pilot-seat-still-RED.png');
    return b;
  });
  if (after === 'no-stations') { expect('skipped — no station plugin', true, 'skipped'); return; }

  expect('⭐⭐ THE BAND STILL READS RED AFTER A FULL RESTART',
    after && after.alert === 'action', JSON.stringify(after));
  expect('⛔ and it did NOT silently stand down to GREEN',
    after && after.alert !== 'normal' && after.label !== 'GREEN', JSON.stringify(after));
  expect('⛔ nor did it forget and read UNKNOWN', after && after.alert !== 'unknown', JSON.stringify(after));
  // The pip is PAINTED: its fill came from the chart colour for `action`, through the store,
  // through the snapshot, into `--ab`. A right attribute over an invisible element is P0a again.
  expect('the pip is filled with the ACTION colour, computed off the live element',
    after && after.pipFill === 'rgb(224, 82, 82)', String(after && after.pipFill));
  expect('and the colour the server published agrees with it',
    after && String(after.colourAttr).toLowerCase() === '#e05252', String(after && after.colourAttr));
  expect('the condition is named on the element, in words', after && after.label === 'RED', JSON.stringify(after && after.label));
  expect('⛔ NON-ZERO BOUNDING BOX — the pip is on the glass, not merely in the DOM',
    after && after.pipBox[0] > 0 && after.pipBox[1] > 0, JSON.stringify(after && after.pipBox));
  expect('⭐ 0571 — AND THE BAND IT REPLACED IS GONE from the DOM, band, dot and all',
    after && after.bandGone && after.dotGone, JSON.stringify(after));
});

test('t0575-09 — ⭐ BRUCE’S SENTENCE: set CONDITION GREEN once, restart, and it is still green', async () => {
  const first = await withSeat(1, 'Captain Probe', async ({ page }) => {
    // Reach GREEN the way a Captain does: the ship must first be somewhere else, or `stand-down`
    // from `unknown` would be indistinguishable from a boot that never heard anything.
    expect('battle stations first, so GREEN is a state we ARRIVED at', await clickOrder(page, 'battle-stations'), 'no button');
    await until(async () => { const b = await paintedBand(page); return b && b.alert === 'action'; },
      { timeout: 8000, label: 'RED' });
    expect('then the Captain stands the ship down', await clickOrder(page, 'stand-down'), 'no button');
    await until(async () => { const b = await paintedBand(page); return b && b.alert === 'normal'; },
      { timeout: 8000, label: 'GREEN' });
    const b = await paintedBand(page);
    report('CONDITION GREEN, set once', b);
    await shoot(page, 'p9-green-BEFORE-restart-captain-seat-GREEN.png');
    return b;
  });
  if (first === 'no-stations') { expect('skipped — no station plugin', true, 'skipped'); return; }
  expect('the ship is at CONDITION GREEN', first && first.alert === 'normal' && first.label === 'GREEN', JSON.stringify(first));

  await wait(400);   // ⛔ the restart

  const after = await withSeat(2, 'Pilot Probe', async ({ page }) => {
    const b = await paintedBand(page);
    report('AFTER RESTART', b);
    await shoot(page, 'p9-green-AFTER-restart-pilot-seat-still-GREEN.png');
    return b;
  });
  if (after === 'no-stations') { expect('skipped — no station plugin', true, 'skipped'); return; }

  expect('⭐ IT STUCK. The captain set it once and the restart did not undo it',
    after && after.alert === 'normal', JSON.stringify(after));
  expect('⛔ and it is a RESTORED green, not the boot default (which 1c made `unknown`)',
    after && after.alert !== 'unknown', JSON.stringify(after));
  expect('the pip is filled with the GREEN colour, computed off the live element',
    after && after.pipFill === 'rgb(63, 185, 80)', String(after && after.pipFill));
  expect('the condition is named on the element, in words', after && after.label === 'GREEN', JSON.stringify(after && after.label));
  expect('⛔ NON-ZERO BOUNDING BOX on the pip',
    after && after.pipBox[0] > 0 && after.pipBox[1] > 0, JSON.stringify(after && after.pipBox));
  expect('⭐ 0571 — and no band, no dot and no order BUTTONS anywhere on this screen',
    after && after.bandGone && after.dotGone && after.buttonsGone, JSON.stringify(after));
});
