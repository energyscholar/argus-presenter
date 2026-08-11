/*
 * 0559 — THE ALERT BAND MUST CHANGE WHEN THE SHIP DOES, OVER THE WIRE.
 *
 * ⛔ THE DEFECT THIS LOCKS DOWN (found 2026-08-11). alert-band.js subscribed with
 * `Argus.subscribe`, which is the IN-PAGE LOCAL BUS — sibling components on one surface emitting
 * to each other over an `argus-presenter:local` CustomEvent. Server state never arrives there.
 * The band therefore mounted, painted its "—" placeholder, and sat unchanged forever: the machine
 * went from `normal` to `action`, the store published it, every client was delivered the diff, and
 * the band on the glass still read "—". The host→frame channel is `Argus.onMessage`
 * (source === 'argus-host'), carrying a `snapshot` on frame load and a `diff` per change.
 *
 * ⭐ WHY IT SURVIVED EVERY OTHER CHECK. It fails SILENTLY: subscribe() returns a valid unsubscribe
 * function, nothing throws, and the component's own unit tests — which call `update()` directly —
 * pass, because `update` was never the broken half. A screenshot of a ship at condition normal is
 * pixel-for-pixel a screenshot of a band that has never heard anything.
 * ⇒ THE ONLY CHECK THAT COULD FIND IT IS TO CHANGE THE STATE AND LOOK AGAIN. This test does that:
 *   it reads the band, moves the ship, and reads the band a second time. A test that renders once
 *   and asserts the rendering cannot distinguish live from dead.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, waitContentFrame, until, wait } from '../../harness/multi.mjs';

/** Read the band's headless surface (0557 D1 / 0559 D8 — data-* attributes, no pixels needed). */
const readBand = async (page) => {
  const f = page.frames().find((x) => x !== page.mainFrame());
  if (!f) return null;
  return f.evaluate(() => {
    const b = document.querySelector('.ap-alertband');
    return b ? { state: b.getAttribute('data-alert'), label: b.getAttribute('data-alert-label'),
                 colour: b.getAttribute('data-alert-colour') } : null;
  });
};

/** Fire an event at the ship machine through the plugin's own contributed tool (core dispatches). */
const shipEvent = async (server, event) => {
  const r = await server.callPluginTool('ship_event', { event });
  return r && r.ok ? r.result : { error: r && r.error };
};

test('t0559-30 — ⛔ a seated station\'s alert band SHOWS current state and CHANGES with the ship', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const declared = server.stations();
    if (!declared.stations.length) {
      /* No station plugin on this deployment ⇒ nothing to assert, and saying so is the point:
         a silent skip is indistinguishable from a pass. */
      expect('no stations declared — nothing to test on this deployment', true, 'skipped');
      return;
    }
    const p = await connectUser(browser, server, { userId: 'seat1', userName: 'Seated' });
    await until(() => server.presence().length >= 1, { label: 'seated client connected' });
    await p.evaluate(() => document.getElementById('cfg-station')?.click());   // "show my station"
    await waitContentFrame(p);
    await wait(600);

    const before = await readBand(p);
    expect('the band rendered on the station screen', !!before, JSON.stringify(before));
    /* ⛔ NOT "the band exists". An inert band exists too — it reads "—" forever. The claim is that
       it arrived carrying the state the ship is ACTUALLY in, delivered by the snapshot. */
    expect('the band shows LIVE state on arrival, not the "—" placeholder',
      before.state && before.state !== '' && before.label !== '—', JSON.stringify(before));

    const moved = await shipEvent(server, 'battle-stations');
    expect('the ship machine actually moved (else this test proves nothing)',
      moved && moved.changed === true, JSON.stringify(moved));

    await until(async () => { const b = await readBand(p); return b && b.state === 'action'; },
      { timeout: 6000, label: 'the band follows the ship to action stations' });

    const after = await readBand(p);
    expect('the band CHANGED over the wire', after.state === 'action' && after.state !== before.state,
      `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    expect('and it carries the chart\'s own label and colour, not a lookup table in the component',
      !!after.label && after.label !== after.state && /^#/.test(after.colour), JSON.stringify(after));

    /* ⛳ STAND DOWN. A test that leaves the ship at battle stations hands the next reader — or the
       next session — a false alarm. */
    await shipEvent(server, 'stand-down');
  } finally { await browser.close(); await server.close(); }
});
