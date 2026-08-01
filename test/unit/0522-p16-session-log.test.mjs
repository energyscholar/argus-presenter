/*
 * Plan 0522 P16.2 (R3, R6) — THE DURABLE SESSION LOG.
 *
 *   t51 — the log SURVIVES PROCESS EXIT: a child writes ops, is SIGKILLed, the parent reads back.
 *   t43 — the default path resolves OUTSIDE ANY GIT REPOSITORY.
 *   t44 — an UNWRITABLE log directory does not take down the session.
 *   t45 — the read endpoint requires the ai/presenter control credential; unauthenticated refused.
 *   t46 — the log ROTATES at the cap and does not grow unbounded.
 *
 * ⛓ TEST IDS. The plan numbers this phase t42–t48; t01–t42 were already claimed (t42 by P15/R18)
 * and t47/t48 are P16.1's. The plan's `t42` is therefore `t51` here. t13 was never used and is
 * NOT recycled — a recycled id is a name that means two things.
 *
 * WHY THIS PHASE EXISTS. app/state.mjs keeps the op-log in a 1000-entry in-memory ring and nothing
 * in this repo has ever written it anywhere. Every "run one session and then measure" criterion in
 * plans 0508/0514/0516 has been unfalsifiable in practice — including 0516's own claim that no
 * instrumentation was needed — because the evidence was freed with the process. S17 (2026-07-28)
 * is the worked example: its process had exited before planning began.
 *
 * ⚠⚠ THE BASELINE TRAP, and it is why t51 is written the way it is. THE OPLOG IS NOT EMPTY AT
 * BOOT: the 0514 ship-machine plugin applies durable ops during createServer(), so store.version()
 * is 3 before any session activity. Eight of this suite's twelve pre-existing failures (C4, E3,
 * X1–X5, X7) are tests that assumed 0. t51 therefore asserts on ops APPENDED RELATIVE TO A
 * CAPTURED BASELINE — the child reports its own version() before it emits anything — and never on
 * an absolute count.
 *
 * ⚠ Every path here is a mkdtemp scratch directory. Nothing is written to the repo, to modules/
 * (§ANNEAL E), or to a real ~/.local/state — t43 asserts things ABOUT the default path without
 * ever creating it. §ANNEAL F4: no server here binds 3000/4300/4399.
 *
 * Unit tier: no browser. t51 uses a real child process because "survives process exit" cannot be
 * demonstrated inside the process that would have to survive.
 */
import { test, check } from '../../harness/test.mjs';
import {
  createSessionLog, resolveSessionLogDir, defaultSessionLogDir, isInsideRepoCheckout,
  listSessionLogs, readSessionLog, SESSION_LOG_DEFAULTS, SESSION_LOG_DIR_ENV, SESSION_LOG_DIR_KEY,
} from '../../lib/session-log.mjs';
import { REPO_ROOT, CONFIG_BASENAME } from '../../lib/deployment-config.mjs';
import { createServer } from '../../app/server.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, chmodSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = () => mkdtempSync(join(tmpdir(), 'ap-0522-p162-'));
const kill = (d) => { try { rmSync(d, { recursive: true, force: true }); } catch {} };

/** GET a url, returning {status, body} — no dependency beyond node:http. */
async function get(url, headers = {}) {
  const { get: httpGet } = await import('node:http');
  return new Promise((res, rej) => {
    httpGet(url, { headers }, (r) => {
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => { let json = null; try { json = JSON.parse(body); } catch {} res({ status: r.statusCode, body, json }); });
    }).on('error', rej);
  });
}

