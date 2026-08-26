/*
 * lib/ops-status.mjs — WHAT IS ACTUALLY DEPLOYED, AND IS IT ACTUALLY SERVING.
 *
 * Plan 0689 R1 + R2. Every deploy, restart, release inspection and journal read on 2026-08-25/26
 * went through `ssh`, and BOTH failed rollback proofs were caused by that rather than by the
 * rollback itself:
 *
 *   1. `smoke.sh` was piped through `tail`, which DISCARDED ITS EXIT STATUS — and the "silent
 *      success" defect that got reported was partly the instrumentation's own.
 *   2. A 120-second tool timeout killed the sequence BEFORE `recover.sh` ran, twice, leaving the
 *      proof inconclusive and the presenter down ~5 minutes each time.
 *
 * ⇒ ⛔ TEXT THROUGH A PIPE IS NOT A MEASUREMENT. A structured result cannot lose an exit code in a
 *   pipeline and cannot be truncated into a different answer. Everything here returns DATA.
 *
 * ⛔⛔ TWO FACTS THIS FILE EXISTS TO REPORT, BECAUSE EACH ONE LIED ONCE:
 *
 *   A. THE SYMLINK IS NOT THE RUNNING CODE. In the 0686 rollback failure `current` pointed at a
 *      release the running process was not executing. So `unitStatus()` reports MainPID **and**
 *      ExecMainStartTimestamp: a start timestamp older than the release's builtAt means the unit
 *      never restarted onto it, and no amount of reading the symlink can tell you that.
 *
 *   B. AN ANSWERING PORT IS NOT HEALTH. The phantom presenters answered 200 on everything for 26
 *      hours while serving a page with no stage in it. So `realPageMarkers()` asserts STRUCTURE the
 *      real presenter emits and an error page cannot — the same two markers `pipeline/smoke.sh`
 *      uses, deliberately, so the tool and the pipeline cannot disagree about what "healthy" means.
 *
 * ⭐ RELEASE IDENTITY IS A PROPERTY OF THE TREE, NOT OF THE FILENAME. This mirrors
 *   `pinion:pipeline/releases.sh` (plan 0688 R1): a release is a directory containing a readable
 *   `layer.json` naming a `sha` and a `contentHash`. One stray `PHANTOM-TEST-…` directory made the
 *   old name-matching enumerator count 0 of 11 and left the presenter down. ⛔ Do not "fix" that by
 *   tightening a regex — that only moves the brittleness.
 *
 * ⛔ NOTHING IS SKIPPED SILENTLY (G6). Every directory that is not a usable release is NAMED with
 *   its reason. "have 0" told an operator nothing.
 *
 * READ-ONLY BY CONSTRUCTION. Nothing here writes, restarts, deploys or rolls back. `presenter_deploy`
 * / `presenter_rollback` are plan 0689 R3 and need a recorded decision from Bruce that has not been
 * made — an agent-callable deploy is a different power from an agent-callable status read.
 */
