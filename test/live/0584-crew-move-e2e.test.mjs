/*
 * Plan 0584 — MULTI-SHIP GETS ITS CONTROLS, AND THE CONTROLS ARE CLICKED.
 *
 * ⛔⛔ THE DEFECT THIS FILE EXISTS TO CLOSE, NAMED: **OBSERVABLE IS NOT OPERABLE.** Plan 0575's own
 * painted acceptance drove EVERY multi-ship state change through `server.callPluginTool(...)`. The
 * browser watched; it never acted. That proved the model observable and never operable — and it is
 * why Bruce opened the live app on 2026-08-14 and found nothing to click, with four of five plugin
 * tools carrying no control anywhere.
 *
 * ⇒ ⭐ EVERY STATE CHANGE BELOW IS DRIVEN BY A REAL `change` EVENT ON A REAL `<select>` IN A REAL
 * BROWSER. A test that calls a plugin tool to move somebody proves nothing this file is for. Tool
 * calls appear here for exactly two things, both of which are SETUP or READ-BACK and neither of
 * which is the action under test: putting two hulls into different alert conditions so "which board
 * am I looking at" is answerable from the pixels, and reading state back to check the guard.
 *
 * ⭐ 0581 B — AND EVERY PAINTED READ CARRIES A CONTROL ELEMENT. A value-under-test cannot vouch for
 * the screen that carries it: `t0575-03p` asserted a real element with a real box and passed while
 * the station screen was blank. `assertControl` asks the whole screen to answer, and `settleCensus`
 * bounds the wait at 4000 ms WITH THE DEADLINE ITSELF AS THE ASSERTION — past it the check runs on
 * the last sample, so a screen that never settles still fails.
 *
 * ⛔ NEVER `frames().find(f => f !== mainFrame())`. A detached or stale frame answers `evaluate()`
 * with entirely plausible numbers; `glassFrames` walks the top document's own `<iframe>` elements
 * and keeps only those the human can actually see.
 *
 * NAMES: invented and obviously fictional throughout (plan 0529 §0 / guard t0531-01). The hulls come
 * from the `TWO_HULLS` fixture, which commissions what it needs rather than skipping when the
 * gitignored deployment file is absent — a test that cannot run must FAIL or COMMISSION, never pass
 * by absence.
 *
 * ⚠ RESOURCES: 6.4 GB, ZERO SWAP, 36 prior OOM kills. One browser at a time, closed before the next
 * is opened, `assertResources` before each launch.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { assertResources } from '../../harness/resources.mjs';
import { settleCensus, assertControl, glassFrames } from '../../harness/painted.mjs';
import { loadShipPluginModule, withFleet, TWO_HULLS } from '../unit/_0514-fixtures.mjs';
import { mkdirSync } from 'fs';
import { join } from 'path';

/*
 * ⭐ THE EVIDENCE. ⚠ `evidence/` is GITIGNORED and that is correct — the durable record is the
 * measured values printed below, never the PNGs.
 */
const SHOTS = process.env.PRESENTER_EVIDENCE_DIR
  || join(process.env.HOME || '/tmp', 'software', 'has-anyone-looked', 'evidence', '0584');
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

async function onGlass(page, fn, arg) {
  const gs = await glassFrames(page);
  for (const g of gs) {
    try { const v = await g.frame.evaluate(fn, arg); if (v != null) return v; }
    catch { /* torn down mid-read — try the next visible frame, never report it healthy */ }
  }
  return null;
}

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

/** The move control, read as literal DOM — geometry included, because placement is the design. */
const readMove = (p) => onGlass(p, () => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const w = document.querySelector('.ap-move');
  const sel = w ? w.querySelector('.ap-move-where') : null;
  const st = w ? w.querySelector('.ap-move-status') : null;
  return {
    present: !!w,
    hasSelect: !!sel,
    here: w ? w.getAttribute('data-here') : null,
    destinations: w ? w.getAttribute('data-destinations') : null,
    kinds: w ? w.getAttribute('data-kinds') : null,
    movers: w ? w.getAttribute('data-movers') : null,
    whoValue: w ? w.getAttribute('data-who') : null,
    movedYou: w ? w.getAttribute('data-ack-moved-you') : null,
    whoOptions: w && w.querySelector('.ap-move-who') ? [...w.querySelector('.ap-move-who').options].map((o) => o.value) : [],
    whoLabels: w && w.querySelector('.ap-move-who') ? [...w.querySelector('.ap-move-who').options].map((o) => o.textContent) : [],
    whoBox: (() => { const e = w ? w.querySelector('.ap-move-who') : null; if (!e) return null;
      const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; })(),
    options: sel ? [...sel.options].map((o) => o.value) : [],
    optionLabels: sel ? [...sel.options].map((o) => o.textContent) : [],
    optionKinds: sel ? [...sel.options].map((o) => o.getAttribute('data-kind')) : [],
    value: sel ? sel.value : null,
    ack: w ? w.getAttribute('data-ack') : null,
    reason: w ? w.getAttribute('data-ack-reason') : null,
    message: w ? w.getAttribute('data-ack-message') : null,
    statusText: st ? (st.textContent || '') : '',
    wrapBox: box(w), selectBox: box(sel), statusBox: box(st),
    // the NEIGHBOUR, because "attach, don't add" is a claim about geometry and must be measured
    ordersBox: box(document.querySelector('.ap-orders')),
    pipBox: box(document.querySelector('#apAlertPip')),
    nameBox: box(document.querySelector('#apShipName')),
    shipName: (document.querySelector('#apShipName') || {}).textContent || null,
    viewport: [window.innerWidth, window.innerHeight],
  };
});

