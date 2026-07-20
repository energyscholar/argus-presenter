/*
 * T-INBOX-UNIFIED (Plan 0472, Phase 1). Both a VOICE transcript AND a TYPED-TEXT message land in
 * ONE inbox ring as items {seq, kind:'voice'|'text', userId, userName, role, text, conf|null, final,
 * ts, sessionId}, attributed by SERVER-AUTHORITATIVE identity, ordered by a single global monotonic
 * seq. (Fails today: typed text isn't in the ring; getInbox doesn't exist.)
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
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

test('T-INBOX-UNIFIED voice + typed text land in ONE ring, seq-ordered, server-attributed', async () => {
  process.env.PRESENTER_ASR_CMD = 'node ' + STUB;
  delete process.env.AP_ASR_COUNT_FILE;
  const s = await createServer({ port: 0 });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'Bruce', role: 'participant' });

    // (1) speak a voice segment -> a voice item
    c.ws.send(JSON.stringify({ t: 'voice_seg_start', seq: 1 }));
    c.ws.send(pcm(8000));
    c.ws.send(JSON.stringify({ t: 'voice_seg_end', seq: 1 }));
    await until(() => s.getInbox && s.getInbox(0).items.some((i) => i.kind === 'voice'), 'voice item in inbox');

    // (2) type text -> a text item (first-class, NOT an anonymous store op)
    c.ws.send(JSON.stringify({ t: 'chat', text: 'hello from keyboard', id: 'u1-typed-1' }));
    await until(() => s.getInbox(0).items.some((i) => i.kind === 'text'), 'text item in inbox');

    const items = s.getInbox(0).items;
    const v = items.find((i) => i.kind === 'voice');
    const tx = items.find((i) => i.kind === 'text');
    expect('both kinds present in ONE ring', !!v && !!tx, JSON.stringify(items.map((i) => i.kind)));

    // server-authoritative attribution (from the connection, never the client payload)
    expect('voice attributed to u1/Bruce/participant', v.userId === 'u1' && v.userName === 'Bruce' && v.role === 'participant', JSON.stringify(v));
    expect('text attributed to u1/Bruce/participant', tx.userId === 'u1' && tx.userName === 'Bruce' && tx.role === 'participant', JSON.stringify(tx));
    expect('text carries the typed text', tx.text === 'hello from keyboard', tx.text);

    // single global monotonic seq (voice emitted first -> lower seq)
    expect('one global monotonic seq (voice < text)', v.seq < tx.seq && Number.isInteger(v.seq) && Number.isInteger(tx.seq), `v=${v.seq} tx=${tx.seq}`);
    expect('items are returned in seq order', items.every((it, i) => i === 0 || items[i - 1].seq < it.seq), JSON.stringify(items.map((i) => i.seq)));

    // item shape (flat, extensible object)
    for (const it of [v, tx]) {
      expect(`item ${it.kind} has full shape`,
        'seq' in it && 'kind' in it && 'userId' in it && 'userName' in it && 'role' in it &&
        'text' in it && 'conf' in it && 'final' in it && typeof it.ts === 'number' && 'sessionId' in it,
        JSON.stringify(it));
    }
    expect('voice conf is a number', typeof v.conf === 'number', String(v.conf));
    expect('text conf is null (no ASR confidence for typed text)', tx.conf === null, String(tx.conf));
    expect('both items final:true (segment-final)', v.final === true && tx.final === true, `${v.final}/${tx.final}`);
    expect('both items share the same sessionId', v.sessionId === tx.sessionId && !!v.sessionId, `${v.sessionId}/${tx.sessionId}`);

    c.ws.close();
  } finally { await s.close(); }
});
