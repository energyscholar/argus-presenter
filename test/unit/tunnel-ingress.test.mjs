/*
 * tunnel-ingress.test.mjs — S220: starting the presenter starts the PUBLIC INGRESS.
 *
 * The bug this guards: presenter_start bound 127.0.0.1, returned running:true, and every remote
 * participant got nothing, because the tunnel unit was inactive AND disabled. The process was up;
 * the service was not. Nothing failed, and the agent reported success.
 *
 * The commands are env-supplied shell strings, so the whole lifecycle is testable with `true` /
 * `false` and a throwaway local http server standing in for the public address — no vendor, no
 * sudo, no network.
 */
import { test, expect } from '../../harness/test.mjs';
import { tunnelConfigured, tunnelStatus, tunnelUp, tunnelDown } from '../../mcp/tunnel.mjs';
import { toolMap, _resetForTests } from '../../mcp/tools.mjs';
import { createServer as httpServer } from 'node:http';
import { rmSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const KEYS = ['PRESENTER_TUNNEL_START', 'PRESENTER_TUNNEL_STOP', 'PRESENTER_TUNNEL_CHECK', 'PRESENTER_PUBLIC_URL'];
function setEnv(o = {}) { for (const k of KEYS) { if (o[k] == null) delete process.env[k]; else process.env[k] = o[k]; } }

/*
 * A REAL little state machine instead of constant `true`/`false`: a flag file stands in for the
 * ingress unit, so start/stop/check actually affect each other. Fixed commands cannot catch an
 * ordering bug — the first draft of this file used them and passed a broken already-up branch.
 */
function fakeUnit() {
  const dir = mkdtempSync(join(tmpdir(), 'ap-ingress-'));
  const flag = join(dir, 'up');
  return {
    flag,
    env: { PRESENTER_TUNNEL_START: `touch ${flag}`, PRESENTER_TUNNEL_STOP: `rm -f ${flag}`, PRESENTER_TUNNEL_CHECK: `test -f ${flag}` },
    isUp: () => existsSync(flag),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A stand-in for the public address: an http server on an ephemeral port. */
async function fakePublic(status = 200) {
  const srv = httpServer((req, res) => { res.writeHead(status); res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => new Promise((r) => srv.close(r)) };
}

test('S220 — no ingress configured ⇒ inert, and presenter_start is unaffected', async () => {
  setEnv({});
  expect(tunnelConfigured() === false, 'unconfigured');
  const st = await tunnelStatus();
  expect(st.configured === false, 'status says unconfigured');
  expect(typeof st.note === 'string' && st.note.length > 0, 'and says WHY, rather than a bare false');
  const up = await tunnelUp();
  expect(up.skipped === true && up.configured === false, 'tunnelUp is a no-op — a teaching deployment must not change behaviour');
});

test('S220 — up: runs the start command, waits for active, VERIFIES the public url', async () => {
  const pub = await fakePublic(200);
  try {
    setEnv({ PRESENTER_TUNNEL_START: 'true', PRESENTER_TUNNEL_CHECK: 'false', PRESENTER_PUBLIC_URL: pub.url });
    // check says inactive and never flips ⇒ must give up at the deadline, not hang or lie.
    const stuck = await tunnelUp({ timeoutMs: 1500 });
    expect(stuck.started === true, 'the start command ran');
    expect(stuck.active === false, 'reports NOT active rather than assuming success');

    setEnv({ PRESENTER_TUNNEL_START: 'true', PRESENTER_TUNNEL_CHECK: 'true', PRESENTER_PUBLIC_URL: pub.url });
    const ok = await tunnelUp({ timeoutMs: 8000 });
    expect(ok.active === true, 'active');
    expect(ok.reachable && ok.reachable.ok === true, 'PUBLIC url answered', JSON.stringify(ok.reachable));
    expect(!ok.warning, 'no warning when the public url answers');
  } finally { await pub.close(); }
});

test('S220 — active but UNREACHABLE is reported, not silently passed — on BOTH branches', async () => {
  // The exact live failure mode: the unit is up, the edge has no route. This is why a local
  // 200 cannot stand in for verification. Port 1 is not listening.
  const u = fakeUnit();
  try {
    setEnv({ ...u.env, PRESENTER_PUBLIC_URL: 'http://127.0.0.1:1/' });

    const fresh = await tunnelUp({ timeoutMs: 2500 });          // we started it
    expect(fresh.started === true && fresh.active === true, 'the process came up');
    expect(fresh.reachable && fresh.reachable.ok === false, 'and the public url did NOT answer');
    expect(/reach/i.test(fresh.warning || ''), 'WARNING on the just-started branch', fresh.warning);

    const again = await tunnelUp({ timeoutMs: 2500 });          // already up — the branch that hid the bug
    expect(again.alreadyUp === true, 'second call takes the already-up branch');
    expect(/reach/i.test(again.warning || ''), 'WARNING on the already-up branch too — already up is not already working', again.warning);
  } finally { u.cleanup(); }
});

test('S220 — a failing start command surfaces the error and does not claim success', async () => {
  setEnv({ PRESENTER_TUNNEL_START: 'exit 7', PRESENTER_TUNNEL_CHECK: 'false' });
  const r = await tunnelUp({ timeoutMs: 2000 });
  expect(r.started === false && r.active === false, 'not started');
  expect(typeof r.error === 'string' && r.error.length > 0, 'the error is reported', r.error);
});

test('S220 — already up ⇒ no second start, and still verified', async () => {
  const pub = await fakePublic(200);
  try {
    setEnv({ PRESENTER_TUNNEL_START: 'exit 1', PRESENTER_TUNNEL_CHECK: 'true', PRESENTER_PUBLIC_URL: pub.url });
    const r = await tunnelUp({ timeoutMs: 4000 });
    expect(r.alreadyUp === true && r.started === false, 'the start command was NOT re-run (it would have failed)');
    expect(r.reachable && r.reachable.ok === true, 'an already-up ingress is still verified, not assumed');
  } finally { await pub.close(); }
});

test('S220 — down: runs stop; absent a stop command it says so instead of pretending', async () => {
  setEnv({ PRESENTER_TUNNEL_START: 'true', PRESENTER_TUNNEL_STOP: 'true', PRESENTER_TUNNEL_CHECK: 'false' });
  const r = await tunnelDown();
  expect(r.stopped === true, 'stopped');
  setEnv({ PRESENTER_TUNNEL_START: 'true', PRESENTER_TUNNEL_CHECK: 'false' });
  const n = await tunnelDown();
  expect(n.stopped === false && typeof n.note === 'string', 'no stop command ⇒ reports it, leaves the ingress alone');
});

test('S220 — the STATE overrules the exit code, both directions', async () => {
  // Found live, and no fixed-command test could have caught it: an interactive `systemctl stop`
  // returns instantly, but under exec() the same string sat until the timeout and was SIGTERM'd
  // — because exec waits for stdio EOF and the service manager hands those fds to the daemon.
  // The unit had stopped correctly all along. So: judge by the check, not by the exit code.
  const u = fakeUnit();
  try {
    // stop DOES the work and then exits non-zero — must still be reported as stopped.
    setEnv({ ...u.env, PRESENTER_TUNNEL_STOP: `rm -f ${u.flag}; exit 1` });
    await tunnelUp({ timeoutMs: 4000 });
    expect(u.isUp(), 'up first');
    const down = await tunnelDown();
    expect(down.stopped === true, 'a lying exit code does NOT produce a false failure', JSON.stringify(down));
    expect(/overruled/.test(down.note || ''), 'and the override is stated, not hidden', down.note);

    // The converse: exit 0 while the ingress is still up must NOT be reported as stopped.
    setEnv({ ...u.env, PRESENTER_TUNNEL_STOP: 'true' });
    await tunnelUp({ timeoutMs: 4000 });
    const fake = await tunnelDown();
    expect(fake.stopped === false, 'a successful exit code cannot vouch for a state that never changed');
    expect(typeof fake.error === 'string', 'and it reports an error');

    // A start that "fails" but leaves the ingress up succeeded.
    setEnv({ ...u.env, PRESENTER_TUNNEL_START: `touch ${u.flag}; exit 1` });
    const up = await tunnelUp({ timeoutMs: 5000 });
    expect(up.active === true && !up.error, 'start judged by state too', JSON.stringify(up));
  } finally { u.cleanup(); setEnv({}); }
});

test('S220 — a hung command is killed at the deadline and does not wedge startup', async () => {
  const u = fakeUnit();
  try {
    setEnv({ ...u.env, PRESENTER_TUNNEL_START: `touch ${u.flag}; sleep 60` });
    const t0 = Date.now();
    const r = await tunnelUp({ timeoutMs: 3000 });
    const ms = Date.now() - t0;
    expect(ms < 12000, 'returned rather than hanging for the full sleep', ms + 'ms');
    expect(r.active === true, 'and still saw that the ingress came up', JSON.stringify(r));
  } finally { u.cleanup(); setEnv({}); }
});

test('S220 — presenter_start raises the ingress and returns the PUBLIC url', async () => {
  const pub = await fakePublic(200);
  const u = fakeUnit();
  const T = toolMap({ voiceEnabled: false });
  try {
    setEnv({ ...u.env, PRESENTER_PUBLIC_URL: pub.url });
    const started = await T.presenter_start.handler({ port: 0, voice: false, tunnelTimeoutMs: 8000 });
    expect(started.publicUrl === pub.url, 'the result carries the address a PARTICIPANT opens', started.publicUrl);
    expect(started.tunnel && started.tunnel.active === true, 'ingress up');
    expect(u.isUp(), 'the start command actually ran');
    // ⚠ AMENDED BY PLAN 0522 P12 (R15). This asserted `warning: 'PUBLICLY REACHABLE AND UNGATED'`
    // — a hazard ANNOUNCED on a successful return and then left standing, which is the exact
    // anti-pattern plan 0522 §P16.1 catalogues. presenter_start now mints a control token when
    // the caller passes none (parity with the CLI, which has done so since Plan 0471 H1), so the
    // publicly-reachable-and-ungated state this warned about can no longer be reached through
    // this tool. The claim is STRENGTHENED, not dropped: prevented beats warned, and the minted
    // secret must come back to the caller or the control surface is unusable.
    expect(started.gated === true && !/UNGATED/.test(started.warning || ''),
      'publicly reachable + ungated is now PREVENTED, not warned about', JSON.stringify({ gated: started.gated, warning: started.warning }));
    expect(typeof started.controlToken === 'string' && started.controlToken.length >= 16 && started.controlTokenMinted === true,
      'and the minted credential is RETURNED to the caller, not merely logged', JSON.stringify(started.controlTokenMinted));

    const st = await T.presenter_status.handler({});
    expect(st.tunnel && st.tunnel.configured === true, 'presenter_status reports ingress state');

    // Raised by us ⇒ presenter_stop lowers it.
    const stopped = await T.presenter_stop.handler({});
    expect(stopped.tunnel && stopped.tunnel.stopped === true, 'presenter_stop lowered the ingress it raised');
    expect(!u.isUp(), 'and it is really down');
  } finally { _resetForTests(); await pub.close(); u.cleanup(); setEnv({}); }
});

test('S220 — an ingress we did NOT raise is left alone, unless forced', async () => {
  // "Lower only what you raised." Someone else's tunnel — or one left up from a previous
  // session — must survive presenter_stop, or stopping a test server takes the table offline.
  const pub = await fakePublic(200);
  const u = fakeUnit();
  const T = toolMap({ voiceEnabled: false });
  try {
    setEnv({ ...u.env, PRESENTER_PUBLIC_URL: pub.url });
    await tunnelUp({ timeoutMs: 5000 });                       // up BEFORE presenter_start
    const started = await T.presenter_start.handler({ port: 0, voice: false, tunnelTimeoutMs: 8000 });
    expect(started.tunnel.alreadyUp === true, 'presenter_start found it already up');

    const stopped = await T.presenter_stop.handler({});
    expect(stopped.tunnel.skipped === true, 'presenter_stop left it alone');
    expect(u.isUp(), 'still up — we did not take down what we did not raise');

    _resetForTests();
    await T.presenter_start.handler({ port: 0, voice: false, tunnelTimeoutMs: 8000 });
    const forced = await T.presenter_stop.handler({ tunnel: true });
    expect(forced.tunnel.stopped === true && !u.isUp(), 'tunnel:true forces it down anyway');
  } finally { _resetForTests(); await pub.close(); u.cleanup(); setEnv({}); }
});

test('S220 — presenter_start tunnel:false binds locally only', async () => {
  const T = toolMap({ voiceEnabled: false });
  try {
    setEnv({ PRESENTER_TUNNEL_START: 'exit 1', PRESENTER_TUNNEL_CHECK: 'false' });
    const started = await T.presenter_start.handler({ port: 0, voice: false, tunnel: false });
    expect(started.tunnel && started.tunnel.skipped === true, 'ingress skipped — the start command (which would fail) never ran');
    expect(!started.publicUrl, 'no public url claimed');
    const stopped = await T.presenter_stop.handler({});
    expect(stopped.tunnel && stopped.tunnel.skipped === true, 'and nothing we did not raise is torn down');
  } finally { _resetForTests(); setEnv({}); }
});

test('S220 — presenter_tunnel exposes status/start/stop explicitly', async () => {
  const pub = await fakePublic(200);
  const u = fakeUnit();
  const T = toolMap({ voiceEnabled: false });
  try {
    expect(T.presenter_tunnel, 'the tool is registered');
    setEnv({ ...u.env, PRESENTER_PUBLIC_URL: pub.url });

    const cold = await T.presenter_tunnel.handler({});
    expect(cold.configured === true && cold.active === false, 'default action is status, and it reads the real state');

    const up = await T.presenter_tunnel.handler({ action: 'start', timeoutMs: 6000 });
    expect(up.active === true && up.reachable.ok === true, 'start raises and verifies');
    const again = await T.presenter_tunnel.handler({ action: 'start', timeoutMs: 6000 });
    expect(again.alreadyUp === true, 'start on an up ingress is idempotent');

    const down = await T.presenter_tunnel.handler({ action: 'stop' });
    expect(down.stopped === true && !u.isUp(), 'stop works');
  } finally { await pub.close(); u.cleanup(); setEnv({}); }
});
