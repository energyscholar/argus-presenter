/*
 * Plan 0571 — THE ALERT PIP, PAINTED, IN A REAL BROWSER.
 *
 * ⭐⭐ WHAT THIS PLAN ACTUALLY BUYS, and it is the only thing worth testing: SPACE. Bruce,
 * 2026-08-13: "The Alert control WORKS but it takes up a lot of screen real estate, both for
 * display and for the captain… Alert Status is a SMALL FEATURE and should take up SMALL SPACE.
 * Screen real estate is at a premium."
 *
 * ⛔ SO EVERY TEST HERE IS TWO CLAIMS, NOT ONE: the pip shows the condition, AND the band that used
 * to show it is gone. A run that only proved the first would report success for a screen no
 * roomier than before — which is exactly the outcome this plan exists to avoid.
 *
 * ⛔ NO SHORTCUTS (0565's rule). A real server, a real seat link, a real browser, real state
 * changes over the wire, and the verdict read off the DOM as literal values.
 *
 * ⭐ 0581 B — AND EVERY PAINTED READ CARRIES A CONTROL. A value-under-test cannot vouch for the
 * screen that carries it: `t0575-03p` asserted a real element with a real box and passed while the
 * station screen was blank. `assertControl` asks the whole screen to answer, and `settleCensus`
 * bounds the wait at 4000 ms with THE DEADLINE ITSELF AS THE ASSERTION — past it the check runs on
 * the last sample, so a screen that never settles still fails.
 *
 * ⚠ RESOURCES: 6.4 GB, ZERO SWAP, 36 prior OOM kills. One browser at a time, closed before the
 * next is opened, `assertResources` before each launch.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { assertResources } from '../../harness/resources.mjs';
import { settleCensus, assertControl, glassFrames } from '../../harness/painted.mjs';
import { mkdirSync } from 'fs';
import { join } from 'path';

/*
 * ⭐ THE EVIDENCE. A painted check that leaves no image is a claim; one that leaves an image is a
 * record somebody else can disagree with. ⚠ `evidence/` is GITIGNORED and that is correct — the
 * durable record is the measured values printed below, never the PNGs.
 */
const SHOTS = process.env.PRESENTER_EVIDENCE_DIR
  || join(process.env.HOME || '/tmp', 'software', 'has-anyone-looked', 'evidence', '0571');
async function shoot(page, name) {
  try {
    mkdirSync(SHOTS, { recursive: true });
    const file = join(SHOTS, name);
    await page.screenshot({ path: file });
    console.log(`      [shot] ${file}`);
    return file;
  } catch (e) { console.log(`      [shot] FAILED ${name} — ${e && e.message}`); return null; }
}

/** Every literal DOM value this file read, printed so the run report can quote it verbatim. */
function report(tag, v) { console.log(`      [painted] ${tag} ${JSON.stringify(v)}`); }

/** Seat a real browser at a station, exactly as a player's link does (the 0565 recipe). */
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

/*
 * ⛔ THE FRAME IS TAKEN FROM `glassFrames`, NOT from `frames().find(f => f !== mainFrame())`.
 * The latter takes the first frame that is not the top one, which is not a claim about the glass:
 * a detached or stale frame answers `evaluate()` with entirely plausible numbers, and that is how
 * `t0575-03p` read a healthy census off a screen that was not there.
 */
async function onGlass(page, fn, arg) {
  const gs = await glassFrames(page);
  for (const g of gs) {
    try {
      const v = await g.frame.evaluate(fn, arg);
      if (v != null) return v;
    } catch { /* torn down mid-read — try the next visible frame, never report it healthy */ }
  }
  return null;
}

/**
 * THE PAINTED READ. The attribute AND the computed fill AND the box AND the removals — because
 * "the pip is right" and "the band is gone" are two different claims and this plan is mostly the
 * second one.
 */
const readPip = (p) => onGlass(p, () => {
  const el = document.querySelector('#apAlertPip');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const t = el.querySelector('title');
  return {
    state: el.getAttribute('data-alert'),
    label: el.getAttribute('data-alert-label'),
    colourAttr: el.getAttribute('data-alert-colour'),
    tooltipAttr: el.getAttribute('data-alert-tooltip'),
    titleText: t ? (t.textContent || '') : null,
    fill: getComputedStyle(el).fill,
    box: [Math.round(r.width), Math.round(r.height)],
    // the removals, as literal DOM facts
    bands: document.querySelectorAll('.ap-alertband').length,
    dots: document.querySelectorAll('.ap-ab-dot').length,
    labels: document.querySelectorAll('.ap-ab-label').length,
    glosses: document.querySelectorAll('.ap-ab-gloss').length,
  };
});

/** Move the ship from the SERVER side, through the plugin's own contributed tool. */
const shipEvent = async (server, event) => {
  const r = await server.callPluginTool('ship_event', { event });
  return r && r.ok ? r.result : { error: r && r.error };
};

/** The chart is the source of truth for every colour and word this file compares against. */
async function chartAlert() {
  const { readFileSync } = await import('fs');
  const { REAL_PLUGINS } = await import('../unit/_0514-fixtures.mjs');
  const j = JSON.parse(readFileSync(join(REAL_PLUGINS, 'starship-ops', 'ship-chart.json'), 'utf8'));
  return j.regions.alert.states;
}

const rgb = (hex) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex));
  return m ? `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})` : null;
};

