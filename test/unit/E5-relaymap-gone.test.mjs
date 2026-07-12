/*
 * E5 — the bespoke map relay is deleted: no relayMap / map-view / map-click /
 * map-pointer relay code remains in the server.
 */
import { test, expect } from '../../harness/test.mjs';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('E5 — server.mjs has no relayMap and no map-* relay message types', () => {
  const src = readFileSync(join(ROOT, 'app', 'server.mjs'), 'utf8');
  expect((src.match(/relayMap/g) || []).length === 0, 'no relayMap', String((src.match(/relayMap/g) || []).length));
  expect(!/'map-view'|'map-click'|'map-pointer'/.test(src), 'no map-* relay message literals in server');
});
