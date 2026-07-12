/*
 * D5 — the bespoke poll relay is gone: no recordResult / pushUpdate in server.mjs.
 */
import { test, expect } from '../../harness/test.mjs';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('D5 — server.mjs has zero recordResult / pushUpdate', () => {
  const src = readFileSync(join(ROOT, 'app', 'server.mjs'), 'utf8');
  const rr = (src.match(/recordResult/g) || []).length;
  const pu = (src.match(/pushUpdate/g) || []).length;
  expect(rr === 0, 'no recordResult in server.mjs', String(rr));
  expect(pu === 0, 'no pushUpdate in server.mjs', String(pu));
});

test('D5 — poll-results.js no longer handles poll-update', () => {
  const src = readFileSync(join(ROOT, 'components', 'poll-results', 'poll-results.js'), 'utf8');
  expect(!/poll-update/.test(src), 'poll-update handler removed from poll-results');
});
