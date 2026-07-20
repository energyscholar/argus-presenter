/*
 * Plan 0473 P10 — RPG PROFILE SCENARIO GATE: T-SCENARIO-RPG.
 *
 * The rpg profile is the ~6-players-plus-GM table use case. Unlike the solo wearable (every directed
 * turn is a work item, nothing shed), an RPG table is FULL of player-to-player roleplay that is NOT
 * directed at the GM. That ambient chatter must NEVER clog the GM's work queue — but it is NARRATIVE,
 * so it must NEVER be discarded either: it is SUMMARIZED into continuity (the rolling summary, P7).
 * Only QUESTIONS/ACTIONS directed at the GM become work items. The GM digest (F-5) surfaces a
 * GM-relevant view (questions-to-GM + recent actions) — a seam/placeholder for the mcp-gm scene/
 * initiative/dice system, wired to the working set here.
 *
 * These are all DATA knobs (profiles.mjs rpg row): shedding='summarize', enqueue='questions',
 * digestContent='gm', floorThresholds.enabled=true — NOT a per-name code fork. Players are
 * PARTICIPANTS (P9): their turns are untrusted + fenced; identities are never merged across the 6.
 *
 * Simulate ~6 players (each its own identity) doing player-to-player roleplay AMBIENT plus one
 * QUESTION-TO-GM, and assert:
 *   (a) ambient roleplay is SUMMARIZED into continuity (folded to the rolling summary, never discarded;
 *       nothing silently shed);
 *   (b) the question-to-GM is a prioritized work item AHEAD of ambient (ambient does not enter the queue);
 *   (c) the GM digest surfaces GM-relevant content (questions-to-GM + recent actions) + the mcp-gm seam;
 *   (d) items are PER-SPEAKER attributed (never merged across the 6) and untrusted-FENCED (P9).
 *
 * settlingMs is tuned down for a fast test — a tuning override threaded through the profile knob
 * (established pattern), NOT a code fork.
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

test('T-SCENARIO-RPG (MILESTONE): 6 players + GM → ambient summarized-not-discarded, question-to-GM prioritized, GM digest, per-speaker fenced', async () => {
  // REAL rpg profile; only the settling window is tuned down for a fast test (knob override, not a fork).
  const s = await createServer({ port: 0, profile: 'rpg', settlingMs: 20 });
  try {
    // --- rpg is DATA & ACTIVE (knobs, not a code fork) ---
    const prof = s.profile();
    expect('rpg profile is selected', prof.name === 'rpg', prof.name);
    expect('rpg profile is WIRED (active, not a placeholder)', prof.wired === true, JSON.stringify({ wired: prof.wired }));
    expect('rpg ambient = SUMMARIZE (never discard narrative)', prof.shedding === 'summarize', prof.shedding);
    expect('rpg digest = GM view', prof.digestContent === 'gm', prof.digestContent);
    expect('rpg queue enqueues only questions/actions-to-GM (ambient does not clog)', prof.queuePolicy && prof.queuePolicy.enqueue === 'questions', JSON.stringify(prof.queuePolicy));
    expect('rpg floor control is ON (under load)', !!(prof.floorThresholds && prof.floorThresholds.enabled), JSON.stringify(prof.floorThresholds));

    // GM = a gated control role (presenter) ⇒ trust 'self' (unfenced). Players = participants (fenced).
    const gm = await wsClient(s.url(), { userId: 'gm', userName: 'GM', role: 'presenter' });
    const PLAYERS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const players = {};
    for (const pid of PLAYERS) players[pid] = await wsClient(s.url(), { userId: pid, userName: pid.toUpperCase(), role: 'participant' });

    // --- Player-to-player ROLEPLAY AMBIENT: many lines, round-robin across the 6 (alternating speakers ⇒
    // each is its own settled turn). NONE is directed at the GM (no '?') ⇒ none should enter the queue.
    // >20 turns so the OLDER ambient AGES OUT of the recent-N window and folds into the rolling summary. ---
    const AMBIENT = 30;
    for (let i = 0; i < AMBIENT; i++) {
      const pid = PLAYERS[i % PLAYERS.length];
      chat(players[pid], '<<' + pid + '>> roleplay ambient line ' + i, 'a' + i);
      await wait(4);   // keep sends ordered; a speaker change still closes the prior turn immediately
    }

    // --- One QUESTION-TO-GM from a player (ends with '?') — the directed work item. ---
    chat(players.p1, '<<p1>> GM do I spot the ambush 999?', 'q999');
    // Nudge the open question turn closed with one more distinct-speaker line, then let everything settle.
    chat(players.p2, '<<p2>> roleplay ambient line trailing', 'a-tail');
    await poll(() => s.workItems().some((w) => w.text.indexOf('999') >= 0), 'question-to-GM settled into a work item');
    await wait(80);   // let the trailing turns settle + age into the summary

    const ai = s.situation({ consumerId: 'argus' });

    // ===== (a) AMBIENT SUMMARIZED INTO CONTINUITY — never discarded, nothing silently shed =====
    expect('older ambient roleplay was FOLDED into the rolling summary (summarized, not discarded)',
      ai.summary && ai.summary.turnsSummarized >= 8, JSON.stringify(ai.summary && { turnsSummarized: ai.summary.turnsSummarized }));
    // Continuity at the RECENT edge: the most recent ambient is still verbatim in the working set.
    const recentText = (ai.recentTurns || []).map((t) => t.text).join(' | ');
    expect('recent ambient roleplay is preserved verbatim in the working set (continuity)',
      recentText.indexOf('roleplay ambient') >= 0, recentText.slice(0, 200));
    // Aged-out ambient DETAIL is retained in the summary text (bounded FIFO), not silently dropped.
    expect('aged-out ambient DETAIL is retained in the rolling summary (never silently dropped)',
      ai.summary && ai.summary.text && ai.summary.text.indexOf('roleplay ambient') >= 0, (ai.summary && ai.summary.text || '').slice(0, 200));
    // rpg sheds ambient from the QUEUE (enqueue='questions'), but that is SUMMARIZE-not-DROP: no reactive
    // queue-overflow shed occurred (ambient never entered the queue), so nothing was silently lost.
    expect('nothing was silently shed (ambient summarized, not queue-dropped)',
      s.backpressure().sheddedCount === 0, JSON.stringify(s.backpressure()));

    // ===== (b) QUESTION-TO-GM PRIORITIZED AHEAD OF AMBIENT (ambient does not clog the queue) =====
    const queue = ai.queue || [];
    const q = queue.find((w) => w.text.indexOf('999') >= 0);
    expect('the question-to-GM is a work item in the queue', !!q, JSON.stringify(queue.map((w) => w.text)));
    expect('the question-to-GM carries DIRECTED priority', q && q.priority === 2, JSON.stringify(q && { priority: q.priority }));
    expect('ambient roleplay does NOT enter the queue (never clogs it)',
      !queue.some((w) => w.text.indexOf('roleplay ambient') >= 0), JSON.stringify(queue.map((w) => w.text)));
    // "prioritized AHEAD of ambient": the only actionable items are the directed question(s); the sorted
    // queue head is the question, not chatter.
    expect('the queue head is the directed question, ahead of any ambient', queue[0] && queue[0].text.indexOf('999') >= 0, JSON.stringify(queue[0] && queue[0].text));

    // ===== (c) GM DIGEST surfaces GM-relevant content + the mcp-gm SEAM =====
    const digest = ai.situation && ai.situation.digest;
    expect('the situation carries a GM digest section', digest && digest.kind === 'gm', JSON.stringify(digest && { kind: digest.kind }));
    expect('GM digest surfaces questions-to-GM', digest && Array.isArray(digest.questionsToGm) && digest.questionsToGm.some((w) => w.text.indexOf('999') >= 0), JSON.stringify(digest && (digest.questionsToGm || []).map((w) => w.text)));
    expect('GM digest surfaces recent player actions', digest && Array.isArray(digest.recentActions) && digest.recentActions.length > 0, JSON.stringify(digest && { recentActions: (digest.recentActions || []).length }));
    // The mcp-gm scene/initiative/dice SEAM is present as a declared placeholder (NOT a full integration).
    expect('GM digest declares the mcp-gm seam (scene/initiative/dice placeholders)',
      digest && 'scene' in digest && 'initiative' in digest && 'dice' in digest, JSON.stringify(digest && Object.keys(digest)));

    // ===== (d) PER-SPEAKER ATTRIBUTED (never merged across 6) + UNTRUSTED-FENCED (P9) =====
    const ids = new Set((ai.recentTurns || []).map((t) => t.userId));
    expect('all 6 player identities are attributed distinctly in the working set (never merged)',
      PLAYERS.every((pid) => ids.has(pid)), JSON.stringify([...ids]));
    // No turn merges two identities: a turn's verbatim text carries only its OWN player marker.
    const merged = (ai.recentTurns || []).find((t) => PLAYERS.some((other) => other !== t.userId && t.text.indexOf('<<' + other + '>>') >= 0));
    expect('no turn merges two player identities', !merged, merged ? JSON.stringify({ userId: merged.userId, text: merged.text }) : 'none');
    // Players are PARTICIPANTS ⇒ every player turn is untrusted + fenced-as-data (P9 injection defense).
    const playerTurns = (ai.recentTurns || []).filter((t) => PLAYERS.includes(t.userId));
    expect('every player turn is marked untrusted', playerTurns.length > 0 && playerTurns.every((t) => t.untrusted === true), JSON.stringify(playerTurns.map((t) => t.untrusted)));
    expect('every player turn is FENCED as data (never merged into the instruction channel)',
      playerTurns.every((t) => typeof t.fenced === 'string' && t.fenced.length > 0), 'someUnfenced');
    // The queued question (from a player) is likewise untrusted + fenced.
    expect('the queued question-to-GM is untrusted + fenced (player = participant)',
      q && q.untrusted === true && typeof q.fenced === 'string', JSON.stringify(q && { untrusted: q.untrusted, hasFence: typeof q.fenced }));

    gm.ws.close();
    for (const pid of PLAYERS) players[pid].ws.close();
  } finally { await s.close(); }
});