/** ⭐ C2 — pick WHO moves, on the real roster select, with a real `change` event. */
const chooseMover = (p, personId) => onGlass(p, (id) => {
  const sel = document.querySelector('.ap-move-who');
  if (!sel) return { ok: false, why: 'no who select' };
  if (![...sel.options].some((o) => o.value === id)) {
    return { ok: false, why: 'no such mover', have: [...sel.options].map((o) => o.value) };
  }
  sel.value = id;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: sel.value };
}, personId);

/** ⭐ THE ACTION. A real value change AND a real `change` event on the real control. */
const chooseDestination = (p, placeId) => onGlass(p, (id) => {
  const sel = document.querySelector('.ap-move-where');
  if (!sel) return { ok: false, why: 'no select' };
  if (![...sel.options].some((o) => o.value === id)) {
    return { ok: false, why: 'no such destination', have: [...sel.options].map((o) => o.value) };
  }
  sel.value = id;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: sel.value };
}, placeId);

const toolResult = async (server, name, args) => {
  const r = await server.callPluginTool(name, args);
  return r && Object.prototype.hasOwnProperty.call(r, 'result') ? r.result : r;
};

test('t0584-C1 / t0584-C4 — ⭐⭐ THE CAPTAIN SWITCHES HIS OWN HULL BY CLICKING A SELECT, and the guard follows him', async () => {
  await withFleet(TWO_HULLS, async () => {
    const mod = await loadShipPluginModule('ship-machine.mjs');
    const fleet = mod.loadFleet();
    const home = fleet.ships.find((s) => s.shipId === fleet.primaryShipId) || fleet.ships[0];
    const other = fleet.ships.find((s) => s.shipId !== home.shipId);
    const server = await createServer({ port: 0 });
    let browser = null;
    try {
      if (!server.stations().stations.length) { expect('skipped — no station plugin', true, 'skipped'); return; }
      expect('⛔ two hulls are really commissioned — no silent skip below this line', !!other,
        JSON.stringify(fleet.ships.map((s) => s.shipId)));
      if (!other) return;

      /* SETUP ONLY, and it is not the action under test: the two hulls are put in DIFFERENT
         conditions so "which board am I looking at" is answerable from the pixels, not only from a
         name a client could have remembered. */
      await toolResult(server, 'ship_event', { event: 'general-quarters', shipId: home.shipId });   // YELLOW
      await toolResult(server, 'ship_event', { event: 'battle-stations', shipId: other.shipId });   // RED

      assertResources({ needMB: 900, label: '0584 C1 painted' });
      browser = await launch();
      const cap = await seat(browser, server, 1, 'Captain Probe');
      await until(() => server.presence().length >= 1, { label: 'seated' });
      const userId = server.presence()[0].userId;

      const settleBefore = await settleCensus(cap, { deadlineMs: 4000 });
      console.log(`      [settle] BEFORE ${settleBefore.ms} ms of a ${settleBefore.deadlineMs} ms deadline, settled=${settleBefore.settled}`);
      expect('⛔ THE DEADLINE IS THE ASSERTION — the art settled inside 4000 ms',
        settleBefore.settled, `ms=${settleBefore.ms} census=${JSON.stringify(settleBefore.census.chosen)}`);
      assertControl(expect, settleBefore.census, 't0584-C1 BEFORE');

      const before = await readMove(cap);
      report('the Captain’s move control', before);
      expect('⭐ THERE IS SOMETHING TO CLICK — the control is present, is a select, and is PAINTED',
        before && before.present && before.hasSelect
          && before.selectBox.w > 0 && before.selectBox.h > 0, JSON.stringify(before));
      expect('it knows where he is, from the store and not from a literal',
        before.here === home.shipId, `${before.here} vs ${home.shipId}`);
      expect('⭐ and the OTHER hull is offered as a destination, by its commissioned label',
        (before.options || []).includes(other.shipId)
          && before.optionLabels[before.options.indexOf(other.shipId)] === other.name,
        JSON.stringify({ options: before.options, labels: before.optionLabels }));
      expect('⛔ the hull he is ALREADY ON is not offered — a control whose only outcome is a refusal',
        !(before.options || []).includes(home.shipId), JSON.stringify(before.options));
      expect('and one NEUTRAL option, so the control has a resting position that is not an order',
        (before.options || []).filter((v) => v === '').length === 1, JSON.stringify(before.options));

      /* ⭐ ATTACH, DON'T ADD — asserted as GEOMETRY, because that is the only form in which the
         claim can be false. The control must sit in the header column WITH the ship name it
         changes, and it must not sit on top of the alert select that shares that column. */
      const overlap = (a, b) => !!(a && b && a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom);
      report('geometry', { move: before.wrapBox, orders: before.ordersBox, pip: before.pipBox, name: before.nameBox });
      expect('⛔⛔ THE TWO CONTROLS DO NOT OVERLAP (a percentage once put one ON TOP of the other)',
        !overlap(before.wrapBox, before.ordersBox),
        `move=${JSON.stringify(before.wrapBox)} orders=${JSON.stringify(before.ordersBox)}`);
      expect('⭐ it is in the SHIP-NAME COLUMN — same left edge as the alert pip and the order select',
        before.wrapBox.x === before.pipBox.x && before.wrapBox.x === before.ordersBox.x,
        JSON.stringify([before.wrapBox.x, before.pipBox.x, before.ordersBox.x]));
      expect('⭐ and it is SMALL — the whole control is under 2% of the console',
        (before.wrapBox.w * before.wrapBox.h) / (before.viewport[0] * before.viewport[1]) < 0.02,
        `${before.wrapBox.w}x${before.wrapBox.h} of ${before.viewport.join('x')}`);
      await shoot(cap, '0584-C1-01-captain-console-move-select-under-alert-select.png');

      /* ── ⭐⭐ THE CLICK. This is the whole plan. ────────────────────────────────────────────── */
      const chose = await chooseDestination(cap, other.shipId);
      expect('⭐⭐ THE HULL WAS CHOSEN ON A REAL SELECT — no tool call moved anybody',
        chose && chose.ok === true, JSON.stringify(chose));

      await until(async () => { const m = await readMove(cap); return m && m.here === other.shipId; },
        { timeout: 9000, label: 'the control reports him on the other hull' });

      const settleAfter = await settleCensus(cap, { deadlineMs: 4000 });
      console.log(`      [settle] AFTER ${settleAfter.ms} ms of a ${settleAfter.deadlineMs} ms deadline, settled=${settleAfter.settled}`);
      expect(`⭐ the art SETTLED within the ${settleAfter.deadlineMs} ms deadline (took ${settleAfter.ms} ms) — the deadline IS the invariant`,
        settleAfter.settled === true,
        JSON.stringify(settleAfter.census.chosen && settleAfter.census.chosen.chromeDetail));
      const controlOk = assertControl(expect, settleAfter.census, 't0584-C1 AFTER');
      if (!controlOk) await shoot(cap, '0584-C1-CONTROL-FAILED.png');

      const after = await readMove(cap);
      const board = settleAfter.census.chosen;
      report('after the click', { move: after, board: board && { shipName: board.shipName, alert: board.alert, alertLabel: board.alertLabel, nameBox: board.nameBox, pipBox: board.pipBox } });
      await shoot(cap, '0584-C1-02-same-seat-now-on-the-other-hull-RED.png');

      /* ⭐⭐ THE SEAT RE-DRESSED ITSELF. 0575 needed `server.stationSet(...)` to make this happen;
         the control now asks for its own redraw over core's self-scoped `station-show`. */
      expect('⭐⭐ THE SAME SCREEN NOW WEARS THE OTHER HULL’S NAME',
        board && board.shipName === other.name && board.shipName !== home.name,
        `${home.name} -> ${board && board.shipName}`);
      expect('⭐⭐ AND SHOWS THE OTHER HULL’S CONDITION (RED), not the one he left (YELLOW)',
        board && board.alert === 'action' && board.alertLabel === 'RED', JSON.stringify(board && { alert: board.alert, label: board.alertLabel }));
      expect('⛔ NON-ZERO BOUNDING BOXES on the name and on the pip',
        board && board.nameBox[0] > 0 && board.nameBox[1] > 0 && board.pipBox[0] > 0 && board.pipBox[1] > 0,
        JSON.stringify([board && board.nameBox, board && board.pipBox]));
      expect('the control now offers the hull he LEFT, and no longer the one he is on',
        (after.options || []).includes(home.shipId) && !(after.options || []).includes(other.shipId),
        JSON.stringify(after.options));

      /* ⭐ HE KEPT HIS STATION. 0581 C's ruling: a crew keeps the station it was on, on the new
         hull — `seatOnArrival`, and it still answers null for a place with no stations. */
      const person = server.store.get(`people/${userId}`);
      report('the person record', person);
      expect('⭐ he is on the other hull in the PERSON registry — the single source of that fact',
        person && String(person.placeId) === String(other.shipId), JSON.stringify(person));
      expect('⭐ and he KEPT HIS STATION across the move (0581 C — a crew keeps its seat on a new hull)',
        person && person.stationUid === 1, JSON.stringify(person));

      /*
       * ── t0584-C4 — ⛔ THE AUTHORITY CONSEQUENCE, TESTED RATHER THAN ASSUMED ────────────────
       * Phase 4's guard follows the PERSON'S PLACE, so switching hull must lose him command of the
       * one he left and gain it on the one he joined. Both halves are asserted: a guard that
       * refused everything would pass the first on its own.
       */
      const st = await loadShipPluginModule('seat-authority.mjs');
      const left = server.store.get(`${mod.shipNs(home.shipId)}/alert`);
      const joinedBefore = server.store.get(`${mod.shipNs(other.shipId)}/alert`);

      /* ⛔ ADDRESSED TO THE HULL HE LEFT — the exact `not-your-ship` case (t0575-04). Driven from
         the browser, because a guard that has only been exercised in-process is a gate nobody has
         seen fail from the outside. */
      const forged = await onGlass(cap, (id) =>
        !!(window.Argus && window.Argus.emit
           && (window.Argus.emit('ship-order', { event: 'stand-down', shipId: id }) || true)), home.shipId);
      expect('the forged order reached the wire', forged === true, String(forged));
      await wait(2000);
      const leftAfter = server.store.get(`${mod.shipNs(home.shipId)}/alert`);
      report('the hull he left', { before: left, after: leftAfter });
      expect('⛔⛔ t0584-C4 — THE HULL HE LEFT DID NOT MOVE: the guard refused `not-your-ship`',
        leftAfter === left && leftAfter === 'elevated', `${left} -> ${leftAfter}`);
      expect('and REFUSAL is the module’s own named reason, not a string this test invented',
        st.REFUSAL.NOT_YOUR_SHIP === 'not-your-ship', JSON.stringify(st.REFUSAL));

      /* ⭐ AND THE OTHER HALF: he DOES command the hull he joined, from the same seat. */
      const commanded = await onGlass(cap, () => {
        const sel = document.querySelector('.ap-orders-select');
        if (!sel) return { ok: false, why: 'no order select' };
        if (![...sel.options].some((o) => o.value === 'stand-down')) return { ok: false, have: [...sel.options].map((o) => o.value) };
        sel.value = 'stand-down';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      });
      expect('he still has an order control on the new hull', commanded && commanded.ok === true, JSON.stringify(commanded));
      await until(() => server.store.get(`${mod.shipNs(other.shipId)}/alert`) === 'normal',
        { timeout: 9000, label: 'the hull he JOINED obeys him' });
      const joinedAfter = server.store.get(`${mod.shipNs(other.shipId)}/alert`);
      report('the hull he joined', { before: joinedBefore, after: joinedAfter });
      expect('⭐ t0584-C4 — AND HE COMMANDS THE HULL HE JOINED, from the same seat (place, not identity)',
        joinedAfter === 'normal' && joinedBefore === 'action', `${joinedBefore} -> ${joinedAfter}`);
      await shoot(cap, '0584-C1-03-guard-follows-him-old-hull-unmoved.png');
    } finally { if (browser) await browser.close(); await server.close(); }
  });
});

