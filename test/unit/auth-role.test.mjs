/*
 * AUTH-ROLE (P5.5) — seeded-hash password gate for the presenter role.
 *
 * The plaintext password NEVER travels: the client sends sha256(seed + password) as the
 * hello token; the server compares it to ROLE_HASH. This test drives the server directly
 * (no browser) to assert the gate + the /api/auth disclosure surface + back-compat.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';
import { createHash } from 'node:crypto';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

// Raw ws that authenticates `hello` and collects frames (mirrors neutral-role.test.mjs).
async function hello(server, frame) {
  const ws = new WebSocket(server.url().replace('http', 'ws'));
  const frames = [];
  ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) {} });
  await new Promise((res) => { ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', ...frame })); res(); }); });
  await wait(200);
  return { ws, frames };
}

test('AUTH-ROLE — rolePassword gates presenter: correct seeded hash granted, wrong denied', async () => {
  const server = await createServer({ port: 0, rolePassword: 'password' });
  // The hash the browser WOULD compute for the default seed + default password.
  const good = sha256hex('argus-presenter' + 'password');
  let a, b;
  try {
    // (a) correct token → presenter.
    a = await hello(server, { userId: 'good', role: 'presenter', token: good });
    const ua = server.presence().find((p) => p.userId === 'good');
    expect(ua && ua.role === 'presenter', 'correct seeded hash → presenter granted', ua && ua.role);
    // welcome echoes the effective role.
    const wa = a.frames.find((f) => f.t === 'welcome');
    expect(wa && wa.role === 'presenter', 'welcome.role === presenter on grant', wa && wa.role);

    // (b) wrong token → downgraded to participant, welcome says so.
    b = await hello(server, { userId: 'bad', role: 'presenter', token: 'deadbeef' });
    const ub = server.presence().find((p) => p.userId === 'bad');
    expect(ub && ub.role === 'participant', 'wrong token → participant', ub && ub.role);
    const wb = b.frames.find((f) => f.t === 'welcome');
    expect(wb && wb.role === 'participant', 'welcome.role === participant on deny', wb && wb.role);
  } finally { if (a) a.ws.close(); if (b) b.ws.close(); await server.close(); }
});

test('AUTH-ROLE — /api/auth advertises {gated,seed} and NEVER leaks the hash or password', async () => {
  const server = await createServer({ port: 0, rolePassword: 'password' });
  try {
    const res = await fetch(server.url() + '/api/auth');
    const body = await res.text();
    const json = JSON.parse(body);
    expect(json.gated === true, '/api/auth reports gated:true', JSON.stringify(json));
    expect(json.seed === 'argus-presenter', '/api/auth exposes the public seed', json.seed);
    // OPSEC: the response body must contain neither the hash nor the plaintext password.
    const hash = sha256hex('argus-presenter' + 'password');
    expect(!body.includes(hash), 'body does NOT contain ROLE_HASH');
    expect(!body.includes('password'), "body does NOT contain the word 'password'", body);
  } finally { await server.close(); }
});

test('AUTH-ROLE — /api/auth reports ungated when no credential configured', async () => {
  const server = await createServer({ port: 0 });
  try {
    const json = await (await fetch(server.url() + '/api/auth')).json();
    expect(json.gated === false, 'ungated server → gated:false', JSON.stringify(json));
  } finally { await server.close(); }
});

test('AUTH-ROLE — back-compat: no rolePassword ⇒ ungated, presenter granted with NO token', async () => {
  const server = await createServer({ port: 0 });
  let c;
  try {
    c = await hello(server, { userId: 'z', role: 'presenter' });   // no token at all
    const u = server.presence().find((p) => p.userId === 'z');
    expect(u && u.role === 'presenter', 'ungated default still grants presenter tokenless', u && u.role);
  } finally { if (c) c.ws.close(); await server.close(); }
});
