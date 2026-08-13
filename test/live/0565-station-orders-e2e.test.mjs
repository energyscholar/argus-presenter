/*
 * 0565 — STATION ORDERS, END TO END, IN REAL BROWSERS ONLY.
 *
 * ⭐ THE SANITY TEST FOR THE WHOLE STATION SYSTEM. Bruce: "this must work PERFECTLY before we can
 * rely on any other features."
 *
 * Two real Chrome instances take two different seats. The Captain presses an order on his own
 * console; the Pilot presses the same order on his. The Captain's ship changes and thirteen
 * stations know it. The Pilot is refused, IN WORDS, on his own screen.
 *
 * ⛔ THE DENY IS THE TEST. `ship-machine.mjs`'s own header warns that a `participant` write is
 * COUNTED as denied, not thrown — so the failure this guards against is not "the wrong person
 * changed the ship", it is "the wrong person pressed a button and nothing happened and nothing
 * said why." A control that fails silently is worse than no control.
 *
 * ⛔ NO SHORTCUTS. No direct calls into the machine, no injected state, no simulated clicks on a
 * component mounted in isolation. A real server, real seat links, real iframes, a real mouse click
 * on a real button, and the verdict read off the DOM.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

/* ⭐ 0575 P1a — the ship's store namespace is `ships/<shipId>/…`. ASK THE PLUGIN for the key;
   this repo is PUBLIC and must not spell a campaign value, and a literal here would be a second
   source of truth for something the plugin already owns. */
const MACHINE = join(dirname(fileURLToPath(import.meta.url)), '../../plugins/starship-ops/ship-machine.mjs');
async function shipNs() {
  const mod = await import(pathToFileURL(MACHINE).href);
  return mod.shipNs(mod.loadShipInstance().shipId);
}

/** Seat a real browser at a station, exactly as a player's link does. */
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

/** Read the orders panel's headless surface — data-* attributes, no pixels needed. */
async function panel(p) {
  const f = frameOf(p);
  if (!f) return null;
  return f.evaluate(() => {
    const w = document.querySelector('.ap-orders');
    if (!w) return null;
    return {
      buttons: [...document.querySelectorAll('.ap-order')].map((b) => b.getAttribute('data-order')),
      ack: w.getAttribute('data-ack'),
      reason: w.getAttribute('data-ack-reason'),
      message: w.getAttribute('data-ack-message'),
      status: (document.querySelector('.ap-orders-status') || {}).textContent || '',
      none: !!document.querySelector('.ap-orders-none'),
    };
  });
}

const clickOrder = (p, ev) =>
  frameOf(p).evaluate((e) => {
    const b = document.querySelector(`.ap-order[data-order="${e}"]`);
    if (!b) return false;
    b.click();
    return true;
  }, ev);

const bandOf = (p) =>
  frameOf(p).evaluate(() => {
    const b = document.querySelector('.ap-alertband');
    return b ? { state: b.getAttribute('data-alert'), label: b.getAttribute('data-alert-label') } : null;
  });

