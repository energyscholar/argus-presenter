/*
 * Plan 0571 A4 — ⛔ THE REFUSAL PATH OF THE ORDER SELECT, IN A REAL BROWSER.
 *
 * ⛔⛔ WHY THIS FILE EXISTS RATHER THAN ONE MORE END-TO-END TEST. The plan asks for: "Pilot changes
 * the select → refused in words, and the select returns to the true state." MEASURED, 2026-08-14:
 * a seat with no orders renders NO CONTROL AT ALL — `t0571-06` prints `{"present":false}` for that
 * seat — so end to end there is no select on the refused console to change, and the branch that
 * matters cannot be reached that way. The live test asserts the half it CAN reach (the ship does
 * not move, and the refusal is legible); this file reaches the other half.
 *
 * ⭐ IT IS STILL A REAL BROWSER AND THE REAL COMPONENT, driven only through its declared inputs:
 * `opts.orders` as the server builds them, and `argus-host` messages, which is the one channel the
 * component listens on. Nothing inside it is stubbed and no internal is reached for.
 *
 * ⚠ AND THE ORDERS ARE READ FROM THE CHART, never written here. This repo is PUBLIC (t0531-01),
 * and a hand-written order list in a test is the same second table the component's own header
 * forbids — it would also keep passing after the chart changed under it.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '../../plugins/starship-ops');
const CHART_PATH = join(PLUGIN, 'ship-chart.json');
const have = existsSync(CHART_PATH);
const MANIFEST = have ? JSON.parse(readFileSync(join(PLUGIN, 'plugin.json'), 'utf8')) : null;

const SHIP = 'component-probe-hull';     // an invented fixture id, never a campaign one
const USER = 'probe-user';

/** The order descriptors exactly as `ship-machine.mjs → ordersFor` builds them, from the chart. */
function ordersFromChart() {
  const chart = JSON.parse(readFileSync(CHART_PATH, 'utf8'));
  const states = chart.regions.alert.states;
  return chart.transitions.filter((t) => t.region === 'alert').map((t) => {
    const d = states[t.to] || {};
    return { event: t.on, to: t.to, label: d.label || t.on, colour: d.colour || null, gloss: d.gloss || null };
  });
}

test('t0571-06b — ⛔ A REFUSED ORDER SNAPS THE SELECT BACK TO THE TRUE STATE, and says why in words', async () => {
  if (!have) { expect('skipped — no station plugin on this deployment', true, 'skipped'); return; }
  const orders = ordersFromChart();
  expect('the chart yields an order set to drive', orders.length >= 2, JSON.stringify(orders.map((o) => o.event)));
  if (orders.length < 2) return;

  const truth = orders[0].to;                      // where the ship really is
  const expectBack = orders[0].event;              // ⇒ the option that must come back
  const refused = orders[orders.length - 1].event; // a DIFFERENT order, which the server refuses

  /* ⚠ THE PROBE IS A STRING, deliberately. `drive` evaluates it in the page, and a function passed
     by reference is SERIALISED — its closure does not travel, so `shipId` and `userId` would arrive
     as undefined and the ack would be delivered to a path nobody is listening on. The test would
     then pass or fail for a reason that has nothing to do with the component. */
  const probe = `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const w = document.querySelector('.ap-orders');
    const sel = document.querySelector('.ap-orders-select');
    if (!w || !sel) return { fatal: 'no control rendered' };
    const before = { value: sel.value, trueState: w.getAttribute('data-alert-state') };

    sel.value = ${JSON.stringify(refused)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(80);
    const pending = { value: sel.value,
                      status: (document.querySelector('.ap-orders-status') || {}).textContent || '' };

    window.postMessage({ source: 'argus-host', type: 'diff', diff: {
      ['ships/' + ${JSON.stringify(SHIP)} + '/ack/' + ${JSON.stringify(USER)}]:
        { ok: false, reason: 'not-your-seat', message: 'not your seat' } } }, '*');
    await wait(250);

    const st = document.querySelector('.ap-orders-status');
    const r = st ? st.getBoundingClientRect() : { width: 0, height: 0 };
    return { before, pending, after: {
      value: sel.value,
      ack: w.getAttribute('data-ack'),
      reason: w.getAttribute('data-ack-reason'),
      message: w.getAttribute('data-ack-message'),
      status: st ? (st.textContent || '') : '',
      statusBox: [Math.round(r.width), Math.round(r.height)],
      buttons: document.querySelectorAll('.ap-order').length,
    } };
  })()`;

  const r = await drive({
    component: 'station-orders',
    requires: [MANIFEST.name],
    opts: { orders, shipId: SHIP, userId: USER, stationUid: 1 },
    viewport: { width: 1280, height: 720 },
    /* The ship reports where it really is. This is the ONLY way the component learns the truth —
       it never infers it from what was asked for, which is the property under test. */
    actions: [{ host: { type: 'snapshot', state: { ships: { [SHIP]: { alert: truth } } } }, after: 250 }],
    probe,
  });

  const p = r.probe;
  console.log(`      [probe] ${JSON.stringify(p)}`);
  expect('the control rendered', p && !p.fatal, JSON.stringify(p));
  if (!p || p.fatal) return;

  expect('⭐ the select shows the TRUE state on arrival, taken from the ship and not from the UI',
    p.before.value === expectBack && p.before.trueState === truth, JSON.stringify(p.before));
  expect('a real selection moved it to the order about to be refused',
    p.pending.value === refused, JSON.stringify(p.pending));
  expect('⛔ THE REFUSAL SPEAKS — a verdict in words, with a reason, not a silent snap-back',
    p.after.ack === 'refused' && p.after.reason === 'not-your-seat' && /\S/.test(p.after.status),
    JSON.stringify(p.after));
  expect('and the words are PAINTED, with a non-zero box',
    p.after.statusBox[0] > 0 && p.after.statusBox[1] > 0, JSON.stringify(p.after.statusBox));
  expect('⭐⭐ AND THE SELECT WENT BACK TO THE TRUE STATE, not to a blank and not to the refusal',
    p.after.value === expectBack, `want ${expectBack}, got ${JSON.stringify(p.after.value)}`);
  expect('⛔ and there are no order BUTTONS anywhere — the three of them are gone',
    p.after.buttons === 0, String(p.after.buttons));
});
