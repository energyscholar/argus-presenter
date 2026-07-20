/*
 * T-ZERO-WHEN-OFF (Plan 0473, P0). Audio-in is OPTIONAL and DEFAULT OFF. When off, the audience
 * display (presenter.html) must carry ZERO voice code: no <script src=/lib/voice-stub.js>, no
 * APVoice / APVoiceHost wiring, no mic row, no voice_enable handler — and a headless load must
 * make ZERO /lib/voice-* requests and expose no always-on voice runtime (window.APVoice absent).
 * When ON (voiceEnabled:true, i.e. PRESENTER_VOICE_ENABLED), the page is exactly as today: the
 * stub loads, window.APVoice is defined, and /lib/voice-stub.js is fetched.
 *
 * ALSO confirms the unified inbox + typed chat are NOT voice: the chat affordance is present on
 * the audience page with voice OFF (functional inbox/chat coverage lives in the V0472-* tests,
 * which now run with voice DEFAULT OFF and stay green).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launchVoice } from '../../harness/voice-browser.mjs';
import http from 'http';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Raw GET of the served page (asserts on the actual bytes the audience receives).
function getPage(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)); }).on('error', reject);
  });
}
// Voice references we must NOT see anywhere in the OFF page bytes.
const VOICE_MARKERS = [/voice-stub/, /APVoice/i, /cfg-voice/, /voice_enable/, /AP-VOICE:/];

test('T-ZERO-WHEN-OFF (off): audience page carries ZERO voice code + zero /lib/voice-* requests', async () => {
  const s = await createServer({ port: 0, voiceEnabled: false });
  const b = await launchVoice({});
  try {
    // (1) raw served bytes: no voice references at all.
    const raw = await getPage(s.url() + '/');
    for (const re of VOICE_MARKERS) expect('no ' + re + ' in served OFF page', !re.test(raw), re.source);
    // The inbox/chat surface is NOT voice — it must still be present with voice off.
    expect('chat input present with voice OFF (inbox/chat not gated)', /id="ap-chat-input"/.test(raw));

    // (2) headless load: zero /lib/voice-* network requests, no always-on voice runtime.
    const page = await b.newPage();
    const urls = [];
    page.on('request', (r) => urls.push(r.url()));
    page.on('response', (r) => urls.push(r.url()));
    await page.goto(s.url() + '/?role=participant&userId=u1&name=A', { waitUntil: 'networkidle0' });
    await wait(200);
    expect('ZERO /lib/voice-* requests when off', !urls.some((u) => /\/lib\/voice-/.test(u)), urls.filter((u) => /voice/.test(u)).join(','));
    expect('no always-on voice runtime (window.APVoice undefined)', await page.evaluate(() => typeof window.APVoice === 'undefined'));
    expect('no APVoiceHost wiring when off', await page.evaluate(() => typeof window.APVoiceHost === 'undefined'));
    expect('no mic row in DOM when off', await page.evaluate(() => !document.getElementById('cfg-voice-toggle')));
    // The page must still be functional (not a JS-broken husk): the chat input rendered.
    expect('chat input rendered in DOM with voice OFF', await page.evaluate(() => !!document.getElementById('ap-chat-input')));
  } finally { await b.close(); await s.close(); }
});

test('T-ZERO-WHEN-OFF (on): with voice enabled the page is as today — stub loads + APVoice defined', async () => {
  const s = await createServer({ port: 0, voiceEnabled: true });
  const b = await launchVoice({});
  try {
    const raw = await getPage(s.url() + '/');
    expect('voice-stub script present when ON', /voice-stub\.js/.test(raw));
    expect('mic row present when ON', /cfg-voice-toggle/.test(raw));

    const page = await b.newPage();
    const urls = [];
    page.on('request', (r) => urls.push(r.url()));
    page.on('response', (r) => urls.push(r.url()));
    await page.goto(s.url() + '/?role=participant&userId=u1&name=A', { waitUntil: 'networkidle0' });
    await wait(200);
    expect('/lib/voice-stub.js fetched when ON', urls.some((u) => /\/lib\/voice-stub\.js/.test(u)));
    expect('window.APVoice defined when ON', await page.evaluate(() => typeof window.APVoice === 'object' && window.APVoice !== null));
    expect('APVoiceHost wired when ON', await page.evaluate(() => typeof window.APVoiceHost === 'object' && window.APVoiceHost !== null));
    expect('mic row in DOM when ON', await page.evaluate(() => !!document.getElementById('cfg-voice-toggle')));
  } finally { await b.close(); await s.close(); }
});