test('t0584-C1b — ⛔ A SEAT THAT MAY NOT MOVE PEOPLE GETS NO CONTROL, and a hostile client is refused IN WORDS', async () => {
  /* Two claims, and the second is the one that matters. "No control" is cheap to get right and
     proves nothing about the server: the entitlement is computed server-side, so the check that
     counts is what happens when a client sends the message anyway. 0565's bar — the failure being
     guarded is not "the wrong person moved the crew", it is "the wrong person acted, nothing
     happened, and nothing said why". */
  await withFleet(TWO_HULLS, async () => {
    const mod = await loadShipPluginModule('ship-machine.mjs');
    const fleet = mod.loadFleet();
    const home = fleet.ships.find((s) => s.shipId === fleet.primaryShipId) || fleet.ships[0];
    const other = fleet.ships.find((s) => s.shipId !== home.shipId);
    const server = await createServer({ port: 0 });
    let browser = null;
    try {
      if (!server.stations().stations.length) { expect('skipped — no station plugin', true, 'skipped'); return; }
      assertResources({ needMB: 900, label: '0584 C1b painted' });
      browser = await launch();
      const pil = await seat(browser, server, 2, 'Pilot Probe');       // uid 2 is not the Captain
      await until(() => server.presence().length >= 1, { label: 'seated' });
      const userId = server.presence()[0].userId;

      const settle = await settleCensus(pil, { deadlineMs: 4000 });
      console.log(`      [settle] ${settle.ms} ms of a ${settle.deadlineMs} ms deadline, settled=${settle.settled}`);
      expect('⛔ THE DEADLINE IS THE ASSERTION — the art settled inside 4000 ms', settle.settled,
        `ms=${settle.ms} census=${JSON.stringify(settle.census.chosen)}`);
      assertControl(expect, settle.census, 't0584-C1b');

      const m0 = await readMove(pil);
      report('the Pilot’s console', m0);
      expect('⛔ the Pilot is offered NO move control at all (entitlement is computed server-side)',
        !m0 || m0.present === false, JSON.stringify(m0));

      const wasAt = server.store.get(`people/${userId}`);
      const sent = await onGlass(pil, (id) =>
        !!(window.Argus && window.Argus.emit
           && (window.Argus.emit('ship-move', { toPlaceId: id }) || true)), other.shipId);
      expect('a hostile client can put the move on the wire', sent === true, String(sent));
      await wait(2000);

      const nowAt = server.store.get(`people/${userId}`);
      report('the Pilot’s person record', { before: wasAt, after: nowAt });
      expect('⛔⛔ HE DID NOT MOVE — the seat guard refused a message no control of his could send',
        nowAt && String(nowAt.placeId) === String(home.shipId), JSON.stringify(nowAt));

      /* ⛔ AND THE REFUSAL SPEAKS. It is written where his console would be listening, with the
         action named so the alert select cannot mistake it for a verdict of its own. */
      const ack = server.store.get(`${mod.shipNs(home.shipId)}/ack/${userId}`);
      report('the refusal', ack);
      expect('⛔ THE DENY SPEAKS — a reason and a MESSAGE IN WORDS, not silence',
        ack && ack.ok === false && typeof ack.message === 'string' && /\S/.test(ack.message),
        JSON.stringify(ack));
      expect('and it is tagged with the ACTION, so the alert select does not display it',
        ack && ack.action === mod.MOVE_EVENT, JSON.stringify(ack));
      await shoot(pil, '0584-C1b-pilot-has-no-move-control-and-did-not-move.png');
    } finally { if (browser) await browser.close(); await server.close(); }
  });
});