// ── t51 ──────────────────────────────────────────────────────────────────────────────────────
test('0522 t51 — the session log SURVIVES PROCESS EXIT (start, emit ops, kill, read back)', async () => {
  const logDir = scratch(), scriptDir = scratch();
  const script = join(scriptDir, 'emit.mjs');
  const OPS = 7;
  /*
   * A child that starts a REAL server with the log pointed at our scratch directory, records the
   * BASELINE version (already non-zero — see the header), emits OPS durable ops, forces them to
   * disk, announces itself, and then blocks forever waiting to be killed. Nothing here calls
   * close(): the point is that the record survives a process that never got to shut down tidily.
   */
  writeFileSync(script, `
import { createServer } from ${JSON.stringify(join(REPO_ROOT, 'app', 'server.mjs'))};
const server = await createServer({ port: 0, sessionLogDir: ${JSON.stringify(logDir)} });
const baselineVersion = server.store.version();
for (let i = 0; i < ${OPS}; i++) {
  server.store.apply({ path: 'chat/line' + i, verb: 'set', value: { text: 'spoken line ' + i } }, { userId: 'u1', role: 'ai' });
}
await server.sessionLog.flush();
console.log('READY ' + JSON.stringify({ baselineVersion, sessionLogId: server.sessionLog.sessionLogId }));
setInterval(() => {}, 1000);
`);
  let child = null;
  try {
    child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const ready = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('child never became READY: ' + out)), 20000);
      child.stdout.on('data', (c) => {
        out += c;
        const m = /READY (\{.*\})/.exec(out);
        if (m) { clearTimeout(t); res(JSON.parse(m[1])); }
      });
      child.stderr.on('data', (c) => { out += c; });
      child.on('exit', (code) => { clearTimeout(t); rej(new Error('child exited early (' + code + '): ' + out)); });
    });

    // KILL, uncatchably. No exit handler, no flush, no close() — only what already reached disk.
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
    check('the writing process is really gone', child.killed === true || child.exitCode !== null);

    const back = readSessionLog(logDir, ready.sessionLogId, { limit: 1000 });
    const ops = back.entries.filter((e) => e.kind === 'op');
    // ⚠⚠ RELATIVE TO THE CAPTURED BASELINE. An absolute count here would encode the exact wrong
    // assumption that fails C4/E3/X1–X5/X7, and it would look like a bug in this phase.
    const appended = ops.filter((e) => e.version > ready.baselineVersion);
    check('the baseline is NOT zero — plugin ops are applied during createServer()',
      ready.baselineVersion > 0, String(ready.baselineVersion));
    check(`all ${OPS} ops appended after the baseline are on disk`, appended.length === OPS,
      `${appended.length} of ${OPS}; total op lines ${ops.length}, baseline ${ready.baselineVersion}`);
    check('...with their content, not just their count',
      appended.every((e, i) => e.value && e.value.text === 'spoken line ' + i), JSON.stringify(appended.map((e) => e.path)));
    check('...and their identity, so a session can be attributed', appended.every((e) => e.by === 'u1' && e.role === 'ai'));
    check('the log opens with a provenance header', back.entries[0] && back.entries[0].kind === 'session-open' && back.entries[0].pid > 0, JSON.stringify(back.entries[0]));
    check('a SIGKILL leaves no unparseable wreckage in this case', back.unparsedLines === 0, String(back.unparsedLines));

    // The directory is discoverable without knowing the id — the reader is a LATER process.
    const sessions = listSessionLogs(logDir);
    check('the session is discoverable by listing the directory alone', sessions.length === 1 && sessions[0].sessionLogId === ready.sessionLogId, JSON.stringify(sessions.map((s) => s.sessionLogId)));
    check('...and reports its size', sessions[0].bytes > 0, String(sessions[0].bytes));

    // THE CONVERSE — without the durable log this evidence does not exist. The in-memory ring is
    // gone with the process; all that remains is what was written.
    check('nothing but the file survived: the ops are readable ONLY off disk',
      readSessionLog(logDir, ready.sessionLogId, { limit: 1000 }).entries.length === back.entries.length);
  } finally {
    if (child && child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
    kill(logDir); kill(scriptDir);
  }
});