import { readFileSync, readdirSync, statSync, lstatSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { loadDeploymentConfig, normalizeRoomsConfig, normalizeRoomConfig } from './deployment-config.mjs';

export const DEFAULT_SRV_ROOT = '/srv/argus';
export const LEGACY_UNIT = 'argus-presenter.service';

/** The deployment root. `$ARGUS_SRV_ROOT` overrides, exactly as the pipeline scripts read it. */
export function srvRoot(env = process.env) {
  const v = (env && env.ARGUS_SRV_ROOT ? String(env.ARGUS_SRV_ROOT).trim() : '');
  return v || DEFAULT_SRV_ROOT;
}

/*
 * ⭐ THE TWO MARKERS, IN ONE PLACE. `id="stage"` is what the display mounts into; `id="ap-config"`
 * is the settings dialog. Both survive the voice-strip transform of the served HTML (verified
 * against a live `node app/server.mjs`, 2026-08-25). An error page has a plausible <title> and
 * neither of these — which is why the check is structure and not a word.
 */
export const REAL_PAGE_MARKERS = Object.freeze(['id="stage"', 'id="ap-config"']);

export function realPageMarkers(body) {
  const text = String(body == null ? '' : body);
  const missing = REAL_PAGE_MARKERS.filter((m) => !text.includes(m));
  return { realPage: missing.length === 0, missing };
}

// ── releases ──────────────────────────────────────────────────────────────────────────────────

function readLayer(path) {
  const manifest = join(path, 'layer.json');
  if (!existsSync(manifest)) return { error: 'no layer.json — a release always has one, so this is not a release' };
  let doc;
  try { doc = JSON.parse(readFileSync(manifest, 'utf8')); }
  catch (e) { return { error: `layer.json will not parse: ${(e && e.message) || e}` }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'layer.json is not a JSON object' };
  if (typeof doc.sha !== 'string' || !doc.sha) return { error: 'layer.json names no sha' };
  if (typeof doc.contentHash !== 'string' || !doc.contentHash) return { error: 'layer.json names no contentHash' };
  return { doc };
}

/**
 * Enumerate the releases under `<root>/releases`, OLDEST FIRST.
 *
 * @returns {{root, ok, releases, rejected, error}}
 *   `ok:false` + `error` means the releases directory itself is unreadable or absent — which is
 *   NOT the same fact as "zero releases found", and is reported as its own thing.
 */
export function enumerateReleases({ root = srvRoot() } = {}) {
  const dir = join(root, 'releases');
  const out = { root, dir, ok: true, releases: [], rejected: [], error: null };
  let entries;
  try { entries = readdirSync(dir).sort(); }
  catch (e) {
    out.ok = false;
    out.error = `cannot read ${dir}: ${(e && e.message) || e} — there is nothing to roll back to, and that is not the same as "zero releases found"`;
    return out;
  }
  const rows = [];
  for (const name of entries) {
    const path = join(dir, name);
    let st;
    try { st = lstatSync(path); } catch (e) { out.rejected.push({ name, reason: `cannot stat: ${(e && e.message) || e}` }); continue; }
    if (st.isSymbolicLink()) { out.rejected.push({ name, reason: 'a symlink, not a release directory (`current` is the only symlink that means anything here)' }); continue; }
    if (!st.isDirectory()) { out.rejected.push({ name, reason: 'not a directory' }); continue; }
    // ⛔ release.sh's half-unpacked `.incoming-XXXXXX` staging tree CONTAINS a layer.json, so
    //   identifying releases by content alone would adopt an interrupted deploy as a rollback
    //   target. A leading dot is release.sh's own "not finished yet" marker.
    if (name.startsWith('.')) { out.rejected.push({ name, reason: "an interrupted or in-progress deploy (leading dot = release.sh's staging tree, never a finished release)" }); continue; }
    const { doc, error } = readLayer(path);
    if (error) { out.rejected.push({ name, reason: error }); continue; }

    let sortKey = null, keySource = 'builtAt';
    if (typeof doc.builtAt === 'string') { const t = Date.parse(doc.builtAt); if (Number.isFinite(t)) sortKey = t / 1000; }
    if (sortKey === null) {
      // ⭐ USABLE, BUT SAY SO. An unreadable builtAt is a metadata defect, not a broken release;
      //   refusing a real release over a missing field is the same outage in a different costume.
      try { sortKey = statSync(path).mtimeMs / 1000; keySource = 'mtime'; }
      catch (e) { out.rejected.push({ name, reason: `no usable builtAt and cannot stat the directory: ${(e && e.message) || e}` }); continue; }
    }
    rows.push({ name, path, sha: doc.sha, contentHash: doc.contentHash, builtAt: doc.builtAt ?? null, sortKey, keySource });
  }
  rows.sort((a, b) => (a.sortKey - b.sortKey) || a.name.localeCompare(b.name));
  out.releases = rows;
  return out;
}

/**
 * What `<root>/current` points at, and what that tree SAYS it is.
 * ⛔ Reported as a claim, never as evidence of what is running — see note A in the header.
 */
export function currentRelease({ root = srvRoot() } = {}) {
  const link = join(root, 'current');
  const out = { link, exists: false, target: null, sha: null, contentHash: null, builtAt: null, error: null };
  if (!existsSync(link)) { out.error = `no ${link} — this deployment has never had a release activated, or the symlink was removed`; return out; }
  out.exists = true;
  try { out.target = realpathSync(link); } catch (e) { out.error = `cannot resolve ${link}: ${(e && e.message) || e}`; return out; }
  const { doc, error } = readLayer(out.target);
  if (error) { out.error = `${out.target}: ${error}`; return out; }
  out.sha = doc.sha; out.contentHash = doc.contentHash; out.builtAt = doc.builtAt ?? null;
  return out;
}

// ── the unit ──────────────────────────────────────────────────────────────────────────────────

const UNIT_PROPS = ['LoadState', 'MainPID', 'ExecMainStartTimestamp', 'ExecMainStartTimestampMonotonic', 'ActiveState', 'SubState', 'NRestarts', 'FragmentPath'];

function run(cmd, args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? null) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? String(err.message || err) : null });
    });
  });
}

