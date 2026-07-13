/*
 * P5 — CFG-open-control. From the green-dot Config overlay a PRESENTER expands a
 * full-screen overlay hosting the SAME-ORIGIN /control page in a NON-sandboxed
 * iframe (ws/fetch resolve to 'self' → allowed by CSP). Closing it SHRINKS BACK to
 * the Config panel (blanks the iframe so control's ws + rAF stop; base display socket
 * untouched the whole time).
 *
 * Screenshots (MANDATORY): test/screenshots/P5-config.png (Config open, Show-Control
 * button visible for a presenter), P5-control-expanded.png (overlay open, /control
 * loaded + its own led connected, base still live), P5-collapsed-to-config.png
 * (overlay gone, iframe blanked, Config panel shrank back — takedown verified as much
 * as setup). Plus a participant sub-test: no Show-Control button.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');

test('P5 — expand /control overlay from Config, then collapse back to Config', async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('PAGEERR', e.message));
    // Presenter, so the Show-Control button is available.
    await page.goto(`${server.url()}/?userId=pres&name=Pres&role=presenter`, { waitUntil: 'domcontentloaded' });

    // 1) base page connected + present on server; record the base socket alive.
    await page.waitForSelector('#led.on', { timeout: 5000 });
    await until(() => server.presence().some((u) => u.userId === 'pres' && u.role === 'presenter'),
      { label: 'server sees pres as presenter' });
    const baseAlive0 = await page.evaluate(() => document.getElementById('led').classList.contains('on'));
    expect(baseAlive0 === true, 'base display socket alive at start');

    // 2) open Config; the Show-Control button is visible + enabled for a presenter.
    await page.click('#led-btn');
    await page.waitForSelector('#ap-config.open', { timeout: 3000 });
    const btnState = await page.evaluate(() => {
      const b = document.getElementById('cfg-open-control');
      return { present: !!b, visible: b ? getComputedStyle(document.getElementById('cfg-control-row')).display !== 'none' : false, enabled: b ? !b.disabled : false };
    });
    expect(btnState.present, 'Show-Control button present');
    expect(btnState.visible, 'Show-Control row visible for presenter');
    expect(btnState.enabled, 'Show-Control button enabled for presenter');
    await page.screenshot({ path: path.join(SHOTS, 'P5-config.png') });

    // 3) EXPAND: click Show-Control → overlay opens, iframe src → /control.
    await page.click('#cfg-open-control');
    await page.waitForSelector('#ap-control-overlay.open', { timeout: 3000 });
    const openHook = await page.evaluate(() => window.__apControl.open());
    expect(openHook === true, 'overlay open (hook)');
    const src = await page.evaluate(() => window.__apControl.frameSrc());
    expect(src.indexOf('/control') === 0, 'iframe src starts with /control', src);
    // NO sandbox attribute → same-origin → we can reach into the frame.
    const hasSandbox = await page.evaluate(() => document.getElementById('ap-control-frame').hasAttribute('sandbox'));
    expect(hasSandbox === false, 'control iframe has NO sandbox attribute (same-origin)', String(hasSandbox));

    // Wait for /control to actually load AND its own socket to connect (its #led.on).
    await until(() => !!page.frames().find((fr) => fr.url().includes('/control')),
      { timeout: 8000, label: '/control frame attached' });
    const cf = page.frames().find((fr) => fr.url().includes('/control'));
    await cf.waitForSelector('#led.on', { timeout: 8000 });
    const ctrlConnected = await cf.evaluate(() => document.getElementById('led').classList.contains('on'));
    expect(ctrlConnected === true, '/control socket connected (its led.on)');
    // BASE display socket still alive during the expand.
    const baseAlive1 = await page.evaluate(() => document.getElementById('led').classList.contains('on'));
    expect(baseAlive1 === true, 'base display socket still alive while control expanded');
    await page.screenshot({ path: path.join(SHOTS, 'P5-control-expanded.png') });

    // 4) COLLAPSE (takedown): click Close → overlay loses .open, iframe blanked,
    //    Config panel shrinks back, base socket still alive.
    await page.click('#ap-control-close');
    await page.waitForFunction(() => !document.getElementById('ap-control-overlay').classList.contains('open'), { timeout: 3000 });
    const openAfter = await page.evaluate(() => window.__apControl.open());
    expect(openAfter === false, '(a) overlay closed after Close (hook)', String(openAfter));
    const srcAfter = await page.evaluate(() => window.__apControl.frameSrc());
    expect(srcAfter === 'about:blank' || srcAfter === '', '(b) iframe torn down (about:blank/empty)', srcAfter);
    // (c) Config panel shrank back into view.
    await page.waitForSelector('#ap-config.open', { timeout: 3000 });
    const cfgBack = await page.evaluate(() => window.__apConfig.open());
    expect(cfgBack === true, '(c) Config panel shrank back into view');
    // (d) base display socket STILL alive.
    const baseAlive2 = await page.evaluate(() => document.getElementById('led').classList.contains('on'));
    expect(baseAlive2 === true, '(d) base display socket still alive after collapse');
    await until(() => server.presence().some((u) => u.userId === 'pres' && u.role === 'presenter'),
      { label: 'server still sees pres as presenter after collapse' });
    await page.screenshot({ path: path.join(SHOTS, 'P5-collapsed-to-config.png') });
  } finally { await browser.close(); await server.close(); }
});

test('P5 — a participant gets NO Show-Control button', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${server.url()}/?userId=part&name=Part&role=participant`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#led.on', { timeout: 5000 });
    await page.click('#led-btn');
    await page.waitForSelector('#ap-config.open', { timeout: 3000 });
    const state = await page.evaluate(() => {
      const b = document.getElementById('cfg-open-control');
      const rowHidden = getComputedStyle(document.getElementById('cfg-control-row')).display === 'none';
      return { rowHidden, disabled: b ? !!b.disabled : true };
    });
    expect(state.rowHidden, 'Show-Control row hidden for participant');
    expect(state.disabled, 'Show-Control button disabled for participant');
  } finally { await browser.close(); await server.close(); }
});