test('t0584-C2 — ⭐⭐ THE ROSTER SELECT SENDS A CREWMATE TO THE OTHER HULL, and the mover keeps their station', async () => {
  /*
   * C2, driven by a real click on a real control. ⭐ THE SECOND CLAIM IS THE INTERESTING ONE: the
   * person who is sent KEEPS THEIR STATION on the destination hull (0581 C — `seatOnArrival`), so
   * `t0581-C1`'s invariant now has a REACHABLE path through it instead of only a unit test.
   *
   * ⛔ AND THE OPERATOR IS NOT MOVED. Sending a crewmate must not re-dress the sender's own screen:
   * the server answers `movedYou:false` and the console leaves its frame alone — which is also the
   * only reason the verdict survives long enough to be read (an accepted SELF move tears the frame
   * down and wipes it).
   */
  await withFleet(TWO_HULLS, async () => {
    const mod = await loadShipPluginModule('ship-machine.mjs');
    const fleet = mod.loadFleet();
    const home = fleet.ships.find((s) => s.shipId === fleet.primaryShipId) || fleet.ships[0];
    const other = fleet.ships.find((s) => s.shipId !== home.shipId);
    const server = await createServer({ port: 0 });
    let browser = null;
    try {
      if (!server.stations().stations.length) { expect('skipped — no station plugin', true, 'skipped'); return; }
      expect('⛔ two hulls are really commissioned', !!other, JSON.stringify(fleet.ships.map((s) => s.shipId)));
      if (!other) return;
      assertResources({ needMB: 900, label: '0584 C2 painted' });
      browser = await launch();

      /* TWO REAL SEATS. The crewmate has to exist as a person before anybody can be offered them,
         and a person exists here by SITTING DOWN — which is the same path a real player takes. */
      const cap = await seat(browser, server, 1, 'Captain Probe');
      const eng = await seat(browser, server, 7, 'Engineer Probe');
      await until(() => server.presence().length >= 2, { label: 'two seats' });
      const ids = server.presence().map((p) => p.userId);
      const capId = ids.find((i) => /captain/i.test(i)) || ids[0];
      const engId = ids.find((i) => i !== capId);
      report('the two seats', { capId, engId });

      const settle = await settleCensus(cap, { deadlineMs: 4000 });
      console.log(`      [settle] ${settle.ms} ms of a ${settle.deadlineMs} ms deadline, settled=${settle.settled}`);
      expect('⛔ THE DEADLINE IS THE ASSERTION — the art settled inside 4000 ms', settle.settled,
        `ms=${settle.ms} census=${JSON.stringify(settle.census.chosen)}`);
      assertControl(expect, settle.census, 't0584-C2');

      await until(async () => { const m = await readMove(cap); return m && (m.whoOptions || []).includes(engId); },
        { timeout: 9000, label: 'the crewmate appears on the roster select' });

      const before = await readMove(cap);
      report('the roster select', { movers: before.movers, whoOptions: before.whoOptions, whoLabels: before.whoLabels, whoBox: before.whoBox, wrapBox: before.wrapBox });
      expect('⭐ the roster select is PAINTED with a non-zero box',
        before.whoBox && before.whoBox.w > 0 && before.whoBox.h > 0, JSON.stringify(before.whoBox));
      expect('⭐ it offers ME, ALL, and the crewmate who is actually here',
        (before.whoOptions || []).includes('me') && (before.whoOptions || []).includes('all')
          && (before.whoOptions || []).includes(engId), JSON.stringify(before.whoOptions));
      expect('and it defaults to ME — C1 is the common case and stays one click',
        before.whoValue === 'me', String(before.whoValue));
      expect('⛔ still no overlap with the alert control above it, now that the row has two selects',
        before.wrapBox.y > before.ordersBox.bottom,
        `move.y=${before.wrapBox.y} orders.bottom=${before.ordersBox.bottom}`);
      expect('⭐ and the whole control is STILL under 2% of the console',
        (before.wrapBox.w * before.wrapBox.h) / (before.viewport[0] * before.viewport[1]) < 0.02,
        `${before.wrapBox.w}x${before.wrapBox.h} of ${before.viewport.join('x')}`);
      await shoot(cap, '0584-C2-01-roster-select-offers-the-crewmate.png');

      const engBefore = server.store.get(`people/${engId}`);
      report('the crewmate before', engBefore);

      /* ── ⭐⭐ TWO REAL CLICKS: pick the mover, then pick the destination ───────────────────── */
      const pickedWho = await chooseMover(cap, engId);
      expect('⭐ the mover was chosen on a REAL select', pickedWho && pickedWho.ok === true, JSON.stringify(pickedWho));
      const pickedWhere = await chooseDestination(cap, other.shipId);
      expect('⭐⭐ and the destination on a REAL select — no tool call moved anybody',
        pickedWhere && pickedWhere.ok === true, JSON.stringify(pickedWhere));

      await until(() => {
        const p = server.store.get(`people/${engId}`);
        return p && String(p.placeId) === String(other.shipId);
      }, { timeout: 9000, label: 'the crewmate lands on the other hull' });

      const engAfter = server.store.get(`people/${engId}`);
      const capAfter = server.store.get(`people/${capId}`);
      report('the crewmate after', engAfter);
      report('the sender after', capAfter);
      expect('⭐⭐ THE CREWMATE IS ON THE OTHER HULL', String(engAfter.placeId) === String(other.shipId),
        `${engBefore.placeId} -> ${engAfter.placeId}`);
      expect('⭐ AND KEPT THEIR STATION across the move — t0581-C1, now reachable by a click',
        engAfter.stationUid === engBefore.stationUid && engAfter.stationUid === 7,
        JSON.stringify({ before: engBefore.stationUid, after: engAfter.stationUid }));
      expect('⛔ THE SENDER DID NOT MOVE — this is a roster action, not a crew action',
        String(capAfter.placeId) === String(home.shipId), JSON.stringify(capAfter));

      /* ⛔ AND THE VERDICT SPEAKS, ON THE SENDER'S OWN SCREEN. It survives here precisely because
         `movedYou` was false and the frame was therefore left alone. */
      await until(async () => { const m = await readMove(cap); return m && m.ack; },
        { timeout: 9000, label: 'the sender gets a verdict' });
      const after = await readMove(cap);
      report('the sender’s verdict', { ack: after.ack, reason: after.reason, message: after.message, movedYou: after.movedYou, statusText: after.statusText, statusBox: after.statusBox });
      expect('⭐ ACCEPTED, IN WORDS, on the console that asked', after.ack === 'ok' && /\S/.test(after.statusText),
        JSON.stringify({ ack: after.ack, statusText: after.statusText }));
      expect('⛔ and the server said the SENDER was not among the movers, so his frame was left alone',
        after.movedYou === '0', String(after.movedYou));
      expect('the sender’s own board still wears his hull’s name', after.shipName === home.name,
        `${after.shipName} vs ${home.name}`);
      expect('and the crewmate has left the sender’s roster select',
        !(after.whoOptions || []).includes(engId), JSON.stringify(after.whoOptions));
      await shoot(cap, '0584-C2-02-crewmate-sent-verdict-in-words-sender-unmoved.png');

      /* ⛔ THE OTHER HALF OF THE ROSTER GUARD: a person who is NOT here cannot be moved, even
         though naming them is a one-word edit to a message a hostile client writes. */
      const forged = await onGlass(cap, (a) =>
        !!(window.Argus && window.Argus.emit
           && (window.Argus.emit('ship-move', { toPlaceId: a.to, who: a.who }) || true)),
        { to: home.shipId, who: engId });
      expect('the forged move reached the wire', forged === true, String(forged));
      await wait(2000);
      const engStill = server.store.get(`people/${engId}`);
      const ack = server.store.get(`${mod.shipNs(home.shipId)}/ack/${capId}`);
      report('the refused remote move', { person: engStill.placeId, ack });
      expect('⛔⛔ A PERSON WHO IS NOT HERE IS NOT MOVED — `who` is not a remote teleport',
        String(engStill.placeId) === String(other.shipId), JSON.stringify(engStill));
      expect('⛔ and the refusal SPEAKS, with the action named', ack && ack.ok === false
        && ack.action === mod.MOVE_EVENT && /\S/.test(ack.message || ''), JSON.stringify(ack));
      await eng.close();
    } finally { if (browser) await browser.close(); await server.close(); }
  });
});

