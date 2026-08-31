/*
 * test.mjs — the Argus Presenter test runner (tiny, zero-dep beyond Node).
 *
 * A test file does:
 *     import { test, expect } from '<rel>/harness/test.mjs';
 *     test('name', async () => { ...; expect(cond, 'msg', detail); });
 *
 * Run modes:
 *   node harness/test.mjs                 discover + run every *.test.mjs under test/
 *   node harness/test.mjs --only poll     only files/tests whose path or name matches
 *   node test/unit/foo.test.mjs           direct-run one file (auto-runs on exit)
 *
 * Output: per-test PASS/FAIL, per-tier counts (unit|component|live), one final
 * `N passed / M failed` summary; exit code non-zero iff any test failed.
 */
import { readdirSync, statSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, relative, sep } from 'path';
import { tmpdir } from 'os';

/*
 * ── Plan 0522 P16.2 — TEST ISOLATION FOR THE DURABLE SESSION LOG ────────────────────────────
 * The deployment paths (the CLI self-run and presenter_start) now write the session op-log to
 * ${XDG_STATE_HOME:-~/.local/state}/argus-presenter/logs. That is correct for a real session and
 * WRONG for a test run: a suite must not leave files in a human's actual state directory, and
 * some of these tests spawn the CLI as a child process, so an in-process override would not
 * reach them.
 *
 * Set at IMPORT, not in main(), because a single file can be direct-run (`node test/unit/x.test.mjs`)
 * and never reaches main() — but every test file imports this module. An explicit env var set by
 * the operator still wins, so a run can be pointed somewhere deliberately.
 */
if (!process.env.PRESENTER_SESSION_LOG_DIR) {
  const scratchLogDir = mkdtempSync(join(tmpdir(), 'ap-test-session-log-'));
  process.env.PRESENTER_SESSION_LOG_DIR = scratchLogDir;
  process.on('exit', () => { try { rmSync(scratchLogDir, { recursive: true, force: true }); } catch {} });
}

/*
 * ── Plan 0575 P9 — A PLUGIN'S DURABLE STATE IS ISOLATED PER TEST ────────────────────────────
 *
 * A plugin may now keep state that OUTLIVES the server, under $PRESENTER_PLUGIN_STATE_DIR
 * (default: XDG state, never the checkout). That is correct for a deployment and would be two
 * separate disasters in a suite:
 *
 *   1. across the machine — a run would write into a human's real state directory, so running
 *      the tests would change what the next real session comes up holding;
 *   2. across the SUITE — one test's saved state is the next test's boot state. A test that
 *      changes something and a test that asserts the value at boot would then pass or fail on
 *      their ORDER IN THE FILE LISTING, which is the worst kind of intermittent: it looks like
 *      flake, it bisects to nothing, and it is nobody's diff.
 *
 * ⭐ So this is fixed BY CONSTRUCTION rather than by asking each test to remember: `runRegistered`
 * points the variable at a fresh, never-created subdirectory before every test, so isolation is
 * not something a new test can forget to opt into. Two servers started INSIDE one test still
 * share a directory — which is exactly what a restart test needs.
 *
 * An explicit setting by the operator still wins outright, so a run can be pointed somewhere
 * deliberately. Set at IMPORT for the same reason as the block above: a file can be direct-run.
 */
const PLUGIN_STATE_ENV = 'PRESENTER_PLUGIN_STATE_DIR';
let _scratchPluginState = null;
if (!process.env[PLUGIN_STATE_ENV]) {
  _scratchPluginState = mkdtempSync(join(tmpdir(), 'ap-test-plugin-state-'));
  process.env[PLUGIN_STATE_ENV] = _scratchPluginState;
  process.on('exit', () => { try { rmSync(_scratchPluginState, { recursive: true, force: true }); } catch {} });
}
let _stateSeq = 0;

