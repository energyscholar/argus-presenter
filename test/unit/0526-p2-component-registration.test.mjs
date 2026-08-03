/*
 * Plan 0534 W5-A · plan 0526 P2 — COMPONENT REGISTRATION HYGIENE, asserted as BEHAVIOUR.
 *
 * Its sibling `0525-p5-core-schema-coverage.test.mjs` (t80 / t80b) asserts the three lists are
 * equal. This file asserts the two things the equality is FOR, because a list comparison can be
 * satisfied by editing either side and neither of these can:
 *
 *   1. a beat naming any real component validates clean with NO ctx — the exact call every caller
 *      that does not build its own `knownComponents` makes, and the one that was quietly warning
 *      on `navmap` and `prose` from S210/0493 until 0534 W5-A;
 *   2. `sectionId` is a declared beat key, so 0527 P2's `phase` → `sectionId` rename across 29
 *      modules lands silent instead of making all 29 announce an undeclared key (V21).
 *
 * Domain-neutral: the component names are read from the registry, never written down here.
 */
import { test, expect } from '../../harness/test.mjs';
import { validate, DEFAULT_COMPONENTS, KNOWN_BEAT_KEYS } from '../../app/validate.mjs';
import { coreComponentNames } from '../../harness/gen-manifest.mjs';

/** A minimal well-formed module wrapping one beat, so only the assertion under test can fire. */
const moduleWith = (beat) => ({
  manifest: { title: 't', version: '1', defaultBeatId: 'b1', requirements: { terminalClear: true } },
  sections: [],
  beats: [{ id: 'b1', durationSec: 1, ...beat }],
});

test('0526 P2 — every real component validates clean with NO knownComponents ctx', () => {
  const registryNames = coreComponentNames();
  expect(registryNames.length > 0, 'the registry is non-empty', String(registryNames.length));

  // ⛓ validate(module) — no second argument. This is the default-ctx path, the one that falls back
  // to DEFAULT_COMPONENTS. `moduleSummary()` in app/server.mjs takes it (a known, out-of-scope
  // defect for PLUGIN components; core components must not be caught by it).
  const flagged = registryNames.filter((name) => {
    const { warnings } = validate(moduleWith({ component: name, promptId: `p-${name}` }));
    return warnings.some((w) => w.code === 'V3-unknown-component');
  });
  expect(flagged.length === 0,
    'no core component is reported V3-unknown-component on a default-ctx validate()',
    flagged.join(', ') || 'none');
});

test('0526 P2 — a component absent from DEFAULT_COMPONENTS IS reported (the check is live, not vacuous)', () => {
  // The negative control. Without it, the test above passes just as well on a validator that never
  // emits V3 at all — an assertion that "nothing is flagged" is worth exactly what its ability to
  // flag something is worth. The name is deliberately one no registry could ever hold.
  const absent = '0526-p2-not-a-component';
  expect(!DEFAULT_COMPONENTS.includes(absent), 'the control name is genuinely unregistered', absent);
  const { warnings } = validate(moduleWith({ component: absent }));
  expect(warnings.some((w) => w.code === 'V3-unknown-component'),
    'an unregistered component IS flagged V3-unknown-component',
    JSON.stringify(warnings.map((w) => w.code)));
});

test('0526 P2 — sectionId is a declared beat key, so 0527 P2 renames quietly', () => {
  expect(KNOWN_BEAT_KEYS.includes('sectionId'),
    'sectionId is declared in KNOWN_BEAT_KEYS', KNOWN_BEAT_KEYS.join(','));

  // The behaviour, not just the membership: a beat carrying sectionId produces no V21 line naming
  // it. V21 is module-level and reports the DISTINCT undeclared keys, so the assertion has to read
  // the message, not merely count the infos.
  const { warnings } = validate(moduleWith({ component: 'card', sectionId: 'sec-1' }));
  const v21 = warnings.filter((w) => w.code === 'V21-undeclared-beat-key');
  expect(!v21.some((w) => w.msg.includes('sectionId')),
    'no V21-undeclared-beat-key mentions sectionId', JSON.stringify(v21.map((w) => w.msg)));

  // And the control again: the key the rename REPLACES is still undeclared, which is the whole
  // reason 0527 P2 is a rename and not an addition.
  const legacy = validate(moduleWith({ component: 'card', phase: 'sec-1' })).warnings
    .filter((w) => w.code === 'V21-undeclared-beat-key');
  expect(legacy.some((w) => w.msg.includes('phase')),
    'the pre-rename key IS still announced, so V21 is doing its job', JSON.stringify(legacy.map((w) => w.msg)));
});