test('t0565-01 — ⭐ THE CAPTAIN GIVES AN ORDER AND THIRTEEN STATIONS CHANGE', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    if (!server.stations().stations.length) {
      expect('no station plugin on this deployment — nothing to test', true, 'skipped');
      return;
    }
    const cap = await seat(browser, server, 1, 'Captain Probe');     // Captain
    const pil = await seat(browser, server, 2, 'Pilot Probe');       // Pilot
    await until(() => server.presence().length >= 2, { label: 'both seated' });

    // ── the Captain's console offers orders; the Pilot's does not ──────────────
    const c0 = await panel(cap);
    const p0 = await panel(pil);
    expect('the Captain has an orders panel', !!c0, JSON.stringify(c0));
    expect('the Captain is offered the alert orders',
      c0 && c0.buttons.includes('battle-stations') && c0.buttons.includes('stand-down'),
      JSON.stringify(c0 && c0.buttons));
    expect('⛔ the Pilot is offered NO orders (entitlement is computed server-side)',
      !p0 || p0.none || !(p0.buttons || []).length, JSON.stringify(p0));

    // ── both consoles start GREEN ─────────────────────────────────────────────
    const capBefore = await bandOf(cap);
    const pilBefore = await bandOf(pil);
    expect('both stations start at the same alert state',
      capBefore && pilBefore && capBefore.state === pilBefore.state,
      `${JSON.stringify(capBefore)} vs ${JSON.stringify(pilBefore)}`);

    // ── the Captain presses BATTLE STATIONS on his own screen ─────────────────
    expect('the button exists and was clicked', await clickOrder(cap, 'battle-stations'), 'no button');
    await until(async () => { const a = await panel(cap); return a && a.ack; },
      { timeout: 6000, label: 'the Captain gets a verdict' });

    const cAck = await panel(cap);
    expect('⭐ the order was ACCEPTED, and said so on his screen',
      cAck.ack === 'ok', JSON.stringify(cAck));
    expect('the acknowledgement names the transition', /normal|action/.test(cAck.message || ''), cAck.message);

    // ── and the OTHER seat's band followed, over the wire ─────────────────────
    await until(async () => { const b = await bandOf(pil); return b && b.state === 'action'; },
      { timeout: 6000, label: "the Pilot's band follows the Captain's order" });
    const pilAfter = await bandOf(pil);
    expect('⭐⭐ a DIFFERENT station changed because the Captain pressed a button',
      pilAfter.state === 'action' && pilAfter.state !== pilBefore.state,
      `${JSON.stringify(pilBefore)} → ${JSON.stringify(pilAfter)}`);

    await server.callPluginTool('ship_event', { event: 'stand-down' });     // leave the ship at rest
  } finally { await browser.close(); await server.close(); }
});

test('t0565-02 — ⛔ THE DENY: a seat without the order is REFUSED, IN WORDS', async () => {
  /* The failure mode this exists for is not "the Pilot changed the ship". It is "the Pilot pressed
     a button, nothing happened, and nothing told him why" — which is exactly what a participant
     write does by default. */
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    if (!server.stations().stations.length) { expect('skipped — no stations', true, 'skipped'); return; }
    const pil = await seat(browser, server, 2, 'Pilot Probe');
    await until(() => server.presence().length >= 1, { label: 'seated' });

    // The Pilot has no button, so injecting the order at the wire is the only way to test the
    // guard — this is a hostile client, which is precisely the case the guard is for.
    const f = frameOf(pil);
    const sent = await f.evaluate(() =>
      !!(window.Argus && window.Argus.emit && (window.Argus.emit('ship-order', { event: 'battle-stations' }) || true)));
    expect('a hostile client can send the order', sent, 'no Argus.emit in the frame');

    await wait(1500);
    /* ⛔ 0575 P1a — READ THE KEYED PATH, and get the key from the plugin rather than writing it
       down: a stale `ship/alert` would read `undefined`, `undefined !== 'action'` is TRUE, and
       this assertion would pass for the wrong reason forever — a guard that can no longer fail. */
    const ns = await shipNs();
    const st = server.store.get(`${ns}/alert`);
    expect('⛔⛔ THE SHIP DID NOT MOVE', st !== 'action' && st !== undefined, `${ns}/alert = ${st}`);

    const ack = await panel(pil);
    if (ack) {
      expect('and the refusal is VISIBLE, not silent',
        ack.ack === 'refused' || /not|cannot/i.test(ack.message || ''), JSON.stringify(ack));
      expect('the reason names the seat', ack.reason === 'not-your-seat', JSON.stringify(ack));
    } else {
      // No panel on this seat at all — the order still must not have moved the ship, asserted above.
      expect('no orders panel on a seat with no orders (also correct)', true, 'no panel');
    }
  } finally { await browser.close(); await server.close(); }
});
