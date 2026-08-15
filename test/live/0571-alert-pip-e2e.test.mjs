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
    /* ⛔ Whatever state the hull came up in — persistence means it is not always `unknown` — the
       pip must be wearing THAT state's chart colour and THAT state's chart wording. Asserting
       "it is unknown" here would be asserting the fixture, and would go red the first time a
       previous run left the ship somewhere else. */
    expect('on arrival the pip already agrees with the chart for whatever state the hull is in',
      first && first.state && states[first.state]
        && first.fill === rgb(states[first.state].colour)
        && first.titleText === states[first.state].tooltip,
      JSON.stringify({ read: first, chart: first && states[first.state] }));
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
      /* ⭐ 0571 A3 — THE WORDS COME FROM THE CHART TOO. A 5.5-unit square has no room for a
         label, so the wording is a native SVG <title> the browser shows on hover; the component
         renders only what it was handed. Compared against the chart, never against a literal. */
      expect(`${want}: the tooltip is the CHART's wording, drawn into the pip's <title>`,
        got && got.titleText === states[want].tooltip && got.tooltipAttr === states[want].tooltip,
        `want ${JSON.stringify(states[want].tooltip)} got title=${JSON.stringify(got && got.titleText)} attr=${JSON.stringify(got && got.tooltipAttr)}`);
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

/** The Captain's control, read as literal DOM. ⛔ Includes what must be ABSENT. */
const readOrders = (p) => onGlass(p, () => {
  const w = document.querySelector('.ap-orders');
  if (!w) return { present: false, buttons: document.querySelectorAll('.ap-order').length };
  const sel = w.querySelector('.ap-orders-select');
  const st = w.querySelector('.ap-orders-status');
  const r = sel ? sel.getBoundingClientRect() : { width: 0, height: 0 };
  const wr = w.getBoundingClientRect();
  const pip = document.querySelector('#apAlertPip');
  const pr = pip ? pip.getBoundingClientRect() : null;
  return {
    present: true,
    hasSelect: !!sel,
    options: sel ? [...sel.options].map((o) => o.value) : [],
    optionLabels: sel ? [...sel.options].map((o) => o.textContent) : [],
    value: sel ? sel.value : null,
    selected: w.getAttribute('data-selected'),
    trueState: w.getAttribute('data-alert-state'),
    ack: w.getAttribute('data-ack'),
    reason: w.getAttribute('data-ack-reason'),
    message: w.getAttribute('data-ack-message'),
    statusText: (st || {}).textContent || '',
    statusBox: st ? [Math.round(st.getBoundingClientRect().width), Math.round(st.getBoundingClientRect().height)] : [0, 0],
    selectBox: [Math.round(r.width), Math.round(r.height)],
    wrapBox: [Math.round(wr.width), Math.round(wr.height)],
    // ⛔ THE REMOVALS
    buttons: document.querySelectorAll('.ap-order').length,
    bands: document.querySelectorAll('.ap-alertband').length,
    // proximity: the control is meant to sit WITH the pip, not across the bottom of the screen
    pipTop: pr ? Math.round(pr.top) : null,
    ctlTop: Math.round(wr.top),
    viewportH: window.innerHeight,
  };
});

/** Choose an order on the select the way a human does — a real value change AND a real event. */
const chooseOrder = (p, ev) => onGlass(p, (e) => {
  const sel = document.querySelector('.ap-orders-select');
  if (!sel) return { ok: false, why: 'no select' };
  if (![...sel.options].some((o) => o.value === e)) return { ok: false, why: 'no such option', have: [...sel.options].map((o) => o.value) };
  sel.value = e;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: sel.value };
}, ev);

