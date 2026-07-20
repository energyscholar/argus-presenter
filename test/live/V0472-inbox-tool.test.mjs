/*
 * T-INBOX-TOOL (Plan 0472, Phase 1). The new MCP presenter_inbox({since}) returns {items: seq>since,
 * cursor} interleaving voice + text by seq. (Fails today: the tool is absent.)
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

test('T-INBOX-TOOL presenter_inbox({since}) interleaves voice+text by seq with a cursor', async () => {
  process.env.PRESENTER_ASR_CMD = 'node ' + STUB;
  delete process.env.AP_ASR_COUNT_FILE;
  const T = toolMap();
  expect('presenter_inbox is registered', !!T.presenter_inbox);
  await T.presenter_start.handler({ port: 0 });
  try {
    const c = await client((await T.presenter_status.handler({})).url, { userId: 'u1', userName: 'Bruce', role: 'participant' });

    // interleave: text, then voice, then text
    c.ws.send(JSON.stringify({ t: 'chat', text: 'first', id: 't1' }));
    await until(async () => (await T.presenter_inbox.handler({ since: 0 })).items.length >= 1, 'text 1');
    c.ws.send(JSON.stringify({ t: 'voice_seg_start', seq: 1 })); c.ws.send(pcm(8000)); c.ws.send(JSON.stringify({ t: 'voice_seg_end', seq: 1 }));
    await until(async () => (await T.presenter_inbox.handler({ since: 0 })).items.some((i) => i.kind === 'voice'), 'voice');
    c.ws.send(JSON.stringify({ t: 'chat', text: 'third', id: 't3' }));
    await until(async () => (await T.presenter_inbox.handler({ since: 0 })).items.length >= 3, 'text 2');

    const all = await T.presenter_inbox.handler({ since: 0 });
    expect('three items returned', all.items.length === 3, JSON.stringify(all.items.map((i) => i.kind)));
    expect('interleaved kinds text,voice,text in seq order', all.items.map((i) => i.kind).join(',') === 'text,voice,text', all.items.map((i) => i.kind).join(','));
    expect('cursor equals the last item seq', all.cursor === all.items[all.items.length - 1].seq, `cursor=${all.cursor}`);

    // cursored poll: nothing past the cursor
    const past = await T.presenter_inbox.handler({ since: all.cursor });
    expect('cursored poll returns nothing past the cursor', past.items.length === 0, JSON.stringify(past));

    // partial cursor: only items after the first
    const afterFirst = await T.presenter_inbox.handler({ since: all.items[0].seq });
    expect('since=first seq returns exactly the last two', afterFirst.items.length === 2 && afterFirst.items[0].seq === all.items[1].seq, JSON.stringify(afterFirst.items.map((i) => i.seq)));

    c.ws.close();
  } finally { await T.presenter_stop.handler({}); }
});
