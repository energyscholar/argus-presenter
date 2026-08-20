/*
 * T1 — the runner itself. Concrete assertions on test()/expect()/runRegistered:
 * expect throws on false (marks a fail) and passes on true; runRegistered tallies
 * exactly and reports per-tier; --only filters by name substring. Uses an isolated
 * probe list (never pollutes the global registry).
 *
 * Plan 0667 phase A3 adds: check()'s and drive.mjs's expect()'s runtime guard on the NAME slot —
 * a non-string there throws, so the EX-1 argument-order mistake becomes an error instead of a
 * silently-vacuous assertion.
 */
import { expect, runRegistered, check } from '../../harness/test.mjs';
import { test } from '../../harness/test.mjs';
import { expect as driveExpect } from '../../harness/drive.mjs';

const FILE = 'test/unit/01-runner.test.mjs';

test('T1 expect(true) passes; expect(false) throws an assertion', () => {
  expect(true, 'true passes');
  let threw = false;
  try { expect(false, 'should throw'); } catch (e) { threw = !!e.isAssertion; }
  expect(threw === true, 'expect(false) threw an assertion');
});

test('T1 runRegistered tallies pass/fail + per-tier over an isolated list', async () => {
  const probe = [
    { name: 'probe A ok', fn: () => expect(1 + 1 === 2, 'math'), file: FILE },
    { name: 'probe B fails', fn: () => expect(false, 'intentional'), file: FILE },
    { name: 'probe C ok', fn: () => expect(true, 'ok'), file: FILE },
  ];
  const res = await runRegistered({ tests: probe, quiet: true });
  expect(res.passed === 2, 'two probes passed', JSON.stringify(res));
  expect(res.failed === 1, 'one probe failed', JSON.stringify(res));
  expect(res.byTier.unit && res.byTier.unit.passed === 2, 'tier=unit passed=2', JSON.stringify(res.byTier));
});

test('T1 --only filters by name substring', async () => {
  const probe = [
    { name: 'poll thing', fn: () => expect(true), file: FILE },
    { name: 'map thing', fn: () => expect(true), file: FILE },
  ];
  const res = await runRegistered({ tests: probe, only: 'poll', quiet: true });
  expect(res.passed === 1 && res.failed === 0, 'only poll ran', JSON.stringify(res));
});

test('T1 0667-A3 — check(name, cond) throws when name is not a string (the EX-1 shape)', () => {
  expect(check('a real name', true) === true, 'legitimate call still works');
  // Args deliberately transposed (a boolean where the name goes) to reproduce the EX-1 mistake.
  // The second arg here is never evaluated as a condition — the guard throws first on the name
  // slot — so it is left as a plain boolean, not a string literal, on purpose: a message string
  // in this slot would itself be the exact shape tools/0667-vacuous-assertion-detector.mjs
  // exists to catch, and this call must not become a self-inflicted finding against its own gate.
  let threw = null;
  try { check(true, false); } catch (e) { threw = e; }
  expect(threw instanceof TypeError, 'a boolean in the name slot throws a TypeError', String(threw));
  expect(/must be a string/.test(String(threw && threw.message)), 'message names the actual defect', String(threw));
});

test('T1 0667-A3 — drive.mjs expect(name, cond) throws when name is not a string', () => {
  expect(driveExpect('a real name', true) === true, 'legitimate call still works');
  // See the comment in the check() test above — same reason the second arg is a bare boolean.
  let threw = null;
  try { driveExpect(false, false); } catch (e) { threw = e; }
  expect(threw instanceof TypeError, 'a boolean in the name slot throws a TypeError', String(threw));
  expect(/must be a string/.test(String(threw && threw.message)), 'message names the actual defect', String(threw));
});
