/*
 * D2 — a poll vote becomes a store op at polls/{pid}/votes/{self} (perm: self).
 * The shim writes the store; a direct op onto another user's vote is denied.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function open(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws }); });
  });
}

test('D2 — vote shim writes the store; another user\'s vote is denied (self)', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await open(url, { userId: 'u1', role: 'participant' });
    await wait(120);
    server.openPoll({ promptId: 'd2', prompt: 'Ship it?', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }], target: 'participant' });

    // Vote via an 'answer' (the shim path).
    a.ws.send(JSON.stringify({ t: 'result', msg: { type: 'answer', promptId: 'd2', value: 'yes' } }));
    await wait(200);
    expect(server.store.get('polls/d2/votes/u1') === 'yes', 'vote stored at self slice', String(server.store.get('polls/d2/votes/u1')));
    expect(server.getPoll('d2').count === 1 && server.getPoll('d2').tally.yes === 1, 'getPoll reads the store', JSON.stringify(server.getPoll('d2').tally));

    // Direct op onto ANOTHER user's vote slice is permission-denied.
    a.ws.send(JSON.stringify({ t: 'op', path: 'polls/d2/votes/u2', verb: 'set', value: 'no', opId: 'x' }));
    await wait(150);
    expect(server.store.get('polls/d2/votes/u2') === undefined, 'cannot vote for another user (perm: self)');
    a.ws.close();
  } finally { await server.close(); }
});
