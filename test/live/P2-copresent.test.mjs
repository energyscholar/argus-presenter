/*
 * P2 — passive coordination signals: presenter A sets a copresent signal; presenter
 * B and the AI observe the diff. The copresent slice is controller-only (a
 * participant never receives it). Uses raw ws (the /control UI sends the same op).
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
const gotCopresent = (inbox) => inbox.some((m) => m.t === 'host' && m.msg && m.msg.type === 'diff' && m.msg.diff && m.msg.diff['copresent/A'] && m.msg.diff['copresent/A'].signal === "I've got this");

test('P2 — presenter B and the AI observe presenter A\'s copresent signal; participant does not', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const A = await open(url, { userId: 'A', userName: 'Ann', role: 'presenter' });
    const B = await open(url, { userId: 'B', userName: 'Bob', role: 'presenter' });
    const ai = await open(url, { userId: 'argus', role: 'ai' });
    const part = await open(url, { userId: 'p', role: 'participant' });
    await wait(150);

    // A signals (exactly what the /control co-presenter button sends).
    A.ws.send(JSON.stringify({ t: 'op', path: 'copresent/A', verb: 'set', value: { signal: "I've got this", name: 'Ann' }, opId: 'cp1' }));
    await wait(250);

    expect(server.store.get('copresent/A').signal === "I've got this", 'signal recorded in the store');
    expect(gotCopresent(B.inbox), 'presenter B observed the copresent diff', JSON.stringify(B.inbox.filter((m) => m.t === 'host')));
    expect(gotCopresent(ai.inbox), 'the AI observed the copresent diff');
    const pStr = JSON.stringify(part.inbox.filter((m) => m.t === 'host'));
    expect(!pStr.includes('copresent') && !pStr.includes('got this'), 'a participant never receives the copresent diff', pStr);

    A.ws.close(); B.ws.close(); ai.ws.close(); part.ws.close();
  } finally { await server.close(); }
});
