/*
 * Plan 1327 P1 (T2, control page) — /control has no mic, so its light is only ever green ("Not recording")
 * or orange ("SERVER NOT CONNECTED"); red is never painted there. Derived from lib/rec-light.mjs.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch } from '../../harness/multi.mjs';

const CTL_TOKEN = 'ap-test-control-token';

test('T2c-1327 /control light: open = green + title; closed = orange + SERVER NOT CONNECTED', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const ctl = await browser.newPage();
    await ctl.goto(`${server.url()}/control?userId=op&role=presenter&token=${CTL_TOKEN}`, { waitUntil: 'domcontentloaded' });
    await ctl.waitForFunction(() => document.getElementById('led2').getAttribute('data-state') === 'idle', { timeout: 8000 });
    const up = await ctl.evaluate(() => ({ c: getComputedStyle(document.getElementById('led2')).backgroundColor, t: document.getElementById('led-btn').title, a: document.getElementById('led-btn').getAttribute('aria-label') }));
    expect('open: green', up.c === 'rgb(34, 197, 94)', JSON.stringify(up));
    expect('open: tooltip + aria', up.t === 'Not recording — mic off' && up.a === up.t, JSON.stringify(up));
    await server.close();
    await ctl.waitForFunction(() => document.getElementById('led2').getAttribute('data-state') === 'down', { timeout: 8000 });
    const down = await ctl.evaluate(() => ({ c: getComputedStyle(document.getElementById('led2')).backgroundColor, t: document.getElementById('led-btn').title }));
    expect('closed: orange', down.c === 'rgb(245, 158, 11)', JSON.stringify(down));
    expect('closed: tooltip', down.t === 'SERVER NOT CONNECTED', JSON.stringify(down));
  } finally { await browser.close(); try { await server.close(); } catch (e) {} }
});
