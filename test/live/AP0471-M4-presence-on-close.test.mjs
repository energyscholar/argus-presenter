/*
 * Plan 0471 M4 — a clean disconnect must refresh the control page's pushed user-list.
 * connect calls pushPresence(); close previously did NOT, so a departed participant
 * lingered in the presenter's {t:'presence'} roster until the next display change.
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
const lastPresence = (inbox) => inbox.filter((m) => m.t === 'presence').map((m) => m.users).pop();

test('M4 — closing a participant pushes a fresh presence roster to the presenter', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const gm = await open(url, { userId: 'gm', role: 'presenter' });
    const part = await open(url, { userId: 'leaver', role: 'participant' });
    await wait(200);
    // The presenter sees the participant in the pushed roster (connect → pushPresence).
    const before = lastPresence(gm.inbox);
    expect(before && before.some((u) => u.userId === 'leaver'), 'presenter roster includes the participant before close', JSON.stringify(before));

    const framesBefore = gm.inbox.filter((m) => m.t === 'presence').length;
    part.ws.close();
    await wait(300);
    // M4: close pushes a NEW presence frame, and the participant is gone from it.
    const framesAfter = gm.inbox.filter((m) => m.t === 'presence').length;
    const after = lastPresence(gm.inbox);
    expect(framesAfter > framesBefore, 'a new presence frame was pushed on close', framesBefore + '->' + framesAfter);
    expect(after && !after.some((u) => u.userId === 'leaver'), 'departed participant removed from the roster immediately', JSON.stringify(after));

    gm.ws.close();
  } finally { await server.close(); } });