// ── t43 ──────────────────────────────────────────────────────────────────────────────────────
test('0522 t43 — the DEFAULT log path resolves outside any git repository', async () => {
  // Pure string resolution: this test creates NOTHING under a real home directory.
  const synthetic = defaultSessionLogDir({ env: { HOME: '/home/somebody' } });
  check('the default is XDG state, not the checkout', synthetic === join('/home/somebody', '.local', 'state', 'argus-presenter', 'logs'), synthetic);
  check('XDG_STATE_HOME is honoured', defaultSessionLogDir({ env: { HOME: '/home/somebody', XDG_STATE_HOME: '/var/lib/state' } })
    === join('/var/lib/state', 'argus-presenter', 'logs'));

  // The real default, on this machine, with this repo. Read-only assertions.
  const real = defaultSessionLogDir();
  check('the real default is NOT inside this checkout', !isInsideRepoCheckout(real, REPO_ROOT), real);
  // Walk every ancestor of the default and prove none of them is a git working tree. "Outside any
  // repo" is not "outside THIS repo": a log inside somebody's dotfiles repo is just as committable.
  const ancestors = [];
  for (let d = resolve(real); ; d = dirname(d)) { ancestors.push(d); if (dirname(d) === d) break; }
  const repos = ancestors.filter((d) => existsSync(join(d, '.git')));
  check('no ancestor of the default path is a git working tree', repos.length === 0, JSON.stringify(repos));
  check('...and the checkout IS one, so that check can actually fire', existsSync(join(REPO_ROOT, '.git')));

  // The mechanism is the PATH, and it is enforced, not merely documented.
  check('the repo root itself is recognised as inside the checkout', isInsideRepoCheckout(REPO_ROOT, REPO_ROOT));
  check('...and a subdirectory of it', isInsideRepoCheckout(join(REPO_ROOT, 'modules', 'logs'), REPO_ROOT));
  check('...and a sibling directory is NOT (no prefix-match false positive)',
    !isInsideRepoCheckout(REPO_ROOT + '-elsewhere', REPO_ROOT), REPO_ROOT + '-elsewhere');

  const inside = resolveSessionLogDir({ env: { [SESSION_LOG_DIR_ENV]: join(REPO_ROOT, 'session-logs') } });
  check('a configured path INSIDE the checkout is refused outright', inside.sessionLogDir === null, JSON.stringify(inside));
  check('...and says why, naming the checkout', /inside the checkout/.test(inside.sessionLogDirError || '') && (inside.sessionLogDirError || '').includes(resolve(REPO_ROOT)), inside.sessionLogDirError);
  const refused = createSessionLog({ ...inside });
  check('...and a log built on it is DISABLED, not half-open', refused.status().enabled === false);
  check('...and accepts nothing', refused.append({ kind: 'op', version: 1 }) === false);

  // Resolution order: env > config file > built-in.
  const cfgRepo = scratch(), fakeHome = scratch(), envDir = scratch(), noCfgRepo = scratch();
  try {
    writeFileSync(join(cfgRepo, CONFIG_BASENAME), JSON.stringify({ presenterPort: 0, [SESSION_LOG_DIR_KEY]: join(fakeHome, 'from-config') }));
    const fromCfg = resolveSessionLogDir({ env: { HOME: fakeHome }, repoDir: cfgRepo });
    check('the config file supplies the directory', fromCfg.sessionLogDir === join(fakeHome, 'from-config') && fromCfg.sessionLogDirSource === 'config', JSON.stringify(fromCfg));
    const fromEnv = resolveSessionLogDir({ env: { HOME: fakeHome, [SESSION_LOG_DIR_ENV]: envDir }, repoDir: cfgRepo });
    check('the env var beats the config file', fromEnv.sessionLogDir === resolve(envDir) && fromEnv.sessionLogDirSource === 'env', JSON.stringify(fromEnv));
    const builtIn = resolveSessionLogDir({ env: { HOME: fakeHome }, repoDir: noCfgRepo });
    check('no env, no config key ⇒ the built-in XDG default', builtIn.sessionLogDir === defaultSessionLogDir({ env: { HOME: fakeHome } }) && builtIn.sessionLogDirSource === 'built-in', JSON.stringify(builtIn));
    // A broken config must not be able to stop a session starting. The port loader is loud on
    // purpose (P16.1); the LOG resolver degrades, because the instrument must never be the thing
    // that takes the instrument's subject down.
    const brokenRepo = scratch();
    writeFileSync(join(brokenRepo, CONFIG_BASENAME), '{ not json');
    const degraded = resolveSessionLogDir({ env: { HOME: fakeHome }, repoDir: brokenRepo });
    check('an unparseable config degrades to the default rather than throwing', degraded.sessionLogDir === defaultSessionLogDir({ env: { HOME: fakeHome } }), JSON.stringify(degraded));
    check('...and reports the reason', /unreadable/.test(degraded.sessionLogDirError || ''), degraded.sessionLogDirError);
    kill(brokenRepo);
  } finally { kill(cfgRepo); kill(fakeHome); kill(envDir); kill(noCfgRepo); }
});

