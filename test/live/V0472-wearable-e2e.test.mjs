/*
 * T-WEARABLE-E2E (Plan 0472, Phase 1). The wearable orchestration path end-to-end: a Bruce-role
 * client both SPEAKS (voice item) and TYPES (text item); a single presenter_inbox LONG-POLL returns
 * BOTH, correctly attributed and seq-ordered — exactly what a standing Argus consumer loop reads.
 * (Stub ASR is fine for the inbox assertions; the real-whisper smoke is the Auditor's separate gate.)
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

test('T-WEARABLE-E2E speak + type -> a single presenter_inbox long-poll returns both, attributed + ordered', async () => {
  process.env.PRESENTER_ASR_CMD = 'node ' + STUB;
  delete process.env.AP_ASR_COUNT_FILE;
  const T = toolMap();
  await T.presenter_start.handler({ port: 0 });
  try {
    const url = (await T.presenter_status.handler({})).url;
    const bruce = await client(url, { userId: 'bruce', userName: 'Bruce', role: 'participant' });

    // The standing consumer opens a long-poll on an empty inbox: it should BLOCK, then wake as
    // items arrive. Fire the long-poll first, THEN speak + type.
    const poll = T.presenter_inbox.handler({ since: 0, waitMs: 4000 });
    await wait(60);

    // speak
    bruce.ws.send(JSON.stringify({ t: 'voice_seg_start', seq: 1 }));
    bruce.ws.send(pcm(8000));
    bruce.ws.send(JSON.stringify({ t: 'voice_seg_end', seq: 1 }));

    // The long-poll wakes on the first item (voice). Read whatever it returned, then drain the rest.
    const first = await poll;
    expect('long-poll woke with at least the voice item', first.items.length >= 1 && first.items.some((i) => i.kind === 'voice'), JSON.stringify(first.items.map((i) => i.kind)));

    // type (after the first wake) — a subsequent poll from the returned cursor gets the text item
    bruce.ws.send(JSON.stringify({ t: 'chat', text: 'and typed too', id: 'bt1' }));
    const second = await T.presenter_inbox.handler({ since: first.cursor, waitMs: 4000 });
    expect('follow-up long-poll returns the typed text', second.items.some((i) => i.kind === 'text' && i.text === 'and typed too'), JSON.stringify(second.items));

    // full-history assertion: both items present, attributed to bruce, seq-ordered voice<text
    const all = (await T.presenter_inbox.handler({ since: 0 })).items;
    const v = all.find((i) => i.kind === 'voice'), tx = all.find((i) => i.kind === 'text');
    expect('both a voice and a text item exist', !!v && !!tx, JSON.stringify(all.map((i) => i.kind)));
    expect('both attributed to the Bruce-role client', v.userId === 'bruce' && tx.userId === 'bruce' && v.role === 'participant' && tx.role === 'participant', JSON.stringify([v, tx]));
    expect('seq-ordered: spoken-first < typed-second', v.seq < tx.seq, `v=${v.seq} tx=${tx.seq}`);

    bruce.ws.close();
  } finally { await T.presenter_stop.handler({}); }
});
