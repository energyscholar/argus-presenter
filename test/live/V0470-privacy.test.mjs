/*
 * T-PRIVACY (Plan 0470, Phase A, RT-9) — the mic is uncoerceable. Capture starts ONLY after the
 * browser permission grant; a persistent on-air badge appears only WHILE capturing; one-click stop
 * halts it. And a DENIED permission surfaces an error with NO capture and NO badge.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launchVoice } from '../../harness/voice-browser.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Plan 1327: the on-air pill is retired; "hot" is the always-visible light in its red `rec` state (+ #rec-toggle pressed).
const hasBadge = (page) => page.evaluate(() => document.getElementById('led').getAttribute('data-state') === 'rec' && document.getElementById('rec-toggle').getAttribute('aria-pressed') === 'true');

test('T-PRIVACY grant: badge appears only after capture starts; one-click stop halts it', async () => {
  const s = await createServer({ port: 0, voiceEnabled: true });
  const b = await launchVoice({});   // fake device + auto-grant UI
  try {
    const page = await b.newPage();
    await page.goto(s.url() + '/?role=participant&userId=u1&name=A', { waitUntil: 'domcontentloaded' });
    await wait(200);
    expect('no on-air badge before enable', !(await hasBadge(page)));
    await page.evaluate(async () => { await window.APVoice.enable(); });
    await wait(400);
    expect('on-air badge appears once capturing', await hasBadge(page));
    expect('APVoice reports enabled', await page.evaluate(() => window.APVoice.enabled === true));
    // one-click local stop
    await page.evaluate(() => { const el = document.getElementById('rec-toggle'); if (el) el.click(); });
    await wait(300);
    expect('badge removed after one-click stop', !(await hasBadge(page)));
    expect('APVoice disabled after stop (frames halt)', await page.evaluate(() => window.APVoice.enabled === false));
  } finally { await b.close(); await s.close(); }
});

test('T-PRIVACY deny: denied mic surfaces an error, NO capture, NO badge (uncoerceable)', async () => {
  const s = await createServer({ port: 0, voiceEnabled: true });
  const b = await launchVoice({});
  try {
    const page = await b.newPage();
    // Mock a DENIED permission: getUserMedia rejects. Capture must never start.
    await page.evaluateOnNewDocument(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
    });
    await page.goto(s.url() + '/?role=participant&userId=u1&name=A', { waitUntil: 'domcontentloaded' });
    await wait(200);
    const r = await page.evaluate(async () => { try { await window.APVoice.enable(); return 'ok'; } catch (e) { return 'ERR ' + (e && e.message || e); } });
    expect('enable() rejects when the mic is denied', /ERR/.test(r), r);
    expect('no badge when the mic is denied', !(await hasBadge(page)));
    expect('APVoice not enabled when denied', await page.evaluate(() => window.APVoice.enabled === false));
  } finally { await b.close(); await s.close(); }
});
