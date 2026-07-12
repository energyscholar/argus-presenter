/*
 * A2 — no DOMAIN-CONTENT strings leak into core components/lib. Role names
 * (gm/presenter/ai) and dual-use doc comments are structural and allowed; specific
 * example-plugin CONTENT tokens must be zero in core.
 */
import { test, expect } from '../../harness/test.mjs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Domain-CONTENT tokens (not roles, not generic UI words) — the example plugin's
// domain vocabulary, which must never appear in the domain-neutral core.
const TOKENS = ['weather', 'cityGrid', 'city-grid', 'Market', 'Harbor',
  'Uptown', 'Downtown', 'Forecaster', 'forecast'];

test('A2 — zero domain-content tokens in components/ and lib/', () => {
  const pattern = TOKENS.join('\\|');
  let out = '';
  try {
    out = execSync(`grep -rniE '${TOKENS.join('|')}' components lib || true`, { cwd: ROOT, encoding: 'utf8' });
  } catch (e) { out = e.stdout || ''; }
  const hits = out.split('\n').filter((l) => l.trim().length);
  expect(hits.length === 0, 'domain-content tokens found in core', JSON.stringify(hits));
});
