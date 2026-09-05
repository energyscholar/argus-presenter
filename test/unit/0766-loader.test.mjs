/*
 * 0766-loader.test.mjs — Plan 0766 (E14s), Phase 2.
 *
 * `ap/lib/loader.mjs` is proven here in isolation: no installed package with an `@system/`
 * dependency exists anywhere in the repertory repo today (E14s CONTEXT), so the D->E refusal
 * branch has no real fixture to exercise it against. Test B is the SYNTHETIC fixture WRITING-A-
 * PLAN's "ACCEPTANCE HAS A FIFTH GUARD" calls for: an untested branch needs a fixture, not a claim.
 *
 * Runnable two ways:
 *   node test/unit/0766-loader.test.mjs      (standalone, direct-run)
 *   node harness/test.mjs --only 0766-loader (via the aggregate runner)
 */
import { test, expect } from '../../harness/test.mjs';
import { checkSystemPlugins, describeBeatTiers, describeRuleset } from '../../lib/loader.mjs';

test('0766 A — a loaded @system/ plugin is not refused', () => {
  const r = checkSystemPlugins({ '@system/starship-ops': '1.0.0' }, ['starship-ops', 'ai-train-the-trainer']);
  expect(r.ok === true, 'ok:true for a loaded plugin', JSON.stringify(r));
});

test('0766 B — an unloaded @system/ plugin IS the D->E refusal', () => {
  const r = checkSystemPlugins({ '@system/nonexistent-plugin': '1.0.0' }, ['starship-ops']);
  expect(r.ok === false, 'ok:false', JSON.stringify(r));
  expect(Array.isArray(r.problems) && r.problems.some((p) => p.key === '@system/nonexistent-plugin'),
    'problems names @system/nonexistent-plugin', JSON.stringify(r));
});

test('0766 C — a non-system stratum is out of scope, never refused here', () => {
  const r = checkSystemPlugins({ '@canon/spinward-marches': '1.0.0' }, ['starship-ops']);
  expect(r.ok === true, 'ok:true — content strata are a different check', JSON.stringify(r));
});

test('0766 D — describeBeatTiers: enhancedBy tiers as enhanced/tier0, NEVER unrunnable', () => {
  const beats = [{ id: 'b1' }, { id: 'b2', enhancedBy: ['ai'] }, { id: 'b3', enhancedBy: [] }];
  const result = describeBeatTiers(beats);
  expect(result.length === 3, '3 rows', JSON.stringify(result));
  expect(result[0].id === 'b1' && result[0].tier === 'tier0', 'b1 tier0', JSON.stringify(result[0]));
  expect(result[1].id === 'b2' && result[1].tier === 'enhanced', 'b2 enhanced', JSON.stringify(result[1]));
  expect(result[2].id === 'b3' && result[2].tier === 'tier0', 'b3 (empty enhancedBy) tier0', JSON.stringify(result[2]));
  expect(result.every((r) => r.tier !== 'unrunnable'), 'no beat is ever unrunnable — the GATE clause, made falsifiable', JSON.stringify(result));
});

test('0766 E — describeRuleset: NO default. A plugin that declares nothing reports null, never a string (R-107/R-045/R-046)', () => {
  expect(describeRuleset(null) === null, 'null manifest -> null', describeRuleset(null));
  expect(describeRuleset({}) === null, 'no ruleset field -> null', describeRuleset({}));
  expect(describeRuleset({ ruleset: 'cepheus' }) === 'cepheus', 'a declared ruleset wins', describeRuleset({ ruleset: 'cepheus' }));
});
