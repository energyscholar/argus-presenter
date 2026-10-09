/*
 * Plan 0904 V1.9 — the capture module gains a sink seam and three options; the defaults are unchanged.
 *
 *   T0904-23  startCapture() with NO new options sends the same frame sequence as before the split
 *             (golden: test/fixtures/0904-capture-golden.json, recorded from the pre-split module with
 *             AP_0904_GOLDEN_WRITE=1): seg_start{seq} · binary batches · seg_end{seq}, same batch sizes.
 *   T0904-24  startCapture({track}) uses the given track and calls getUserMedia ZERO times; badge:false
 *             injects no badge; the stream still reaches the feed.
 *   T0904-06a the capture module and worklet are served with Access-Control-Allow-Origin for a listed
 *             client origin, and without it for any other origin.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launchVoice, writeWav } from '../../harness/voice-browser.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { useStubAsr, until, wait } from './_0904-voice.mjs';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', '0904-capture-golden.json');

// Record what the page's socket SENDS (type + seq for JSON, byte length for binary).
const RECORDER = () => {
  window.__sent = [];
  const orig = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    try {
      if (typeof d === 'string') { const m = JSON.parse(d); window.__sent.push({ t: m.t, seq: m.seq, tag: m.tag }); }
      else window.__sent.push({ bin: d.byteLength });
    } catch (e) {}
    return orig.call(this, d);
  };
};
function firstSegment(sent) {
  const i = sent.findIndex((f) => f.t === 'voice_seg_start');
  if (i < 0) return null;
  const j = sent.findIndex((f, k) => k > i && f.t === 'voice_seg_end');
  if (j < 0) return null;
  return sent.slice(i, j + 1).filter((f) => f.t !== 'voicedbg');
}

test('T0904-23 — the default capture path is unchanged (golden frame sequence)', async () => {
  useStubAsr();
  const wav = join(tmpdir(), 'ap-0904-golden-' + Date.now() + '.wav');
  writeWav(wav, [{ freq: 0, secs: 0.5 }, { freq: 440, secs: 1.0, amp: 0.35 }, { freq: 0, secs: 1.5 }]);
  const s = await createServer({ port: 0, voiceEnabled: true });
  const b = await launchVoice({ wavPath: wav });
  try {
    const page = await b.newPage();
    await page.evaluateOnNewDocument(RECORDER);
    await page.goto(s.url() + '/?role=participant&userId=gold&name=Gold', { waitUntil: 'domcontentloaded' });
    await wait(200);
    const en = await page.evaluate(async () => { try { await window.APVoice.enable(); return 'ok'; } catch (e) { return 'ERR ' + (e && e.message || e); } });
    expect(en === 'ok', 'voice enabled', en);
    await until(async () => firstSegment(await page.evaluate(() => window.__sent)), 'first segment sent', { timeout: 12000 });
    const seg = firstSegment(await page.evaluate(() => window.__sent));
    const shape = { start: seg[0], end: seg[seg.length - 1], bins: seg.filter((f) => f.bin).map((f) => f.bin) };
    if (process.env.AP_0904_GOLDEN_WRITE === '1') {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, JSON.stringify(shape, null, 1) + '\n');
      console.log('  golden written: ' + GOLDEN);
    }
    expect(existsSync(GOLDEN), 'the golden exists', GOLDEN);
    const g = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    expect(JSON.stringify(shape.start) === JSON.stringify(g.start), 'seg_start frame identical', JSON.stringify([shape.start, g.start]));
    expect(JSON.stringify(shape.end) === JSON.stringify(g.end), 'seg_end frame identical', JSON.stringify([shape.end, g.end]));
    expect(seg.every((f, k) => k === 0 || k === seg.length - 1 || f.bin), 'only binary frames between the brackets', JSON.stringify(seg));
    // Batches are 1600 samples (3200 B) except the last. Measured: identical batches on 7 of 8 runs; the
    // eighth differed by one 20 ms frame of fake-device alignment, so the TOTAL may differ by ≤ 640 B.
    const allButLast = (a) => a.slice(0, -1);
    expect(allButLast(shape.bins).every((n) => n === 3200) && shape.bins[shape.bins.length - 1] <= 3200, 'every batch but the last is 3200 bytes', JSON.stringify(shape.bins));
    const tot = (a) => a.reduce((x, y) => x + y, 0);
    expect(Math.abs(tot(shape.bins) - tot(g.bins)) <= 640, 'segment size matches the golden within one frame', `${tot(shape.bins)} vs ${tot(g.bins)}`);
    // ORDER: no PCM may travel outside a bracket. A final flush reordered after seg_end shows up here.
    const all = (await page.evaluate(() => window.__sent)).filter((f) => f.t !== 'voicedbg');
    let open = false, stray = 0;
    for (const f of all) { if (f.t === 'voice_seg_start') open = true; else if (f.t === 'voice_seg_end') open = false; else if (f.bin && !open) stray++; }
    expect(stray === 0, 'no binary frame is sent outside a seg_start…seg_end bracket', 'stray=' + stray);
  } finally { await b.close(); await s.close(); try { unlinkSync(wav); } catch (e) {} }
});

test('T0904-24 — startCapture({track}) never calls getUserMedia; badge:false draws no badge', async () => {
  useStubAsr();
  const wav = join(tmpdir(), 'ap-0904-track-' + Date.now() + '.wav');
  writeWav(wav, [{ freq: 0, secs: 0.4 }, { freq: 440, secs: 0.9, amp: 0.35 }, { freq: 0, secs: 1.2 }]);
  const s = await createServer({ port: 0, voiceEnabled: true });
  const b = await launchVoice({ wavPath: wav });
  try {
    const page = await b.newPage();
    page.on('pageerror', (e) => console.log('  PAGEERR ' + e.message));
    await page.goto(s.url() + '/?role=participant&userId=trk&name=Track', { waitUntil: 'domcontentloaded' });
    await wait(200);
    const out = await page.evaluate(async () => {
      const own = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = own.getAudioTracks()[0];
      let calls = 0;
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (...a) => { calls++; return orig(...a); };
      try {
        const m = await import('/lib/voice-capture.mjs');
        const ctrl = await m.startCapture({ getSocket: () => window.APVoiceHost.getSocket(), track, badge: false });
        return { calls, badge: !!document.getElementById('ap-voice-badge'), sameTrack: ctrl.stream.getAudioTracks()[0] === track };
      } catch (e) { return { err: String(e && e.message || e) }; }
    });
    expect(!out.err, 'startCapture ran', JSON.stringify(out));
    expect(out.calls === 0, 'getUserMedia was called ZERO times', JSON.stringify(out));
    expect(out.badge === false, 'no badge with badge:false', JSON.stringify(out));
    expect(out.sameTrack === true, 'the given track is the one captured', JSON.stringify(out));
    await until(() => s.getTranscripts(0).transcripts.some((t) => t.userId === 'trk'), 'transcript via the given track', { timeout: 12000 });
  } finally { await b.close(); await s.close(); try { unlinkSync(wav); } catch (e) {} }
});

test('T0904-06a — the capture module and worklet carry CORS for a listed client origin only', async () => {
  const listed = 'http://127.0.0.1:59999';
  const s = await createServer({ port: 0, voiceEnabled: true, voiceClientOrigins: [listed] });
  try {
    for (const p of ['/lib/voice-capture.mjs', '/lib/voice-worklet.js', '/lib/voice-link.mjs']) {
      const ok = await fetch(s.url() + p, { headers: { origin: listed } });
      expect(ok.status === 200 && ok.headers.get('access-control-allow-origin') === listed, p + ' allows the listed origin', `${ok.status} ${ok.headers.get('access-control-allow-origin')}`);
      expect(/Origin/.test(ok.headers.get('vary') || ''), p + ' varies on Origin', ok.headers.get('vary'));
      const no = await fetch(s.url() + p, { headers: { origin: 'http://elsewhere.invalid' } });
      expect(no.headers.get('access-control-allow-origin') === null, p + ' does not allow an unlisted origin', no.headers.get('access-control-allow-origin'));
    }
  } finally { await s.close(); }
});
