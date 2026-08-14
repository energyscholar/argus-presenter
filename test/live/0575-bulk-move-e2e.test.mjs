/*
 * Plan 0575 PHASE 6 — THE CREW CHANGES SHIP, AND THE GLASS FOLLOWS.
 *
 * §5's plumbing trace for this phase is "move → occupancy → all stations re-dress". This test walks
 * exactly that, in a real browser: a real seat on hull A, a real `ship_move_crew`, and then the
 * SAME screen wearing hull B's name and hull B's alert condition.
 *
 * ⚠ A BOUNDARY, FOUND AND REPORTED RATHER THAN WORKED AROUND. The plugin registration context
 * (app/server.mjs `pluginContext`) offers {store, allowRead, on, emit, log, addTool, stations,
 * surfaces, provideSeatResolver} and NOTHING that re-renders a seated client's screen. So a moved
 * crew does not re-dress by itself; it re-dresses on the next SEAT RESOLUTION — a reconnect, the
 * player's own "show my station", or the operator's `stationSet`. That is a real gap and the plan
 * already fences the UI half of it: §7 puts the SWITCH SHIPS dropdown (0574 N1) out of scope.
 *
 * ⭐ SO THIS TEST DRIVES THE RE-DRESS THROUGH AN EXISTING, GATED CORE PATH (`stationSet`, plan 0522
 * P14) rather than inventing a push. What it proves is the part phase 6 owns: after the move, the
 * seat resolves to the OTHER HULL and the screen shows it. Inventing a mechanism to make the
 * screenshot prettier would have been exactly the fake painted check the brief forbids.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { assertResources } from '../../harness/resources.mjs';
import { stationCensus, assertControl } from '../../harness/painted.mjs';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadShipPluginModule, SHIP_ID } from '../unit/_0514-fixtures.mjs';

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

const toolResult = async (server, name, args) => {
  const r = await server.callPluginTool(name, args);
  return r && Object.prototype.hasOwnProperty.call(r, 'result') ? r.result : r;
};

async function seat(browser, server, uid, name) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 800 });
  await p.goto(`${server.url()}/?stationUID=${uid}&n=${encodeURIComponent(name)}`, { waitUntil: 'domcontentloaded' });
  await wait(1200);
  await p.evaluate(() => document.getElementById('cfg-station')?.click());
  await wait(1500);
  return p;
}

/*
 * ⛔ 0581 PHASE B — THIS USED TO BE `p.frames().find(f => f !== p.mainFrame())`.
 * That takes the first frame that is not the top one, which is not a claim about the glass. Two
 * measured consequences, both of which this test suffered: re-resolving the seat TEARS THE FRAME
 * DOWN and builds a new one, so the read either lands on a stale frame and returns plausible
 * numbers for a screen nobody is looking at, or lands mid-teardown and throws `Execution context
 * was destroyed`. The census walks the TOP document's own `<iframe>` elements, keeps only those
 * with a non-zero box, and skips any that vanish mid-read — so a torn-down frame comes back
 * MISSING and `until(...)` retries, instead of coming back healthy.
 */
const boardOf = async (p) => {
  const c = (await stationCensus(p)).chosen;
  return c ? { shipName: c.shipName, nameBox: c.nameBox, alert: c.alert, alertLabel: c.alertLabel, alertBox: c.bandBox } : null;
};

