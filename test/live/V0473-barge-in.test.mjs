/*
 * Plan 0473, P13 — BARGE-IN + OWN-TURNS (one coherent conversation object). Cross-plan (0469 + 0470).
 *
 * The OUTBOUND TTS reply leg (Plan 0469) is NOT built in this branch — so P13 provides the barge-in
 * MECHANISM + a fenced client seam, NOT real TTS audio. Two parts, both server-side:
 *
 *   (a) OWN-TURNS join the conversation. When the AI/controller emits an outbound reply
 *       (api.emitOwnTurn({text})) it lands in the SAME inbox/working-set as a turn with trust:'self'
 *       and role:'ai' — so presenter_situation / presenter_inbox show ONE coherent conversation that
 *       INCLUDES the agent's own contributions, not just inbound user turns. It is NOT fenced (self is
 *       the trusted instruction side) and it is NOT queued as a judgment item for the agent (own reply).
 *
 *   (b) BARGE-IN. The server tracks a "speaking" state (the agent's TTS reply is playing — set via
 *       emitOwnTurn or api.setSpeaking(true/false)). If a USER speaks (an inbound turn / voice_seg_start)
 *       WHILE speaking is active, the server emits a {t:'barge_in'} signal to the speaker(s) (the cue to
 *       DUCK/STOP the TTS — the actual audio duck is the Plan-0469 client seam) AND records the
 *       interruption as an inbound turn (never lost), and clears speaking-state.
 *
 *   T-BARGE-IN
 *     (a) an outbound own-turn appears in situation + inbox as a trust:'self' conversation item; the
 *         conversation object holds BOTH the user's turn and the agent's own turn.
 *     (b) with speaking active, a user speaking → a barge_in signal (server event + client frame) AND
 *         the interruption is recorded as an inbound turn (nothing lost); speaking-state cleared.
 *     (c) no barge-in fires when the agent is NOT speaking.
 *   T-ZERO-WHEN-OFF (regression) the barge-in cue is FENCED — absent from the served OFF page.
 *
 * settlingMs:0 ⇒ each item settles into its own completed turn (deterministic).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer, renderPresenterPage } from '../../app/server.mjs';
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
async function until(pred, label, { timeout = 5000 } = {}) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(15); } throw new Error('timeout ' + label); }
const chat = (c, text, id) => c.ws.send(JSON.stringify({ t: 'chat', text, id }));

// (a): the agent's OWN reply joins the ONE conversation object as trust:'self' — in situation + inbox.
test('T-BARGE-IN (own-turn): AI reply joins the conversation as a trust:self item in situation + inbox', async () => {
  const s = await createServer({ port: 0, settlingMs: 0 });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'Bruce', role: 'participant' });

    // the user speaks (an inbound turn)
    chat(c, 'hello argus a question', 'm1');
    await until(() => s.getInbox(0).items.some((i) => (i.text || '').includes('hello argus')), 'user turn lands');

    // the AI emits an OUTBOUND reply (own turn) — a server call, no real TTS in this branch
    const own = s.emitOwnTurn({ text: 'hello, how can I help you today' });
    expect('emitOwnTurn returns the emitted entry', own && (own.text || '').includes('how can I help'), JSON.stringify(own && own.text));
    await until(() => s.getInbox(0).items.some((i) => (i.text || '').includes('how can I help')), 'own turn lands');

    // inbox: the own item is trust:'self', flagged own, role 'ai', and NOT fenced (self is trusted).
    const oi = s.getInbox(0).items.find((i) => (i.text || '').includes('how can I help'));
    expect('own item trust is self', oi && oi.trust === 'self', JSON.stringify(oi && oi.trust));
    expect('own item is NOT untrusted', oi && oi.untrusted === false, JSON.stringify(oi && oi.untrusted));
    expect('own item is flagged own:true', oi && oi.own === true, JSON.stringify(oi && oi.own));
    expect('own item is attributed role ai', oi && oi.role === 'ai', JSON.stringify(oi && oi.role));
    expect('own item is NOT fenced', oi && oi.fenced === undefined, JSON.stringify(oi && oi.fenced));

    // situation: ONE coherent conversation object — BOTH the user turn AND the agent's own turn present.
    const sit = s.situation({ consumerId: 'argus' });
    const ownTurn = (sit.recentTurns || []).find((t) => (t.text || '').includes('how can I help'));
    const userTurn = (sit.recentTurns || []).find((t) => (t.text || '').includes('hello argus'));
    expect('agent own-turn is in the situation conversation', !!ownTurn, JSON.stringify((sit.recentTurns || []).map((t) => t.text)));
    expect('agent own-turn is trust:self in situation', ownTurn && ownTurn.trust === 'self', JSON.stringify(ownTurn && ownTurn.trust));
    expect('user turn is ALSO in the same conversation object', !!userTurn, 'user turn missing from situation');

    // the agent's own reply is NOT a judgment work item for the agent (it is the agent's own contribution)
    const ownWork = (sit.queue || []).find((w) => (w.text || '').includes('how can I help'));
    expect('own reply is NOT queued as a judgment item', !ownWork, JSON.stringify(sit.queue && sit.queue.map((w) => w.text)));

    c.ws.close();
  } finally { await s.close(); }
});

// (b): user speech during TTS → barge_in signal (event + client frame) + interruption recorded + cleared.
test('T-BARGE-IN (interrupt): user speech during TTS → barge_in + interruption recorded + speaking cleared', async () => {
  const s = await createServer({ port: 0, settlingMs: 0 });
  try {
    const barges = [];
    s.on('barge_in', (sig) => barges.push(sig));
    const c = await client(s.url(), { userId: 'u1', userName: 'Bruce', role: 'participant' });

    // the AI starts speaking a (long) reply — speaking-state goes active
    s.emitOwnTurn({ text: 'let me explain this at some length so there is time to interrupt' });
    expect('speaking is active after an own-turn reply', s.isSpeaking() === true, String(s.isSpeaking()));

    // the user interrupts — speaks WHILE the agent is speaking
    chat(c, 'wait stop I have a question', 'int1');
    await until(() => s.getInbox(0).items.some((i) => (i.text || '').includes('wait stop')), 'interruption lands');

    // a barge_in signal fired (server event)
    expect('a barge_in signal was emitted', barges.length >= 1, String(barges.length));
    expect('barge_in names the interrupter', barges.length >= 1 && barges[0].by && barges[0].by.userId === 'u1', JSON.stringify(barges[0] && barges[0].by));

    // ...and reached the speaker(s) as a {t:'barge_in'} client frame (the duck cue)
    await until(() => c.msgs.some((m) => m.t === 'barge_in'), 'client received barge_in frame');
    expect('client received a barge_in duck cue', c.msgs.some((m) => m.t === 'barge_in'), 'no barge_in frame at client');

    // speaking-state cleared by the barge-in
    expect('speaking-state cleared on barge-in', s.isSpeaking() === false, String(s.isSpeaking()));

    // the interruption is NOT lost — it is recorded as an inbound (untrusted participant) turn
    const rec = s.getInbox(0).items.find((i) => (i.text || '').includes('wait stop'));
    expect('interruption recorded as an inbound turn (nothing lost)', !!rec, 'interruption missing from inbox');
    expect('recorded interruption is an inbound participant turn', rec && rec.trust === 'participant', JSON.stringify(rec && rec.trust));

    c.ws.close();
  } finally { await s.close(); }
});

// (c): nothing barges in when the agent is NOT speaking (idle, or speaking explicitly cleared).
test('T-BARGE-IN (no false fire): no barge_in when the agent is not speaking', async () => {
  const s = await createServer({ port: 0, settlingMs: 0 });
  try {
    const barges = [];
    s.on('barge_in', (sig) => barges.push(sig));
    const c = await client(s.url(), { userId: 'u1', userName: 'Bruce', role: 'participant' });

    // (1) agent idle (never spoke) → a user turn does NOT barge in
    chat(c, 'just chatting away', 'x1');
    await until(() => s.getInbox(0).items.some((i) => (i.text || '').includes('just chatting')), 'x1 lands');
    expect('no barge-in while the agent is idle', barges.length === 0, String(barges.length));

    // (2) agent spoke then TTS FINISHED (speaking explicitly cleared) → a later user turn does NOT barge in
    s.emitOwnTurn({ text: 'a short reply' });
    s.setSpeaking(false);   // TTS finished normally
    expect('speaking cleared by setSpeaking(false)', s.isSpeaking() === false, String(s.isSpeaking()));
    chat(c, 'another line entirely', 'x2');
    await until(() => s.getInbox(0).items.some((i) => (i.text || '').includes('another line')), 'x2 lands');
    expect('no barge-in after the TTS finished (speaking cleared)', barges.length === 0, String(barges.length));

    c.ws.close();
  } finally { await s.close(); }
});

// T-ZERO-WHEN-OFF (regression): the barge-in client cue is FENCED — present ON, absent OFF.
test('T-BARGE-IN (zero-when-off): the barge-in cue is fenced — absent from the served OFF page', () => {
  const on = renderPresenterPage(true);
  const off = renderPresenterPage(false);
  expect('barge_in cue present in the served ON page', /barge_in/.test(on), 'barge_in cue missing when ON');
  expect('barge_in cue ABSENT from the served OFF page (fenced)', !/barge_in/.test(off), 'barge_in cue leaked into the OFF page!');
  // belt-and-braces: the whole voice fence is stripped OFF (no AP-VOICE markers either)
  expect('no AP-VOICE markers in the OFF page', !/AP-VOICE:/.test(off), 'AP-VOICE fence leaked into OFF page');
});
