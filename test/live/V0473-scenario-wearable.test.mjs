/*
 * Plan 0473 — WEARABLE-INSTRUMENT MILESTONE GATE: T-SCENARIO-WEARABLE.
 *
 * The wearable is the solo, trusted, turn-by-turn use case: one speaker, every directed turn is a work
 * item, NOTHING is shed or deprioritized (profile.shedding='none'), snappy turns, the digest IS the
 * conversation, the queue is trivial (one pending exchange). This is the "instrument complete" gate:
 * simulate a LONG solo conversation PLAYED through the instrument (sense → act → resolve → repeat) and
 * assert the whole-system invariants hold end-to-end:
 *
 *   - NO turn is shed/deprioritized (wearable shedding=none ⇒ sheddedCount stays 0; no item ends 'shed';
 *     no item is deprioritized/deferred);
 *   - turns are LOW-LATENCY (the wearable settling window is the SHORT tier; a turn settles promptly);
 *   - the WORKING SET stays BOUNDED over the long session (recentTurns <= 20, response size capped,
 *     older context folded into the rolling summary WITH counts — retained, never silently dropped);
 *   - the HUMAN face (GET /api/situation) and the AI face (api.situation) stay COHERENT — one shared
 *     working set, consistent queue/status/owner — resolves through EITHER face agree.
 *
 * The profile is the REAL 'wearable' (default); only settlingMs is tuned down for a fast test — a tuning
 * override threaded through the profile knob (established pattern), NOT a code fork. The instrument is
 * played correctly (each solo exchange is resolved as it arrives), which is exactly why nothing is shed.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function wsClient(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws'));
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('message', (d, b) => { if (b) return; let m; try { m = JSON.parse(d.toString()); } catch (e) { return; } if (m.t === 'welcome') resolve({ ws }); });
  });
}
async function poll(pred, label, { timeout = 6000 } = {}) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(15); } throw new Error('timeout ' + label); }
const chat = (c, text, id) => c.ws.send(JSON.stringify({ t: 'chat', text, id }));

test('T-SCENARIO-WEARABLE (MILESTONE): long solo conversation → nothing shed, low-latency, bounded, faces coherent', async () => {
  // REAL wearable profile (default); only the settling window is tuned down for a fast test.
  const s = await createServer({ port: 0, profile: 'wearable', settlingMs: 20 });
  try {
    const solo = await wsClient(s.url(), { userId: 'bruce', userName: 'Bruce', role: 'self' });

    // The wearable design: shedding NONE, digest = conversation, snappy (SHORT settling), floor OFF.
    const prof = s.profile();
    expect('wearable shedding is NONE (nothing directed is ever shed)', prof.shedding === 'none', prof.shedding);
    expect('wearable digest IS the conversation', prof.digestContent === 'conversation', prof.digestContent);
    expect('wearable floor control is OFF (solo, one speaker)', !(prof.floorThresholds && prof.floorThresholds.enabled), JSON.stringify(prof.floorThresholds));

    const N = 40;                       // a LONG solo conversation (well past the recent-N window of 20)
    let latencyMax = 0;
    for (let i = 0; i < N; i++) {
      const t0 = Date.now();
      // alternate directed questions and statements — in the wearable profile ALL directed turns enqueue.
      const text = (i % 2 === 0) ? ('point number ' + i + ' i want to make') : ('what about option ' + i + '?');
      chat(solo, text, 'k' + i);
      await poll(() => s.workItems().some((w) => w.turnId && w.text.indexOf('' + i) >= 0), 'turn ' + i + ' settled into a work item');
      latencyMax = Math.max(latencyMax, Date.now() - t0);

      // The two faces are ONE working set: the human GET and the AI read show the SAME queue ids/status.
      const human = await (await fetch(s.url() + '/api/situation?c=human')).json();
      const ai = s.situation({ consumerId: 'argus' });
      const hIds = JSON.stringify((human.queue || []).map((w) => w.id + ':' + w.status));
      const aIds = JSON.stringify((ai.queue || []).map((w) => w.id + ':' + w.status));
      expect('faces coherent at turn ' + i + ' (same queue + status)', hIds === aIds, hIds + ' vs ' + aIds);

      // BOUNDED working set even deep into the session.
      expect('working set bounded at turn ' + i + ' (recentTurns <= 20)', (ai.recentTurns || []).length <= 20, String((ai.recentTurns || []).length));
      expect('response size capped at turn ' + i, JSON.stringify(ai).length < 100000, JSON.stringify(ai).length + ' bytes');

      // NOTHING shed at any point (wearable shedding=none).
      expect('sheddedCount still 0 at turn ' + i + ' (nothing shed)', s.backpressure().sheddedCount === 0, JSON.stringify(s.backpressure()));

      // Play the instrument: PROCESS the exchange (alternate the two faces to prove both resolve paths),
      // so the trivial one-pending-exchange queue never overflows and nothing is shed.
      const item = s.workItems().find((w) => w.text.indexOf('' + i) >= 0);
      if (i % 2 === 0) {
        await fetch(s.url() + '/api/work', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: item.id, op: 'resolve' }) });   // human face
      } else {
        s.resolveWork(item.id);   // AI face (api, as the MCP tool would)
      }
      expect('the just-processed item is resolved on both faces at turn ' + i, s.workItem(item.id).status === 'resolved', JSON.stringify(s.workItem(item.id)));
    }

    // --- End-of-session whole-system invariants ---
    // Low-latency: every turn settled promptly (SHORT window), never a multi-second stall.
    expect('turns were low-latency across the long session', latencyMax < 1500, 'maxLatency=' + latencyMax + 'ms');

    // Nothing shed / deprioritized across the ENTIRE long session.
    expect('sheddedCount is 0 for the whole long solo session (nothing shed)', s.backpressure().sheddedCount === 0, JSON.stringify(s.backpressure()));
    // No work item ever ended in a shed/expired/deferred (deprioritized) status.
    const all = s.debugAllWorkItems ? s.debugAllWorkItems() : null;
    if (all) {
      expect('no work item was ever SHED', !all.some((w) => w.status === 'shed'), JSON.stringify(all.filter((w) => w.status === 'shed').map((w) => w.id)));
      expect('no work item was ever DEPRIORITIZED (deferred)', !all.some((w) => w.deferred), JSON.stringify(all.filter((w) => w.deferred).map((w) => w.id)));
      expect('every directed turn became a work item and was processed (all resolved)', all.length >= N && all.every((w) => w.status === 'resolved'), 'n=' + all.length);
    }

    // Bounded + continuity: older context folded into the rolling summary WITH counts (retained, not lost).
    const finalAi = s.situation({ consumerId: 'argus' });
    expect('final working set stays bounded (recentTurns <= 20)', (finalAi.recentTurns || []).length <= 20, String((finalAi.recentTurns || []).length));
    expect('older turns were retained in the rolling summary (continuity, not amnesia)', finalAi.summary && finalAi.summary.turnsSummarized >= (N - 20), JSON.stringify(finalAi.summary && { turnsSummarized: finalAi.summary.turnsSummarized }));
    expect('nothing was folded via a SILENT shed (sheddedFolded stays 0 for wearable)', finalAi.summary && finalAi.summary.sheddedFolded === 0, JSON.stringify(finalAi.summary && { sheddedFolded: finalAi.summary.sheddedFolded }));

    // Faces coherent at the end (queue empty on both — everything processed).
    const humanEnd = await (await fetch(s.url() + '/api/situation?c=human')).json();
    expect('both faces show an empty actionable queue at the end (all processed, coherent)', (humanEnd.queue || []).length === 0 && (finalAi.queue || []).length === 0, JSON.stringify({ h: (humanEnd.queue || []).length, a: (finalAi.queue || []).length }));

    solo.ws.close();
  } finally { await s.close(); }
});