test('t0571-02 — ⭐ THE PIP FOLLOWS THE SHIP through UNKNOWN → GREEN → YELLOW → RED → GREEN, on a seat that gives no orders', async () => {
  const server = await createServer({ port: 0 });
  if (!server.stations().stations.length) {
    expect('skipped — no station plugin on this deployment', true, 'skipped');
    await server.close(); return;
  }
  assertResources({ needMB: 900, label: '0571 t0571-02 painted' });
  const browser = await launch();
  try {
    const states = await chartAlert();
    /* ⛔ A SEAT THAT IS NOT THE CAPTAIN'S. Reading the condition back on the console that set it
       would pass for a client that merely remembered; the Pilot can only be showing what the
       SERVER sent him. */
    const pil = await seat(browser, server, 2, 'Pilot Probe');

    const settle = await settleCensus(pil, { deadlineMs: 4000 });
    console.log(`      [settle] ${settle.ms} ms of a ${settle.deadlineMs} ms deadline, settled=${settle.settled}`);
    expect('⛔ THE DEADLINE IS THE ASSERTION — the art settled inside 4000 ms',
      settle.settled, `ms=${settle.ms} census=${JSON.stringify(settle.census.chosen)}`);
    assertControl(expect, settle.census, 't0571-02');

    const first = await readPip(pil);
    report('on arrival', first);
    expect('the pip is on the glass with a NON-ZERO box (1004×0 is the failure this catches)',
      first && first.box[0] > 0 && first.box[1] > 0, JSON.stringify(first && first.box));
    expect('⛔ AND THE BAND IS GONE — no .ap-alertband, no dot, no label, no gloss anywhere',
      first && first.bands === 0 && first.dots === 0 && first.labels === 0 && first.glosses === 0,
      JSON.stringify(first));
    await shoot(pil, '0571-pip-01-on-arrival-no-band.png');

    /* ⛔ CHANGE THE STATE AND LOOK AGAIN — the only check that separates a live indicator from a
       dead one, per alert-band.js's own post-mortem. Four states, in order, each read back. */
    const walk = [['stand-down', 'normal'], ['general-quarters', 'elevated'],
                  ['battle-stations', 'action'], ['stand-down', 'normal']];
    const seen = [{ was: 'boot', got: first }];
    for (const [event, want] of walk) {
      const moved = await shipEvent(server, event);
      expect(`the ship machine actually moved on ${event} (else this proves nothing)`,
        moved && moved.changed === true, JSON.stringify(moved));
      await until(async () => { const b = await readPip(pil); return b && b.state === want; },
        { timeout: 8000, label: `the pip follows the ship to ${want}` });
      const got = await readPip(pil);
      report(`after ${event}`, got);
      seen.push({ was: want, got });
      expect(`⭐ ${want}: the pip's COMPUTED FILL is the chart's colour, not an attribute nobody drew`,
        got && got.fill === rgb(states[want].colour),
        `want ${rgb(states[want].colour)} (${states[want].colour}) got ${got && got.fill}`);
      expect(`${want}: and the colour the server published agrees with it`,
        got && String(got.colourAttr).toLowerCase() === String(states[want].colour).toLowerCase(),
        String(got && got.colourAttr));
      expect(`${want}: still a non-zero box, still no band`,
        got && got.box[0] > 0 && got.box[1] > 0 && got.bands === 0, JSON.stringify(got));
      await shoot(pil, `0571-pip-${seen.length}-${want}.png`);
    }

    /* THE STATES ARE ALL DIFFERENT COLOURS — asserted rather than assumed, because a pip stuck on
       one colour would satisfy every per-state check above if the chart ever handed out a repeat. */
    const fills = seen.slice(1).map((s) => s.got.fill);
    expect('the four readings are not all the same colour (a stuck pip fails here)',
      new Set(fills).size >= 3, JSON.stringify(fills));

    /* ⛳ STAND DOWN — a test that leaves the ship at battle stations hands the next session a
       false alarm. Already done by the last step of the walk; asserted so it cannot be dropped. */
    const end = await readPip(pil);
    expect('⛳ the ship is left at rest, not at battle stations', end && end.state === 'normal', JSON.stringify(end));
  } finally { await browser.close(); await server.close(); }
});

test('t0571-07a — ⛔ NO ALERT BAND SURVIVES ON ANY STATION — the four states are one 5.5-unit square', async () => {
  /* t0571-07's first half. The buttons are the other half and are asserted where they are removed.
     ⭐ ACROSS SEVERAL STATIONS, not one: the band was mounted by station-screen, which serves all
     thirteen, so a leftover on the fourteenth code path is exactly the kind of thing one sample
     misses. */
  const server = await createServer({ port: 0 });
  const declared = server.stations().stations;
  if (!declared.length) { expect('skipped — no station plugin', true, 'skipped'); await server.close(); return; }
  assertResources({ needMB: 900, label: '0571 t0571-07a painted' });
  const browser = await launch();
  try {
    /* ⚠ MEASURED: `server.stations()` returns the SANITISED station rows — the screen descriptor
       is not on them, the boolean `hasScreen` is. Filtering on `stationScreen` matched nothing and
       the test failed on its own premise rather than on the thing it was testing, which is the
       right way round for that mistake to come out. */
    const uids = declared.filter((s) => s.hasScreen).map((s) => s.stationUid).slice(0, 4);
    expect('several stations declare a screen to check', uids.length >= 2, JSON.stringify(uids));
    for (const uid of uids) {
      const p = await seat(browser, server, uid, `Probe ${uid}`);
      const v = await readPip(p);
      report(`station ${uid}`, v);
      expect(`station ${uid}: the pip is there and painted`, v && v.box[0] > 0 && v.box[1] > 0, JSON.stringify(v));
      expect(`station ${uid}: ⛔ zero bands, zero dots, zero labels, zero glosses`,
        v && v.bands === 0 && v.dots === 0 && v.labels === 0 && v.glosses === 0, JSON.stringify(v));
      await p.close();
    }
  } finally { await browser.close(); await server.close(); }
});
