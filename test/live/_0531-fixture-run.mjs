/*
 * _0531-fixture-run.mjs — ONE neutral-fixture session, shared by every test that asserts on it.
 * Plan 0531 P2.
 *
 * ⚠ WHY THIS FILE EXISTS. Booting five real browsers takes ~45 s. Two test files now assert over
 * the same walk — `0525-fixture-session.test.mjs` (t78: the walk runs on COMMITTED content, and
 * nothing it touches is gitignored) and `0531-fixture-behaviour.test.mjs` (the product behaviour
 * that plan 0531 P2 ported off a private deployment's deck). Running the rig twice would cost a
 * minute and prove nothing extra, and two independent five-browser sessions in one process is
 * exactly the shape that turns a flaky wait into a flaky suite.
 *
 * ⚠ MEMOISED, AND LAZY. The promise is created on the first call, never at import: the whole suite
 * is ONE process, and a module that started five browsers at import time would start them even for
 * `--only` runs that match nothing here.
 *
 * ⛔ Every caller gets the SAME report object. Nobody may mutate it.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSession, writeReport } from '../../harness/session-rig.mjs';
import SPEC from './0525-fixture-spec.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where the screenshots and REPORT.md land. Gitignored (`test/screenshots/`). */
export const SHOT_DIR = join(ROOT, 'test', 'screenshots', '0525-fixture');

let _run = null;

/** The one fixture session. Resolves to the rig's report; never rejects for an in-session failure. */
export function fixtureRun() {
  if (!_run) _run = runSession(SPEC, { shotDir: SHOT_DIR }).then((r) => {
    try { writeReport(r, SHOT_DIR); } catch (e) { /* a report we could not write is not a test failure */ }
    return r;
  });
  return _run;
}

/**
 * The same run, but with the "did the session itself die?" check already made — so a rig that
 * never completed says so once, in full, instead of surfacing as fourteen `undefined` derefs.
 */
export async function fixtureReport() {
  const r = await fixtureRun();
  if (!r.ok) throw new Error(`the session rig did not complete: ${r.error}`);
  return r;
}
