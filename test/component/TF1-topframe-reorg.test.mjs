/*
 * TF1 (Plan 0456 P2.7) — control top-frame reorganization.
 *
 * Contract: ALWAYS-VISIBLE presenter controls live in the top frame; content-specific
 * controls (series nav, outline) stay lower-left. Specifically:
 *   (1) a PRESENTER SCREEN button sits immediately LEFT of the preview dock and opens
 *       the presenter display via a NAMED window.open target ('presenter-display') on a
 *       same-origin URL carrying role=presenter + THIS page's token (never hardcoded);
 *   (2) the live-preview checkbox sits directly UNDER the green dot (#led-btn) and the
 *       enlarged preview (≥280px wide) still sits geometrically LEFT of the dot;
 *   (3) Now Playing (+ Module select/load) render in the top frame; series nav + outline
 *       stay in the lower-left column;
 *   (4) a "Show Now Playing" toggle in the green-dot config overlay hides the Now
 *       Playing block, persists in localStorage (default VISIBLE), survives reload.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until } from '../../harness/multi.mjs';

const TOKEN = 'tf1-test-token';

test('TF1 — presenter-screen button: named window.open, same-origin URL, page token; geometry', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const ctl = await browser.newPage();
    ctl.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
    // Carry an explicit ?name= and ?token= — the button must FORWARD these, not invent them.
    await ctl.goto(`${server.url()}/control?userId=op&role=presenter&name=Op&token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
    await ctl.waitForFunction(() => typeof window.__control === 'function');
    await until(() => server.presence().some((u) => u.role === 'presenter'), { label: 'presenter connected' });

    // Stub window.open (records calls; returns a focusable window-alike).
    await ctl.evaluate(() => {
      window.__opens = [];
      window.open = (url, target) => { window.__opens.push({ url, target }); return { focus() { window.__opens.push({ focused: true }); } }; };
    });
    await ctl.click('#btn-present');
    const opens = await ctl.evaluate(() => window.__opens);
    expect('presenter-screen button called window.open once', opens.filter((o) => o.url).length === 1, JSON.stringify(opens));
    const call = opens.find((o) => o.url);
    expect('window.open uses the NAMED target presenter-display', call.target === 'presenter-display', call.target);
    const parsed = await ctl.evaluate((u) => {
      const url = new URL(u, location.origin);
      return { sameOrigin: url.origin === location.origin, role: url.searchParams.get('role'), name: url.searchParams.get('name'), token: url.searchParams.get('token'), path: url.pathname };
    }, call.url);
    expect('opened URL is same-origin', parsed.sameOrigin === true, JSON.stringify(parsed));
    expect('opened URL targets the display page root', parsed.path === '/', parsed.path);
    expect('opened URL carries role=presenter', parsed.role === 'presenter', parsed.role);
    expect("opened URL carries the page's name", parsed.name === 'Op', parsed.name);
    expect("opened URL carries THIS page's token (not hardcoded)", parsed.token === TOKEN, parsed.token);

    // Geometry: button LEFT of preview dock; big preview LEFT of the dot; checkbox UNDER the dot.
    const geo = await ctl.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      const btn = r('btn-present'), pv = r('preview'), led = r('led-btn'), lbl = r('livepreview-lbl');
      const np = document.getElementById('np-section'), tf = document.getElementById('topframe');
      return {
        btnRight: btn.right, pvLeft: pv.left, pvRight: pv.right, pvWidth: pv.width,
        ledLeft: led.left, ledRight: led.right, ledBottom: led.bottom,
        lblTop: lbl.top, lblLeft: lbl.left, lblRight: lbl.right,
        npInTop: tf.contains(np), modInTop: tf.contains(document.getElementById('mod-load')),
        seriesInTop: tf.contains(document.getElementById('series-select')),
        outlineInTop: tf.contains(document.getElementById('outline')),
      };
    });
    expect('presenter-screen button sits LEFT of the preview dock', geo.btnRight <= geo.pvLeft,
      'btn.right=' + geo.btnRight + ' preview.left=' + geo.pvLeft);
    expect('preview enlarged to ≥280px wide', geo.pvWidth >= 280, 'width=' + geo.pvWidth);
    expect('preview still geometrically LEFT of #led-btn', geo.pvRight <= geo.ledLeft,
      'preview.right=' + geo.pvRight + ' led.left=' + geo.ledLeft);
    expect('live-preview checkbox sits UNDER the green dot (below its bottom edge)', geo.lblTop >= geo.ledBottom,
      'lbl.top=' + geo.lblTop + ' led.bottom=' + geo.ledBottom);
    expect('live-preview checkbox horizontally overlaps the dot column', geo.lblLeft <= geo.ledRight && geo.lblRight >= geo.ledLeft,
      JSON.stringify({ lblLeft: geo.lblLeft, lblRight: geo.lblRight, ledLeft: geo.ledLeft, ledRight: geo.ledRight }));
    expect('Now Playing block lives in the top frame', geo.npInTop === true);
    expect('Module Validate&Load lives in the top frame', geo.modInTop === true);
    expect('series nav stays OUT of the top frame (lower-left)', geo.seriesInTop === false);
    expect('outline stays OUT of the top frame (lower-left)', geo.outlineInTop === false);

    await ctl.close();
  } finally { await browser.close(); await server.close(); }
});

test('TF1 — Now Playing toggle: hides via config overlay, persists across reload, default visible', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const ctl = await browser.newPage();
    ctl.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
    await ctl.goto(`${server.url()}/control?userId=op&role=presenter`, { waitUntil: 'domcontentloaded' });
    await ctl.waitForFunction(() => typeof window.__control === 'function');

    const npVisible = () => ctl.evaluate(() => getComputedStyle(document.getElementById('np-section')).display !== 'none');
    expect('Now Playing visible by default', (await npVisible()) === true);

    // Toggle OFF from the green-dot config overlay.
    await ctl.click('#led-btn');
    await ctl.waitForSelector('#ap-config.open', { timeout: 3000 });
    expect('config checkbox reflects the visible state (checked)', await ctl.$eval('#cfg-shownp', (el) => el.checked));
    await ctl.click('#cfg-shownp');
    expect('Now Playing hidden after toggling off', (await npVisible()) === false);
    expect('config overlay stayed open across the toggle click', await ctl.evaluate(() => document.getElementById('ap-config').classList.contains('open')));

    // Reload: the choice PERSISTS (localStorage), checkbox reflects it.
    await ctl.reload({ waitUntil: 'domcontentloaded' });
    await ctl.waitForFunction(() => typeof window.__control === 'function');
    expect('Now Playing STAYS hidden after reload', (await npVisible()) === false);
    await ctl.click('#led-btn');
    await ctl.waitForSelector('#ap-config.open', { timeout: 3000 });
    expect('config checkbox unchecked after reload', (await ctl.$eval('#cfg-shownp', (el) => el.checked)) === false);

    // Toggle back ON — top frame shows the block again.
    await ctl.click('#cfg-shownp');
    expect('Now Playing visible again after toggling on', (await npVisible()) === true);

    await ctl.close();
  } finally { await browser.close(); await server.close(); }
});