/**
 * ⭐⭐ THE PID AND THE START TIMESTAMP, NOT JUST THE SYMLINK.
 *
 * `systemctl show` is a KEY=VALUE reader with no journal and no pager, so it cannot hang on output
 * and cannot be truncated into a different answer.
 *
 * @param exec injectable for tests — same shape as run().
 */
export async function unitStatus(unit, { exec = run, timeoutMs = 5000 } = {}) {
  const out = { unit, present: false, loadState: null, activeState: null, subState: null, mainPID: null, execMainStartTimestamp: null, nRestarts: null, fragmentPath: null, error: null };
  const r = await exec('systemctl', ['show', unit, '--no-pager', ...UNIT_PROPS.map((p) => `--property=${p}`)], { timeoutMs });
  if (!r.stdout.trim()) { out.error = r.error || r.stderr.trim() || `systemctl show ${unit} returned nothing`; return out; }
  const kv = {};
  for (const line of r.stdout.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim(); }
  /* ⛔ `systemctl show` answers for a unit that does not exist: inactive/dead, exit 0. That reads
   *   as "a stopped presenter" when the truth is "there is no such unit on this box" — two very
   *   different things to an operator at 3am. LoadState is what separates them. */
  out.loadState = kv.LoadState || null;
  out.present = out.loadState !== 'not-found';
  out.activeState = kv.ActiveState || null;
  out.subState = kv.SubState || null;
  out.mainPID = kv.MainPID ? Number(kv.MainPID) : null;
  out.execMainStartTimestamp = kv.ExecMainStartTimestamp || null;
  out.nRestarts = kv.NRestarts != null ? Number(kv.NRestarts) : null;
  out.fragmentPath = kv.FragmentPath || null;
  // ⛔ systemd reports a stopped unit as MainPID=0. Zero is not a pid; saying so beats a caller
  //   reading `0` as a running process.
  if (out.mainPID === 0) out.mainPID = null;
  if (!r.ok && !out.activeState) out.error = r.error || r.stderr.trim() || null;
  return out;
}

/**
 * ⛔⛔ THE SYMLINK LIED ONCE — SO COMPARE IT WITH THE CLOCK.
 * A unit whose ExecMainStartTimestamp is EARLIER than the current release's builtAt is running code
 * from before that release existed, however confidently `current` points at it.
 */
