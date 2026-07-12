/*
 * D4 — closePoll sets polls/{pid}/open=false in the store; votes after close are
 * denied (dropped by the close guard).
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function open(url, hello) {
  return new Promise((resolve) => { const ws = new WebSocket(url); ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws }); }); });
}

test('D4 — closePoll sets open=false; a later vote is denied', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await open(url, { userId: 'u1', role: 'participant' });
    await wait(120);
    server.openPoll({ promptId: 'd4', prompt: 'Ship it?', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }], target: 'participant' });

    a.ws.send(JSON.stringify({ t: 'result', msg: { type: 'answer', promptId: 'd4', value: 'yes' } }));
    await wait(150);
    expect(server.getPoll('d4').count === 1, 'vote counted while open');

    server.closePoll('d4');
    await wait(50);
    expect(server.store.get('polls/d4/open') === false, 'store open=false after close', String(server.store.get('polls/d4/open')));

    // A vote after close is dropped.
    a.ws.send(JSON.stringify({ t: 'result', msg: { type: 'answer', promptId: 'd4', value: 'no' } }));
    await wait(150);
    expect(server.getPoll('d4').count === 1, 'vote after close ignored (count unchanged)', String(server.getPoll('d4').count));
    expect(server.getPoll('d4').tally.yes === 1, 'tally unchanged after close');
    a.ws.close();
  } finally { await server.close(); }
});
