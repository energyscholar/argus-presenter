/*
 * PRIM-mirror (MON-2) — a control op that pushes a TARGET user's current display
 * HTML back to the requesting control client so the GM can thumbnail "what that
 * user sees". Fire-and-forget: a server PUSH to the requester, not a reply.
 * A presenter raw-ws requests mirror of user 'alice'; it receives a {t:'mirror'}
 * frame carrying alice's per-user display html. An unknown userId yields html:null.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { until } from '../../harness/multi.mjs';
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

test('PRIM-mirror — target user display html is pushed back to the requesting control client', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    // Requester = a control client (presenter). Target = participant 'alice'.
    const presenter = await rawConn(url, { userId: 'gm', userName: 'GM', role: 'presenter' });
    const alice = await rawConn(url, { userId: 'alice', userName: 'Alice', role: 'participant' });
    await until(() => server.presence().length === 2 && server.presence().some((u) => u.userId === 'alice'),
      { label: 'presenter + alice connected' });

    // Give alice a distinct per-user display so displayByUser has an entry.
    server.pushContent('alice', '<b id="who">ALICE-ONLY</b>', 'a1');

    // Presenter requests a mirror of alice's current display.
    presenter.ws.send(JSON.stringify({ t: 'control', action: 'mirror', args: { userId: 'alice' } }));
    await until(() => presenter.frames.some((f) => f.t === 'mirror' && f.userId === 'alice'),
      { label: 'presenter got mirror frame', timeout: 4000 });

    const mf = presenter.frames.find((f) => f.t === 'mirror' && f.userId === 'alice');
    expect('mirror frame carries alice html', mf && typeof mf.html === 'string' && mf.html.includes('ALICE-ONLY'), JSON.stringify(mf));

    // Unknown userId -> html:null (no display, no target connection).
    presenter.ws.send(JSON.stringify({ t: 'control', action: 'mirror', args: { userId: 'nobody' } }));
    await until(() => presenter.frames.some((f) => f.t === 'mirror' && f.userId === 'nobody'),
      { label: 'presenter got mirror frame for unknown user', timeout: 4000 });
    const nf = presenter.frames.find((f) => f.t === 'mirror' && f.userId === 'nobody');
    expect('unknown userId mirror -> html:null', nf && nf.html === null, JSON.stringify(nf));

    presenter.ws.close(); alice.ws.close();
  } finally { await server.close(); }
});
