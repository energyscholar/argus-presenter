/*
 * Plan 0575 PHASE 7 — PERSON TIERS, AND THE PROMOTION BETWEEN THEM.
 *
 * Bruce, 2026-08-13: "most NPCs will have a STUBBED state machine… the enemy officers and all
 * [a named NPC]'s marines will need full state machines… we do not necessarily need a state
 * machine for the food handler, nor the dishwasher in the back room."
 *
 * ⛔ THE NAME IS REDACTED AND THAT IS NOT PEDANTRY. This repo is PUBLIC; the plan it implements is
 * private. Quoting Bruce verbatim put a campaign NPC's name into a tracked file and t0531-01 —
 * "no campaign vocabulary in ANY tracked file" — caught it on the full-suite run, which is exactly
 * the job that guard exists to do. The quote loses nothing that matters: what the sentence is
 * FOR is "some NPCs need machines and most do not".
 *
 * ⛔ NO PAINTED SURFACE (brief §4 names 2, 3 and 7), and none is invented. Nothing renders a tier.
 * Verified at the model layer, against the LOCAL rules bundle.
 *
 * ⚠⚠ THE RULES PROVENANCE, AND §4's CITATION IS CORRECT. Plan §4 cites
 * `02-personal-combat-rules.md §22` and §22 is exactly right for the EXACT tier: "Apply to END
 * first / Overflow to STR or DEX (target's choice) / STR or DEX = 0: unconscious / All three
 * physical stats = 0: dead" (§22 DAMAGE, INJURY AND DEATH, p.74, 78-79). ⚠ The bundle states that
 * same rule TWICE — the earlier copy sits under §14/§15 — and reading only the second copy is how
 * a reviewer talks themselves into "the plan cited the wrong section". It did not.
 *
 * ⛔ THE REAL AND NARROWER DEFECT: §22 supports ONLY THE EXACT HALF. The POOLED half has no §22
 * basis at all. Its basis is §27 ANIMALS IN COMBAT (p.80-81) — "Hits: Total damage before death.
 * All damage applied to Hits (NOT STR/DEX/END)" — and `Hits` appears NOWHERE ELSE in the bundle:
 * there is no character-level Hits pool in MgT2e. So the stub is a published construct EXTENDED to
 * humanoid rank-and-file, not a rule that already covered them, and the two tiers' unconsciousness
 * predicates genuinely differ. These tests assert what is true and refuse to assert what is not.
 *
 * ⭐ RULED BY BRUCE, 2026-08-14: KEEP BOTH PREDICATES. Promotion does not preserve status and
 * cannot — at 20 damage against 10/10/10 the overflow zeroes a characteristic whichever one is
 * chosen. The rule tags and the demonstrated disagreement below ARE the answer, not a placeholder.
 */
import { test, expect } from '../../harness/test.mjs';
import { existsSync } from 'fs';
import { join } from 'path';
import { REAL_PLUGINS, loadShipPluginModule } from './_0514-fixtures.mjs';

const haveTiers = existsSync(join(REAL_PLUGINS, 'starship-ops', 'person-tiers.mjs'));

/** A crew registry whose machine factory COUNTS its calls — the whole of t0575-07. */
async function countingCrew() {
  const mod = await loadShipPluginModule('people.mjs');
  let built = 0;
  const people = mod.createPeople({
    write: () => {},
    placeHasStations: () => true,
    makeMachine: (p) => { built++; return { personId: p.personId }; },
  });
  return { people, machinesBuilt: () => built };
}

