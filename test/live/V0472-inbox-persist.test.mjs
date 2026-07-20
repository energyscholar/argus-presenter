/*
 * T-INBOX-PERSIST (Plan 0472, Phase 1, RT-26 uniformity). The Plan 0470 persistence policy applies
 * to TEXT too: default EPHEMERAL (in-ring only, nothing on disk); with PRESENTER_TRANSCRIPT_PERSIST
 * ON, TEXT items ALSO append to the JSONL; transcriptPersisting is surfaced on welcome.
 * (Fails today: typed text bypasses the ring/policy entirely.)
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, rmSync } from 'fs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws'));
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('message', (d, b) => { if (b) return; let m; try { m = JSON.parse(d.toString()); } catch (e) { return; } if (m.t === 'welcome') resolve({ ws, welcome: m }); });
  });
}
async function until(pred, label, { timeout = 5000 } = {}) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(50); } throw new Error('timeout ' + label); }

test('T-INBOX-PERSIST typed text is ephemeral by default; opt-in appends to JSONL (RT-26 uniformity)', async () => {
  const dir = join(tmpdir(), 'ap-inbox-tp-' + Date.now());
  const file = join(dir, 'transcripts.jsonl');

  // ---- OFF (default): text is ephemeral (ring only, nothing on disk) ----
  delete process.env.PRESENTER_TRANSCRIPT_PERSIST;
  process.env.PRESENTER_TRANSCRIPT_DIR = dir;
  let s = await createServer({ port: 0 });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'A', role: 'participant' });
    expect('OFF: welcome reports transcriptPersisting=false', c.welcome.transcriptPersisting === false, JSON.stringify(c.welcome));
    c.ws.send(JSON.stringify({ t: 'chat', text: 'ephemeral text', id: 'e1' }));
    await until(() => s.getInbox(0).items.some((i) => i.kind === 'text'), 'text in ring');
    expect('OFF: ring serves the typed text', s.getInbox(0).items.some((i) => i.kind === 'text' && i.text === 'ephemeral text'));
    expect('OFF: nothing written to disk for typed text', !existsSync(file));
    c.ws.close();
  } finally { await s.close(); }

  // ---- ON: typed text appends to the JSONL, uniform with voice ----
  process.env.PRESENTER_TRANSCRIPT_PERSIST = '1';
  process.env.PRESENTER_TRANSCRIPT_DIR = dir;
  s = await createServer({ port: 0 });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'A', role: 'participant' });
    expect('ON: welcome reports transcriptPersisting=true (consent surface)', c.welcome.transcriptPersisting === true, JSON.stringify(c.welcome));
    c.ws.send(JSON.stringify({ t: 'chat', text: 'durable text', id: 'd1' }));
    await until(() => existsSync(file) && readFileSync(file, 'utf8').trim().length > 0, 'jsonl written for text');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect('ON: exactly one JSONL line for the typed text', lines.length === 1, 'lines=' + lines.length);
    const rec = JSON.parse(lines[0]);
    expect('ON: JSONL line carries the text-item fields incl. kind=text', rec.text === 'durable text' && rec.userId === 'u1' && rec.kind === 'text' && typeof rec.ts === 'number' && 'seq' in rec && 'conf' in rec, JSON.stringify(rec));
    c.ws.close();
  } finally { await s.close(); }

  try { rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  delete process.env.PRESENTER_TRANSCRIPT_PERSIST; delete process.env.PRESENTER_TRANSCRIPT_DIR;
});
