/*
 * test.mjs — the Argus Presenter test runner (tiny, zero-dep beyond Node).
 *
 * A test file does:
 *     import { test, expect } from '<rel>/harness/test.mjs';
 *     test('name', async () => { ...; expect(cond, 'msg', detail); });
 *
 * Run modes:
 *   node harness/test.mjs                 discover + run every *.mjs under test/
 *   node harness/test.mjs --only poll     only files/tests whose path or name matches
 *   node test/unit/foo.test.mjs           direct-run one file (auto-runs on exit)
 *
 * Output: per-test PASS/FAIL, per-tier counts (unit|component|live), one final
 * `N passed / M failed` summary; exit code non-zero iff any test failed.
 */
import { readdirSync, statSync, existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, relative, sep } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TEST_DIR = join(ROOT, 'test');

const REG = [];
let _currentFile = null;
let _runnerActive = false;   // true when this module is the CLI entry (disables auto-run)
let _active = null;          // { failed } for the currently-running test (for check())

/** Register a test. `fn` may be sync or async. */
export function test(name, fn) { REG.push({ name, fn, file: _currentFile || '(direct)' }); }

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
 */
export function check(name, cond, detail) {
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

function discover(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...discover(p));
    else if (name.endsWith('.mjs')) out.push(p);
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

  const { passed, failed, byTier } = await runRegistered({ only });

  // Cleanup any shared headless browser so node exits promptly.
  try { const m = await import('./drive.mjs'); if (m.closeBrowser) await m.closeBrowser(); } catch {}

  const tierStr = Object.entries(byTier)
    .map(([k, v]) => `${k}:${v.passed}/${v.passed + v.failed}`)
    .join('  ');
  console.log(`\n${passed} passed / ${failed} failed` + (tierStr ? `   [${tierStr}]` : ''));
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
