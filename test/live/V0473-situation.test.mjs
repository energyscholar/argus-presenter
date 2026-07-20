/*
 * Plan 0473, P3 — BOUNDED SITUATION + SERVER-HELD PER-CONSUMER CURSOR.
 *
 * `presenter_situation()` is the PRIMARY sense tool: it returns a BOUNDED WORKING SET assembled from
 * EXISTING server state (display/beat, session profile, open polls + live tallies, roster) PLUS the
 * last-N coalesced turns (P2) verbatim PLUS a new-since-last-read delta computed from a SERVER-HELD
 * per-consumer cursor (the consumer NEVER passes a cursor). The response is ALWAYS bounded — a
 * 10k-turn session must not return full history.
 *
 *   T-SITUATION-DIGEST      one read = display/beat + open polls + tallies + roster + recent turns.
 *   T-SERVER-CURSOR         consecutive reads from ONE consumer return only what's new since that
 *                           consumer last read, WITHOUT passing a cursor; a fresh/other consumer sees
 *                           current state; a later call resumes from the stored cursor (reconnect-safe).
 *   T-BOUNDED-WORKING-SET   after thousands of items the response stays under a fixed size cap and
 *                           never returns full history.
 *   T-SITUATION-CORE-TOOL   presenter_situation is a CORE (always-registered) tool — present even when
 *                           voice is OFF (it serves text + session state without a mic).
 *
 * settlingMs:0 is used where deterministic turns help (each item settles into its own completed turn).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { toolMap, coreTools, voiceTools } from '../../mcp/tools.mjs';
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

// T-SITUATION-DIGEST: ONE situation read carries every situational section in a single object.
test('T-SITUATION-DIGEST: one read = display/beat + open polls + tallies + roster + recent turns', async () => {
  const s = await createServer({ port: 0, settlingMs: 0 });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'Bruce', role: 'participant' });

    // a content module with a shown beat (current display/beat state)
    s.setModule({ title: 'Demo', beats: [{ component: 'display', opts: { text: 'hello' } }, { component: 'display', opts: { text: 'two' } }] });
    s.showBeat(0);

    // an OPEN poll + a live vote (open polls + live tallies)
    s.openPoll({ promptId: 'p1', prompt: 'Ship it?', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }], target: 'participant' });
    c.ws.send(JSON.stringify({ t: 'result', msg: { type: 'answer', promptId: 'p1', value: 'yes' } }));
    await until(() => s.getPoll('p1').count === 1, 'vote lands');

    // a conversational turn (recent turns, verbatim)
    chat(c, 'a spoken turn', 'm1');
    await until(() => s.getInbox(0).items.length >= 1, 'turn lands');

    const sit = await s.situation();
    expect('single object with a situation section', sit && typeof sit.situation === 'object', typeof (sit && sit.situation));

    // display + beat
    expect('current beat surfaced (index 0)', sit.situation.beat && sit.situation.beat.index === 0, JSON.stringify(sit.situation.beat));
    expect('beat carries module title + total', sit.situation.beat && sit.situation.beat.total === 2 && sit.situation.beat.title === 'Demo', JSON.stringify(sit.situation.beat));
    expect('display summary present', sit.situation.display && typeof sit.situation.display === 'object', JSON.stringify(sit.situation.display));

    // open polls + live tallies
    const p = (sit.situation.polls || []).find((x) => x.promptId === 'p1');
    expect('open poll present in the digest', !!p && p.open === true, JSON.stringify(sit.situation.polls));
    expect('poll carries a LIVE tally (yes:1)', p && p.tally && p.tally.yes === 1, JSON.stringify(p && p.tally));
    expect('poll carries its prompt', p && p.prompt === 'Ship it?', JSON.stringify(p && p.prompt));

    // roster (present + recently active)
    expect('roster lists the connected participant', Array.isArray(sit.situation.roster) && sit.situation.roster.some((r) => r.userId === 'u1'), JSON.stringify(sit.situation.roster));
    expect('roster summary present', sit.situation.rosterSummary && sit.situation.rosterSummary.total >= 1, JSON.stringify(sit.situation.rosterSummary));

    // recent turns, verbatim
    expect('recentTurns present + verbatim', Array.isArray(sit.recentTurns) && sit.recentTurns.some((t) => (t.text || '').includes('a spoken turn')), JSON.stringify(sit.recentTurns));

    // profile + bounded marker
    expect('active profile name surfaced', sit.profile === 'wearable', String(sit.profile));
    expect('bounded marker set', sit.bounded === true, String(sit.bounded));
    c.ws.close();
  } finally { await s.close(); }
});

// T-SERVER-CURSOR: server holds each consumer's last-read position; consumer passes NO cursor.
test('T-SERVER-CURSOR: server-held per-consumer cursor — only-new per consumer, fresh consumer sees current, resume-safe', async () => {
  const s = await createServer({ port: 0, settlingMs: 0 });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'Bruce', role: 'participant' });
    chat(c, 'first', 'm1');
    await until(() => s.getInbox(0).items.length >= 1, 'first lands');

    // consumer A first read: sees the new item (consumer passes NO cursor — server tracks it)
    const a1 = await s.situation({ consumerId: 'A' });
    expect('A first read: newSinceLastRead includes the first item', a1.newSinceLastRead.count >= 1, JSON.stringify(a1.newSinceLastRead));

    // A second read with NOTHING new ⇒ empty delta (server advanced A's stored cursor)
    const a2 = await s.situation({ consumerId: 'A' });
    expect('A second read: nothing new (server-held cursor advanced; no consumer bookkeeping)', a2.newSinceLastRead.count === 0, JSON.stringify(a2.newSinceLastRead));

    // new activity ⇒ A sees ONLY the one delta
    chat(c, 'second', 'm2');
    await until(() => s.getInbox(0).items.length >= 2, 'second lands');
    const a3 = await s.situation({ consumerId: 'A' });
    expect('A third read: exactly the ONE new item since A last read', a3.newSinceLastRead.count === 1, JSON.stringify(a3.newSinceLastRead));

    // a FRESH consumer B is independent — sees current state on its first read
    const b1 = await s.situation({ consumerId: 'B' });
    expect('fresh consumer B sees current state (both items) on first read', b1.newSinceLastRead.count >= 2, JSON.stringify(b1.newSinceLastRead));
    expect('B digest carries the current recent turns', b1.recentTurns.length >= 2, String(b1.recentTurns.length));

    // resume-safe: A calls again (after B) ⇒ resumes from A's STORED cursor (nothing new for A)
    const a4 = await s.situation({ consumerId: 'A' });
    expect('resume/reconnect-safe: A resumes from its stored cursor (nothing new)', a4.newSinceLastRead.count === 0, JSON.stringify(a4.newSinceLastRead));
    c.ws.close();
  } finally { await s.close(); }
});

// T-BOUNDED-WORKING-SET: response is size-capped regardless of session length; never full history.
test('T-BOUNDED-WORKING-SET: thousands of items ⇒ response under a fixed cap, never full history', async () => {
  const s = await createServer({ port: 0, settlingMs: 0 });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'Bruce', role: 'participant' });
    const N = 3000;
    for (let i = 0; i < N; i++) chat(c, 'utterance number ' + i + ' with some words to add weight to the payload', 'k' + i);
    await until(() => s.getInbox(0).cursor >= N, 'all ' + N + ' items ingested', { timeout: 25000 });

    const sit = await s.situation({ consumerId: 'big' });
    const size = JSON.stringify(sit).length;
    expect('recentTurns bounded to <= 20', sit.recentTurns.length <= 20, String(sit.recentTurns.length));
    expect('never returns full history (recentTurns << N)', sit.recentTurns.length < N, String(sit.recentTurns.length));
    expect('response size capped under 100KB regardless of a ' + N + '-item session', size < 100000, size + ' bytes');
    expect('new-since-last-read is itself bounded (not the firehose)', sit.newSinceLastRead.count <= 500 && (sit.newSinceLastRead.turns || []).length <= 20, JSON.stringify({ count: sit.newSinceLastRead.count, turns: (sit.newSinceLastRead.turns || []).length }));
    expect('bounded marker set', sit.bounded === true, String(sit.bounded));
    c.ws.close();
  } finally { await s.close(); }
});

// T-SITUATION-CORE-TOOL: presenter_situation is CORE — always registered, present with voice OFF.
test('T-SITUATION-CORE-TOOL: presenter_situation is a CORE (always-registered) tool, present when voice OFF', () => {
  const off = toolMap({ voiceEnabled: false });
  expect('presenter_situation present when voice OFF (core)', !!off['presenter_situation'], 'missing from off surface');
  expect('presenter_situation is in coreTools', coreTools.some((t) => t.name === 'presenter_situation'), 'not in coreTools');
  expect('presenter_situation is NOT a voice-conditional tool', !voiceTools.some((t) => t.name === 'presenter_situation'), 'leaked into voiceTools');
  const t = off['presenter_situation'];
  const keys = Object.keys((t.input && t.input.properties) || {});
  expect('minimal input surface (only waitMs)', keys.length <= 1 && keys.every((k) => k === 'waitMs'), keys.join(','));
});
