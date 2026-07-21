/*
 * Plan 0471 D1 — poll results visibility modes (INV-POLL-1).
 *   resultsMode:'control' (default) → only controllers get the tally; participants get NOTHING.
 *   resultsMode:'all' → everyone gets the AGGREGATE (polls/<pid>/results, counts-only).
 * In BOTH modes, no participant ever receives another participant's raw per-user vote.
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
const gotPath = (ds, pred) => ds.some((d) => Object.keys(d).some(pred));
const gotResults = (ds, pid) => gotPath(ds, (k) => k === 'polls/' + pid + '/results');
const gotAnyPeerVote = (ds, pid, selfId) => gotPath(ds, (k) => k.startsWith('polls/' + pid + '/votes/') && k !== 'polls/' + pid + '/votes/' + selfId);

async function runVotes(server, url, pid, resultsMode) {
  const alice = await open(url, { userId: 'alice', role: 'participant' });
  const bob = await open(url, { userId: 'bob', role: 'participant' });
  const gm = await open(url, { userId: 'gm', role: 'presenter' });
  await wait(150);
  server.openPoll({ promptId: pid, prompt: 'Ship it?', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }], target: 'participant', resultsMode });
  await wait(100);
  alice.ws.send(JSON.stringify({ t: 'result', msg: { type: 'answer', promptId: pid, value: 'yes' } }));
  bob.ws.send(JSON.stringify({ t: 'result', msg: { type: 'answer', promptId: pid, value: 'no' } }));
  await wait(300);
  const out = { alice: diffs(alice.inbox), bob: diffs(bob.inbox), gm: diffs(gm.inbox) };
  alice.ws.close(); bob.ws.close(); gm.ws.close();
  return out;
}

test('D1 — control mode: only controllers get the tally; participants get no aggregate', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const d = await runVotes(server, url, 'ctl', 'control');
    expect(!gotResults(d.alice, 'ctl') && !gotResults(d.bob, 'ctl'), 'participants get NO aggregate results slice in control mode', JSON.stringify({ a: d.alice, b: d.bob }));
    expect(!gotAnyPeerVote(d.alice, 'ctl', 'alice') && !gotAnyPeerVote(d.bob, 'ctl', 'bob'), 'no participant receives a peer raw vote (control)', JSON.stringify({ a: d.alice, b: d.bob }));
    // Controller sees the raw votes (it computes the tally itself / drives poll-results live).
    expect(d.gm.some((x) => Object.keys(x).some((k) => k.startsWith('polls/ctl/votes/'))), 'controller receives raw votes (drives tally)', JSON.stringify(d.gm));
  } finally { await server.close(); }
});

test('D1 — all mode: everyone gets the AGGREGATE; still no raw peer votes', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const d = await runVotes(server, url, 'pub', 'all');
    expect(gotResults(d.alice, 'pub') && gotResults(d.bob, 'pub'), 'participants DO get the aggregate results slice in all mode', JSON.stringify({ a: d.alice, b: d.bob }));
    expect(!gotAnyPeerVote(d.alice, 'pub', 'alice') && !gotAnyPeerVote(d.bob, 'pub', 'bob'), 'no participant receives a peer raw vote (all)', JSON.stringify({ a: d.alice, b: d.bob }));
    // The aggregate carries counts only (tally/count), never a per-user row.
    const agg = d.alice.map((x) => x['polls/pub/results']).filter(Boolean).pop();
    expect(agg && agg.tally && typeof agg.count === 'number' && !('votes' in agg), 'aggregate is counts-only (no per-user rows)', JSON.stringify(agg));
  } finally { await server.close(); }
});