test('t0575-07 — ⛔ needsFullState DEFAULTS FALSE: 40 stubs make 40 RECORDS and ZERO MACHINES', async () => {
  if (!haveTiers) { expect(false, 'person-tiers.mjs is installed (run tools/install-system-plugins.sh)'); return; }
  const { people, machinesBuilt } = await countingCrew();

  for (let i = 0; i < 40; i++) people.upsert({ personId: `mook-${i}`, placeId: 'hull-a', hits: 30, hitsMax: 30 });

  expect(people.ids().length === 40, '40 records exist', String(people.ids().length));
  expect(people.list().every((p) => p.tier === 'stub'), 'every one of them is a STUB by default',
    JSON.stringify(people.list().map((p) => p.tier).slice(0, 4)));
  expect(people.list().every((p) => p.needsFullState === false), 'and needsFullState is FALSE on every one',
    JSON.stringify(people.list().map((p) => p.needsFullState).slice(0, 4)));
  expect(machinesBuilt() === 0, '⛔⛔ AND ZERO MACHINES WERE CONSTRUCTED', String(machinesBuilt()));
  expect(people.machineCount() === 0, 'the registry agrees', String(people.machineCount()));

  /* ⭐ THE COUNTER IS LIVE, NOT DECORATIVE. Without this, the assertion above passes just as
     happily for a build that can never make a machine at all — a test that cannot fail. */
  people.upsert({ personId: 'the-officer', placeId: 'hull-a', tier: 'full', needsFullState: true });
  expect(machinesBuilt() === 1, '⭐ someone who NEEDS one gets one — so the zero above is a result',
    String(machinesBuilt()));
  people.upsert({ personId: 'the-officer', placeId: 'hull-a', name: 'renamed' });
  expect(machinesBuilt() === 1, 'and never a second one for the same person', String(machinesBuilt()));

  // ⛔ The flag takes a real boolean. Strings and numbers are how a hand-edited scene file gets
  //    forty machines it never asked for.
  const { people: p2, machinesBuilt: b2 } = await countingCrew();
  for (const v of ['true', 1, 'yes', {}, []]) p2.upsert({ personId: `sneak-${String(v)}`, placeId: 'hull-a', needsFullState: v });
  expect(b2() === 0, 'a truthy NON-boolean does not buy a machine', String(b2()));
});

test('t0575-06 — ⭐⭐ A STUB PROMOTES TO FULL WITH POOLED HITS SPLIT INTO END/STR/DEX', async () => {
  if (!haveTiers) { expect(false, 'person-tiers.mjs is installed'); return; }
  const tiers = await loadShipPluginModule('person-tiers.mjs');

  // Bruce's own example: HEALTH: 30/30, undamaged.
  const whole = tiers.promoteStub({ hits: 30, hitsMax: 30 });
  expect(whole.ok, 'an undamaged stub promotes', JSON.stringify(whole));
  expect(whole.chars.END === 10 && whole.chars.STR === 10 && whole.chars.DEX === 10,
    '30 pooled becomes 10/10/10', JSON.stringify(whole.chars));
  expect(!whole.status.dead && !whole.status.unconscious, 'and they are unharmed', JSON.stringify(whole.status));

  // Damaged: 18/30 ⇒ 12 damage. §22: END first (10), then the CHOSEN overflow (2 off STR).
  const hurt = tiers.promoteStub({ hits: 18, hitsMax: 30 });
  expect(hurt.chars.END === 0 && hurt.chars.STR === 8 && hurt.chars.DEX === 10,
    '⭐ damage runs END-FIRST then overflows — it is NOT spread evenly', JSON.stringify(hurt.chars));
  const check = tiers.promotionIsConsistent({ hits: 18, hitsMax: 30 }, hurt);
  expect(check.ok, '⭐⭐ NO RULES CONTRADICTION: points and maxima both conserved', JSON.stringify(check.checks));
  expect(hurt.chars.END + hurt.chars.STR + hurt.chars.DEX === 18, 'the characteristics sum to the hits that were left',
    JSON.stringify(hurt.chars));

  /* ⛔ THE OVERFLOW TARGET IS THE TARGET'S CHOICE (§22 step 4), so it is an ARGUMENT. A constant
     here would be the system making a player's decision for them, mid-boarding-action. */
  const chooseDex = tiers.promoteStub({ hits: 18, hitsMax: 30 }, { overflowTo: 'DEX' });
  expect(chooseDex.chars.DEX === 8 && chooseDex.chars.STR === 10,
    'choosing DEX puts the overflow on DEX', JSON.stringify(chooseDex.chars));
  expect(chooseDex.overflowTo === 'DEX', 'and the choice is RECORDED, so it is auditable afterwards', chooseDex.overflowTo);

  // §22 step 5: further damage goes to the remaining physical characteristic.
  const deep = tiers.promoteStub({ hits: 5, hitsMax: 30 });
  expect(deep.chars.END === 0 && deep.chars.STR === 0 && deep.chars.DEX === 5,
    'past END and STR, the rest comes off DEX', JSON.stringify(deep.chars));
  expect(deep.status.unconscious === true, 'and STR at 0 means unconscious (§22 step 5)', JSON.stringify(deep.status));

  // Endpoints: dead stays dead, and nobody is resurrected by being promoted.
  const dead = tiers.promoteStub({ hits: 0, hitsMax: 30 });
  expect(dead.chars.END === 0 && dead.chars.STR === 0 && dead.chars.DEX === 0, 'a dead stub promotes to all zero',
    JSON.stringify(dead.chars));
  expect(dead.status.dead === true, 'and reads dead under the exact rule too', JSON.stringify(dead.status));
  expect(tiers.promotionIsConsistent({ hits: 0, hitsMax: 30 }, dead).ok, 'consistently', 'no');
});