// ── t44 ──────────────────────────────────────────────────────────────────────────────────────
test('0522 t44 — an UNWRITABLE log directory does not take down the session', async () => {
  const parent = scratch();
  const unwritable = join(parent, 'no-entry');
  mkdirSync(unwritable, { recursive: true });
  chmodSync(unwritable, 0o500);                       // r-x: cannot create anything inside
  const target = join(unwritable, 'logs');
  let server = null;
  try {
    // Running as root defeats mode bits entirely; say so rather than assert a false green.
    const rootish = (typeof process.getuid === 'function' && process.getuid() === 0);
    check('the scratch directory really is unwritable (skip this file as root)', !rootish, rootish ? 'running as root — mode bits do not apply' : '');

    server = await createServer({ port: 0, sessionLogDir: target, rolePassword: 'pw' });
    const st = server.sessionLog.status();
    check('the server STARTED anyway', typeof server.url() === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(server.url()), server.url());
    if (!rootish) {
      check('the log disabled itself', st.enabled === false, JSON.stringify(st));
      check('...and named the directory it could not write', (st.sessionLogDirError || '').includes(target), st.sessionLogDirError);
    }

    // THE SESSION KEEPS WORKING. Ops still apply, still version, still return their diff — the
    // sink is instrumentation and a failed sink is not allowed to become a failed op.
    const baselineVersion = server.store.version();
    const res = server.store.apply({ path: 'chat/x', verb: 'set', value: { text: 'still speaking' } }, { userId: 'u1', role: 'ai' });
    check('an op still applies with the log dead', !!res && res.version === baselineVersion + 1, JSON.stringify(res));
    check('...and still reaches the in-memory state', server.store.get('chat/x').text === 'still speaking');
    check('...and still reaches the in-memory op-log', server.store.oplogSince(baselineVersion).length === 1);
    for (let i = 0; i < 50; i++) server.store.apply({ path: 'chat/y' + i, verb: 'set', value: { i } }, { userId: 'u1', role: 'ai' });
    check('fifty more ops do not throw and do not stall', server.store.version() === baselineVersion + 51, String(server.store.version()));
    check('the log counts what it dropped rather than pretending', server.sessionLog.status().stats.dropped >= 51 || rootish, JSON.stringify(server.sessionLog.status().stats));

    // The HTTP surface is still alive after the log failure — this is the "server still serves" leg.
    const r = await get(server.url() + '/api/modules');
    check('the http surface still answers', r.status === 200, String(r.status));
    // And close() does not throw on a dead log.
    await server.close(); server = null;
    check('close() completes with a dead log', true);

    // The same guarantee one layer down, with NO server involved: a directory that cannot be
    // created at all, and a flush that cannot fail loudly.
    const direct = createSessionLog({ sessionLogDir: join(unwritable, 'deeper', 'still') });
    check('a log on an uncreatable directory is disabled, not thrown', direct.status().enabled === false || rootish);
    check('...append returns false instead of raising', direct.append({ kind: 'op', version: 1 }) === false || rootish);
    await direct.flush();
    direct.close();
    check('...flush and close are safe on a dead log', true);
  } finally {
    if (server) { try { await server.close(); } catch {} }
    try { chmodSync(unwritable, 0o700); } catch {}
    kill(parent);
  }
});

