/*
 * NEUTRAL-1 — the core is domain-neutral: roles are participant | presenter | ai.
 * The `gm` role must carry NO control privilege. This asserts the BEHAVIOUR (not a
 * source grep — a grep for "gm" false-positives on the visibility tag / userId /
 * comments): a connection that hellos as role:'gm' is NOT treated as a controller,
 * while presenter and ai still are.
 *
 * Surface under test: the presence feed. pushPresence() pushes {t:'presence'} to
 * CONTROL roles ONLY. After the purge, presenter + ai receive it; gm (and
 * participant) never do. The chat_listeners count (currentListeners) likewise
 * counts presenter + ai only — a gm connection must NOT bump it.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Raw ws that authenticates `hello` and collects every frame it receives.
function rawConn(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const frames = [];
    ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) {} });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws, frames }); });
  });
}

test('NEUTRAL — gm role gets NO presence feed and is NOT counted as a controller; presenter/ai still are', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const presenter = await rawConn(url, { userId: 'p1', userName: 'Pres', role: 'presenter' });
    const ai = await rawConn(url, { userId: 'ai1', userName: 'AI', role: 'ai' });
    const gm = await rawConn(url, { userId: 'g1', userName: 'GM', role: 'gm' });
    const part = await rawConn(url, { userId: 'u1', userName: 'User', role: 'participant' });
    await wait(200);   // let all four hellos + resulting pushPresence/chat_listeners settle

    // Force a fresh presence broadcast (setDisplay -> pushPresence to control roles only).
    server.clear('all');
    await wait(150);

    const gotPresence = (conn) => conn.frames.some((f) => f.t === 'presence');
    // Control roles receive the presence feed.
    expect(gotPresence(presenter), 'presenter (control role) receives the presence feed');
    expect(gotPresence(ai), 'ai (control role) receives the presence feed');
    // gm has NO control privilege: it must never receive a presence frame.
    expect(!gotPresence(gm), 'gm role receives NO presence feed (control privilege purged)',
      JSON.stringify(gm.frames.filter((f) => f.t === 'presence')));
    // Participant likewise never sees the (OPSEC) presence feed.
    expect(!gotPresence(part), 'participant receives NO presence feed');

    // Controller COUNT (currentListeners -> chat_listeners): presenter + ai = 2. gm must
    // NOT be counted (would be 3 if gm were still a controller).
    const listenerCounts = [...presenter.frames, ...gm.frames, ...part.frames]
      .filter((f) => f.t === 'chat_listeners').map((f) => f.n);
    const maxN = listenerCounts.length ? Math.max(...listenerCounts) : null;
    expect(maxN === 2, 'controller count is 2 (presenter + ai); gm not counted', 'maxN=' + maxN);

    presenter.ws.close(); ai.ws.close(); gm.ws.close(); part.ws.close();
  } finally { await server.close(); }
});
