/*
 * A3 — no domain leakage (labels/data/presets) anywhere in the CORE surface
 * (app/ harness/ mcp/ lib/ components/). Domain content lives only in plugins/ and
 * test/. This is the standing separation invariant across the whole core.
 */
import { test, expect } from '../../harness/test.mjs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKENS = ['weather', 'cityGrid', 'city-grid', 'Market', 'Harbor',
  'Uptown', 'Downtown', 'Forecaster', 'forecast', 'weather-update'];

test('A3 — zero domain-content tokens across app/harness/mcp/lib/components', () => {
  let out = '';
  try {
    out = execSync(`grep -rniE '${TOKENS.join('|')}' app harness mcp lib components || true`, { cwd: ROOT, encoding: 'utf8' });
  } catch (e) { out = e.stdout || ''; }
  const hits = out.split('\n').filter((l) => l.trim().length);
  expect(hits.length === 0, 'domain leakage in core', JSON.stringify(hits));
});
