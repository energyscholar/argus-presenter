/*
 * T-PROFILE-SCAFFOLD (Plan 0473, P1). Session-type profiles are DATA (a table of knobs), not code
 * forks. ONE working-set engine will READ these knobs; this phase establishes the config OBJECT +
 * selection + readability ONLY — no knob is CONSUMED yet.
 *
 * Asserts: (a) a session has an active profile, default wearable; (b) the wearable knobs are readable
 * and match the plan's wearable defaults (specific values); (c) selecting a different named profile
 * returns ITS knobs (proves profiles are data-selectable, not hardcoded); (d) an unknown profile name
 * falls back cleanly to the default (wearable) rather than throwing.
 *
 * DRIFT GUARD: selection is a pure DATA lookup (selectProfile) with no per-profile code path.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { PROFILES, DEFAULT_PROFILE, selectProfile } from '../../app/profiles.mjs';

// (b) — wearable knobs read as DATA, matching the plan's wearable row:
//   shedding NONE · settling SHORT · budget generous+SOFT · floor OFF · digest=conversation · queue trivial.
test('T-PROFILE-SCAFFOLD (b): wearable knobs readable + match the plan defaults', () => {
  const w = selectProfile('wearable');
  expect(w.name === 'wearable', 'name is wearable', w.name);
  expect(w.shedding === 'none', 'shedding NONE — every directed turn is a work item (F-1)', w.shedding);
  expect(typeof w.settlingMs === 'number' && w.settlingMs > 0 && w.settlingMs <= 800,
    'settling is a SHORT ms window (snappy turn-taking, F-2)', String(w.settlingMs));
  expect(w.perTurnBudget && w.perTurnBudget.mode === 'soft',
    'per-turn budget is SOFT (wrap-up cue only, F-3)', JSON.stringify(w.perTurnBudget));
  expect(w.perTurnBudget.byRole && w.perTurnBudget.byRole.self >= 60000,
    'budget is GENEROUS (>=60s for the solo self role)', JSON.stringify(w.perTurnBudget.byRole));
  expect(w.floorThresholds && w.floorThresholds.enabled === false,
    'floor control OFF (one speaker)', JSON.stringify(w.floorThresholds));
  expect(w.digestContent === 'conversation', 'digest content = the conversation', String(w.digestContent));
  expect(w.queuePolicy && w.queuePolicy.mode === 'trivial' && w.queuePolicy.maxPending === 1,
    'queue policy TRIVIAL (1 pending exchange)', JSON.stringify(w.queuePolicy));
});

// (c) — selecting a DIFFERENT named profile returns DIFFERENT data ⇒ profiles are data-selectable,
// not a hardcoded single behavior. (rpg is a data placeholder in P1; NOT wired to behavior yet.)
test('T-PROFILE-SCAFFOLD (c): a different named profile returns its own knobs (data-selectable)', () => {
  const w = selectProfile('wearable');
  const r = selectProfile('rpg');
  expect(r.name === 'rpg', 'rpg profile selected by name', r.name);
  expect(r.shedding !== w.shedding, 'rpg shedding differs from wearable (distinct data, not a fork)',
    r.shedding + ' vs ' + w.shedding);
  expect(r.shedding === 'summarize', 'rpg ambient = summarize-into-continuity (F-4)', r.shedding);
  // The four named profiles are all present as DATA keys (wearable fully populated; others placeholders).
  for (const n of ['wearable', 'rpg', 'teaching', 'guest'])
    expect(!!PROFILES[n], n + ' present in the profile table', n);
});

// (d) — an unknown / null / undefined profile name falls back CLEANLY to the default, never throws.
test('T-PROFILE-SCAFFOLD (d): unknown profile name falls back to the default (no throw)', () => {
  expect(DEFAULT_PROFILE === 'wearable', 'default profile is wearable', DEFAULT_PROFILE);
  for (const bad of ['nope', '', null, undefined, 123, {}]) {
    let got;
    expect((() => { got = selectProfile(bad); return true; })(),
      'selectProfile did not throw for ' + JSON.stringify(bad));
    expect(got && got.name === DEFAULT_PROFILE,
      'fell back to default (wearable) for ' + JSON.stringify(bad), got && got.name);
  }
});

// (a) — a live session has an active profile; default = wearable; a named one is READABLE via api.profile().
test('T-PROFILE-SCAFFOLD (a): a session has an active profile (default wearable), readable via api.profile()', async () => {
  const def = await createServer({ port: 0 });
  try {
    expect(typeof def.profile === 'function', 'api.profile() exists', typeof def.profile);
    expect(def.profile().name === 'wearable', 'default active profile is wearable', def.profile().name);
    expect(def.profile().shedding === 'none', 'active wearable knobs are readable', def.profile().shedding);
  } finally { await def.close(); }

  const rpg = await createServer({ port: 0, profile: 'rpg' });
  try {
    expect(rpg.profile().name === 'rpg', 'selected profile at session start is active', rpg.profile().name);
  } finally { await rpg.close(); }

  // (d) at the session boundary too: an unknown profile selected at start falls back to wearable.
  const bad = await createServer({ port: 0, profile: 'does-not-exist' });
  try {
    expect(bad.profile().name === 'wearable', 'unknown profile at session start → wearable', bad.profile().name);
  } finally { await bad.close(); }
});