/*
 * ⭐ C3's fleet. `TWO_HULLS` already carries one `world`; an `eva` point is added HERE rather than
 * in the shared fixture, because widening a fixture other tests assert against is how one test's
 * setup becomes another test's surprise. ⛔ Both are invented and obviously fictional (t0531-01).
 */
const FLEET_WITH_PLACES = {
  ships: TWO_HULLS.ships,
  places: [...TWO_HULLS.places, { placeId: 'eva-point', kind: 'eva', label: 'EVA POINT' }],
};

test('t0584-C3 — ⭐⭐ THE AWAY PARTY: a world and an EVA point are in the same dropdown, and landing there takes the seat', async () => {
  /*
   * ⭐ THE WHOLE OF C3 IS THE KINDS LIST. 0575 §2 promised that "away parties, boarding and
   * spacewalks need no new machinery, only new place records" — so redeeming it DELETED a list
   * (`['ship']` became `PLACE_KINDS`) instead of adding a feature. This test is what makes that
   * claim checkable: the same control, the same click, a destination that is not a ship.
   *
   * ⛔ AND THE SECOND HALF IS THE ONE THAT MATTERS. `people.moveTo`: "a remembered seat is how
   * someone on a beach keeps a Gunner's authority." Landing on a world must take the stationUid
   * AND the authority that came with it, and both are asserted from a real click.
   */
  await withFleet(FLEET_WITH_PLACES, async () => {
    const mod = await loadShipPluginModule('ship-machine.mjs');
    const places = await loadShipPluginModule('places.mjs');
    const fleet = mod.loadFleet();
    const home = fleet.ships.find((s) => s.shipId === fleet.primaryShipId) || fleet.ships[0];
    const world = FLEET_WITH_PLACES.places.find((p) => p.kind === 'world');
    const eva = FLEET_WITH_PLACES.places.find((p) => p.kind === 'eva');
    const server = await createServer({ port: 0 });
    let browser = null;
    try {
      if (!server.stations().stations.length) { expect('skipped — no station plugin', true, 'skipped'); return; }
      assertResources({ needMB: 900, label: '0584 C3 painted' });
      browser = await launch();
      const cap = await seat(browser, server, 1, 'Captain Probe');
      await until(() => server.presence().length >= 1, { label: 'seated' });
      const userId = server.presence()[0].userId;

      const settle = await settleCensus(cap, { deadlineMs: 4000 });
      console.log(`      [settle] ${settle.ms} ms of a ${settle.deadlineMs} ms deadline, settled=${settle.settled}`);
      expect('⛔ THE DEADLINE IS THE ASSERTION — the art settled inside 4000 ms', settle.settled,
        `ms=${settle.ms} census=${JSON.stringify(settle.census.chosen)}`);
      assertControl(expect, settle.census, 't0584-C3');

      await until(async () => { const m = await readMove(cap); return m && (m.options || []).includes(world.placeId); },
        { timeout: 9000, label: 'the world reaches the destination list' });

      const before = await readMove(cap);
      report('the destination list', { kinds: before.kinds, destinations: before.destinations,
        options: before.options, labels: before.optionLabels, optionKinds: before.optionKinds });
      expect('⭐⭐ A WORLD AND AN EVA POINT ARE IN THE SAME DROPDOWN AS THE OTHER HULL',
        (before.options || []).includes(world.placeId) && (before.options || []).includes(eva.placeId),
        JSON.stringify(before.options));
      expect('and they carry their KIND, so the list is the registry’s and not a literal here',
        before.optionKinds[before.options.indexOf(world.placeId)] === 'world'
          && before.optionKinds[before.options.indexOf(eva.placeId)] === 'eva',
        JSON.stringify({ options: before.options, kinds: before.optionKinds }));
      expect('⭐ the entitlement names EVERY declared kind — one closed list, in places.mjs',
        (before.kinds || '').split(',').sort().join(',') === [...places.PLACE_KINDS].sort().join(','),
        `${before.kinds} vs ${JSON.stringify(places.PLACE_KINDS)}`);
      expect('and they are labelled by the deployment, not by a word this plugin knows',
        before.optionLabels[before.options.indexOf(world.placeId)] === world.label,
        JSON.stringify(before.optionLabels));
      await shoot(cap, '0584-C3-01-destination-list-has-a-world-and-an-eva-point.png');

      const wasSeated = server.store.get(`people/${userId}`);
      report('before going ashore', wasSeated);
      expect('he starts aboard, at a station', wasSeated && String(wasSeated.placeId) === String(home.shipId)
        && wasSeated.stationUid === 1, JSON.stringify(wasSeated));

      /* ── ⭐⭐ ONE REAL CLICK, ONTO A PLACE THAT IS NOT A SHIP ─────────────────────────────── */
      const chose = await chooseDestination(cap, world.placeId);
      expect('⭐⭐ THE WORLD WAS CHOSEN ON THE SAME REAL SELECT — no new control, no tool call',
        chose && chose.ok === true, JSON.stringify(chose));

      await until(() => {
        const p = server.store.get(`people/${userId}`);
        return p && String(p.placeId) === String(world.placeId);
      }, { timeout: 9000, label: 'he lands on the world' });

      const ashore = server.store.get(`people/${userId}`);
      report('ashore', ashore);
      expect('⭐⭐ HE IS ON THE WORLD', String(ashore.placeId) === String(world.placeId), JSON.stringify(ashore));
      expect('⛔⛔ AND HE HAS NO STATION — a stationUid is meaningless off the hull it belongs to',
        ashore.stationUid === null, JSON.stringify({ was: wasSeated.stationUid, now: ashore.stationUid }));
      expect('the place he is on is really a non-ship kind, from the registry',
        server.store.get(`places/${world.placeId}`).hasStations === false,
        JSON.stringify(server.store.get(`places/${world.placeId}`)));

      /* ⛔ AND THE AUTHORITY WENT WITH THE SEAT. This is t0575-04e reached by a click: he was
         commanding that hull one action ago, and from a beach he commands nothing. */
      const alertWas = server.store.get(`${mod.shipNs(home.shipId)}/alert`);
      const forged = await onGlass(cap, (id) =>
        !!(window.Argus && window.Argus.emit
           && (window.Argus.emit('ship-order', { event: 'battle-stations', shipId: id }) || true)), home.shipId);
      expect('the order reached the wire from the beach', forged === true, String(forged));
      await wait(2000);
      const alertNow = server.store.get(`${mod.shipNs(home.shipId)}/alert`);
      report('the hull he left', { before: alertWas, after: alertNow });
      expect('⛔⛔ THE SHIP DOES NOT OBEY A MAN ON A BEACH — the seat went, so the authority went',
        alertNow === alertWas, `${alertWas} -> ${alertNow}`);
      await shoot(cap, '0584-C3-02-ashore-no-station-no-authority.png');

      /*
       * ⛔⛔ THE LIMIT, FOUND BY THIS TEST AND ASSERTED RATHER THAN PAPERED OVER.
       *
       * This block was first written as *"and he can come back on the same control"* — because an
       * away party is a round trip or it is a one-way door, and a one-way door is a bug nobody
       * notices until a session. It FAILED, and the failure is real and structural:
       *
       *   ⭐ ENTITLEMENT IS A PROPERTY OF A STATION, AND A BEACH HAS NO STATIONS. Off-ship the
       *     person holds no stationUid (asserted above), so the seat resolver falls back to the
       *     deployment default, `movesFor(default)` is empty, and NO CONTROL RENDERS. It is not a
       *     missing widget: the guard refuses at the server too, `not-aboard`, because
       *     seat-authority's step 3 asks whether the actor is aboard THIS hull and nobody on a
       *     world is aboard any of them.
       *
       * ⇒ AS BUILT, GOING ASHORE IS ONE-WAY FROM THE CONSOLE. The way back is the operator's
       *   `ship_move_crew`, which is a documented route and not a workaround — but it is a REAL
       *   BOUNDARY of the away party and it belongs in a test, not in a report nobody re-reads.
       *   ⚠ Left for a follow-on plan to rule on: whether a person with no seat may walk back to
       *   their own ship is a question about AUTHORITY, and inventing an answer here would be a
       *   second authority path, which 0575 §3 forbids.
       *
       * ⭐ THE TOOL CALL BELOW IS THE SUBJECT OF THE ASSERTION, NOT A SUBSTITUTE FOR A CLICK. What
       *   is being proved is precisely that the operator route is the only one left.
       */
      const stranded = await readMove(cap);
      report('the console on the beach', { present: stranded.present, here: stranded.here,
        options: stranded.options, station: stranded.shipName });
      expect('⛔⛔ ONE-WAY: off-ship there is no seat, so there is NO MOVE CONTROL at all',
        stranded.present === false, JSON.stringify(stranded));

      const forgedBack = await onGlass(cap, (id) =>
        !!(window.Argus && window.Argus.emit
           && (window.Argus.emit('ship-move', { toPlaceId: id }) || true)), home.shipId);
      expect('the move reached the wire from the beach', forgedBack === true, String(forgedBack));
      await wait(2000);
      const stillAshore = server.store.get(`people/${userId}`);
      const beachAck = server.store.get(`${mod.shipNs(home.shipId)}/ack/${userId}`);
      report('the refused walk home', { placeId: stillAshore.placeId, ack: beachAck });
      expect('⛔ and the SERVER refuses it too — this is a guard, not a missing widget',
        String(stillAshore.placeId) === String(world.placeId), JSON.stringify(stillAshore));
      expect('⛔ THE DENY SPEAKS, and names the reason the guard actually used',
        beachAck && beachAck.ok === false && beachAck.reason === 'not-aboard'
          && /\S/.test(beachAck.message || '') && beachAck.action === mod.MOVE_EVENT,
        JSON.stringify(beachAck));

      /* ⭐ THE OPERATOR'S ROUTE IS THE WAY BACK, and it is the SAME `moveCrew` loop the control
         drives — one code path, reached from the other end. */
      const rescued = await toolResult(server, 'ship_move_crew',
        { toPlaceId: home.shipId, fromPlaceId: world.placeId });
      report('the operator brings him back', rescued);
      const aboard = server.store.get(`people/${userId}`);
      report('back aboard', aboard);
      expect('⭐ the operator route brings him back', String(aboard.placeId) === String(home.shipId),
        JSON.stringify(aboard));
      expect('⛔ AND HE DOES NOT GET HIS OLD SEAT BACK — he left without one, so he arrives at the '
        + 'deployment default (0581 C: `seatOnArrival` carries a seat, it does not remember one)',
        aboard.stationUid === server.stations().stationDefaultUid,
        JSON.stringify({ now: aboard.stationUid, default: server.stations().stationDefaultUid }));

      const settleBack = await settleCensus(cap, { deadlineMs: 4000 });
      console.log(`      [settle] BACK ${settleBack.ms} ms of a ${settleBack.deadlineMs} ms deadline, settled=${settleBack.settled}`);
      expect(`⭐ the art SETTLED within the ${settleBack.deadlineMs} ms deadline (took ${settleBack.ms} ms)`,
        settleBack.settled === true, JSON.stringify(settleBack.census.chosen && settleBack.census.chosen.chromeDetail));
      assertControl(expect, settleBack.census, 't0584-C3 BACK');
      report('the board he came back to', settleBack.census.chosen && { shipName: settleBack.census.chosen.shipName, alert: settleBack.census.chosen.alert });
      await shoot(cap, '0584-C3-03-back-aboard-via-operator-route.png');
    } finally { if (browser) await browser.close(); await server.close(); }
  });
});
