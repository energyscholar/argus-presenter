/*
 * Plan 0687 R5 — THE TEST HARNESSES, EXERCISED.
 *
 * ⛔ Gate B names a scripted guest and a scripted agent client and nothing built them, so the gate
 * could not be executed at all. They now exist in tools/. These tests are not about the delivery
 * layer — R2/R3/R4 cover that — they are about the HARNESSES being real: a rehearsal tool that has
 * never been run is a plan, not a tool.
 *
 * The end-to-end case is the whole phase in one shape: a guest speaks, an agent is handed the
 * words, the transfer is cut off before it confirms anything, and the words come back.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { runScriptedGuest } from '../../tools/scripted-guest.mjs';
import { runScriptedAgent, ACK_POLICIES } from '../../tools/scripted-agent.mjs';

test('0687 R5 — the scripted guest really speaks into the room, and its words reach the inbox', async () => {
  const s = await createServer({ port: 0 });
  try {
    const r = await runScriptedGuest({ url: s.url(), name: 'Guest A', script: [{ say: 'the first line' }, { wait: 60 }, { say: 'the second line' }] });
    expect(r.ok && r.said.length === 2, 'the guest ran its script', JSON.stringify(r.said));
    const inbox = s.getInbox(0);
    const texts = (inbox.items || []).map((i) => i.text).join(' | ');
    expect(texts.includes('the first line') && texts.includes('the second line'),
      'BOTH lines landed in the room, in order', texts);
    expect((inbox.items || []).every((i) => i.userName === 'Guest A' || i.userId),
      'and each is attributed by the SERVER, not by the script');
  } finally { await s.close(); }
});

test('0687 R5 — the scripted agent subscribes, is handed the turns, and acks EXPLICITLY', async () => {
  const s = await createServer({ port: 0 });
  try {
    s.pvsStart({ consumer: 'rehearsal' });
    const agent = runScriptedAgent({ url: s.url(), consumer: 'rehearsal', listenMs: 500, ack: 'explicit' });
    await new Promise((r) => setTimeout(r, 150));
    await runScriptedGuest({ url: s.url(), name: 'Guest A', script: [{ say: 'something worth hearing' }] });
    const r = await agent;
    expect(r.turns.length >= 1, 'the agent was handed the turn', JSON.stringify(r.turns));
    expect(r.turns[0].text === 'something worth hearing', 'verbatim', r.turns[0].text);
    expect(r.acked === r.turns[r.turns.length - 1].seq, 'and it acked what it had actually taken in', String(r.acked));
    expect(s.pvsBacklog({ consumer: 'rehearsal' }).count === 0, 'so the room has nothing outstanding for it');
  } finally { await s.close(); }
});

test('0687 R5 — ⛔ THE WHOLE PHASE IN ONE SHAPE: the transfer is cut off, and the turn comes back', async () => {
  const s = await createServer({ port: 0 });
  try {
    s.pvsStart({ consumer: 'rehearsal' });
    // Run 1: the agent is handed the turn and the socket dies before it confirms anything.
    const cut = runScriptedAgent({ url: s.url(), consumer: 'rehearsal', listenMs: 600, ack: 'never', truncateAfter: 1 });
    await new Promise((r) => setTimeout(r, 150));
    await runScriptedGuest({ url: s.url(), name: 'Guest A', script: [{ say: 'cut off mid-json' }] });
    const first = await cut;
    expect(first.truncated === true, 'the transfer was truncated', String(first.truncated));
    expect(first.turns.length === 1 && first.acked === null, 'a turn was HANDED OVER and nothing was acked', JSON.stringify({ n: first.turns.length, acked: first.acked }));

    // Run 2: a fresh agent attaches to the same cursor.
    const second = await runScriptedAgent({ url: s.url(), consumer: 'rehearsal', listenMs: 500, ack: 'explicit' });
    expect(second.resumeCursor === 0, 'it resumed from the ACKED position, which never moved', String(second.resumeCursor));
    expect(second.sentCursor > 0, 'while `sent` remembers the handover that was lost', String(second.sentCursor));
    expect(second.turns.some((t) => t.text === 'cut off mid-json'),
      '⛔ THE TURN CAME BACK', JSON.stringify(second.turns.map((t) => t.text)));
    expect(second.acked >= 1, 'and this time it was confirmed', String(second.acked));
    expect(s.pvsBacklog({ consumer: 'rehearsal' }).count === 0, 'so now, and only now, is it retired');
  } finally { await s.close(); }
});

test('0687 R5 — the WRONG agent is reproducible too: acking on frame receipt loses the turn', async () => {
  const s = await createServer({ port: 0 });
  try {
    s.pvsStart({ consumer: 'rehearsal' });
    const wrong = runScriptedAgent({ url: s.url(), consumer: 'rehearsal', listenMs: 600, ack: 'onFrame' });
    await new Promise((r) => setTimeout(r, 150));
    await runScriptedGuest({ url: s.url(), name: 'Guest A', script: [{ say: 'gone the moment it arrived' }] });
    await wrong;
    expect(s.pvsBacklog({ consumer: 'rehearsal' }).count === 0,
      '⛔ nothing is outstanding — the bytes arriving was treated as the turn being read');
    const after = await runScriptedAgent({ url: s.url(), consumer: 'rehearsal', listenMs: 300, ack: 'explicit' });
    expect(after.turns.length === 0, 'and a fresh agent gets NOTHING back: this is the at-most-once failure, on demand',
      JSON.stringify(after.turns));
  } finally { await s.close(); }
});

test('0687 R5 — an ack from a socket that is not a subscriber is REFUSED BY NAME, not ignored', async () => {
  const s = await createServer({ port: 0 });
  try {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(s.url().replace('http', 'ws'));
    const frames = [];
    ws.on('message', (b) => { try { frames.push(JSON.parse(b.toString())); } catch (e) {} });
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'hello', userId: 'nosy', userName: 'Nosy' }));
    await new Promise((r) => setTimeout(r, 80));
    ws.send(JSON.stringify({ t: 'pvs_ack', seq: 99 }));
    await new Promise((r) => setTimeout(r, 120));
    const receipt = frames.find((f) => f.t === 'pvs_acked');
    expect(receipt && receipt.ok === false && receipt.reason === 'not-a-subscriber',
      'the refusal names itself — a silent ignore would look exactly like a successful ack', JSON.stringify(receipt));
    try { ws.close(); } catch (e) {}
  } finally { await s.close(); }
});

test('0687 R5 — the harnesses refuse nonsense rather than running something else', async () => {
  let threw = null;
  try { await runScriptedAgent({ url: 'http://127.0.0.1:1', ack: 'whenever' }); } catch (e) { threw = e; }
  expect(threw && /unknown ack policy/.test(threw.message), 'an unknown ack policy is a named error', threw && threw.message);
  expect(ACK_POLICIES.length === 3, 'and the policies are declared, not implied', ACK_POLICIES.join(','));
  let threw2 = null;
  try { await runScriptedGuest({}); } catch (e) { threw2 = e; }
  expect(threw2 && /url is required/.test(threw2.message), 'a guest with no room is a named error', threw2 && threw2.message);
});
