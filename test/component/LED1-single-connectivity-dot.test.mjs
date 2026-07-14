/*
 * LED1 (Plan 0456 P2.6) — exactly ONE connectivity LED on /control.
 *
 * REGRESSION: /control historically showed the green connectivity dot TWICE — an old
 * 9px #led inside the header #status span AND #led2 inside the fixed top-right
 * settings button (#led-btn, which doubles as the config entry). P2.6 removed the
 * header one. Contract: the page has exactly one visible connectivity-LED element,
 * it is #led2 inside #led-btn, there is NO #led element at all, and the surviving
 * LED still reflects socket state (gains .on once the ws connects).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until } from '../../harness/multi.mjs';

test('LED1 — /control shows exactly ONE visible connectivity LED (#led2 in #led-btn)', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const ctl = await browser.newPage();
    ctl.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
    await ctl.goto(`${server.url()}/control?userId=op&role=presenter`, { waitUntil: 'domcontentloaded' });
    await ctl.waitForSelector('#led2.on', { timeout: 8000 });   // socket up → LED live
    await until(() => server.presence().some((u) => u.userId === 'op'), { label: 'op connected' });

    const led = await ctl.evaluate(() => {
      const visible = (el) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      // Every connectivity-LED candidate this app has ever used: #led (old header dot),
      // #led2 (settings-button dot), plus anything else claiming an led-ish id.
      const candidates = Array.from(document.querySelectorAll('#led, #led2, [id^="led"]'))
        .filter((el) => el.id !== 'led-btn');   // the button is the LED's housing, not an LED
      const visibleLeds = candidates.filter(visible);
      return {
        ids: candidates.map((el) => el.id),
        visibleIds: visibleLeds.map((el) => el.id),
        hasOldLed: !!document.getElementById('led'),
        insideBtn: !!document.querySelector('#led-btn > #led2'),
        onClass: document.getElementById('led2').classList.contains('on'),
      };
    });

    expect('exactly ONE visible connectivity-LED element on /control', led.visibleIds.length === 1,
      JSON.stringify(led.visibleIds));
    expect('the survivor is #led2 (upper-right settings dot)', led.visibleIds[0] === 'led2',
      JSON.stringify(led.visibleIds));
    expect('old header #led element is GONE from the DOM', led.hasOldLed === false,
      JSON.stringify(led.ids));
    expect('#led2 lives inside the #led-btn settings button', led.insideBtn === true);
    expect('#led2 reflects the live socket (.on while connected)', led.onClass === true);

    await ctl.close();
  } finally { await browser.close(); await server.close(); }
});
