/*
 * Plan 0543 P4 — mint_cap / revoke_cap MCP tools (clean anon seating, UC3) + DURABLE revocation.
 *
 * The substantive requirement is the persistence: 0489 flagged that a revocation died with the
 * process, so a still-unexpired guest link came back to life after a restart. With a nonce file
 * configured, a revoked nonce survives — proven by refusing the SAME cap on a fresh server.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { mintCapability } from '../../lib/capability.mjs';
import { toolMap } from '../../mcp/tools.mjs';
import { WebSocket } from 'ws';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function connectCap(url, cap) {
  const ws = new WebSocket(url.replace('http', 'ws'));
  const frames = [];
  ws.on('message', (b) => { try { frames.push(JSON.parse(b.toString())); } catch (e) {} });
  await new Promise((res) => ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', cap })); res(); }));
  await wait(120);
  return { ws, welcome: frames.find((f) => f.t === 'welcome') };
}

test('0543 P4: a revoked nonce SURVIVES a restart (persisted to the nonce file)', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ap-revoked-')), 'revoked-caps.json');
  const cap = mintCapability({ v: 1, sid: 'guest-one', role: 'participant', scope: ['speak', 'type'], name: 'Guest One', exp: Math.floor(Date.now() / 1000) + 3600, nonce: 'n-persist' }, 'capkey');

  const s1 = await createServer({ port: 0, capSecret: 'capkey', revokedNonceFile: file });
  try {
    // Before revoke, the cap seats a guest.
    const pre = await connectCap(s1.url(), cap);
    expect(pre.welcome && pre.welcome.guest === true, 'the cap seats a guest before revoke', JSON.stringify(pre.welcome));
    pre.ws.close();
    expect(s1.revokeCap('n-persist') === true, 'nonce revoked on s1');
    const post = await connectCap(s1.url(), cap);
    expect(!post.welcome || post.welcome.guest !== true, 'the revoked cap is refused on s1', JSON.stringify(post.welcome));
    post.ws.close();
  } finally { await s1.close(); }

  expect(existsSync(file), 'the nonce file was written');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  expect(Array.isArray(saved) && saved.includes('n-persist'), 'the nonce is on disk', JSON.stringify(saved));

  // Restart: a fresh server loads the file — the still-unexpired cap must STILL be refused.
  const s2 = await createServer({ port: 0, capSecret: 'capkey', revokedNonceFile: file });
  try {
    expect(s2.isCapRevoked('n-persist') === true, 'the revoked nonce is loaded after restart');
    const c2 = await connectCap(s2.url(), cap);
    expect(!c2.welcome || c2.welcome.guest !== true, 'the still-unexpired cap is STILL refused after restart (0489 bug fixed)', JSON.stringify(c2.welcome));
    c2.ws.close();
  } finally { await s2.close(); }
});

test('0543 P4: mint_cap / revoke_cap MCP tools — seat-slug sid, /?cap= url, revoke by nonce', async () => {
  const T = toolMap();
  await T.presenter_start.handler({ port: 0, capSecret: 'capkey', tunnel: false });
  try {
    const url = (await T.presenter_status.handler({})).url;
    const mint = await T.mint_cap.handler({ seat: 'Guest One', name: 'Guest One', ttlMs: 600000 });
    expect(mint.ok === true, 'mint ok', JSON.stringify(mint));
    expect(mint.sid === 'guest-one', 'the cap sid is the SEAT SLUG (reload returns the same seat)', mint.sid);
    expect(typeof mint.url === 'string' && mint.url.includes('/?cap='), 'the url carries the cap link', mint.url);
    expect(typeof mint.nonce === 'string' && mint.nonce, 'the nonce is returned for a later revoke', mint.nonce);

    const capToken = mint.url.split('cap=')[1];
    const g = await connectCap(url, capToken);
    expect(g.welcome && g.welcome.guest === true, 'the minted link seats a guest', JSON.stringify(g.welcome));
    g.ws.close();

    const rev = await T.revoke_cap.handler({ nonce: mint.nonce });
    expect(rev.ok === true && rev.nonce === mint.nonce, 'revoke_cap revokes by nonce', JSON.stringify(rev));
    const after = await connectCap(url, capToken);
    expect(!after.welcome || after.welcome.guest !== true, 'the revoked link no longer seats a guest', JSON.stringify(after.welcome));
    after.ws.close();
  } finally { await T.presenter_stop.handler({}); }
});

test('0543 P4: mint_cap fails cleanly when guest links are disabled (no cap secret)', async () => {
  const T = toolMap();
  await T.presenter_start.handler({ port: 0, tunnel: false });   // no capSecret
  try {
    const mint = await T.mint_cap.handler({ seat: 'guest-one' });
    expect(mint.ok === false && /disabled/.test(mint.error || ''), 'mint_cap ok:false when caps are disabled', JSON.stringify(mint));
  } finally { await T.presenter_stop.handler({}); }
});
