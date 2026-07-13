/*
 * AUTH-1 — control-token gate. When a controlToken is configured, a hello that
 * claims a control role (presenter/ai/gm) WITHOUT the matching token is forced
 * to 'participant'. With the token it keeps the role. No token → unchanged.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function hello(server, frame) {
  const ws = new WebSocket(server.url().replace('http', 'ws'));
  await new Promise((res) => { ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', ...frame })); res(); }); });
  await wait(200);
  return ws;
}

test('AUTH-1 — token configured, no token in hello → control role denied (participant)', async () => {
  const server = await createServer({ port: 0, controlToken: 'secret' });
  let ws;
  try {
    ws = await hello(server, { userId: 'x', role: 'presenter' });
    const u = server.presence().find((p) => p.userId === 'x');
    expect(u && u.role === 'participant', 'presenter downgraded to participant without token', u && u.role);
  } finally { if (ws) ws.close(); await server.close(); }
});

test('AUTH-1 — token configured, correct token in hello → control role granted', async () => {
  const server = await createServer({ port: 0, controlToken: 'secret' });
  let ws;
  try {
    ws = await hello(server, { userId: 'y', role: 'presenter', token: 'secret' });
    const u = server.presence().find((p) => p.userId === 'y');
    expect(u && u.role === 'presenter', 'presenter granted with correct token', u && u.role);
  } finally { if (ws) ws.close(); await server.close(); }
});

test('AUTH-1 — no token configured → control role granted (backward-compat / LAN-open)', async () => {
  const server = await createServer({ port: 0 });
  let ws;
  try {
    ws = await hello(server, { userId: 'z', role: 'presenter' });
    const u = server.presence().find((p) => p.userId === 'z');
    expect(u && u.role === 'presenter', 'presenter granted when no token configured', u && u.role);
  } finally { if (ws) ws.close(); await server.close(); }
});
