/*
 * T-LAZY (Plan 0470, Phase A) — lightweight-by-default. On the default page with voice DISABLED,
 * ZERO requests for voice-capture.mjs / voice-worklet.js / any .wasm (only the sub-1KB stub is
 * on the page). After APVoice.enable(), the Tier-1 capture chunk is fetched — and STILL no .wasm.
 * (The worklet module is fetched inside the AudioWorklet realm, which puppeteer's request event
 * does not surface; its load is confirmed functionally: the on-air badge appears only once the
 * AudioWorkletNode is constructed, which requires the worklet module to have loaded.)
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launchVoice } from '../../harness/voice-browser.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('T-LAZY zero voice/wasm bytes while disabled; Tier-1 loads only after enable()', async () => {
  const s = await createServer({ port: 0 });
  const b = await launchVoice({});
  try {
    const page = await b.newPage();
    const urls = [];
    page.on('request', (r) => urls.push(r.url()));
    page.on('response', (r) => urls.push(r.url()));   // catch sub-resource fetches too
    page.on('pageerror', (e) => console.log('  PAGEERR ' + e.message));
    await page.goto(s.url() + '/?role=participant&userId=u1&name=A', { waitUntil: 'networkidle0' });
    await wait(300);

    const has = (re) => urls.some((u) => re.test(u));
    // Disabled: only the stub; no capture, no worklet, no wasm.
    expect('stub IS on the default page', has(/voice-stub\.js/));
    expect('NO voice-capture.mjs while disabled', !has(/voice-capture\.mjs/));
    expect('NO voice-worklet.js while disabled', !has(/voice-worklet\.js/));
    expect('NO .wasm while disabled', !has(/\.wasm/));

    // Enable -> Tier 1 arrives.
    const en = await page.evaluate(async () => { try { await window.APVoice.enable(); return 'ok'; } catch (e) { return 'ERR ' + (e && e.message || e); } });
    expect('enable() succeeded', en === 'ok', en);
    await wait(500);
    expect('voice-capture.mjs fetched AFTER enable', has(/voice-capture\.mjs/));
    expect('STILL no .wasm after enable', !has(/\.wasm/));
    const badge = await page.evaluate(() => !!document.getElementById('ap-voice-badge'));
    const workletNet = has(/voice-worklet\.js/);
    expect('worklet loaded after enable (network or functional badge)', workletNet || badge, 'workletNet=' + workletNet + ' badge=' + badge);
  } finally { await b.close(); await s.close(); }
});