export function staleUnit(current, unit) {
  if (!current || !current.builtAt || !unit || !unit.execMainStartTimestamp) return { stale: null, reason: 'not comparable — need both the release builtAt and the unit ExecMainStartTimestamp' };
  const built = Date.parse(current.builtAt);
  const started = Date.parse(unit.execMainStartTimestamp);
  if (!Number.isFinite(built) || !Number.isFinite(started)) return { stale: null, reason: 'not comparable — one of the two timestamps will not parse' };
  if (started < built) {
    return { stale: true, reason: `the unit started at ${unit.execMainStartTimestamp}, BEFORE the current release was built at ${current.builtAt} — the symlink was moved and the unit was never restarted onto it. This is the 0686 shape: the symlink says one thing and the running process is another.` };
  }
  return { stale: false, reason: `the unit started at ${unit.execMainStartTimestamp}, after the current release was built at ${current.builtAt}` };
}

// ── rooms ─────────────────────────────────────────────────────────────────────────────────────

/**
 * WHICH ROOMS EXIST, and what each one's unit and ports are — read from the deployment config the
 * ENGINE reads, exactly as `pinion:pipeline/rooms.sh` does.
 *
 * ⛔ NO `rooms{}` BLOCK IS NOT AN ERROR — it is the single legacy room on `presenterPort`. Deriving
 *   the room set from anything else (a hardcoded list, `systemctl list-units`, a naming convention)
 *   means the pipeline's answer and the engine's answer can differ, and the pipeline's is the wrong
 *   one.
 */
export function roomTable(opts = {}) {
  const cfg = loadDeploymentConfig(opts);
  const topPort = cfg.presenterPort;
  const rooms = normalizeRoomsConfig(cfg.rooms, cfg.configPath || '(built-in defaults)');
  if (!rooms) {
    const d = normalizeRoomConfig(cfg.defaultRoom, cfg.configPath || '(built-in defaults)', '(defaultRoom)');
    return {
      configPath: cfg.configPath, configSource: cfg.configSource, legacy: true,
      rooms: [{ name: '(default)', unit: LEGACY_UNIT, port: d.port ?? topPort, mcpPort: d.mcpPort ?? null }],
    };
  }
  const list = Object.keys(rooms).sort().map((name) => ({
    name,
    unit: `argus-presenter@${name}.service`,
    port: rooms[name].port ?? topPort,
    mcpPort: rooms[name].mcpPort ?? null,
  }));
  return { configPath: cfg.configPath, configSource: cfg.configSource, legacy: false, rooms: list };
}

// ── probing ───────────────────────────────────────────────────────────────────────────────────

/**
 * ⛔ NOT `curl | grep -q`. This returns the STATUS and the BODY VERDICT together; there is no pipe
 * to lose an exit code in and no early-exiting reader to send a SIGPIPE upstream (the shape that
 * once reported the presenter's own homepage as "not the presenter").
 */
export async function probe(url, { timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
  const out = { url, ok: false, status: null, ms: null, realPage: false, missing: [...REAL_PAGE_MARKERS], error: null };
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, redirect: 'manual' });
    out.status = res.status;
    const body = await res.text();
    const marks = realPageMarkers(body);
    out.realPage = marks.realPage;
    out.missing = marks.missing;
    out.ok = res.status === 200 && marks.realPage;
  } catch (e) {
    out.error = String((e && e.name === 'AbortError') ? `no answer within ${timeoutMs}ms` : ((e && e.message) || e));
  } finally { clearTimeout(timer); out.ms = Date.now() - t0; }
  return out;
}

/** This host's tailnet address. `$ARGUS_TAILNET_IP` wins; else `tailscale ip -4`; else null. */
export async function tailnetAddress({ env = process.env, exec = run } = {}) {
  const v = (env && env.ARGUS_TAILNET_IP ? String(env.ARGUS_TAILNET_IP).trim() : '');
  if (v) return { address: v, source: 'ARGUS_TAILNET_IP' };
  const r = await exec('tailscale', ['ip', '-4'], { timeoutMs: 4000 });
  const first = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)[0];
  if (first) return { address: first, source: 'tailscale ip -4' };
  return { address: null, source: null, error: r.error || r.stderr.trim() || 'tailscale did not name an address' };
}
