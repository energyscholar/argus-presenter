/*
 * Plan 0471 C3 — vote NON-DISCLOSURE (INV-SEC-1/2). A participant must never receive
 * another participant's raw per-user vote — live OR in a late-joiner snapshot — while a
 * voter DOES see its own vote and a controller sees all. Raw-ws (server-logic isolation).
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function open(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on('message', (b) => { try { inbox.push(JSON.parse(b.toString())); } catch {} });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws, inbox }); });
  });
}
const diffs = (inbox) => inbox.filter((m) => m.t === 'host' && m.msg && m.msg.type === 'diff').map((m) => m.msg.diff);
const hasVoteOf = (ds, uid) => ds.some((d) => Object.keys(d).some((k) => k === 'polls/q/votes/' + uid));

test('C3 — a peer never sees another\'s vote (live); voter sees own; controller sees all', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const alice = await open(url, { userId: 'alice', role: 'participant' });
    const bob = await open(url, { userId: 'bob', role: 'participant' });
    const gm = await open(url, { userId: 'gm', role: 'presenter' });
    await wait(150);
    server.openPoll({ promptId: 'q', prompt: 'Ship it?', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }], target: 'participant' });
    await wait(100);

    alice.ws.send(JSON.stringify({ t: 'result', msg: { type: 'answer', promptId: 'q', value: 'yes' } }));
    bob.ws.send(JSON.stringify({ t: 'result', msg: { type: 'answer', promptId: 'q', value: 'no' } }));
    await wait(300);

    expect(hasVoteOf(diffs(alice.inbox), 'alice'), 'Alice sees her OWN vote (INV-SEC-2)', JSON.stringify(diffs(alice.inbox)));
    expect(!hasVoteOf(diffs(alice.inbox), 'bob'), 'Alice does NOT see Bob\'s vote (INV-SEC-1)', JSON.stringify(diffs(alice.inbox)));
    expect(!hasVoteOf(diffs(bob.inbox), 'alice'), 'Bob does NOT see Alice\'s vote (INV-SEC-1)', JSON.stringify(diffs(bob.inbox)));
    expect(hasVoteOf(diffs(gm.inbox), 'alice') && hasVoteOf(diffs(gm.inbox), 'bob'), 'controller sees ALL votes', JSON.stringify(diffs(gm.inbox)));

    // Late joiner (participant) snapshot: readable spec present, NO peer votes.
    const late = await open(url, { userId: 'late', role: 'participant' });
    await wait(200);
    const snap = late.inbox.find((m) => m.t === 'snapshot');
    const votes = snap && snap.state.polls && snap.state.polls.q && snap.state.polls.q.votes;
    expect(snap && snap.state.polls && snap.state.polls.q && snap.state.polls.q.spec, 'late snapshot has the readable poll spec', JSON.stringify(snap && snap.state));
    expect(!votes || Object.keys(votes).length === 0, 'late-joiner snapshot has NO peer votes', JSON.stringify(votes));

    alice.ws.close(); bob.ws.close(); gm.ws.close(); late.ws.close();
  } finally { await server.close(); }
});