/*
 * ── Plan 0720 RUN C — THE SUITE MUST NEVER INHERIT A DEPLOYMENT'S STATE DIRECTORY ───────────
 *
 * `createServer()` becomes DURABLE when any of the three variables below is set: it then dumps
 * `shared/**` + `ships/**` to disk on change and restores from that file at boot. Both halves are
 * a disaster inside a test run, and the second one is the worse:
 *
 *   1. ACROSS THE MACHINE — the live deployment on this estate sets `PRESENTER_DATA_DIR`. A suite
 *      run in that environment would write into, and restore from, THE RUNNING SESSION'S OWN
 *      STATE FILE. The tests would be editing the game.
 *   2. ACROSS THE SUITE — every bare `createServer()` would share ONE file, so one test's board
 *      would be the next test's boot state and results would depend on file-listing order. That is
 *      the worst kind of intermittent: it looks like flake, it bisects to nothing, it is nobody's
 *      diff. (The same argument the plugin-state block above makes, one layer down.)
 *
 * ⇒ The variables are CLEARED, not redirected. Redirecting to a scratch directory would leave
 *   every server durable and merely move failure 2 somewhere tidier; clearing makes a bare
 *   `createServer()` INERT, which is the library default this repo already relies on. A test that
 *   wants durability passes `stateDir:` explicitly and owns its own directory.
 *
 * ⚠ An explicit `PRESENTER_STATE_DIR` still wins outright, so a run can be pointed somewhere
 *   deliberately — the same escape hatch the two blocks above give.
 */