test('t0575-03p — ⭐⭐ THE CREW CHANGES SHIP AND THE STATION RE-DRESSES TO THE NEW HULL', async () => {
  const mod = await loadShipPluginModule('ship-machine.mjs');
  const fleet = mod.loadFleet();
  const other = fleet.ships.find((s) => s.shipId !== SHIP_ID);
  const server = await createServer({ port: 0 });
  let browser = null;
  try {
    if (!server.stations().stations.length) { expect('skipped — no station plugin', true, 'skipped'); return; }
    if (!other) { expect(`this deployment declares ${fleet.ships.length} hull(s) — commission a second to exercise t0575-03p`, true, 'reported'); return; }
    const home = fleet.ships.find((s) => s.shipId === SHIP_ID) || fleet.ships[0];

    // Put the two hulls in DIFFERENT conditions, so "which board am I looking at" is answerable
    // from the pixels alone and not only from a name.
    await toolResult(server, 'ship_event', { event: 'general-quarters', shipId: home.shipId });   // YELLOW
    await toolResult(server, 'ship_event', { event: 'battle-stations', shipId: other.shipId });   // RED

    assertResources({ needMB: 900, label: '0575 P6 painted move' });
    browser = await launch();
    const pil = await seat(browser, server, 2, 'Pilot Probe');
    await until(() => server.presence().length >= 1, { label: 'seated' });
    await until(async () => { const b = await boardOf(pil); return b && b.alert === 'elevated'; },
      { timeout: 8000, label: 'the home hull’s condition reaches the seat' });

    const before = await boardOf(pil);
    const censusBefore = await stationCensus(pil);
    console.log(`      [painted] BEFORE the move ${JSON.stringify(before)}`);
    console.log(`      [census] BEFORE ${JSON.stringify(censusBefore.frames)}`);
    /* ⭐ t0581-B1 — the control element, BEFORE as well as after. Asserting it only on the state
       under test would leave "was the screen ever there" unanswered, and a control that has only
       been seen in one state is the same untested gate this phase exists to retire. */
    assertControl(expect, censusBefore, 'BEFORE');
    expect('the seat is on the home hull, wearing its name', before.shipName === home.name, `${before.shipName} vs ${home.name}`);
    expect('and showing ITS condition (YELLOW)', before.alert === 'elevated' && before.alertLabel === 'YELLOW', JSON.stringify(before));
    await shoot(pil, 'p6-BEFORE-move-seat-on-home-hull-YELLOW.png');

    // ── ⭐⭐ EVERYONE MOVES — the exposed tool, the loop over people ────────────────────────
    const userId = server.presence()[0].userId;
    const res = await toolResult(server, 'ship_move_crew', { toPlaceId: other.shipId });
    console.log(`      [move] ${JSON.stringify(res)}`);
    expect('the crew moved', res.ok === true && res.moved.length >= 1, JSON.stringify(res));
    expect('and the seated player is among them', res.moved.some((m) => m.personId === userId), JSON.stringify(res.moved));

    /* ⚠ THE RE-DRESS NEEDS A SEAT RESOLUTION — see this file's header. `stationSet` is the existing
       gated core path (0522 P14); no new mechanism was invented for the sake of the screenshot. */
    const set = server.stationSet(userId, 2);
    expect('the seat was re-resolved and delivered to a real socket', set.ok === true && set.delivered >= 1, JSON.stringify(set));
    await until(async () => { const b = await boardOf(pil); return b && b.alert === 'action'; },
      { timeout: 9000, label: 'the NEW hull’s condition reaches the same screen' });

    const after = await boardOf(pil);
    const censusAfter = await stationCensus(pil);
    console.log(`      [painted] AFTER the move ${JSON.stringify(after)}`);
    console.log(`      [census] AFTER ${JSON.stringify(censusAfter.frames)}`);
    await shoot(pil, 'p6-AFTER-move-same-seat-now-on-other-hull-RED.png');

    /* ⭐⭐ t0581-B1, ON THE STATE THAT LIED. Everything below this line was already true on
       2026-08-13 while the screenshot showed a hex background, a role chip and an alert band and
       NOTHING ELSE. The control element is what separates "the value is right" from "the value is
       right and the screen is gone". */
    const controlOk = assertControl(expect, censusAfter, 'AFTER');
    // ⛔ A missing frame must FAIL here, never throw a TypeError two lines down and be read as an
    // infrastructure problem. `boardOf` can honestly return null, so say so as an assertion.
    if (!after) { expect('AFTER: a visible frame answered at all', false, JSON.stringify(censusAfter.frames)); return; }

    /*
     * ⛔ NOT A FIX. The brief allows ZERO fix attempts on a painted-gate failure, so nothing below
     * changes what is asserted or when. This MEASURES how long the art takes to settle and shoots
     * it again, so the failure arrives with a number and a second image instead of an opinion.
     * ⭐ The measurement is the deliverable — see the settle line and the two screenshots.
     */
    if (!controlOk) {
      const t0 = Date.now();
      let settled = null, last = null;
      while (Date.now() - t0 < 8000) {
        const c = (await stationCensus(pil)).chosen;
        last = c;
        if (c && c.textOpacity && c.textOpacity[1] >= 0.9 && c.visibleChrome >= 3) { settled = Date.now() - t0; break; }
        await wait(200);
      }
      console.log(`      [settle] the art reached the control bar ${settled === null ? 'NEVER within 8000ms' : `after ${settled}ms`}; last=${JSON.stringify(last && last.chromeDetail)}`);
      await shoot(pil, 'p6-AFTER-move-CONTROL-FAILED-then-settled.png');
    }

    expect('⭐⭐ THE SAME SCREEN NOW WEARS THE OTHER HULL’S NAME',
      after.shipName === other.name && after.shipName !== before.shipName,
      `${before.shipName} -> ${after.shipName}`);
    expect('⭐⭐ AND SHOWS THE OTHER HULL’S CONDITION',
      after.alert === 'action' && after.alertLabel === 'RED', JSON.stringify(after));
    expect('⛔ it is not still showing the old hull’s condition', after.alert !== before.alert,
      `${before.alert} -> ${after.alert}`);
    expect('⛔ NON-ZERO BOUNDING BOXES on both the name and the band',
      after.nameBox[0] > 0 && after.nameBox[1] > 0 && after.alertBox[0] > 0 && after.alertBox[1] > 0,
      JSON.stringify([after.nameBox, after.alertBox]));

    // ⭐ And the hull they LEFT is untouched by any of this — it is still at general quarters.
    expect('the hull they left kept its own condition',
      server.store.get(`${mod.shipNs(home.shipId)}/alert`) === 'elevated',
      String(server.store.get(`${mod.shipNs(home.shipId)}/alert`)));
  } finally { if (browser) await browser.close(); await server.close(); }
});
