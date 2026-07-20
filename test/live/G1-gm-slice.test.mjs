/*
 * G1 — a gm-tagged slice's diffs + snapshot never reach a player (read-perm, S7).
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

test('G1 — a gm/ slice diff is broadcast to the presenter, never to a player', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const player = await open(url, { userId: 'p1', role: 'participant' });
    const gm = await open(url, { userId: 'gm', role: 'presenter' });
    await wait(150);

    gm.ws.send(JSON.stringify({ t: 'op', path: 'gm/secret', verb: 'set', value: 'informant', opId: 'g1' }));
    // Plan 0471 C3: 'crud' is an ALL-readable shared surface (default-deny elsewhere).
    gm.ws.send(JSON.stringify({ t: 'op', path: 'crud/note', verb: 'set', value: 'hello', opId: 'g2' }));
    await wait(250);

    const pStr = JSON.stringify(diffs(player.inbox));
    expect(!pStr.includes('informant') && !pStr.includes('gm/secret'), 'player never receives the gm-only diff', pStr);
    expect(pStr.includes('crud/note'), 'player DOES receive the shared (crud) diff', pStr);

    const gStr = JSON.stringify(diffs(gm.inbox));
    expect(gStr.includes('informant'), 'presenter receives the gm-only diff', gStr);

    player.ws.close(); gm.ws.close();
  } finally { await server.close(); }
});

test('G1 — a late player\'s snapshot omits the gm/ slice; presenter\'s includes it', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    server.store.apply({ path: 'gm/secret', verb: 'set', value: 'informant' }, { userId: 'gm', role: 'presenter' });
    server.store.apply({ path: 'crud/x', verb: 'set', value: 1 }, { userId: 'gm', role: 'presenter' });   // Plan 0471 C3: crud = shared, readable by all

    const player = await open(url, { userId: 'late', role: 'participant' });
    const gm = await open(url, { userId: 'gm2', role: 'presenter' });
    await wait(200);

    const pSnap = player.inbox.find((m) => m.t === 'snapshot');
    const gSnap = gm.inbox.find((m) => m.t === 'snapshot');
    expect(pSnap && (!pSnap.state.gm || pSnap.state.gm.secret === undefined), 'player snapshot omits the gm-only value', JSON.stringify(pSnap && pSnap.state));
    expect(pSnap && pSnap.state.crud && pSnap.state.crud.x === 1, 'player snapshot keeps shared (crud) state', JSON.stringify(pSnap && pSnap.state));
    expect(gSnap && gSnap.state.gm && gSnap.state.gm.secret === 'informant', 'presenter snapshot includes the gm slice', JSON.stringify(gSnap && gSnap.state.gm));

    player.ws.close(); gm.ws.close();
  } finally { await server.close(); }
});
