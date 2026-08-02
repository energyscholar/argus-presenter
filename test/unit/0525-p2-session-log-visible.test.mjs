/*
 * Plan 0525 P2 (I1) — t76/t77: CAN THE AGENT TELL WHETHER THE SESSION IS BEING RECORDED?
 *
 * Plan 0522 P16.2 added the durable session log because a live session's evidence died with its
 * process, and every "run one session and then measure" criterion in three earlier plans had been
 * unfalsifiable in practice. The CLI has printed whether it is recording ever since — `session log: <dir>/<id>`
 * or `DISABLED — <reason>` — but only the CLI. `presenter_start` is the path that raises the
 * PUBLIC ingress, i.e. the path the real sessions come up on, and an agent that started a session
 * that way had no way to ask. A recorder nobody can confirm is running is the original failure
 * with extra steps: that is the I1 surface-parity gap these two tests close.
 *
 *   t76 — a RECORDING session reports enabled:true, its directory, and a growing appended count.
 *   t77 — a NON-RECORDING one reports enabled:false WITH THE REASON.
 *
 * ⛔⛔ AND NEITHER RESPONSE CARRIES ONE LOG ENTRY. That is the assertion that stops a status
 * surface quietly becoming a read surface later. The log is the session transcript — participants'
 * own spoken and typed words — and its read surface is deliberately ONE role-gated endpoint
 * (GET /api/session-log, control credential required, fails closed when none is configured; Plan
 * 0522 R6). t76 puts a nonce through the op path, proves it reached the FILE, and proves it is
 * nowhere in what presenter_health hands back: the words exist, and the status surface does not
 * carry them. Both tests assert the reported shape is exactly six enumerated keys, so a future
 * spread of `sessionLog.status()` — which would drag `parts` in today and could drag anything in
 * tomorrow — fails here rather than in a live session.
 *
 * ⚠ OBSERVED, NOT FIXED (reported, out of this phase's scope): `sessionLogDirSource` reads
 * `option` on the presenter_start path, never `env`/`config`/`built-in`. tools.mjs resolves the
 * deployment's directory and passes it to createServer as an option, and createServer stamps the
 * source of any explicit option as `option` (app/server.mjs, "sessionLogDirSource: 'option'"), so
 * the provenance the field exists to carry is erased one call before it is read. The field is
 * still reported and asserted here — a weak gauge that is visible can be fixed; an absent one
 * cannot — and t76 pins the value so the day it starts saying `env` is a change somebody chose.
 *
 * ⚠ Unit tier, no browser. Every path is a mkdtemp scratch directory; nothing here writes to the
 * repo, to the gitignored modules/ directory, or to a real ~/.local/state. t77's refused path is
 * asserted NOT to exist, before and after. No server binds a fixed port (`port: 0` throughout).
 * PRESENTER_SESSION_LOG_DIR is set and restored inside each test — the suite runs in one process.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { toolMap, _server } from '../../mcp/tools.mjs';
import { SESSION_LOG_DIR_ENV } from '../../lib/session-log.mjs';
import { REPO_ROOT } from '../../lib/deployment-config.mjs';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = () => mkdtempSync(join(tmpdir(), 'ap-0525-p2-'));
const kill = (d) => { try { rmSync(d, { recursive: true, force: true }); } catch {} };

/** The six keys P2 declares. Enumerated, never spread — see the header. */
const SHAPE = ['enabled', 'sessionLogId', 'sessionLogDir', 'sessionLogDirSource', 'sessionLogDirError', 'stats'];

/** Set the deployment's log directory for one test, and hand back the undo. */
function withLogDir(dir) {
  const had = Object.prototype.hasOwnProperty.call(process.env, SESSION_LOG_DIR_ENV);
  const prev = process.env[SESSION_LOG_DIR_ENV];
  process.env[SESSION_LOG_DIR_ENV] = dir;
  return () => { if (had) process.env[SESSION_LOG_DIR_ENV] = prev; else delete process.env[SESSION_LOG_DIR_ENV]; };
}