test('t0575-06b — ⚠ THE TWO TIERS DISAGREE IN THE MIDDLE, AND THAT IS DECLARED, NOT HIDDEN', async () => {
  if (!haveTiers) { expect(false, 'person-tiers.mjs is installed'); return; }
  const tiers = await loadShipPluginModule('person-tiers.mjs');
  /* ⛔ THE HONEST CLAIM. §27's pooled rule calls someone unconscious at 1/10 of starting Hits;
     §22 calls them unconscious when STR or DEX hits 0. Those are different predicates over the
     same person, and asserting they agree would be the rules contradiction t0575-06 forbids.
     They agree at the ENDPOINTS, and in between the FULL tier is the more precise one — which is
     the reason to promote, not an argument against it. */
  const stub = { hits: 3, hitsMax: 30 };                  // 1/10 of 30 ⇒ the pooled rule says out cold
  const s = tiers.stubStatus(stub);
  const f = tiers.promoteStub(stub).status;
  expect(s.unconscious === true, 'the POOLED rule (§27) says unconscious at 3/30', JSON.stringify(s));
  expect(f.unconscious === true, 'and here the exact rule (§22) agrees, because STR reached 0', JSON.stringify(f));

  const mid = { hits: 12, hitsMax: 30 };                  // 18 damage: END 10, STR 8 ⇒ STR is 2, not 0
  const sm = tiers.stubStatus(mid), fm = tiers.promoteStub(mid).status;
  expect(sm.unconscious === false, 'the pooled rule says still up at 12/30', JSON.stringify(sm));
  expect(fm.unconscious === false, 'and so does the exact rule', JSON.stringify(fm));

  const edge = { hits: 10, hitsMax: 30 };                 // 20 damage: END 10, STR 10 ⇒ STR EXACTLY 0
  const se = tiers.stubStatus(edge), fe = tiers.promoteStub(edge).status;
  expect(se.unconscious === false, '⚠ the POOLED rule says this one is still standing (10 > 30/10)', JSON.stringify(se));
  expect(fe.unconscious === true, '⚠ but the EXACT rule says unconscious — STR reached 0', JSON.stringify(fe));
  expect(se.unconscious !== fe.unconscious,
    '⭐⭐ SO THE PREDICATES DIFFER, DEMONSTRABLY. Each tier reports which rule it applied.',
    `${se.rule} vs ${fe.rule}`);
  expect(/§27/.test(se.rule) && /§22/.test(fe.rule), 'and each names its own source', `${se.rule} | ${fe.rule}`);
});

