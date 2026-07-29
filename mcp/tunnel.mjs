/*
 * mcp/tunnel.mjs — public ingress (tunnel) lifecycle, tied to MCP startup.
 *
 * WHY THIS EXISTS (S220, 2026-07-28). `presenter_start` bound a server to 127.0.0.1, reported
 * `running: true`, and every remote participant got nothing: the tunnel unit was `inactive` AND
 * `disabled`, so it does not come back after a reboot or a crash. The agent said "AP is up" while
 * the only address anyone else can reach was dead. Bruce: *"that's part of starting up Presenter."*
 *
 * So starting the presenter means starting the whole REACHABLE surface. The tool result must
 * measure the service, not the process.
 *
 * DOMAIN-NEUTRAL BY CONSTRUCTION. Core carries no vendor, no hostname, no unit name — every one of
 * those is deployment configuration supplied by env, exactly like PRESENTER_ASR_CMD. A deployment
 * with no ingress configured is unaffected: everything here degrades to {configured:false} and
 * `presenter_start` behaves as it always did.
 *
 *   PRESENTER_TUNNEL_START  shell command that brings the ingress up
 *   PRESENTER_TUNNEL_STOP   shell command that takes it down          (optional)
 *   PRESENTER_TUNNEL_CHECK  shell command, exit 0 ⇔ ingress is active (optional but wanted)
 *   PRESENTER_PUBLIC_URL    the address a PARTICIPANT actually opens  (optional but wanted)
 *
 * These are shell commands from local configuration and are executed as such — the same trust
 * model the ASR command already has. They are never taken from a wire frame, a module, or a
 * transcript.
 */
import { spawn } from 'node:child_process';

const env = (k) => {
  const v = process.env[k];
  return (typeof v === 'string' && v.trim()) ? v.trim() : null;
};

const cfg = () => ({
  start: env('PRESENTER_TUNNEL_START'),
  stop: env('PRESENTER_TUNNEL_STOP'),
  check: env('PRESENTER_TUNNEL_CHECK'),
  publicUrl: env('PRESENTER_PUBLIC_URL'),
});

/** An ingress exists to be brought up; without a start command there is nothing to manage. */
export function tunnelConfigured() { return !!cfg().start; }

/*
 * Resolve on the child's EXIT, not on its pipes closing.
 *
 * `exec()` waits for stdout/stderr EOF as well as exit, and a service manager hands those fds to
 * the daemon it supervises — so the fds outlive the command. Observed S220: an interactive
 * `systemctl stop` returns instantly, while the same string under exec() sat until the 20 s
 * timeout, took a SIGTERM, and reported failure. The unit had stopped correctly the whole time.
 * A false failure on a command that WORKED is worse than a slow one: it makes the caller undo,
 * retry, or report a problem that does not exist.
 */
function sh(command, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill('SIGKILL'); } catch {} finish(null, 'timeout'); } }, timeoutMs);
    function finish(code, note) {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim(), ...(note ? { note } : {}) });
    }
    child.on('error', (e) => { if (!done) { done = true; stderr += String(e.message || e); finish(null, 'spawn-error'); } });
    child.on('exit', (code) => { if (!done) { done = true; finish(code); } });
  });
}

/** Is the ingress process up? `null` when no check command is configured — unknown, not false. */
async function active() {
  const { check } = cfg();
  if (!check) return null;
  return (await sh(check, 10000)).ok;
}

/*
 * THE POINT OF THE WHOLE MODULE. A local 200 proves the process is listening and proves nothing
 * about whether anyone can reach it. Verification fetches the PUBLIC address, from outside.
 */
async function reachable(url, timeoutMs = 8000) {
  if (!url) return null;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'manual' });
    return { ok: res.status > 0 && res.status < 500, status: res.status };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}

export async function tunnelStatus() {
  const { start, stop, check, publicUrl } = cfg();
  if (!start) return { configured: false, note: 'no PRESENTER_TUNNEL_START — this deployment has no public ingress; the server is reachable only on its bound address' };
  return {
    configured: true,
    active: await active(),
    publicUrl: publicUrl || null,
    canStop: !!stop,
    canCheck: !!check,
    ...(publicUrl ? { reachable: await reachable(publicUrl) } : {}),
  };
}

/**
 * Bring the ingress up and DO NOT return success until the public address answers.
 * Returns {configured, started, alreadyUp, active, publicUrl, reachable, waitedMs}.
 */
export async function tunnelUp({ verify = true, timeoutMs = 30000 } = {}) {
  const { start, publicUrl } = cfg();
  if (!start) return { configured: false, skipped: true };

  const was = await active();
  if (was === true) {
    // Already up is NOT already working. An ingress process can be active with no route at the
    // edge — verify and warn here too, or this branch becomes the silent one.
    const r = verify && publicUrl ? await reachable(publicUrl) : null;
    return {
      configured: true, alreadyUp: true, started: false, active: true, publicUrl,
      ...(r ? { reachable: r } : {}),
      ...(r && !r.ok ? { warning: 'ingress is up but the PUBLIC url did not answer — participants cannot reach this session' } : {}),
    };
  }

  const t0 = Date.now();
  const run = await sh(start, Math.min(timeoutMs, 20000));
  // The exit code is ADVISORY; the check command is the authority. A start that "fails" but
  // leaves the ingress active succeeded, and one that "succeeds" but leaves it down did not.
  if (!run.ok && (await active()) !== true) {
    return { configured: true, started: false, active: false, publicUrl, error: run.stderr || run.stdout || `start command exited ${run.code}`, command: start };
  }

  // Settle: the unit reports active before the edge has a route. Poll both, and report which
  // stage we are stuck at rather than a bare boolean — "up but unreachable" is a real state.
  //
  // do/while, not while: a start command that eats the whole budget (or hangs to its deadline)
  // must still leave us with ONE honest look at the state. The while-form reported active:null
  // — "I never checked" dressed up as a result.
  let isActive = null, reach = null;
  do {
    isActive = await active();
    if (isActive === false) { if (Date.now() - t0 >= timeoutMs) break; await new Promise((r) => setTimeout(r, 500)); continue; }
    if (!verify || !publicUrl) break;
    reach = await reachable(publicUrl);
    if (reach && reach.ok) break;
    if (Date.now() - t0 >= timeoutMs) break;
    await new Promise((r) => setTimeout(r, 1000));
  } while (Date.now() - t0 < timeoutMs);

  return {
    configured: true,
    started: true,
    active: isActive,
    publicUrl: publicUrl || null,
    ...(reach ? { reachable: reach } : {}),
    waitedMs: Date.now() - t0,
    ...(verify && publicUrl && !(reach && reach.ok)
      ? { warning: 'ingress started but the PUBLIC url did not answer in time — participants cannot reach this session yet' }
      : {}),
  };
}

export async function tunnelDown({ timeoutMs = 20000 } = {}) {
  const { stop } = cfg();
  if (!stop) return { configured: tunnelConfigured(), stopped: false, note: 'no PRESENTER_TUNNEL_STOP configured — ingress left as it is' };
  const run = await sh(stop, timeoutMs);
  // Same rule as tunnelUp: the STATE decides, the exit code only explains. Where there is no
  // check command there is no state to consult, so the exit code is all we have.
  const isActive = await active();
  const stopped = (isActive === null) ? run.ok : (isActive === false);
  return {
    configured: true, stopped, active: isActive,
    ...(stopped ? {} : { error: run.stderr || run.stdout || `stop command exited ${run.code}` }),
    ...(stopped && !run.ok ? { note: 'ingress is down; the stop command reported failure and was overruled by the check' } : {}),
  };
}
