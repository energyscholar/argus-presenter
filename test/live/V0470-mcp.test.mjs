/*
 * T-MCP (Plan 0470, Phase A). The two new tools on the MCP surface: presenter_voice_enable
 * (request-only mic enable) and presenter_transcript (cursored poll of recognized speech).
 * Drives them through the real tool handlers + a stub ASR worker (no whisper, no browser).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { toolMap, _server } from '../../mcp/tools.mjs';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const STUB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'voice', 'asr-stub.mjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws'));
    const msgs = [];
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('message', (d, b) => { if (b) return; let m; try { m = JSON.parse(d.toString()); } catch (e) { return; } msgs.push(m); if (m.t === 'welcome') resolve({ ws, msgs }); });
  });
}
function pcm(n, amp = 9000) { const a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = Math.round(amp * Math.sin(2 * Math.PI * 300 * i / 16000)); return Buffer.from(a.buffer); }
async function until(pred, label, { timeout = 5000 } = {}) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(50); } throw new Error('timeout ' + label); }

test('T-MCP presenter_voice_enable + presenter_transcript (cursored) on the tool surface', async () => {
  process.env.PRESENTER_ASR_CMD = 'node ' + STUB;
  delete process.env.AP_ASR_COUNT_FILE;
  const T = toolMap({ voiceEnabled: true });
  expect('presenter_voice_enable is registered', !!T.presenter_voice_enable);
  expect('presenter_transcript is registered', !!T.presenter_transcript);
  const started = await T.presenter_start.handler({ port: 0 });
  expect('presenter_start returns url', /^http:\/\//.test(started.url), started.url);
  const s = _server();
  try {
    const spk = await client(s.url(), { userId: 'u1', userName: 'Alice', role: 'participant' });
    await client(s.url(), { userId: 'gm', userName: 'GM', role: 'presenter' });

    // presenter_voice_enable only REQUESTS — returns how many targets it signalled.
    const req = await T.presenter_voice_enable.handler({ target: 'all' });
    expect('voice_enable requested >=1 target', req.requested >= 1, JSON.stringify(req));

    // Drive one recognized segment, then read it via the cursored transcript tool.
    spk.ws.send(JSON.stringify({ t: 'voice_seg_start', seq: 1 }));
    spk.ws.send(pcm(8000));
    spk.ws.send(JSON.stringify({ t: 'voice_seg_end', seq: 1 }));
    await until(async () => (await T.presenter_transcript.handler({ since: 0 })).transcripts.length >= 1, 'transcript via tool');

    const t0 = await T.presenter_transcript.handler({ since: 0 });
    expect('transcript text via MCP', t0.transcripts[0].text === 'hello world', JSON.stringify(t0.transcripts[0]));
    expect('cursor advanced', t0.cursor === 1, 'cursor=' + t0.cursor);
    const t1 = await T.presenter_transcript.handler({ since: t0.cursor });
    expect('cursored poll returns nothing past the cursor', t1.transcripts.length === 0, JSON.stringify(t1));
  } finally { await T.presenter_stop.handler({}); }
});