test('t0575-06c — a pool that cannot be split is REFUSED, and declared characteristics win', async () => {
  if (!haveTiers) { expect(false, 'person-tiers.mjs is installed'); return; }
  const tiers = await loadShipPluginModule('person-tiers.mjs');
  /* ⛔ A pool of 1 or 2 cannot become three characteristics without one of them being 0 at FULL
     health — which §22 reads as unconscious or dead. Refuse, rather than invent a distribution
     that quietly makes an uninjured person unconscious. */
  for (const hitsMax of [0, 1, 2]) {
    const r = tiers.promoteStub({ hits: hitsMax, hitsMax });
    expect(r.ok === false && r.reason === 'pool-too-small-to-split', `hitsMax ${hitsMax} is refused`, JSON.stringify(r));
  }
  expect(tiers.splitPool(2) === null, 'splitPool says so directly', String(tiers.splitPool(2)));

  // ⭐ EXPLICIT BEATS DERIVED: a stub carrying real characteristics promotes EXACTLY.
  const declared = tiers.promoteStub({ hits: 20, hitsMax: 26, chars: { END: 6, STR: 12, DEX: 8 } });
  expect(declared.max.STR === 12 && declared.max.DEX === 8, 'the declared characteristics are used unchanged',
    JSON.stringify(declared.max));
  expect(declared.chars.END === 0 && declared.chars.STR === 12 && declared.chars.DEX === 8,
    '6 damage takes END to 0 and stops there', JSON.stringify(declared.chars));
  expect(tiers.promotionIsConsistent({ hits: 20, hitsMax: 26, chars: { END: 6, STR: 12, DEX: 8 } }, declared).ok,
    'and it is consistent', 'no');

  // Remainders are deterministic, in §22's own order.
  expect(JSON.stringify(tiers.splitPool(31)) === JSON.stringify({ END: 11, STR: 10, DEX: 10 }),
    '31 splits 11/10/10 — remainder to END first (§22 order)', JSON.stringify(tiers.splitPool(31)));
  expect(JSON.stringify(tiers.splitPool(32)) === JSON.stringify({ END: 11, STR: 11, DEX: 10 }),
    'and 32 to END then STR', JSON.stringify(tiers.splitPool(32)));
});

test('t0575-06d — promotion through the REGISTRY: mid-scene, once, and it builds the machine', async () => {
  if (!haveTiers) { expect(false, 'person-tiers.mjs is installed'); return; }
  const { people, machinesBuilt } = await countingCrew();
  people.upsert({ personId: 'marine', placeId: 'hull-a', hits: 18, hitsMax: 30 });
  people.seat('marine', 10);
  expect(machinesBuilt() === 0, 'a stub marine has no machine', String(machinesBuilt()));

  const promoted = people.promote('marine', { overflowTo: 'DEX' });
  expect(promoted && promoted.tier === 'full', 'promoted mid-scene', JSON.stringify(promoted));
  expect(promoted.chars.END === 0 && promoted.chars.DEX === 8 && promoted.chars.STR === 10,
    'with the pool split through §22, honouring the choice', JSON.stringify(promoted.chars));
  expect(promoted.needsFullState === true, '⭐ promotion IS the decision that they need a machine',
    String(promoted.needsFullState));
  expect(machinesBuilt() === 1, 'and one was built', String(machinesBuilt()));

  // ⛔ Everything else about them survives: promotion is not a re-creation.
  expect(promoted.placeId === 'hull-a' && promoted.stationUid === 10,
    'they are still where they were, still in their seat', JSON.stringify(promoted));
  expect(people.occupantsOf('hull-a', 10).includes('marine'), 'and the station still lists them',
    JSON.stringify(people.occupantsOf('hull-a', 10)));

  const again = people.promote('marine');
  expect(again.tier === 'full' && machinesBuilt() === 1, 'promoting twice is a no-op, not a second machine',
    String(machinesBuilt()));
  expect(people.promote('nobody-at-all') === null, 'promoting a stranger is null, never a crash');

  const { people: p3 } = await countingCrew();
  p3.upsert({ personId: 'tiny', placeId: 'hull-a', hits: 2, hitsMax: 2 });
  expect(p3.promote('tiny') === null, '⛔ an unsplittable pool REFUSES promotion rather than fudging it');
  expect(p3.get('tiny').tier === 'stub', 'and the person is left exactly as they were', JSON.stringify(p3.get('tiny')));
});
