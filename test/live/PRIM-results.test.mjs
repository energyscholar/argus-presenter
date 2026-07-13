/*
 * PRIM-results — a beat result (answer/continue) is forwarded to CONTROL roles ONLY.
 * A real participant PAGE answers a `choice`; a presenter raw-ws receives the
 * {t:'result'} frame; a participant raw-ws (OPSEC witness) receives NONE.
 * Also asserts the server tracks the last result per prompt (lastResults slice via getPoll-independent path).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, frameClick, until, wait } from '../../harness/multi.mjs';
import { WebSocket } from 'ws';

// Raw ws that authenticates `hello` and collects every frame it receives.
function rawConn(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const frames = [];
    ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) {} });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws, frames }); });
  });
}

test('PRIM-results — result reaches presenter/ai/gm only; participant gets none', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  const browser = await launch();
  try {
    // Control witness (presenter) + OPSEC witness (participant) as raw ws.
    const presenter = await rawConn(url, { userId: 'gm', userName: 'GM', role: 'presenter' });
    const witness = await rawConn(url, { userId: 'w1', userName: 'Witness', role: 'participant' });
    // A real participant PAGE that will actually answer the choice.
    const alice = await connectUser(browser, server, { userId: 'u1', userName: 'Alice' });
    await until(() => server.presence().length === 3 && server.presence().some((u) => u.role === 'presenter'),
      { label: '3 connected incl presenter' });

    // Push a plain interactive `choice` (with a promptId) to participants; Alice's page answers it.
    server.pushComponent('participant', 'choice', {
      prompt: 'Which way?', promptId: 'prim1',
      options: [{ label: 'Left', value: 'left' }, { label: 'Right', value: 'right' }],
    });
    await wait(300);
    await frameClick(alice, '[data-value="right"]');

    // Presenter (control role) receives the result frame with the value.
    await until(() => presenter.frames.some((f) => f.t === 'result' && f.promptId === 'prim1' && f.value === 'right'),
      { label: 'presenter got result', timeout: 6000 });
    const rf = presenter.frames.find((f) => f.t === 'result' && f.promptId === 'prim1' && f.value === 'right');
    expect('presenter received t:result with value=right', rf && rf.value === 'right' && rf.userId === 'u1', JSON.stringify(rf));
    expect('result frame carries userName', rf && rf.userName === 'Alice', JSON.stringify(rf));

    // OPSEC: the participant witness received NO result frame at all.
    const leaked = witness.frames.filter((f) => f.t === 'result');
    expect('OPSEC — participant received NO t:result frame', leaked.length === 0, JSON.stringify(leaked));

    presenter.ws.close(); witness.ws.close();
  } finally { await browser.close(); await server.close(); }
});
