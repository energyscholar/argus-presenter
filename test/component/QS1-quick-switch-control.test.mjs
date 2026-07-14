/*
 * QS1 (Plan 0456 P2.8) — presenter-display quick-switch button to Control.
 *
 * Contract: on the presenter DISPLAY page, a small top-LEFT "⧉ Control" button exists
 * ONLY when the server-granted (welcome-echoed) EFFECTIVE role is presenter:
 *   (1) presenter-granted → button visible; clicking it window.open's a same-origin
 *       /control URL carrying role=presenter + THIS page's token (never hardcoded),
 *       with the NAMED target 'presenter-control' (two-way pair with TF1's
 *       'presenter-display' — refocuses, never spawns duplicates);
 *   (2) participant → button hidden;
 *   (3) SILENT DOWNGRADE (gated server, wrong token: URL says presenter but welcome
 *       grants participant) → button hidden;
 *   (4) geometry: top-left corner, does not occlude the green dot, z below the
 *       config overlay.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until } from '../../harness/multi.mjs';

const TOKEN = 'qs1-test-token';

// welcome-arrival probe: dbg.socketId is set on welcome even without ?debug=1.
const welcomed = (page) => page.waitForFunction(() => window.__apDebug && window.__apDebug.dump().socketId);
const btnState = (page) => page.evaluate(() => {
  const b = document.getElementById('ap-goto-control');
  if (!b) return { exists: false };
  const cs = getComputedStyle(b), r = b.getBoundingClientRect();
  return { exists: true, visible: cs.display !== 'none' && r.width > 0, rect: { top: r.top, left: r.left, right: r.right }, z: parseInt(cs.zIndex, 10) };
});

test('QS1 — presenter-granted: button visible, named window.open to /control with page token', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const pg = await browser.newPage();
    pg.on('pageerror', (e) => console.log('DISP PAGEERR', e.message));
    // Ungated server: presenter role is granted; token must still be FORWARDED, not invented.
    await pg.goto(`${server.url()}/?userId=p1&role=presenter&name=Pres&token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
    await welcomed(pg);
    await until(() => server.presence().some((u) => u.role === 'presenter'), { label: 'presenter connected' });

    const st = await btnState(pg);
    expect('quick-switch button present + visible for a presenter-granted connection', st.exists && st.visible, JSON.stringify(st));

    // Geometry: top-LEFT corner; must not occlude the green dot (top-right); z below config overlay.
    const geo = await pg.evaluate(() => {
      const b = document.getElementById('ap-goto-control').getBoundingClientRect();
      const led = document.getElementById('led-btn').getBoundingClientRect();
      const cfgZ = parseInt(getComputedStyle(document.getElementById('ap-config')).zIndex, 10);
      const btnZ = parseInt(getComputedStyle(document.getElementById('ap-goto-control')).zIndex, 10);
      return { top: b.top, left: b.left, right: b.right, ledLeft: led.left, btnZ, cfgZ };
    });
    expect('button sits in the top-left corner', geo.top < 40 && geo.left < 40, JSON.stringify(geo));
    expect('button does not occlude the green dot', geo.right < geo.ledLeft, JSON.stringify(geo));
    expect('button z-index is below the config overlay', geo.btnZ < geo.cfgZ, `btn=${geo.btnZ} cfg=${geo.cfgZ}`);

    // Stub window.open (records calls; returns a focusable window-alike).
    await pg.evaluate(() => {
      window.__opens = [];
      window.open = (url, target) => { window.__opens.push({ url, target }); return { focus() { window.__opens.push({ focused: true }); } }; };
    });
    await pg.click('#ap-goto-control');
    const opens = await pg.evaluate(() => window.__opens);
    expect('button called window.open once', opens.filter((o) => o.url).length === 1, JSON.stringify(opens));
    const call = opens.find((o) => o.url);
    expect("window.open uses the NAMED target presenter-control", call.target === 'presenter-control', call.target);
    const parsed = await pg.evaluate((u) => {
      const url = new URL(u, location.origin);
      return { sameOrigin: url.origin === location.origin, path: url.pathname, role: url.searchParams.get('role'), token: url.searchParams.get('token') };
    }, call.url);
    expect('opened URL is same-origin', parsed.sameOrigin === true, JSON.stringify(parsed));
    expect('opened URL targets /control', parsed.path === '/control', parsed.path);
    expect('opened URL carries role=presenter', parsed.role === 'presenter', parsed.role);
    expect("opened URL carries THIS page's token (not hardcoded)", parsed.token === TOKEN, parsed.token);

    await pg.close();
  } finally { await browser.close(); await server.close(); }
});

test('QS1 — participant: button hidden', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const pg = await browser.newPage();
    pg.on('pageerror', (e) => console.log('DISP PAGEERR', e.message));
    await pg.goto(`${server.url()}/?userId=u1&name=Viewer`, { waitUntil: 'domcontentloaded' });
    await welcomed(pg);
    const st = await btnState(pg);
    expect('quick-switch button absent for participant', st.exists && !st.visible, JSON.stringify(st));
    await pg.close();
  } finally { await browser.close(); await server.close(); }
});

test('QS1 — silent downgrade (gated server, wrong token): button hidden despite ?role=presenter', async () => {
  const server = await createServer({ port: 0, controlToken: 'the-right-token' });
  const browser = await launch();
  try {
    const pg = await browser.newPage();
    pg.on('pageerror', (e) => console.log('DISP PAGEERR', e.message));
    await pg.goto(`${server.url()}/?userId=p2&role=presenter&name=Mallory&token=wrong-token`, { waitUntil: 'domcontentloaded' });
    await welcomed(pg);
    // Server granted participant (welcome echoes it) — the EFFECTIVE role gates the button.
    await pg.waitForFunction(() => window.__apConfig && window.__apConfig.role() === 'participant');
    await until(() => server.presence().some((u) => u.userId === 'p2' && u.role === 'participant'), { label: 'downgraded connection present' });
    const st = await btnState(pg);
    expect('quick-switch button hidden when welcome downgrades the role', st.exists && !st.visible, JSON.stringify(st));
    await pg.close();
  } finally { await browser.close(); await server.close(); }
});