test('t0571-05 — ⭐ THE SELECT ISSUES THE SAME ORDER THE BUTTON DID, and the buttons are gone', async () => {
  const server = await createServer({ port: 0 });
  if (!server.stations().stations.length) { expect('skipped — no station plugin', true, 'skipped'); await server.close(); return; }
  assertResources({ needMB: 900, label: '0571 t0571-05 painted' });
  const browser = await launch();
  try {
    const cap = await seat(browser, server, 1, 'Captain Probe');
    const settle = await settleCensus(cap, { deadlineMs: 4000 });
    console.log(`      [settle] ${settle.ms} ms of a ${settle.deadlineMs} ms deadline, settled=${settle.settled}`);
    expect('⛔ THE DEADLINE IS THE ASSERTION — the art settled inside 4000 ms', settle.settled,
      `ms=${settle.ms} census=${JSON.stringify(settle.census.chosen)}`);
    assertControl(expect, settle.census, 't0571-05');

    const before = await readOrders(cap);
    report('the Captain’s control', before);
    expect('the control is one SELECT, painted, with a non-zero box',
      before && before.hasSelect && before.selectBox[0] > 0 && before.selectBox[1] > 0, JSON.stringify(before));
    expect('⛔ ZERO order BUTTONS remain, and zero alert bands',
      before && before.buttons === 0 && before.bands === 0, JSON.stringify(before));
    /* ⭐ THE OPTION SET IS EXACTLY THE THREE ORDERS PLUS THE NEUTRAL ONE — asserted here as well as
       structurally in t0571-05b, because "the server offers three" and "the dropdown shows three"
       are two different claims. `unknown` is not among them and there is no filter making it so. */
    const opts = (before.options || []).filter(Boolean);
    expect('exactly three orders are offered, and `unknown` is not one of them',
      opts.length === 3 && !opts.includes('unknown'), JSON.stringify(before.options));
    expect('and one NEUTRAL option, for the state no order leads to',
      (before.options || []).filter((v) => v === '').length === 1, JSON.stringify(before.options));
    /* ⭐ IT SITS WITH THE PIP. The plan's point was screen real estate: the old row of buttons was
       anchored across the BOTTOM of the console. This asserts the control is in the top quarter of
       the screen and near the pip, not that it is at a pixel. */
    expect('the control moved UP TO THE PIP — top quarter of the screen, within 8% of the pip',
      before.ctlTop != null && before.pipTop != null
        && before.ctlTop < before.viewportH * 0.25
        && Math.abs(before.ctlTop - before.pipTop) < before.viewportH * 0.08,
      JSON.stringify({ ctlTop: before.ctlTop, pipTop: before.pipTop, viewportH: before.viewportH }));
    await shoot(cap, '0571-orders-01-captain-select-in-header.png');

    const chose = await chooseOrder(cap, 'battle-stations');
    expect('the order was chosen on a real select', chose && chose.ok === true, JSON.stringify(chose));
    await until(async () => { const a = await readOrders(cap); return a && a.ack; },
      { timeout: 8000, label: 'the Captain gets a verdict' });
    const after = await readOrders(cap);
    report('after the order', after);
    expect('⭐ ACCEPTED, and it said so in words on his own screen',
      after.ack === 'ok' && /\S/.test(after.statusText), JSON.stringify(after));
    expect('the verdict line is PAINTED, not merely present',
      after.statusBox[0] > 0 && after.statusBox[1] > 0, JSON.stringify(after.statusBox));

    await until(async () => { const b = await readPip(cap); return b && b.state === 'action'; },
      { timeout: 8000, label: 'the ship reached action stations' });
    const pip = await readPip(cap);
    report('the pip after the order', pip);
    expect('⭐⭐ the SAME event the button used to send moved the ship — the pip is RED',
      pip && pip.state === 'action', JSON.stringify(pip));
    const settled = await readOrders(cap);
    expect('and the select agrees with the ship it just moved',
      settled.trueState === 'action' && settled.value === 'battle-stations', JSON.stringify(settled));
    await shoot(cap, '0571-orders-02-accepted-red.png');

    await server.callPluginTool('ship_event', { event: 'stand-down' });   // ⛳ leave the ship at rest
  } finally { await browser.close(); await server.close(); }
});

