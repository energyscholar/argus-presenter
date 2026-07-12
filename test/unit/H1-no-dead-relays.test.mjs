/*
 * H1 — all bespoke relay code is gone: no recordResult / pushUpdate / relayMap /
 * resultsChannels, and no legacy relay MESSAGE literals (poll-update, map-*).
 */
import { test, expect } from '../../harness/test.mjs';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const count = (s, re) => (s.match(re) || []).length;

test('H1 — server has no dead relay identifiers', () => {
  const s = read('app/server.mjs');
  for (const id of ['recordResult', 'pushUpdate', 'relayMap', 'resultsChannels']) {
    expect(count(s, new RegExp(id, 'g')) === 0, `no ${id} in server.mjs`, id);
  }
});

test('H1 — no legacy relay message literals remain', () => {
  const files = ['app/server.mjs', 'components/map/map.js', 'components/poll-results/poll-results.js', 'lib/bridge.js'];
  for (const f of files) {
    const s = read(f);
    for (const lit of ["'poll-update'", "'map-view'", "'map-click'", "'map-pointer'"]) {
      expect(s.indexOf(lit) === -1, `${f} has no ${lit} message literal`, `${f}:${lit}`);
    }
  }
});
