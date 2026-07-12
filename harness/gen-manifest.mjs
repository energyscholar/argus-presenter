/*
 * gen-manifest.mjs — generate the CORE COMPONENT MANIFEST (the "big pick list").
 * ONE artifact, three uses: author catalog, the registry-derived schema contract,
 * and the assembler's input. Catalog = the core component set (components/ dirs =
 * the server-side registry); each entry carries its published field schema.
 *
 *   node harness/gen-manifest.mjs        writes docs/component-manifest.json
 *   import { generateManifest } ...       returns the object (deterministic)
 */
import { readdirSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { coreSchemas } from './core-schemas.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'component-manifest.json');

/** Core component names = the components/ directories (server-side registry). */
export function coreComponentNames() {
  const base = join(ROOT, 'components');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

/** Build the manifest object (deterministic — no timestamps). */
export function generateManifest() {
  const names = coreComponentNames();
  const missing = names.filter((n) => !coreSchemas[n]);
  if (missing.length) throw new Error('core components missing a field schema: ' + missing.join(', '));
  return {
    kind: 'argus-presenter/component-manifest',
    version: 1,
    components: names.map((name) => ({ name, fields: coreSchemas[name].fields })),
  };
}

/** Write the manifest to docs/component-manifest.json. Returns the object. */
export function writeManifest() {
  const m = generateManifest();
  writeFileSync(OUT, JSON.stringify(m, null, 2) + '\n');
  return m;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const m = writeManifest();
  console.log('wrote', OUT, '—', m.components.length, 'components');
}
