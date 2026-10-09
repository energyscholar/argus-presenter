/*
 * Plan 0904 R13 — OVER THE WIRE, against a LOCAL server started the way a deployment starts it.
 *
 * The unit test drives createServer() in-process. This one spawns the real CLI (`node app/server.mjs`)
 * with a scratch deployment config that declares a control token — the shape of a gated deployment —
 * and talks to it with a raw WebSocket client, exactly as an anonymous visitor would. Nothing here
 * reaches any host but 127.0.0.1.
 */
import { test, expect } from '../../harness/test.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = 'wire-ctl-token-0904-r13';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startCli() {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0904-r13-'));
  const cfg = join(dir, 'presenter-config.json');
  writeFileSync(cfg, JSON.stringify({ presenterPort: 0, controlToken: TOKEN }));
  const env = { PATH: process.env.PATH, HOME: dir, XDG_STATE_HOME: join(dir, 'state'), XDG_CONFIG_HOME: join(dir, 'config'), PRESENTER_CONFIG_FILE: cfg };
  const child = spawn(process.execPath, [join(REPO, 'app', 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const url = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('CLI never announced a URL: ' + out.slice(-800))), 20000);
    const on = (c) => { out += c; const m = /display\s*:\s*(http:\/\/127\.0\.0\.1:\d+)\//.exec(out); if (m) { clearTimeout(t); res(m[1]); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', (code) => { clearTimeout(t); rej(new Error('CLI exited early (' + code + '): ' + out.slice(-800))); });
  });
  return { child, url, dir };
}
function stop(h) { try { h.child.kill('SIGKILL'); } catch {} try { rmSync(h.dir, { recursive: true, force: true }); } catch {} }

function frameAfter(url, frame, want, ms = 4000) {
  return new Promise((res) => {
    const ws = new WebSocket(url.replace('http', 'ws'));
    const frames = [];
    const done = () => { try { ws.close(); } catch {} res(frames); };
    const t = setTimeout(done, ms);
    ws.on('message', (b, bin) => { if (bin) return; try { const f = JSON.parse(b.toString()); frames.push(f); if (want.includes(f.t)) { clearTimeout(t); done(); } } catch {} });
    ws.on('open', () => ws.send(JSON.stringify(frame)));
    ws.on('error', () => { clearTimeout(t); done(); });
  });
}

test('T0904-R13-wire — a gated CLI deployment refuses an anonymous transcript subscriber and admits the control token', async () => {
  const h = await startCli();
  try {
    const anon = await frameAfter(h.url, { t: 'pvs_subscribe', consumer: 'anon-probe' }, ['pvs_refused', 'pvs_subscribed']);
    expect(anon.some((f) => f.t === 'pvs_refused'), 'anonymous socket refused over the wire', JSON.stringify(anon.map((f) => f.t)));
    expect(!anon.some((f) => f.t === 'pvs_subscribed'), 'and never subscribed');
    const tok = await frameAfter(h.url, { t: 'pvs_subscribe', consumer: 'operator', token: TOKEN }, ['pvs_refused', 'pvs_subscribed']);
    expect(tok.some((f) => f.t === 'pvs_subscribed'), 'the control token subscribes over the wire', JSON.stringify(tok.map((f) => f.t)));
    // The sibling HTTP reader of the same feed stays gated too (audit, not a change).
    const r = await fetch(h.url + '/api/situation');
    expect(r.status === 403, '/api/situation without the token is refused', String(r.status));
    await wait(50);
  } finally { stop(h); }
});
