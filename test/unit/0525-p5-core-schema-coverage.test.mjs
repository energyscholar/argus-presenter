/*
 * Plan 0525 PHASE 5 — t80. EVERY core component has a published field schema, and every published
 * field schema names a core component. Asserted by ENUMERATION, reported BY NAME.
 *
 * WHY THIS TEST EXISTS. A component directory was added with no `coreSchemas` entry.
 * `generateManifest()` filters for components missing a schema and throws, so one missing object
 * key surfaced as THREE failures in tests about something else — the pick-list compose walk and
 * both manifest tests — each of them reporting a manifest that would not build. Nothing failed
 * where the omission was.
 *
 * So this is the test that should have failed, and it fails by name: the diagnosis is the failure
 * line, not an afternoon spent working backwards from a thrown generator.
 *
 * BOTH DIRECTIONS, because both are drift:
 *   a component with no schema  — the manifest cannot be built at all, and an author picking that
 *                                 component off the catalog would be offered no fields to fill;
 *   a schema with no component  — a stale entry advertising something the registry cannot render,
 *                                 which fails only later, in a browser, on a beat that shows nothing.
 *
 * Neither set is restated here. Both are read from their source of truth — the components/
 * directory listing (the server-side registry, via `coreComponentNames()`) and the keys of
 * `coreSchemas` — because a hand-written list would be a third place to forget.
 *
 * ⛓ PLAN 0534 W5-A (0526 P2) — THE THIRD LIST, AND WHY THIS TEST DID NOT CATCH THE DRIFT IT WAS
 * WRITTEN TO CATCH. There is a third place, and it was the one that was wrong. `DEFAULT_COMPONENTS`
 * (app/validate.mjs) is what the validator falls back to when a caller passes no `knownComponents`.
 * At the time this test was written it held 14 names; `components/` and `coreSchemas` held 16.
 * Every check above passed, because two of the three lists agreed with each other — and `navmap`
 * and `prose` were reported `V3-unknown-component` on every default-ctx validation for months.
 *
 * A test that compares two of three lists cannot see a drift in the third. That is not a gap in
 * the assertions; it is a gap in the ENUMERATION, and it is the more dangerous kind, because a
 * green run reads as coverage. So the sets compared here are now all three, pairwise, both
 * directions — and none of them is restated as a literal.
 *
 * Domain-neutral by construction: it names no component, so it cannot acquire a deployment's
 * vocabulary as the catalog grows (docs/naming-canon.md — "This document is domain-neutral, like
 * the core it governs. Domain vocabulary lives in plugins.").
 */
import { test, expect } from '../../harness/test.mjs';
import { coreComponentNames, generateManifest } from '../../harness/gen-manifest.mjs';
import { coreSchemas } from '../../harness/core-schemas.mjs';
import { DEFAULT_COMPONENTS } from '../../app/validate.mjs';

test('0525 t80 — every core component has a field schema, and every field schema has a core component', () => {
  const registryNames = coreComponentNames();
  const schemaNames = Object.keys(coreSchemas);
  expect(registryNames.length > 0, 'the core registry is non-empty (components/ was found)', String(registryNames.length));

  // ── (a) no component without a schema ─────────────────────────────────────────────────────
  const withoutSchema = registryNames.filter((n) => !coreSchemas[n]);
  expect(withoutSchema.length === 0,
    'every core component publishes a field schema — add it to harness/core-schemas.mjs',
    withoutSchema.join(', ') || 'none');

  // ── (b) no schema without a component ─────────────────────────────────────────────────────
  const withoutComponent = schemaNames.filter((n) => !registryNames.includes(n));
  expect(withoutComponent.length === 0,
    'every field schema names a component the registry can actually render',
    withoutComponent.join(', ') || 'none');

  // ── (c) present is not the same as usable ─────────────────────────────────────────────────
  // An empty `fields: []` would satisfy (a) and still leave the authoring surface with nothing to
  // offer, which is the failure this phase was fixing dressed up as a pass.
  for (const componentName of registryNames) {
    const fields = coreSchemas[componentName] && coreSchemas[componentName].fields;
    expect(Array.isArray(fields) && fields.length >= 1,
      `${componentName} publishes at least one field`, JSON.stringify(fields));
    expect(fields.every((f) => f.name && f.type),
      `${componentName} — every field carries a name and a type`, JSON.stringify(fields));
  }

  // ── (d) and the generator agrees with both ────────────────────────────────────────────────
  // With the two sets in agreement the manifest builds, and its catalog is exactly the registry:
  // not a subset that quietly drops a component, and not a superset inherited from the schemas.
  const catalog = generateManifest().components.map((c) => c.name);
  expect(catalog.join(',') === registryNames.join(','),
    'the generated catalog is exactly the registry, in registry order', catalog.join(','));
});

/*
 * Plan 0534 W5-A (0526 P2) — THE THIRD LIST. `DEFAULT_COMPONENTS` is the validator's fallback set:
 * what a beat's `component` is checked against whenever the caller supplies no `knownComponents`.
 * It is a hand-written literal, it is the only one of the three that is, and that is precisely why
 * it is the one that fell behind. Compared here rather than in a fourth file, because a fourth
 * list-comparison test is the same mistake one level up.
 */
test('0526 P2 t80b — components/ ≡ core-schemas ≡ DEFAULT_COMPONENTS: all three, both directions', () => {
  const registryNames = coreComponentNames();
  const catalog = generateManifest().components.map((c) => c.name);   // the generated manifest
  const defaults = [...DEFAULT_COMPONENTS];

  // ── (a) no component the validator would call unknown ──────────────────────────────────────
  // The failure this catches, stated as the harm: a real component in components/, renderable by
  // the registry, that every default-ctx validate() flags `V3-unknown-component`.
  const unregistered = registryNames.filter((n) => !defaults.includes(n));
  expect(unregistered.length === 0,
    'every core component is registered in DEFAULT_COMPONENTS — add it to app/validate.mjs',
    unregistered.join(', ') || 'none');

  // ── (b) no registered name without a component ─────────────────────────────────────────────
  // The other direction: a stale entry that suppresses the V3 warning for a component that no
  // longer exists, so the beat validates clean and renders nothing.
  const phantom = defaults.filter((n) => !registryNames.includes(n));
  expect(phantom.length === 0,
    'every DEFAULT_COMPONENTS entry is a real components/ directory',
    phantom.join(', ') || 'none');

  // ── (c) and the third edge, directly ───────────────────────────────────────────────────────
  // (a)+(b) tie DEFAULT_COMPONENTS to the registry, and t80 ties the registry to the schemas and
  // the generated manifest. Asserting the DEFAULT_COMPONENTS↔manifest edge on its own means no
  // single broken edge can be hidden by the route around it — the triangle is closed, not chained.
  const sorted = (a) => [...a].sort().join(',');
  expect(sorted(defaults) === sorted(catalog),
    'DEFAULT_COMPONENTS is exactly the generated manifest catalog',
    `defaults=[${sorted(defaults)}] manifest=[${sorted(catalog)}]`);

  // ── (d) the counts agree, reported as counts ───────────────────────────────────────────────
  // Set equality above already implies this. It is asserted separately because the drift that
  // occasioned this test was legible as three numbers — 16 / 16 / 14 — and a failure line that
  // prints those three numbers is the one that gets diagnosed in a minute instead of an hour.
  expect(registryNames.length === catalog.length && catalog.length === defaults.length,
    'components/ , manifest and DEFAULT_COMPONENTS hold the same number of entries',
    `components/=${registryNames.length} manifest=${catalog.length} DEFAULT_COMPONENTS=${defaults.length}`);
});
