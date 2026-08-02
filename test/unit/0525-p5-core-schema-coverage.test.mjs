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
 * Domain-neutral by construction: it names no component, so it cannot acquire a deployment's
 * vocabulary as the catalog grows (docs/naming-canon.md — "This document is domain-neutral, like
 * the core it governs. Domain vocabulary lives in plugins.").
 */
import { test, expect } from '../../harness/test.mjs';
import { coreComponentNames, generateManifest } from '../../harness/gen-manifest.mjs';
import { coreSchemas } from '../../harness/core-schemas.mjs';

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
