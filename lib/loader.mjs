/*
 * lib/loader.mjs — Plan 0766 (E14s): dependency refusal + `enhancedBy` beat tiering.
 *
 * Pure, no filesystem access — every caller supplies already-read data. This file must NOT import
 * `repertory`'s `lib/package/read-package.mjs`: that file lives in a CONTENT repo, and this engine
 * is a general-purpose tool with no repertory-specific knowledge (a cross-repo import from the
 * engine into a content repo would be backwards). See plan CONTEXT.
 */

/**
 * A package's `dependencies` map (already parsed) against the plugin names actually loaded
 * (`harness/plugins.mjs`'s `pluginNames()`). Refuses ONLY on the `@system/` stratum — the D→E
 * seam contract (0766, seams.tsv D→E) is scoped to "a plugin that is not loaded"; the other three
 * strata (`@canon`, `@neocanon`, `@campaign`) name content, not code, and loading content is a
 * different check this run does not own.
 */
export function checkSystemPlugins(dependencies, loadedPluginNames) {
  const loaded = new Set(loadedPluginNames || []);
  const problems = [];
  for (const key of Object.keys(dependencies || {})) {
    const m = /^@system\/(.+)$/.exec(key);
    if (m && !loaded.has(m[1])) problems.push({ key, pluginId: m[1] });
  }
  return problems.length
    ? { ok: false, problems, message: `names ${problems.map((p) => p.key).join(', ')} — not a loaded plugin` }
    : { ok: true };
}

/**
 * ⭐ WORKLIST 36 — `enhancedBy`, never `requires`, for an AI capability. `beats[].requires` keeps
 * its EXISTING meaning (client plugin-bundle deps — see CONTEXT; untouched by this function).
 * `enhancedBy` is a NEW, separate beat-level array this run introduces: naming an AI capability
 * there means "better with it, runs fine without it" — the tier is NEVER 'unrunnable'.
 */
export function describeBeatTiers(beats) {
  return (beats || []).map((b, i) => ({
    id: b.id != null ? b.id : i,
    tier: Array.isArray(b.enhancedBy) && b.enhancedBy.length ? 'enhanced' : 'tier0',
  }));
}

/**
 * `ruleset` for a load: the loaded plugin's own manifest field if present, else `null`.
 *
 * R-107 anneal (0766): NO DEFAULT. An earlier draft of this function invented a fallback string
 * ('mongoose-2e') for the common case where no plugin declares a ruleset. That hardcodes an
 * agreement into the PUBLIC engine that does not exist anywhere else (R-045/R-046) — this file
 * has no authority to assert what ruleset a deployment with no declaration is running. A caller
 * that wants a default renders `null` itself, in its own, non-public layer.
 */
export function describeRuleset(pluginManifest) {
  return (pluginManifest && pluginManifest.ruleset) || null;
}