if (!process.env.PRESENTER_STATE_DIR) {
  delete process.env.PRESENTER_DATA_DIR;
  delete process.env.PRESENTER_CAMPAIGN_DIR;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TEST_DIR = join(ROOT, 'test');

const REG = [];
let _currentFile = null;
let _runnerActive = false;   // true when this module is the CLI entry (disables auto-run)
let _active = null;          // { failed } for the currently-running test (for check())

/** Register a test. `fn` may be sync or async. */
export function test(name, fn) { REG.push({ name, fn, file: _currentFile || '(direct)' }); }

/* Plan 0667 phase A3 — safe one-line rendering of a wrong-typed value for a guard message.
 * try/catch because JSON.stringify throws on a circular object and returns undefined on some
 * primitives (Symbol, function) that String() renders fine instead. */
function describeForError(v) {
  try {
    const s = JSON.stringify(v);
    if (s !== undefined) return s;
  } catch { /* fall through to String() */ }
  return String(v);
}

/** Throwing assertion. cond-first. Marks the enclosing test failed on !cond. */
export function expect(cond, msg, detail) {
  if (!cond) {
    const e = new Error('expect failed: ' + (msg || '') + (detail != null ? ' — ' + detail : ''));
    e.isAssertion = true;
    throw e;
  }
  return true;
}

/**
 * Non-throwing assertion, name-first — the signature the migrated practice reps use
 * (`expect(name, cond, detail)`). Prints a per-assertion PASS/FAIL line and marks
 * the enclosing test failed on !cond WITHOUT aborting the rest of the rep.
 *
 * Plan 0667 phase A3 — the NAME slot is unambiguous: a real call always passes a string here,
 * so a non-string is always the two argument-order mistakes EX-1 was full of (a condition passed
 * where a name was expected, `check as expect` used cond-first by habit, or the arguments
 * transposed some other way). Thrown, not silently coerced, so the mistake surfaces at the call
 * site instead of shipping a vacuous test. The CONDITION slot is deliberately left unguarded —
 * `check('label', someObject)` is legitimate name-first usage and a runtime type-check there
 * would false-positive on working code (the redteam confirmed this reasoning; see plan §A3).
 */
export function check(name, cond, detail) {
  if (typeof name !== 'string') {
    throw new TypeError(
      `check(name, cond, detail): "name" must be a string, got ${typeof name} ` +
      `(${describeForError(name)}). This is usually the arguments swapped — ` +
      `check(cond, name) instead of check(name, cond).`
    );
  }
  const ok = !!cond;
  if (!ok && _active) _active.failed = true;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? '  — ' + detail : ''}`);
  return ok;
}

/** Tier from a file path: test/unit|component/live -> unit|component|live (else 'other'). */
function tierOf(file) {
  const parts = String(file).split(sep);
  const i = parts.lastIndexOf('test');
  const t = i >= 0 ? parts[i + 1] : null;
  return ['unit', 'component', 'live'].includes(t) ? t : 'other';
}

/*
 * Discovery is restricted to `*.test.mjs`.
 *
 * WHY (Plan 0522 P1): discovery used to take EVERY `*.mjs` under test/, and the runner
 * imports all discovered files BEFORE running anything. One deployment's standalone acceptance
 * SCRIPT sat under test/: it executed at import time (top-level await) and ended in
 * `process.exit()`. Sorted, it landed between `test/live/` and `test/unit/`, so importing it
 * terminated the process — every registered test was discarded unrun and the harness exited 0
 * with the script's own "ALL PASS". `test/unit/` had never executed. (That script left for the
 * private content repo in plan 0531 P2; the restriction is what keeps the next one harmless.)
 *
 * A file that is not named `*.test.mjs` is not a suite: it is a helper (`test/unit/_*.mjs`) or a
 * standalone script. Both are reported by `skippedFiles()` rather than silently dropped.
 */
function discover(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...discover(p));
    else if (name.endsWith('.test.mjs')) out.push(p);
  }
  return out.sort();
}

/** `*.mjs` under test/ that discovery deliberately skips — reported, never silent. */
function skippedFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...skippedFiles(p));
    else if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) out.push(p);
  }
  return out.sort();
}

/** Run tests (default: the global registry). Returns {passed,failed,byTier}.
 *  quiet=true suppresses per-test lines (used by the runner's own self-tests). */
export async function runRegistered({ only = null, tests = REG, quiet = false } = {}) {
  const byTier = {};
  let passed = 0, failed = 0;
  const saved = _active;   // nested runRegistered (e.g. a runner self-test) must not clobber the caller's active test
  const match = (t) => !only || t.file.includes(only) || t.name.toLowerCase().includes(only.toLowerCase());
  for (const t of tests.slice()) {
    if (!match(t)) continue;
    const tier = tierOf(t.file);
    byTier[tier] = byTier[tier] || { passed: 0, failed: 0 };
    // 0575 P9 — a fresh, empty plugin-state directory per test (see the note at the top of this
    // file). Not created here: a plugin that persists nothing must leave nothing behind, and one
    // that does will mkdir on its first write.
    if (_scratchPluginState) process.env[PLUGIN_STATE_ENV] = join(_scratchPluginState, 't' + (_stateSeq++));
    _active = { failed: false };
    let err = null;
    try { await t.fn(); } catch (e) { err = e; }
    const failedThis = _active.failed || !!err;
    _active = null;
    if (failedThis) {
      failed++; byTier[tier].failed++;
      if (!quiet) console.log(`FAIL  ${t.name}${err ? '  — ' + (err.message || err) : ''}`);
      if (!quiet && err && err.stack && !err.isAssertion) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    } else {
      passed++; byTier[tier].passed++;
      if (!quiet) console.log(`PASS  ${t.name}`);
    }
  }
  _active = saved;   // restore caller's active test (supports nested runs)
  return { passed, failed, byTier };
}

async function main() {
  _runnerActive = true;
  const argv = process.argv.slice(2);
  const oi = argv.indexOf('--only');
  const only = oi >= 0 ? argv[oi + 1] : null;

  // Import every test file (registers tests); --only is applied at run time so it
  // can match a test NAME inside a file, not just the file path.
  const files = discover(TEST_DIR);
  for (const f of files) {
    _currentFile = f;
    try { await import(pathToFileURL(f).href); }
    catch (e) { console.log(`FAIL  (import ${relative(ROOT, f)}) — ${e && e.message ? e.message : e}`); process.exitCode = 1; }
  }
  _currentFile = null;

  const skipped = skippedFiles(TEST_DIR);
  if (skipped.length) {
    console.log(`\nnot a suite, not discovered (run directly if needed):`);
    for (const s of skipped) console.log(`  - ${relative(ROOT, s)}`);
    console.log('');
  }

  // A harness that runs zero tests passes. That is the bug P1 exists to kill: never
  // let an empty registry report success.
  if (REG.length === 0) {
    console.log(`FAIL  discovery found ${files.length} file(s) under test/ but registered 0 tests`);
    process.exit(1);
  }

  const { passed, failed, byTier } = await runRegistered({ only });

  // Cleanup any shared headless browser so node exits promptly.
  try { const m = await import('./drive.mjs'); if (m.closeBrowser) await m.closeBrowser(); } catch {}

  const tierStr = Object.entries(byTier)
    .map(([k, v]) => `${k}:${v.passed}/${v.passed + v.failed}`)
    .join('  ');
  console.log(`\n${passed} passed / ${failed} failed` + (tierStr ? `   [${tierStr}]` : ''));
  if (passed + failed === 0) {
    console.log(`FAIL  ${REG.length} test(s) registered but 0 executed` + (only ? ` — --only ${only} matched nothing` : ''));
    process.exit(1);
  }
  process.exit(failed ? 1 : 0);
}

// Direct-run of a single test file: auto-run its registered tests on exit.
let _autoRan = false;
process.on('beforeExit', async () => {
  if (_runnerActive || _autoRan || REG.length === 0) return;
  _autoRan = true;
  const { passed, failed } = await runRegistered({});
  try { const m = await import('./drive.mjs'); if (m.closeBrowser) await m.closeBrowser(); } catch {}
  console.log(`\n${passed} passed / ${failed} failed`);
  process.exit(failed ? 1 : 0);
});

// CLI entry?
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
