/*
 * T-TURN-BUDGET (Plan 0473, P5) — PROACTIVE per-turn budget, TRANSPARENT (never a silent truncation).
 *
 * A single conversational TURN (P2) is time-bounded by the ACTIVE PROFILE's `perTurnBudget` knob
 * (per role/trust — read from api.profile(), NEVER a name fork). This is the user-facing proactive
 * layer that sits ABOVE the existing hard VOICE_SEG_MAX_BYTES backstop (which is kept). It matters
 * most for VOICE ("talkative granny who won't yield the floor"), but the engine is turn-generic.
 *
 * As an OPEN turn approaches its budget the server emits a visible WRAP-UP cue to that speaker
 * ({t:'turn_budget', state:'wrap'}) BEFORE the cap; AT the cap it gracefully CLOSES/YIELDS the turn
 * and NOTIFIES the speaker ({t:'turn_budget', state:'closed'}) — the already-captured content is
 * PRESERVED (settled as a turn), never silently cut.
 *
 *   (a) a turn approaching the budget receives a WRAP-UP signal BEFORE the cap;
 *   (b) at the cap the turn is CLOSED/yielded and the speaker is NOTIFIED (a 'closed' signal), NOT
 *       silently truncated — the captured content survives as a settled turn (turnComplete fires);
 *   (c) the budget value differs by role/profile: the wearable's SOFT + GENEROUS value is read from
 *       the profile (so a short test window never trips it), while a SHORTER injected budget trips
 *       sooner. Injected via createServer({perTurnBudgetMs, perTurnWrapMs}) — a tuning override
 *       THREADED THROUGH the profile knob (like settlingMs / queueTtlMs), not a code hack.
 *
 * A LONG settlingMs keeps the turn OPEN for the whole test so the BUDGET (not settling) is what
 * closes it — proving the proactive budget, independent of the P2 settling window.
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
async function until(pred, label, { timeout = 5000 } = {}) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(20); } throw new Error('timeout ' + label); }
const chat = (c, text, id) => c.ws.send(JSON.stringify({ t: 'chat', text, id }));
const budgetMsgs = (c) => c.msgs.filter((m) => m.t === 'turn_budget');

// (a)+(b): a long-running turn gets a WRAP-UP before the cap, then a graceful CLOSE + NOTIFY at the
// cap — and its captured content is preserved (never a silent truncation).
test('T-TURN-BUDGET (a)+(b): wrap-up BEFORE the cap, graceful close + notify AT the cap, never silent', async () => {
  // settling 5s ⇒ the turn stays OPEN (budget, not settling, closes it). Injected budget: wrap@100ms,
  // close@280ms — threaded through the profile knob, deterministic.
  const s = await createServer({ port: 0, settlingMs: 5000, perTurnWrapMs: 100, perTurnBudgetMs: 280 });
  try {
    const turns = [];
    s.on('turnComplete', (t) => turns.push(t));
    const c = await client(s.url(), { userId: 'u1', userName: 'Granny', role: 'participant' });

    // one utterance opens a turn; the speaker then holds the floor (no more items) — the budget clock runs.
    chat(c, 'let me tell you a very long story about the war', 'm1');
    await until(() => s.getInbox(0).items.length >= 1, 'item lands');

    // (a) the WRAP-UP cue arrives BEFORE the cap — the turn is still OPEN (not yet closed) at wrap time.
    await until(() => budgetMsgs(c).some((m) => m.state === 'wrap'), 'wrap-up cue arrives');
    const atWrap = budgetMsgs(c);
    expect('the wrap cue is the FIRST budget signal (before any close)', atWrap[0].state === 'wrap', JSON.stringify(atWrap.map((m) => m.state)));
    expect('no CLOSE has fired at wrap time (wrap is proactive, before the cap)', !atWrap.some((m) => m.state === 'closed'), JSON.stringify(atWrap.map((m) => m.state)));
    expect('the wrap cue carries the turnId', typeof atWrap[0].turnId === 'string' && atWrap[0].turnId.length > 0, JSON.stringify(atWrap[0]));
    expect('turn still OPEN at wrap (not yet settled by the budget)', turns.length === 0, String(turns.length));

    // (b) AT the cap the turn is CLOSED/yielded and the speaker NOTIFIED — never a silent cut.
    await until(() => budgetMsgs(c).some((m) => m.state === 'closed'), 'close + notify at the cap');
    const closed = budgetMsgs(c).find((m) => m.state === 'closed');
    expect('the speaker is NOTIFIED of the close (never silent)', !!closed, JSON.stringify(budgetMsgs(c)));
    expect('the close carries the same turnId', closed.turnId === atWrap[0].turnId, closed.turnId + ' vs ' + atWrap[0].turnId);
    // the budget close SETTLES the turn (content preserved), it does NOT discard/truncate it.
    await until(() => turns.length >= 1, 'budget close settles the turn');
    expect('turnComplete fired ⇒ the captured content is preserved as a settled turn (not dropped)', turns[0].turnId === closed.turnId, JSON.stringify(turns.map((t) => t.turnId)));
    expect('the close reason marks it a budget close (auditable, not a silent cut)', closed.reason === 'budget' || turns[0].reason === 'budget', JSON.stringify({ closed, turn: turns[0] }));
    const items = s.getInbox(0).items;
    expect('the utterance text SURVIVES (nothing truncated away)', items.length === 1 && /long story/.test(items[0].text), JSON.stringify(items.map((i) => i.text)));
    c.ws.close();
  } finally { await s.close(); }
});

// (c) the wearable's SOFT + GENEROUS budget is READ FROM THE PROFILE (not global): a short test window
// never trips it — while a SHORTER injected budget on the SAME engine trips sooner. Proves per-role/
// per-profile budget as DATA.
test('T-TURN-BUDGET (c): generous wearable budget is read from the profile; a shorter injected budget trips sooner', async () => {
  // --- the profile knob is DATA: wearable = soft + generous (>=60s) for the trusted self/participant. ---
  const gen = await createServer({ port: 0, settlingMs: 5000 });
  try {
    const p = gen.profile().perTurnBudget;
    expect('wearable per-turn budget is SOFT (wrap-up cue, not a hard cut)', p && p.mode === 'soft', JSON.stringify(p));
    expect('wearable budget is GENEROUS (>=60s) for the trusted solo role', p.byRole && p.byRole.participant >= 60000, JSON.stringify(p.byRole));

    // With the generous profile default, a SHORT window sees NO wrap/close (the budget is ~120s, not tripped).
    const c = await client(gen.url(), { userId: 'g1', userName: 'Bruce', role: 'participant' });
    chat(c, 'a brief line under the generous budget', 'g-m1');
    await until(() => gen.getInbox(0).items.length >= 1, 'item lands');
    await wait(350);
    expect('NO budget signal under the generous profile default (nothing tripped)', budgetMsgs(c).length === 0, JSON.stringify(budgetMsgs(c)));
    c.ws.close();
  } finally { await gen.close(); }

  // --- a SHORTER injected budget on the same engine trips SOONER (data-driven, same code path). ---
  const short = await createServer({ port: 0, settlingMs: 5000, perTurnWrapMs: 60, perTurnBudgetMs: 160 });
  try {
    const c = await client(short.url(), { userId: 's1', userName: 'Granny', role: 'participant' });
    chat(c, 'and another long ramble about the old days', 's-m1');
    await until(() => short.getInbox(0).items.length >= 1, 'item lands');
    await until(() => budgetMsgs(c).some((m) => m.state === 'closed'), 'shorter budget trips the close sooner');
    const states = budgetMsgs(c).map((m) => m.state);
    expect('the shorter injected budget produced BOTH wrap then close', states.includes('wrap') && states.includes('closed') && states.indexOf('wrap') < states.indexOf('closed'), JSON.stringify(states));
    c.ws.close();
  } finally { await short.close(); }
});
