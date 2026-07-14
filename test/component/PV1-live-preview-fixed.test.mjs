/*
 * PV1 (Plan 0456 P2.5) — Live Preview: fixed placement, no scroll-to-top.
 *
 * REPRO HISTORY (diagnosis validated on pre-fix code, base b4b564c): pushing content
 * containing an autofocus input made document.activeElement jump to IFRAME#pvframe and
 * scrolled the outline column (.col — the page's actual scroll container; body is
 * height:100vh so window.scrollY is pinned at 0) from 1904 → 0. Mechanism confirmed:
 * srcdoc reload + sandbox allow-scripts lets pushed content steal focus; the browser
 * scrolls ancestors to reveal the focused frame near the top of the page.
 *
 * REGRESSION contract (this test): the same push leaves BOTH window.scrollY and the
 * outline column's scrollTop unchanged, and focus is kicked back out of the iframe;
 * the preview sits in a fixed dock geometrically LEFT of the green #led-btn dot and
 * stays fully visible while the presenter is scrolled deep into the outline.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';

// Enough beats that the outline column overflows and can be scrolled far down.
const beats = [];
for (let i = 1; i <= 80; i++) beats.push({ id: 'b' + i, component: 'card', opts: { title: 'Beat ' + i, promptId: 'p' + i } });
const MODULE = { title: 'Scroll demo', beats };

// Pushed content that tries BOTH steal paths: declarative autofocus + script .focus().
const STEALER = '<!doctype html><body><input id="grab" autofocus><script>document.getElementById("grab").focus();</script></body>';

test('PV1 — Live Preview: autofocus push does not scroll; dock is fixed left of #led-btn', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const ctl = await browser.newPage();
    ctl.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
    await ctl.goto(`${server.url()}/control?userId=op&role=presenter`, { waitUntil: 'domcontentloaded' });
    await ctl.waitForFunction(() => typeof window.__control === 'function' && window.__gm && typeof window.__gm.setModule === 'function');
    await until(() => server.presence().some((u) => u.role === 'presenter'), { label: 'presenter connected' });

    server.setModule(MODULE);
    await ctl.evaluate((m) => window.__gm.setModule(m), MODULE);

    // Scroll deep into the outline (the .col is the scroll container that regressed).
    const before = await ctl.evaluate(() => {
      window.scrollTo(0, 100000);
      const col = document.querySelector('.col');
      col.scrollTop = 100000;                       // clamps to max
      return { scrollY: window.scrollY, colTop: col.scrollTop };
    });
    expect('outline column is scrolled well down before the push', before.colTop > 500, 'colTop=' + before.colTop);

    // Push focus-stealing content into the preview (same 'content' path as any beat).
    server.pushContent('all', STEALER, 'af1');
    await until(async () => (await ctl.$eval('#pvframe', (el) => el.getAttribute('srcdoc') || '')).includes('grab'),
      { label: 'stealer content reached the preview iframe' });
    await wait(500);   // give any focus-reveal scroll a chance to happen

    const after = await ctl.evaluate(() => {
      const col = document.querySelector('.col');
      return {
        scrollY: window.scrollY, colTop: col.scrollTop,
        active: document.activeElement && (document.activeElement.tagName + '#' + (document.activeElement.id || '')),
      };
    });
    expect('window.scrollY unchanged by the autofocus push', after.scrollY === before.scrollY,
      before.scrollY + ' -> ' + after.scrollY);
    expect('outline column scrollTop unchanged by the autofocus push', after.colTop === before.colTop,
      before.colTop + ' -> ' + after.colTop);
    expect('focus-steal neutralized — iframe does not hold focus', after.active !== 'IFRAME#pvframe', after.active);

    // Placement contract: fixed dock, geometrically LEFT of the green dot, fully visible
    // in the viewport while the outline is still scrolled down.
    const geo = await ctl.evaluate(() => {
      const dock = document.getElementById('pvdock');
      const pv = document.getElementById('preview');
      const led = document.getElementById('led-btn');
      const r = pv.getBoundingClientRect(), l = led.getBoundingClientRect();
      return {
        dockPosition: getComputedStyle(dock).position,
        dockZ: +getComputedStyle(dock).zIndex, cfgZ: +getComputedStyle(document.getElementById('ap-config')).zIndex,
        pvRight: r.right, ledLeft: l.left,
        visible: r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
        colTop: document.querySelector('.col').scrollTop,
      };
    });
    expect('preview dock is position:fixed', geo.dockPosition === 'fixed', geo.dockPosition);
    expect('preview sits geometrically LEFT of #led-btn', geo.pvRight <= geo.ledLeft,
      'preview.right=' + geo.pvRight + ' led.left=' + geo.ledLeft);
    expect('preview fully visible in the viewport while scrolled down', geo.visible && geo.colTop > 500,
      JSON.stringify(geo));
    expect('dock z-index stays below the config overlay', geo.dockZ < geo.cfgZ, geo.dockZ + ' vs ' + geo.cfgZ);

    await ctl.close();
  } finally { await browser.close(); await server.close(); }
});
