/*
 * Plan 0473 P7 — ROLLING SUMMARY: continuity BEYOND the recent-N turns.
 *
 * The situation digest (P3) surfaces only the last-N coalesced turns. A live session is UNBOUNDED in
 * duration, so context OLDER than N would be LOST — an agent (or a solo wearable over a long
 * conversation) would go amnesiac past N. The rolling summary RETAINS that aged-out context while
 * itself staying BOUNDED, is PRECOMPUTED incrementally (never on-read), and is fed the P6 reactive
 * shed so shed ambient is REPRESENTED (with a count), never silently discarded.
 *
 *   T-SUMMARY-RETAIN — after M turns beyond the recent-N window (recent-N=20), context that has
 *                      SCROLLED OUT of recentTurns is still REPRESENTED in situation().summary; the
 *                      summary stays BOUNDED as the session grows; shed ambient (P6) is reflected in
 *                      the summary WITH a count; and situation() returns PROMPTLY (never blocks on
 *                      summary computation — it serves the last precomputed snapshot).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws'));
    const msgs = [];
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('message', (d, b) => { if (b) return; let m; try { m = JSON.parse(d.toString()); } catch (e) { return; } msgs.push(m); if (m.t === 'welcome') resolve({ ws, msgs }); });
  });
}
async function until(pred, label, { timeout = 20000 } = {}) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(20); } throw new Error('timeout ' + label); }
const chat = (c, text, id) => c.ws.send(JSON.stringify({ t: 'chat', text, id }));

// T-SUMMARY-RETAIN: aged-out context is retained in a BOUNDED, PRECOMPUTED, NON-BLOCKING summary;
// the P6 shed is represented WITH a count.
test('T-SUMMARY-RETAIN: aged-out context retained in a bounded, precomputed, non-blocking summary; shed represented', async () => {
  // settlingMs:0 ⇒ each chat is its own settled turn (deterministic turns). Wearable default recent-N=20.
  const s = await createServer({ port: 0, settlingMs: 0 });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'Bruce', role: 'participant' });

    // Drive M turns FAR beyond the recent-N window so many turns scroll out of recentTurns.
    const M = 200;
    for (let i = 0; i < M; i++) chat(c, 'turn marker-' + i + ' with some filler words to add weight', 'k' + i);
    await until(() => s.getInbox(0).cursor >= M, 'all ' + M + ' turns ingested');
    // let the last turn settle (settlingMs:0 settles synchronously, but be safe)
    await until(() => s.situation({ consumerId: 'probe' }).recentTurns.length >= 20, 'recent window filled');

    // --- PROMPTNESS: situation() must NOT block on summary work — it serves precomputed state. ---
    const t0 = Date.now();
    const sit = s.situation({ consumerId: 'A' });
    const elapsed = Date.now() - t0;
    expect('situation() returns a plain object synchronously (does NOT block on summary work)', sit && typeof sit.then !== 'function', typeof sit);
    expect('situation() returned promptly (<50ms — precomputed, not computed on read)', elapsed < 50, elapsed + 'ms');

    // --- RETAIN: the summary exists and is a bounded object. ---
    expect('situation carries a summary', sit.summary && typeof sit.summary === 'object', JSON.stringify(sit.summary));

    // recentTurns holds only the last 20 (0-indexed 180..199) — everything <=179 has aged OUT.
    expect('recentTurns bounded to <= 20', sit.recentTurns.length <= 20, String(sit.recentTurns.length));
    const inWindow = new Set(sit.recentTurns.map((t) => (t.text || '')));
    expect('an early aged-out turn (marker-5) is NOT in the recent window', ![...inWindow].some((x) => /\bmarker-5\b/.test(x)), 'marker-5 unexpectedly still in window');

    // an aged-out (but not ancient) turn is REPRESENTED in the rolling summary — continuity beyond recent-N.
    const agedIdx = M - 30;   // 170: aged out of the 20-window, still within the summary's detail retention
    expect('an aged-out turn (marker-' + agedIdx + ') is REPRESENTED in the summary', new RegExp('marker-' + agedIdx + '\\b').test(sit.summary.text || ''), (sit.summary.text || '').slice(-300));
    // the continuity COUNT reflects that turns beyond the window were folded (not lost).
    expect('summary.turnsSummarized reflects the aged-out turns (>= M - 20)', sit.summary.turnsSummarized >= M - 20, String(sit.summary.turnsSummarized));

    // --- BOUNDED: the summary is size-capped regardless of session length. ---
    const summarySize = JSON.stringify(sit.summary).length;
    expect('summary stays BOUNDED (< 8KB) even after ' + M + ' turns', summarySize < 8000, summarySize + ' bytes');

    // --- PRECOMPUTED: a second read (no new turns) returns the SAME retained summary (not recomputed to empty). ---
    const sit2 = s.situation({ consumerId: 'A' });
    expect('summary persists across reads (precomputed, not on-read)', new RegExp('marker-' + agedIdx + '\\b').test(sit2.summary.text || ''), 'aged marker lost on re-read');
    c.ws.close();
  } finally { await s.close(); }
});

// T-SUMMARY-RETAIN (shed arm): the P6 reactive shed folds ambient INTO the summary WITH a count —
// shed ambient is REPRESENTED, never silently discarded.
test('T-SUMMARY-RETAIN (shed): P6-shed ambient is represented in the summary with a count', async () => {
  // Tiny queue bound so an ambient flood overflows → the reactive backstop sheds (P6). Wearable
  // enqueue:'all' ⇒ ambient enters as low priority. settlingMs:0 ⇒ one turn per line.
  const s = await createServer({ port: 0, settlingMs: 0, queueMaxPending: 3 });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'Bruce', role: 'participant' });

    for (let i = 0; i < 20; i++) chat(c, 'ambient chatter number ' + i, 'a' + i);
    await until(() => s.backpressure().sheddedCount > 0, 'ambient overflow shed');

    const sit = s.situation({ consumerId: 'shed' });
    const bp = sit.backpressure;
    expect('reactive shed fired (backpressure.sheddedCount > 0)', bp && bp.sheddedCount > 0, JSON.stringify(bp));
    // the shed is REPRESENTED in the rolling summary (with a count) — not a silent drop.
    expect('summary.sheddedFolded reflects the P6 shed (>= 1)', sit.summary && sit.summary.sheddedFolded >= 1, JSON.stringify(sit.summary));
    expect('summary.sheddedFolded tracks the surfaced shed count', sit.summary.sheddedFolded === bp.sheddedCount, sit.summary.sheddedFolded + ' vs ' + bp.sheddedCount);
    c.ws.close();
  } finally { await s.close(); }
});