/**
 * THE ASSERTION THIS PHASE IS REALLY FOR: a status surface that reports on a transcript must not
 * become a way to read one. Checked three ways, on the WHOLE health response and not just on the
 * sessionLog block, because a leak that appears one level up is still a leak.
 */
function carriesNoEntries(label, health, nonce) {
  const sl = health.sessionLog;
  const whole = JSON.stringify(health);
  expect(`${label}: the reported shape is exactly the six declared keys — no entries, no parts, no read handle`,
    Object.keys(sl).sort().join(',') === SHAPE.slice().sort().join(','), Object.keys(sl).sort().join(','));
  for (const forbidden of ['entries', 'lines', 'tail', 'read', 'sessions']) {
    expect(`${label}: nothing named "${forbidden}" anywhere in the response`,
      !new RegExp('"' + forbidden + '"').test(whole), whole.slice(0, 400));
  }
  if (nonce) {
    expect(`${label}: and not one word of what was logged — the nonce is absent from the ENTIRE response`,
      !whole.includes(nonce), whole.slice(0, 400));
  }
  expect(`${label}: stats are counters, all numeric — a counter cannot smuggle a transcript`,
    sl.stats && typeof sl.stats === 'object' && Object.values(sl.stats).every((v) => typeof v === 'number'),
    JSON.stringify(sl.stats));
}

// ── t76 ──────────────────────────────────────────────────────────────────────────────────────
test('0525 t76 — a RECORDING session reports enabled, its directory and a growing count, and NOT ONE entry', async () => {
  const logDir = scratch();
  const undo = withLogDir(logDir);
  const T = toolMap();
  // The stand-in for a participant's own words: distinctive enough that if it ever appears in a
  // status response the grep above cannot miss it, and domain-neutral (docs/naming-canon.md).
  const NONCE = 'nonce-0525-p2-spoken-aloud-and-never-echoed';
  try {
    await T.presenter_start.handler({ port: 0, tunnel: false });
    try {
      const before = (await T.presenter_health.handler({})).sessionLog;
      expect('the session says it is being recorded', before.enabled === true, JSON.stringify(before));

      // Work, through the agent's own surface, plus one op carrying words — the thing the log is
      // for and the thing the status surface must never hand back.
      await T.present_module.handler({ title: 'Fixture', beats: [{ id: 'a', component: 'card', opts: { title: 'A' } }] });
      await T.append_beat.handler({ beat: { id: 'b', component: 'card', opts: { title: 'B' } } });
      _server().store.apply({ path: 'chat/line0', verb: 'set', value: { text: NONCE } }, { userId: 'u1', role: 'ai' });
      await _server().sessionLog.flush();     // deterministic: the documented close-path/test flush

      const h = await T.presenter_health.handler({});
      const sl = h.sessionLog;

      // ── it is recording, and it says WHERE ────────────────────────────────────────────────
      expect('enabled:true', sl.enabled === true, JSON.stringify(sl));
      expect('the directory is reported, and it is the one this deployment declared',
        sl.sessionLogDir === logDir, String(sl.sessionLogDir));
      expect('the session log id is reported, so a human can find THIS run among the others',
        typeof sl.sessionLogId === 'string' && /^session-/.test(sl.sessionLogId), String(sl.sessionLogId));
      expect('the provenance field is populated (see the header: `option` on this path, not `env`)',
        sl.sessionLogDirSource === 'option', String(sl.sessionLogDirSource));
      expect('and no error is reported while it is working', sl.sessionLogDirError === null, String(sl.sessionLogDirError));

      // ── the counters MOVED: "enabled" that never counts anything is the dead-gauge shape ──
      expect('appended is non-zero', sl.stats.appended > 0, JSON.stringify(sl.stats));
      expect('…and GREW as the session did — not just the one line the log writes when it opens',
        sl.stats.appended > before.stats.appended && sl.stats.appended > 1,
        `${before.stats.appended} -> ${sl.stats.appended}`);
      expect('written is non-zero after a flush — buffered is not recorded',
        sl.stats.written > 0, JSON.stringify(sl.stats));
      expect('nothing was dropped and nothing failed', sl.stats.dropped === 0 && sl.stats.failures === 0, JSON.stringify(sl.stats));

      // ── the reported directory is the one really being written (beyond the letter: an
      //    "enabled" that names a directory nobody writes to would be a dead gauge with a path) ─
      const parts = readdirSync(sl.sessionLogDir).filter((n) => n.startsWith(sl.sessionLogId));
      expect('a part file for THIS session exists in the reported directory', parts.length >= 1, parts.join(','));
      expect('…and it has bytes in it', parts.some((n) => statSync(join(sl.sessionLogDir, n)).size > 0), parts.join(','));

      // ── the words ARE on disk, and are NOT in the response. Both halves, or neither means
      //    anything: an absent nonce proves nothing if it was never recorded in the first place.
      const onDisk = parts.map((n) => readFileSync(join(sl.sessionLogDir, n), 'utf8')).join('');
      expect('the spoken line reached the FILE — the record exists', onDisk.includes(NONCE), String(onDisk.length));
      carriesNoEntries('t76', h, NONCE);

      // ── and the agent reading the schema learns the field is there and what it is not ─────
      const desc = T.presenter_health.description;
      expect('the tool description names sessionLog, so it is discoverable without reading source',
        /sessionLog/.test(desc), desc);
      expect('…and says the content is not on this surface',
        /never the content|role-gated/i.test(desc), desc);
    } finally { await T.presenter_stop.handler({}); }
  } finally { undo(); kill(logDir); }
});

