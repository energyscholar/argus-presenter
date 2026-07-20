/*
 * T-VOICE-UI (Plan 0470, Phase A, RT-27). The ONLY voice on/off control is a row inside the
 * existing #ap-config Settings overlay (opened by the green dot). Default OFF; toggling ON runs
 * APVoice.enable() (mic prompt) and, on grant, shows the on-air badge and flips the row to ON;
 * a denied mic reverts the row to OFF with an inline message. No standalone voice chrome exists.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launchVoice } from '../../harness/voice-browser.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (page, sel, fn) => page.$eval(sel, fn);

test('T-VOICE-UI voice toggle lives in #ap-config; grant flips it ON + shows badge; deny reverts', async () => {
  // --- grant path ---
  let s = await createServer({ port: 0 });
  let b = await launchVoice({});
  try {
    const page = await b.newPage();
    await page.goto(s.url() + '/?role=participant&userId=u1&name=A', { waitUntil: 'domcontentloaded' });
    await wait(200);
    // The control is INSIDE the settings overlay, not standalone chrome.
    expect('voice toggle is a child of #ap-config', await page.$eval('#cfg-voice-toggle', (el) => !!el.closest('#ap-config')));
    expect('no standalone voice button outside #ap-config', await page.evaluate(() => {
      return ![...document.querySelectorAll('button')].some((btn) => /mic/i.test(btn.textContent) && !btn.closest('#ap-config'));
    }));
    expect('default OFF', await q(page, '#cfg-voice-toggle', (el) => el.getAttribute('aria-pressed') === 'false' && /off/i.test(el.textContent)));
    expect('no badge by default', !(await page.evaluate(() => !!document.getElementById('ap-voice-badge'))));

    // open Settings (green dot) then toggle voice ON
    await page.click('#led-btn');
    await wait(100);
    await page.$eval('#cfg-voice-toggle', (el) => el.click());
    await wait(500);
    expect('row flips ON after grant', await q(page, '#cfg-voice-toggle', (el) => el.getAttribute('aria-pressed') === 'true' && /on/i.test(el.textContent)));
    expect('on-air badge visible while hot', await page.evaluate(() => !!document.getElementById('ap-voice-badge')));

    // toggle OFF
    await page.$eval('#cfg-voice-toggle', (el) => el.click());
    await wait(300);
    expect('row flips OFF', await q(page, '#cfg-voice-toggle', (el) => el.getAttribute('aria-pressed') === 'false'));
    expect('badge gone after OFF', !(await page.evaluate(() => !!document.getElementById('ap-voice-badge'))));
  } finally { await b.close(); await s.close(); }

  // --- deny path ---
  s = await createServer({ port: 0 });
  b = await launchVoice({});
  try {
    const page = await b.newPage();
    await page.evaluateOnNewDocument(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); });
    await page.goto(s.url() + '/?role=participant&userId=u1&name=A', { waitUntil: 'domcontentloaded' });
    await wait(200);
    await page.click('#led-btn');
    await wait(100);
    await page.$eval('#cfg-voice-toggle', (el) => el.click());
    await wait(400);
    expect('denied mic reverts the row to OFF', await q(page, '#cfg-voice-toggle', (el) => el.getAttribute('aria-pressed') === 'false' && /off/i.test(el.textContent)));
    expect('inline error message shown on deny', await q(page, '#cfg-voice-msg', (el) => el.textContent.trim().length > 0));
    expect('no badge on deny', !(await page.evaluate(() => !!document.getElementById('ap-voice-badge'))));
  } finally { await b.close(); await s.close(); }
});