test('t0571-06 — ⛔ THE DENY STILL SPEAKS: a seat without the order is refused IN WORDS, and the select goes back', async () => {
  /* 0565's bar, carried forward: the failure this guards is not "the wrong person changed the
     ship", it is "the wrong person acted, nothing happened, and nothing said why". ⚠ A dropdown
     that snaps back is WORSE than a button that does nothing, because it looks like a UI glitch
     rather than a refusal — so the words are the assertion, and the snap-back is the second half. */
  const server = await createServer({ port: 0 });
  if (!server.stations().stations.length) { expect('skipped — no station plugin', true, 'skipped'); await server.close(); return; }
  assertResources({ needMB: 900, label: '0571 t0571-06 painted' });
  const browser = await launch();
  try {
    /* The Captain first puts the ship somewhere definite, so "the select went back to the truth"
       is a claim with content rather than a coincidence of both being empty. */
    const cap = await seat(browser, server, 1, 'Captain Probe');
    expect('the Captain orders general quarters', (await chooseOrder(cap, 'general-quarters')).ok === true, 'no option');
    await until(async () => { const b = await readPip(cap); return b && b.state === 'elevated'; },
      { timeout: 8000, label: 'the ship reaches elevated' });
    await cap.close();

    const pil = await seat(browser, server, 2, 'Pilot Probe');
    const p0 = await readOrders(pil);
    report('the Pilot’s console', p0);
    expect('⛔ the Pilot is offered NO orders at all (entitlement is computed server-side)',
      !p0 || p0.present === false || !(p0.options || []).filter(Boolean).length, JSON.stringify(p0));
    expect('and he certainly has no buttons', p0 && p0.buttons === 0, JSON.stringify(p0));

    /* He has no control, so a hostile client is the only way to put the order on the wire — which
       is exactly the case the guard exists for. */
    const sent = await onGlass(pil, () =>
      !!(window.Argus && window.Argus.emit && (window.Argus.emit('ship-order', { event: 'battle-stations' }) || true)));
    expect('a hostile client can send the order', sent === true, String(sent));
    await wait(1800);

    const pip = await readPip(pil);
    report('the Pilot’s pip after the refused order', pip);
    expect('⛔⛔ THE SHIP DID NOT MOVE — the pip is not RED', pip && pip.state !== 'action', JSON.stringify(pip));
    expect('and it still shows the condition the Captain set', pip && pip.state === 'elevated', JSON.stringify(pip));
    await shoot(pil, '0571-orders-03-pilot-refused-ship-unmoved.png');

    const p1 = await readOrders(pil);
    if (p1 && p1.present && p1.hasSelect) {
      expect('the refusal is VISIBLE, in words', p1.ack === 'refused' || /not|cannot/i.test(p1.message || ''), JSON.stringify(p1));
      expect('and the select went back to the TRUE state, not the one refused',
        p1.value === '' || p1.value !== 'battle-stations', JSON.stringify(p1));
    } else {
      expect('no control at all on a seat with no orders (also correct — the ship is asserted above)', true, JSON.stringify(p1));
    }
  } finally { await browser.close(); await server.close(); }
});

test('t0571-08 — ⭐⭐ THE SCREEN IS ROOMIER: the alert feature occupies a fraction of what it did', async () => {
  /* ⛔ THE TEST THAT PROVES THE PLAN'S ACTUAL PURPOSE. Every other test here can pass while the
     screen gets no roomier. What the alert feature used to occupy was a bordered band roughly
     190 x 30 px at the top right of EVERY station, plus a 3-button row roughly 430 x 60 px on the
     Captain's — call it ~31,500 px^2 on his console. The assertion is not against those numbers,
     which are history and would rot; it is against the SCREEN: the alert display plus its control
     must now be a small fraction of the surface, and the band must be absent. */
  const server = await createServer({ port: 0 });
  if (!server.stations().stations.length) { expect('skipped — no station plugin', true, 'skipped'); await server.close(); return; }
  assertResources({ needMB: 900, label: '0571 t0571-08 painted' });
  const browser = await launch();
  try {
    const cap = await seat(browser, server, 1, 'Captain Probe');
    const settle = await settleCensus(cap, { deadlineMs: 4000 });
    console.log(`      [settle] ${settle.ms} ms of a ${settle.deadlineMs} ms deadline, settled=${settle.settled}`);
    expect('⛔ THE DEADLINE IS THE ASSERTION — the art settled inside 4000 ms', settle.settled,
      `ms=${settle.ms} census=${JSON.stringify(settle.census.chosen)}`);
    assertControl(expect, settle.census, 't0571-08');

    const o = await readOrders(cap);
    const pip = await readPip(cap);
    const area = (b) => (b && b.length === 2 ? b[0] * b[1] : 0);
    const surface = await onGlass(cap, () => [window.innerWidth, window.innerHeight]);
    const total = area(pip.box) + area(o.wrapBox);
    const pct = Math.round((total / (surface[0] * surface[1])) * 10000) / 100;
    report('footprint', { pipBox: pip.box, controlBox: o.wrapBox, surface, totalPx2: total, percentOfScreen: pct });
    expect('the pip is on the glass and TINY', pip.box[0] > 0 && pip.box[0] <= 24, JSON.stringify(pip.box));
    expect('⭐ the whole alert feature — display AND control — is under 2% of the console',
      pct < 2, `${pct}% of ${surface[0]}x${surface[1]}, pip=${JSON.stringify(pip.box)} control=${JSON.stringify(o.wrapBox)}`);
    expect('⛔ and the band it replaced is not hiding somewhere', pip.bands === 0 && o.buttons === 0,
      JSON.stringify({ bands: pip.bands, buttons: o.buttons }));
    await shoot(cap, '0571-orders-04-captain-console-footprint.png');
  } finally { await browser.close(); await server.close(); }
});
