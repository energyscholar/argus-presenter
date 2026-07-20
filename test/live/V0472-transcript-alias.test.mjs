/*
 * T-TRANSCRIPT-ALIAS (Plan 0472, Phase 1). presenter_transcript still returns VOICE-ONLY items
 * (back-compat) — it delegates to the unified inbox filtered by kind==='voice'. A typed-text item
 * in the inbox must NOT appear in the transcript view.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { toolMap } from '../../mcp/tools.mjs';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const STUB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'voice', 'asr-stub.mjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws'));
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('message', (d, b) => { if (b) return; let m; try { m = JSON.parse(d.toString()); } catch (e) { return; } if (m.t === 'welcome') resolve({ ws }); });
  });
}
function pcm(n, amp = 9000) { const a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = Math.round(amp * Math.sin(2 * Math.PI * 300 * i / 16000)); return Buffer.from(a.buffer); }
async function until(pred, label, { timeout = 5000 } = {}) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(50); } throw new Error('timeout ' + label); }

test('T-TRANSCRIPT-ALIAS presenter_transcript stays voice-only (back-compat) over the unified inbox', async () => {
  process.env.PRESENTER_ASR_CMD = 'node ' + STUB;
  delete process.env.AP_ASR_COUNT_FILE;
  const T = toolMap({ voiceEnabled: true });
  await T.presenter_start.handler({ port: 0 });
  try {
    const c = await client((await T.presenter_status.handler({})).url, { userId: 'u1', userName: 'Bruce', role: 'participant' });

    // one voice, one text
    c.ws.send(JSON.stringify({ t: 'voice_seg_start', seq: 1 })); c.ws.send(pcm(8000)); c.ws.send(JSON.stringify({ t: 'voice_seg_end', seq: 1 }));
    c.ws.send(JSON.stringify({ t: 'chat', text: 'typed not spoken', id: 'x1' }));
    await until(async () => (await T.presenter_inbox.handler({ since: 0 })).items.length >= 2, 'both items');

    const tr = await T.presenter_transcript.handler({ since: 0 });
    expect('presenter_transcript returns exactly the ONE voice item', tr.transcripts.length === 1, JSON.stringify(tr.transcripts.map((x) => x.text)));
    expect('the voice item text', tr.transcripts[0].text === 'hello world', tr.transcripts[0].text);
    expect('transcript view excludes typed text', !tr.transcripts.some((x) => x.text === 'typed not spoken'), JSON.stringify(tr.transcripts));

    c.ws.close();
  } finally { await T.presenter_stop.handler({}); }
});
