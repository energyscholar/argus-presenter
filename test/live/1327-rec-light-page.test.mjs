/*
 * Plan 1327 P1 — the recording light and the one-click mic toggle on the audience page.
 * T2 light follows socket state · T3 mic on => red + toggle stops it · T4 no big pill ·
 * T5 geometry (no overlap) · T6 voice OFF page has no toggle, light still works ·
 * T7 the four never-silent voice notices land in #rec-note.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launchVoice } from '../../harness/voice-browser.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const URL_Q = '/?role=participant&userId=u1&name=A';
const lightOf = (page) => page.evaluate(() => {
  const led = document.getElementById('led'), btn = document.getElementById('led-btn');
  return { state: led.getAttribute('data-state'), color: getComputedStyle(led).backgroundColor,
    title: btn.getAttribute('title'), aria: btn.getAttribute('aria-label') };
});

test('T2-1327 light: socket open + mic off = green "Not recording"; socket closed = orange "SERVER NOT CONNECTED"', async () => {
  const s = await createServer({ port: 0, voiceEnabled: true });
  const b = await launchVoice({});
  try {
    const page = await b.newPage();
    await page.goto(s.url() + URL_Q, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('led').getAttribute('data-state') === 'idle', { timeout: 8000 });
    const up = await lightOf(page);
    expect('open: green', up.color === 'rgb(34, 197, 94)', JSON.stringify(up));
    expect('open: tooltip', up.title === 'Not recording — mic off' && up.aria === up.title, JSON.stringify(up));
    await s.close();
    await page.waitForFunction(() => document.getElementById('led').getAttribute('data-state') === 'down', { timeout: 8000 });
    const down = await lightOf(page);
    expect('closed: orange', down.color === 'rgb(245, 158, 11)', JSON.stringify(down));
    expect('closed: tooltip', down.title === 'SERVER NOT CONNECTED' && down.aria === down.title, JSON.stringify(down));
  } finally { await b.close(); try { await s.close(); } catch (e) {} }
});

test('T3-1327 mic on (real APVoice.enable) => red RECORDING NOW; #rec-toggle stops it => green', async () => {
  const s = await createServer({ port: 0, voiceEnabled: true });
  const b = await launchVoice({});
  try {
    const page = await b.newPage();
    await page.goto(s.url() + URL_Q, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('led').getAttribute('data-state') === 'idle', { timeout: 8000 });
    expect('#rec-toggle exists and is pressed=false', await page.$eval('#rec-toggle', (el) => el.getAttribute('aria-pressed') === 'false'));
    await page.evaluate(async () => { await window.APVoice.enable(); });
    await page.waitForFunction(() => document.getElementById('led').getAttribute('data-state') === 'rec', { timeout: 5000 });
    const hot = await lightOf(page);
    expect('hot: red', hot.color === 'rgb(224, 48, 58)', JSON.stringify(hot));
    expect('hot: tooltip RECORDING NOW', hot.title === 'RECORDING NOW', JSON.stringify(hot));
    expect('hot: toggle pressed', await page.$eval('#rec-toggle', (el) => el.getAttribute('aria-pressed') === 'true'));
    await page.evaluate(() => { const o = window.APVoice.disable; window.__dis = 0; window.APVoice.disable = function () { window.__dis++; return o.apply(this, arguments); }; });
    await page.click('#rec-toggle');
    await page.waitForFunction(() => document.getElementById('led').getAttribute('data-state') === 'idle', { timeout: 5000 });
    expect('APVoice.disable was called by the click', (await page.evaluate(() => window.__dis)) >= 1);
    expect('mic is off', await page.evaluate(() => window.APVoice.enabled === false));
    expect('toggle unpressed', await page.$eval('#rec-toggle', (el) => el.getAttribute('aria-pressed') === 'false'));
    // and one click turns it back on (the same path as the Settings row)
    await page.click('#rec-toggle');
    await page.waitForFunction(() => document.getElementById('led').getAttribute('data-state') === 'rec', { timeout: 5000 });
    expect('one click turns the mic on again', await page.evaluate(() => window.APVoice.enabled === true));
  } finally { await b.close(); await s.close(); }
});

test('T4-1327 no #ap-voice-badge exists while capturing', async () => {
  const s = await createServer({ port: 0, voiceEnabled: true });
  const b = await launchVoice({});
  try {
    const page = await b.newPage();
    await page.goto(s.url() + URL_Q, { waitUntil: 'domcontentloaded' });
    await wait(200);
    await page.evaluate(async () => { await window.APVoice.enable(); });
    await wait(500);
    expect('capturing', await page.evaluate(() => window.APVoice.enabled === true));
    expect('no badge', !(await page.evaluate(() => !!document.getElementById('ap-voice-badge'))));
    expect('no stop pill button', !(await page.evaluate(() => !!document.getElementById('ap-voice-stop'))));
    expect('ctrl.badgeEl is null', await page.evaluate(() => window.APVoice.capture.badgeEl === null));
  } finally { await b.close(); await s.close(); }
});

test('T5-1327 geometry: #rec-toggle, #led-btn, #ap-signin do not overlap at 1366x768 and 390x844', async () => {
  const s = await createServer({ port: 0, voiceEnabled: true });
  const b = await launchVoice({});
  try {
    for (const [w, h] of [[1366, 768], [390, 844]]) {
      const page = await b.newPage();
      await page.setViewport({ width: w, height: h });
      await page.goto(s.url() + URL_Q, { waitUntil: 'domcontentloaded' });
      await wait(300);
      const r = await page.evaluate(() => {
        document.getElementById('ap-signin').style.display = 'inline-flex';
        const R = (id) => { const x = document.getElementById(id).getBoundingClientRect(); return { l: x.left, r: x.right, t: x.top, b: x.bottom, w: x.width, h: x.height }; };
        return { tog: R('rec-toggle'), led: R('led-btn'), sign: R('ap-signin'), vw: innerWidth };
      });
      const hit = (a, c) => a.l < c.r && c.l < a.r && a.t < c.b && c.t < a.b;
      const tag = w + 'x' + h;
      expect(tag + ' toggle is visible', r.tog.w > 0 && r.tog.h > 0 && r.tog.l >= 0 && r.tog.r <= r.vw, JSON.stringify(r.tog));
      expect(tag + ' toggle/led no overlap', !hit(r.tog, r.led), JSON.stringify([r.tog, r.led]));
      expect(tag + ' toggle/signin no overlap', !hit(r.tog, r.sign), JSON.stringify([r.tog, r.sign]));
      expect(tag + ' led/signin no overlap', !hit(r.led, r.sign), JSON.stringify([r.led, r.sign]));
      await page.close();
    }
  } finally { await b.close(); await s.close(); }
});

test('T6-1327 voice OFF: raw page bytes carry no rec-toggle / rec-note; the light still reaches idle and down', async () => {
  const s = await createServer({ port: 0, voiceEnabled: false });
  const b = await launchVoice({});
  try {
    const raw = await (await fetch(s.url() + URL_Q)).text();
    expect('no rec-toggle in OFF bytes', !/rec-toggle/.test(raw));
    expect('no rec-note in OFF bytes', !/rec-note/.test(raw));
    expect('the light is still in the OFF bytes', /id="led"/.test(raw));
    const page = await b.newPage();
    await page.goto(s.url() + URL_Q, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('led').getAttribute('data-state') === 'idle', { timeout: 8000 });
    expect('no toggle in the DOM', !(await page.evaluate(() => !!document.getElementById('rec-toggle'))));
    await s.close();
    await page.waitForFunction(() => document.getElementById('led').getAttribute('data-state') === 'down', { timeout: 8000 });
    expect('down after close', true);
  } finally { await b.close(); try { await s.close(); } catch (e) {} }
});

test('T7-1327 the four never-silent voice notices land in #rec-note (and the toggle title)', async () => {
  const s = await createServer({ port: 0, voiceEnabled: true });
  const b = await launchVoice({});
  try {
    const page = await b.newPage();
    await page.evaluateOnNewDocument(() => {
      const W = window.WebSocket; window.__socks = [];
      window.WebSocket = function (...a) { const w = new W(...a); window.__socks.push(w); return w; };
      window.WebSocket.prototype = W.prototype; Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    });
    await page.goto(s.url() + URL_Q, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('led').getAttribute('data-state') === 'idle', { timeout: 8000 });
    const fire = (m) => page.evaluate((mm) => {
      const sock = window.__socks[window.__socks.length - 1];
      sock.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(mm) }));
      return { note: document.getElementById('rec-note').textContent, title: document.getElementById('rec-toggle').getAttribute('title') };
    }, m);
    const cases = [
      [{ t: 'voice_dropped', seq: 1, reason: 'rate' }, 'audio dropped'],
      [{ t: 'turn_budget', state: 'wrap' }, 'please wrap up'],
      [{ t: 'turn_budget', state: 'closed' }, 'turn ended'],
      [{ t: 'floor', state: 'hold' }, 'please hold'],
      [{ t: 'floor', state: 'wrap' }, 'wrap up soon'],
      [{ t: 'barge_in', by: null }, 'interrupted'],
    ];
    expect('note empty by default', (await page.$eval('#rec-note', (e) => e.textContent)) === '');
    expect('note is a polite status region', await page.$eval('#rec-note', (e) => e.getAttribute('role') === 'status' && e.getAttribute('aria-live') === 'polite'));
    for (const [msg, text] of cases) {
      const r = await fire(msg);
      expect(msg.t + '/' + (msg.state || '') + ' => "' + text + '" in #rec-note', r.note.includes(text), JSON.stringify(r));
      expect(msg.t + ' also on the toggle title', (r.title || '').includes(text), JSON.stringify(r));
    }
    // clears after 6 s
    await wait(6400);
    expect('note clears after 6 s', (await page.$eval('#rec-note', (e) => e.textContent)) === '');
  } finally { await b.close(); await s.close(); }
});
