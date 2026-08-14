/*
 * Plan 0575 PHASE 4 — THE PLACE-AWARE REFUSAL, PAINTED.
 *
 * ⛔⛔ A SECURITY GUARD IS THE ONE THING A SCREENSHOT CANNOT CATCH BY ITSELF, because its failure
 * mode is SUCCEEDING. So this test does both halves: it proves the ship DID NOT MOVE (read off the
 * store), and it proves the person was TOLD (read off the DOM, with a non-zero box). 0565's rule
 * applies unchanged — "a control that fails silently is worse than no control."
 *
 * ⭐ THE HOSTILE CLIENT IS THE POINT. Core overwrites `r.userId` with the connection's userId, so
 * identity cannot be forged — but nothing sanitises the rest of the payload. A real Captain, on a
 * real seat, sends a real order that names A DIFFERENT HULL. Before phase 4 the guard never looked
 * at that field, so the order would have been granted on the wrong ship's machine and nothing
 * anywhere would have said so.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { assertResources } from '../../harness/resources.mjs';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { SHIP_NS } from '../unit/_0514-fixtures.mjs';

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

async function seat(browser, server, uid, name) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 800 });
  await p.goto(`${server.url()}/?stationUID=${uid}&n=${encodeURIComponent(name)}`, { waitUntil: 'domcontentloaded' });
  await wait(1200);
  await p.evaluate(() => document.getElementById('cfg-station')?.click());
  await wait(1500);
  return p;
}

const frameOf = (p) => p.frames().find((f) => f !== p.mainFrame()) || null;

/** The orders panel's painted surface: the attributes AND the words AND the box. */
const panel = (p) =>
  frameOf(p).evaluate(() => {
    const w = document.querySelector('.ap-orders');
    if (!w) return null;
    const s = document.querySelector('.ap-orders-status');
    const r = s ? s.getBoundingClientRect() : { width: 0, height: 0 };
    return {
      ack: w.getAttribute('data-ack'),
      reason: w.getAttribute('data-ack-reason'),
      message: w.getAttribute('data-ack-message'),
      statusText: (s || {}).textContent || '',
      statusBox: [Math.round(r.width), Math.round(r.height)],
    };
  });

const bandOf = (p) =>
  frameOf(p).evaluate(() => {
    const b = document.querySelector('.ap-alertband');
    return b ? { state: b.getAttribute('data-alert'), label: b.getAttribute('data-alert-label') } : null;
  });

/** Send an order that NAMES A HULL — which no button in the UI can do. A hostile client can. */
const injectOrderFor = (p, ev, shipId) =>
  frameOf(p).evaluate((e, s) =>
    !!(window.Argus && window.Argus.emit && (window.Argus.emit('ship-order', { event: e, shipId: s }) || true)), ev, shipId);

test('t0575-04p — ⛔⛔ AN ORDER ADDRESSED TO ANOTHER HULL IS REFUSED, AND THE REFUSAL IS ON THE GLASS', async () => {
  const server = await createServer({ port: 0 });
  let browser = null;
  try {
    if (!server.stations().stations.length) { expect('skipped — no station plugin on this deployment', true, 'skipped'); return; }
    assertResources({ needMB: 900, label: '0575 P4 painted deny' });
    browser = await launch();
    const cap = await seat(browser, server, 1, 'Captain Probe');   // a REAL captain, genuinely in the chair
    await until(() => server.presence().length >= 1, { label: 'seated' });

    const before = await bandOf(cap);
    expect('the Captain is on a real seat with a real band', !!before, JSON.stringify(before));

    // ── the control: his own hull obeys him. Without this the refusal below proves nothing. ──
    expect('the hostile-client channel works at all', await injectOrderFor(cap, 'battle-stations', null), 'no Argus.emit');
    await until(async () => { const b = await bandOf(cap); return b && b.state === 'action'; },
      { timeout: 8000, label: 'his own ship obeys' });
    expect('⭐ CONTROL: the Captain CAN order his own hull', (await bandOf(cap)).state === 'action', JSON.stringify(await bandOf(cap)));
    await server.callPluginTool('ship_event', { event: 'stand-down' });
    await until(async () => { const b = await bandOf(cap); return b && b.state === 'normal'; }, { timeout: 8000, label: 'back to green' });

    // ── ⛔⛔ THE TEST: the same Captain, the same seat, the same order, ADDRESSED ELSEWHERE. ──
    expect('the order naming another hull was sent', await injectOrderFor(cap, 'battle-stations', 'some-other-hull'), 'no Argus.emit');
    await until(async () => { const a = await panel(cap); return a && a.reason === 'not-your-ship'; },
      { timeout: 8000, label: 'a verdict naming the SHIP arrives' });

    const verdict = await panel(cap);
    console.log(`      [painted] refusal ${JSON.stringify(verdict)}`);
    await shoot(cap, 'p4-order-addressed-to-another-hull-REFUSED-on-captain-screen.png');

    // (a) THE SHIP DID NOT MOVE. The half a screenshot cannot prove.
    const st = server.store.get(`${SHIP_NS}/alert`);
    expect('⛔⛔ THE SHIP DID NOT MOVE', st !== 'action' && st !== undefined, `${SHIP_NS}/alert = ${st}`);
    const band = await bandOf(cap);
    expect('and no band anywhere went red', band && band.state !== 'action', JSON.stringify(band));

    // (b) AND HE WAS TOLD. The half only a screenshot can prove.
    expect('⭐ the refusal is PAINTED, not silent', verdict && verdict.ack === 'refused', JSON.stringify(verdict));
    expect('⭐⭐ and the reason names the SHIP, not the seat — he is in the right chair',
      verdict && verdict.reason === 'not-your-ship', JSON.stringify(verdict));
    expect('the message is in words a player can read',
      verdict && /not aboard that ship/i.test(verdict.message || ''), verdict && verdict.message);
    expect('and those words are DRAWN on his screen', /not aboard that ship/i.test(verdict.statusText || ''), verdict.statusText);
    expect('⛔ NON-ZERO BOUNDING BOX on the status line', verdict.statusBox[0] > 0 && verdict.statusBox[1] > 0,
      JSON.stringify(verdict.statusBox));
  } finally { if (browser) await browser.close(); await server.close(); }
});
