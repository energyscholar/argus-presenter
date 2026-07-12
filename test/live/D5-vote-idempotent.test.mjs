/*
 * D5 — re-delivering a vote op is idempotent (count unchanged); poll stays
 * store-native end-to-end without the old relay.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function open(url, hello) {
  return new Promise((resolve) => { const ws = new WebSocket(url); ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws }); }); });
}

test('D5 — re-delivered vote op is idempotent (count unchanged)', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await open(url, { userId: 'u1', role: 'participant' });
    await wait(120);
    server.openPoll({ promptId: 'd5', prompt: 'Ship it?', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }], target: 'participant' });

    // Vote via a direct op with a fixed opId; deliver it TWICE.
    const voteOp = JSON.stringify({ t: 'op', path: 'polls/d5/votes/u1', verb: 'set', value: 'yes', opId: 'vote-1' });
    a.ws.send(voteOp);
    a.ws.send(voteOp);      // re-delivery (dedup)
    await wait(200);
    expect(server.getPoll('d5').count === 1, 'count is 1 after re-delivery', String(server.getPoll('d5').count));
    expect(server.getPoll('d5').tally.yes === 1, 'tally yes=1');

    // A change-of-mind (new value) still LWW to one vote.
    a.ws.send(JSON.stringify({ t: 'op', path: 'polls/d5/votes/u1', verb: 'set', value: 'no', opId: 'vote-2' }));
    await wait(150);
    expect(server.getPoll('d5').count === 1 && server.getPoll('d5').tally.no === 1, 'change-of-mind: still one vote, now no', JSON.stringify(server.getPoll('d5').tally));
    a.ws.close();
  } finally { await server.close(); }
});
