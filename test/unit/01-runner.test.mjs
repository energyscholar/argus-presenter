/*
 * T1 — the runner itself. Concrete assertions on test()/expect()/runRegistered:
 * expect throws on false (marks a fail) and passes on true; runRegistered tallies
 * exactly and reports per-tier; --only filters by name substring. Uses an isolated
 * probe list (never pollutes the global registry).
 */
import { expect, runRegistered } from '../../harness/test.mjs';
import { test } from '../../harness/test.mjs';

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