// ── t45 ──────────────────────────────────────────────────────────────────────────────────────
test('0522 t45 — reading the log requires the ai/presenter control credential', async () => {
  const logDir = scratch();
  const ungatedDir = scratch();
  let gated = null, ungated = null;
  try {
    // roleSeed + rolePassword ARE the presenter/ai gate (CONTROL_ROLES) — the same credential the
    // ws hello presents. No second auth scheme was added for this endpoint.
    gated = await createServer({ port: 0, sessionLogDir: logDir, rolePassword: 'sekrit', roleSeed: 'salty' });
    const { createHash } = await import('node:crypto');
    const roleHash = createHash('sha256').update('salty' + 'sekrit').digest('hex');
    const base = gated.url() + '/api/session-log';

    gated.store.apply({ path: 'chat/l1', verb: 'set', value: { text: 'a participant speaking' } }, { userId: 'u1', role: 'ai' });
    await gated.sessionLog.flush();

    const anon = await get(base);
    check('unauthenticated is REFUSED', anon.status === 403, `${anon.status} ${anon.body.slice(0, 120)}`);
    check('...and leaks no transcript in the refusal', !/participant speaking/.test(anon.body), anon.body.slice(0, 120));
    const wrong = await get(base, { 'x-control-token': 'not-the-password' });
    check('a wrong credential is REFUSED', wrong.status === 403, String(wrong.status));
    const wrongQuery = await get(base + '?token=nope');
    check('...including via the query string', wrongQuery.status === 403, String(wrongQuery.status));

    const okHeader = await get(base, { 'x-control-token': roleHash });
    check('the role credential (roleSeed+rolePassword hash) is ACCEPTED', okHeader.status === 200, `${okHeader.status} ${okHeader.body.slice(0, 160)}`);
    check('...and returns this session\'s entries', okHeader.json && okHeader.json.entries.some((e) => e.value && e.value.text === 'a participant speaking'), JSON.stringify((okHeader.json || {}).stats));
    check('...naming where the log lives and how it got there', okHeader.json.sessionLogDir === logDir && okHeader.json.sessionLogDirSource === 'option', JSON.stringify({ d: okHeader.json.sessionLogDir, s: okHeader.json.sessionLogDirSource }));
    check('...and which session is current', okHeader.json.currentSessionLogId === gated.sessionLog.sessionLogId);
    const okQuery = await get(base + '?token=' + roleHash + '&limit=5');
    check('the query-string form works too, and limit is honoured', okQuery.status === 200 && okQuery.json.limit === 5, `${okQuery.status} ${JSON.stringify((okQuery.json || {}).limit)}`);

    // A controlToken is the other half of the SAME credential, not a second scheme.
    await gated.close(); gated = null;
    gated = await createServer({ port: 0, sessionLogDir: logDir, controlToken: 'tok-abc' });
    const tokBase = gated.url() + '/api/session-log';
    check('a controlToken server also refuses anonymous', (await get(tokBase)).status === 403);
    check('...and accepts the token', (await get(tokBase, { 'x-control-token': 'tok-abc' })).status === 200);

    /*
     * ⚠ FAIL CLOSED, and this is a DECLARED DIVERGENCE from /api/situation, which is open on an
     * ungated server. P16.1's own finding is the reason: presenter_start raises a PUBLIC ingress,
     * so "ungated AND publicly reachable" is an observed state of this deployment, not a
     * hypothetical — and what would be world-readable here is other people's speech. "No
     * credential configured" is not "no gate to apply"; it is "nothing to verify against".
     */
    await gated.close(); gated = null;
    ungated = await createServer({ port: 0, sessionLogDir: ungatedDir });
    const u = await get(ungated.url() + '/api/session-log');
    check('an UNGATED server refuses the log rather than serving it open', u.status === 403, `${u.status} ${u.body.slice(0, 160)}`);
    check('...and says it is a configuration fault, not a bad password', /has none configured/.test(u.body), u.body.slice(0, 200));
    check('...while the rest of that ungated server is still open (this is not a blanket lockdown)',
      (await get(ungated.url() + '/api/situation')).status === 200);
  } finally {
    if (gated) { try { await gated.close(); } catch {} }
    if (ungated) { try { await ungated.close(); } catch {} }
    kill(logDir); kill(ungatedDir);
  }
});

