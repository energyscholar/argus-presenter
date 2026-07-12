/*
 * T0 — self-contained / standalone package. Concrete assertions: own package.json
 * (ws dep, ESM), node_modules is a REAL dir (not a dev symlink), NO local/linked
 * dependencies (nothing resolved from a path outside this repo), ws resolves.
 *
 * Runnable two ways:
 *   node test/unit/00-selfcontained.test.mjs      (standalone, before the T1 runner)
 *   node harness/test.mjs --only selfcontained    (via the aggregate runner, after T1)
 */
import { test, expect } from '../../harness/test.mjs';
import { readFileSync, lstatSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('T0 own package.json declares ws dependency', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  expect(pkg.name === 'argus-presenter', 'package name', pkg.name);
  expect(!!(pkg.dependencies && pkg.dependencies.ws), 'ws in dependencies');
  expect(pkg.type === 'module', 'ESM package');
});

test('T0 node_modules is a real directory, not a symlink', () => {
  const nm = join(ROOT, 'node_modules');
  expect(existsSync(nm), 'node_modules exists');
  expect(!lstatSync(nm).isSymbolicLink(), 'node_modules is not a symlink');
});

test('T0 no local/linked dependencies (fully self-contained)', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const all = Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies);
  const bad = Object.entries(all).filter(([, spec]) => /^(file:|link:|portal:|\.\.?\/|\/)/.test(String(spec)));
  expect(bad.length === 0, 'every dependency is a registry/version range, not a local path', JSON.stringify(bad));
});

test('T0 ws resolves standalone', async () => {
  const ws = await import('ws');
  expect(typeof ws.WebSocketServer === 'function', 'ws.WebSocketServer is a function');
});
