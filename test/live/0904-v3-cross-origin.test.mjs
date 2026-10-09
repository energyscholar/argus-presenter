/*
 * Plan 0904 V3 (T0904-06, the presenter's half) — a page on a SECOND local origin (as an embedding web app is) imports the
 * capture module, the worklet and the resumable link FROM THE PRESENTER (CORS), pairs itself (Pattern A: it holds
 * C, a relay registers H, the page redeems C cross-origin), opens its WebSocket from that origin (the V4 check
 * admits a listed origin) and streams the fake mic into the feed with the seat's extRef.
 * The embedding app's own half is tested in that app's repository.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launchVoice, writeWav } from '../../harness/voice-browser.mjs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { useStubAsr, until, wait, SECRET } from './_0904-voice.mjs';

const TOKEN = 'ctl-0904-v3';
const PAGE = (ap) => `<!doctype html><meta charset="utf-8"><title>second origin</title><body><script type="module">
  const AP = ${JSON.stringify(ap)};
  const a = new Uint8Array(16); crypto.getRandomValues(a); const C = [...a].map(b => b.toString(16).padStart(2, '0')).join('');
  const H = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(C)))].map(b => b.toString(16).padStart(2, '0')).join('');
  window.__pair = { H };                       // only the hash leaves the page (the test plays the relay)
  window.__go = async () => {
    const r = await fetch(AP + '/api/voice/pair/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ c: C }) });
    const j = await r.json(); if (!j.ok) throw new Error('redeem: ' + j.error);
    const { startCapture } = await import(AP + '/lib/voice-capture.mjs');
    const { createVoiceLink } = await import(AP + '/lib/voice-link.mjs');
    const link = createVoiceLink({ wsUrl: AP.replace('http', 'ws') + '/', cap: j.cap, onWelcome: (w) => { window.__welcome = w; } });
    window.__link = link;
    const ctrl = await startCapture({ sink: link.sink(), workletUrl: AP + '/lib/voice-worklet.js', badge: false });
    return { ref: j.ref, badge: !!document.getElementById('ap-voice-badge'), ctx: ctrl.context.state };
  };
</script></body>`;

test('T0904-06 — a second-origin page pairs, imports the voice client from the presenter, and streams', async () => {
  useStubAsr();
  const wav = join(tmpdir(), 'ap-0904-xo-' + Date.now() + '.wav');
  writeWav(wav, [{ freq: 0, secs: 0.4 }, { freq: 440, secs: 0.9, amp: 0.35 }, { freq: 0, secs: 1.2 }]);
  // The second origin first, so its port is known when the presenter is configured.
  let apUrl = null;
  const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE(apUrl)); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const siteOrigin = 'http://127.0.0.1:' + site.address().port;
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET, controlToken: TOKEN, voiceClientOrigins: [siteOrigin] });
  apUrl = s.url().replace(/\/$/, '');
  const b = await launchVoice({ wavPath: wav });
  try {
    const page = await b.newPage();
    page.on('pageerror', (e) => console.log('  PAGEERR ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.log('  CONSOLE ' + m.text()); });
    await page.goto(siteOrigin + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__pair && window.__pair.H, { timeout: 8000 });
    const H = await page.evaluate(() => window.__pair.H);
    // The relay (in an embedding app, a privileged client over its own socket; here, the control credential).
    const reg = await fetch(apUrl + '/api/voice/pair/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-control-token': TOKEN }, body: JSON.stringify({ h: H, ref: 'app:w1:u1', name: 'Seat Two' }) });
    expect(reg.status === 200, 'H registered', String(reg.status));
    const out = await page.evaluate(async () => { try { return await window.__go(); } catch (e) { return { err: String(e && e.message || e) }; } });
    expect(!out.err, 'pairing + cross-origin imports succeeded', JSON.stringify(out));
    expect(out.ref === 'app:w1:u1' && out.badge === false, 'the seat ref came back; no presenter badge drawn', JSON.stringify(out));
    const e = await until(() => s.getInbox().items.find((i) => i.extRef === 'app:w1:u1'), 'an entry from the second origin', { timeout: 12000 });
    expect(e.userName === 'Seat Two' && e.trust === 'guest', 'named by the registration; GUEST trust', JSON.stringify({ n: e.userName, t: e.trust }));
    expect(await page.evaluate(() => !!(window.__welcome && window.__welcome.guest)), 'the WebSocket from the second origin was admitted');
    await until(() => s.telemetry().rtt.samples > 0, 'the client answers ping');
  } finally { await b.close(); await s.close(); site.close(); try { unlinkSync(wav); } catch (e) {} }
});