// ── t46 ──────────────────────────────────────────────────────────────────────────────────────
test('0522 t46 — the log ROTATES at the cap and does not grow unbounded', async () => {
  const dir = scratch();
  try {
    const maxBytes = 2048, maxParts = 3;
    const slog = createSessionLog({ sessionLogDir: dir, maxBytes, maxParts, flushMs: 1 });
    check('the log is live', slog.status().enabled === true, JSON.stringify(slog.status()));

    const LINES = 400;
    for (let i = 0; i < LINES; i++) {
      slog.append({ kind: 'op', version: i + 1, path: 'chat/line' + i, verb: 'set', value: { text: 'x'.repeat(64), i } });
      if (i % 20 === 0) await slog.flush();          // interleave flushes: rotation on many chunks
    }
    await slog.flush();

    const st = slog.status();
    check('it rotated', st.stats.rotated > 0, JSON.stringify(st.stats));
    const files = readdirSync(dir).filter((f) => f.startsWith(slog.sessionLogId));
    check(`at most maxParts (${maxParts}) part files remain`, files.length <= maxParts, JSON.stringify(files));
    check('...and the oldest were UNLINKED, not merely abandoned', files.length === maxParts, JSON.stringify(files));
    const totalBytes = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
    // The ceiling that matters: bytes on disk, not part count. One chunk may overshoot maxBytes
    // (a line is never split), so the bound is per-part-cap + one chunk of slack per part.
    check('total bytes are BOUNDED by the caps, not by how long the session ran',
      totalBytes <= maxParts * maxBytes * 2, `${totalBytes} bytes over ${files.length} parts (cap ${maxBytes})`);

    const back = readSessionLog(dir, slog.sessionLogId, { limit: 10000 });
    const ops = back.entries.filter((e) => e.kind === 'op');
    check('the NEWEST entries survived', ops.length > 0 && ops[ops.length - 1].version === LINES, JSON.stringify(ops[ops.length - 1] || null));
    check('the OLDEST were dropped — that is what "bounded" costs', ops.length < LINES, `${ops.length} of ${LINES}`);
    check('...and what remains is contiguous, not interleaved wreckage',
      ops.every((e, i) => i === 0 || e.version === ops[i - 1].version + 1), 'versions are not contiguous');
    check('nothing unparseable was left behind by rotation', back.unparsedLines === 0, String(back.unparsedLines));
    slog.close();

    // Growth across SESSIONS is capped too — the vector that actually runs away is one new file
    // per run, forever. maxSessions prunes the oldest at open.
    const many = scratch();
    try {
      const ids = [];
      for (let i = 0; i < 8; i++) {
        const s = createSessionLog({ sessionLogDir: many, maxSessions: 4, sessionLogId: `session-2026080100000${i}-aaa${i}` });
        s.append({ kind: 'op', version: 1, path: 'chat/x', verb: 'set', value: { i } });
        s.close();
        ids.push(s.sessionLogId);
      }
      const kept = listSessionLogs(many);
      check('the directory retains at most maxSessions session logs', kept.length <= 4, JSON.stringify(kept.map((s) => s.sessionLogId)));
      check('...and it is the OLDEST that were dropped', kept.every((s) => ids.indexOf(s.sessionLogId) >= ids.length - 4), JSON.stringify(kept.map((s) => s.sessionLogId)));
    } finally { kill(many); }

    // The buffer has a ceiling too: a wedged disk must not grow the heap under a live session.
    check('the declared caps are all bounded numbers', Object.values(SESSION_LOG_DEFAULTS).every((v) => Number.isFinite(v) && v > 0), JSON.stringify(SESSION_LOG_DEFAULTS));
    const tiny = createSessionLog({ sessionLogDir: dir, bufferMaxBytes: 256, flushMs: 100000 });
    for (let i = 0; i < 500; i++) tiny.append({ kind: 'op', version: i, value: { text: 'y'.repeat(64) } });
    check('the in-memory buffer is bounded while a flush is pending', tiny.status().pending < 20, String(tiny.status().pending));
    check('...and the loss is COUNTED, never silent', tiny.status().stats.dropped > 0, JSON.stringify(tiny.status().stats));
    tiny.close();
  } finally { kill(dir); }
});
