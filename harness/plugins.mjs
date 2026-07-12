/*
 * plugins.mjs — read plugin manifests (plugins/<name>/plugin.json).
 * Node-style plugin metadata: { name, requires, components, presets, fieldSchemas }.
 * Used by the manifest generator (A5) and the dependency-driven assembler (A6).
 */
import { readdirSync, existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_DIR = join(ROOT, 'plugins');

/** All plugin dir names. */
export function pluginNames() {
  if (!existsSync(PLUGINS_DIR)) return [];
  return readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

/** Read one plugin's manifest (or null if it has no plugin.json). */
export function readManifest(name) {
  const p = join(PLUGINS_DIR, name, 'plugin.json');
  if (!existsSync(p)) return null;
  const m = JSON.parse(readFileSync(p, 'utf8'));
  m.name = m.name || name;
  m.requires = m.requires || [];
  m.components = m.components || [];
  m.presets = m.presets || {};
  m.fieldSchemas = m.fieldSchemas || {};
  return m;
}

/** Map of name -> manifest for every plugin that has a manifest. */
export function loadManifests() {
  const out = {};
  for (const n of pluginNames()) { const m = readManifest(n); if (m) out[n] = m; }
  return out;
}

/**
 * Transitive plugin closure of a `requires` list (Node-style dependency
 * resolution). Follows each manifest's own `requires`. Unknown names are ignored
 * (S9: allowlisted by the existence of a manifest, no path traversal). Returns a
 * de-duplicated, sorted array; [] in → [] out (pure core).
 */
export function resolveClosure(requires = []) {
  const manifests = loadManifests();
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name) || !manifests[name]) return;   // ignore unknown/unmanifested names
    seen.add(name);
    for (const dep of manifests[name].requires) visit(dep);
  };
  for (const r of requires || []) visit(r);
  return [...seen].sort();
}