// ── t77 ──────────────────────────────────────────────────────────────────────────────────────
test('0525 t77 — a NON-RECORDING session says so WITH THE REASON, and still carries not one entry', async () => {
  /*
   * The refusal is the deployment's own, and it needs no permission games to provoke: a log
   * directory inside the checkout is REFUSED outright by lib/session-log.mjs (isInsideRepoCheckout
   * — "the log carries session transcripts and must live outside any repository"). Nothing is
   * created, which is asserted, so this test cannot leave a stray directory in the repo.
   */
  const refused = join(REPO_ROOT, 'never-created-0525-p2-session-logs');
  expect('the refused path does not exist before the test', !existsSync(refused), refused);
  const undo = withLogDir(refused);
  const T = toolMap();
  try {
    await T.presenter_start.handler({ port: 0, tunnel: false });
    try {
      const h = await T.presenter_health.handler({});
      const sl = h.sessionLog;

      expect('enabled:false — nothing is being recorded, and the agent is told', sl.enabled === false, JSON.stringify(sl));
      expect('THE REASON is reported: a disabled gauge that will not say why is the dead-gauge shape',
        typeof sl.sessionLogDirError === 'string' && sl.sessionLogDirError.trim().length > 0, String(sl.sessionLogDirError));
      expect('…and the reason is specific enough to act on — it names the refused path',
        sl.sessionLogDirError.includes(refused), sl.sessionLogDirError);
      expect('no directory is claimed, because there is none', sl.sessionLogDir === null, String(sl.sessionLogDir));
      expect('and the counters are still reported, at zero appended', sl.stats && sl.stats.appended === 0, JSON.stringify(sl.stats));

      // The session itself is FINE — the log is an instrument, never a gate on play.
      expect('the health verdict is unaffected: a disabled log does not degrade the session',
        h.status === 'green', h.status);

      carriesNoEntries('t77', h, null);

      expect('nothing was created at the refused path', !existsSync(refused), refused);
    } finally { await T.presenter_stop.handler({}); }
  } finally { undo(); }
  expect('…and nothing is left behind in the checkout after the server is gone', !existsSync(refused), refused);
});
