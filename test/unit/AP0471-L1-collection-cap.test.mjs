/*
 * Plan 0471 L1 — participant-writable id-keyed collections (chat/markers/crud items) are
 * bounded in TOTAL size (the rate limiter caps rate, not total). Oldest evicted (FIFO);
 * the add's diff carries the evictions so clients drop them too.
 */
import { test, expect } from '../../harness/test.mjs';
import { createStore } from '../../app/state.mjs';

const part = { userId: 'u', role: 'participant' };

test('L1 — a participant-writable collection is capped; oldest evicted, newest kept', () => {
  const s = createStore();
  let lastRes = null;
  for (let i = 0; i < 1100; i++) lastRes = s.apply({ path: 'chat', verb: 'add', value: { id: 'm' + i, text: 'x' } }, part);
  const chat = s.get('chat');
  const n = Object.keys(chat).length;
  expect(n <= 1000, 'chat collection capped at COLLECTION_MAX', 'count=' + n);
  expect(chat['m1099'] !== undefined, 'newest item retained');
  expect(chat['m0'] === undefined, 'oldest item evicted');
  // The evicting add's diff includes at least one removal (null value).
  expect(lastRes && lastRes.diff && Object.values(lastRes.diff).some((v) => v === null), 'eviction surfaced in the diff', JSON.stringify(Object.keys(lastRes.diff)));
});

test('L1 — a small collection is untouched (no eviction below the cap)', () => {
  const s = createStore();
  for (let i = 0; i < 5; i++) s.apply({ path: 'map/markers', verb: 'add', value: { id: 'k' + i } }, part);
  expect(Object.keys(s.get('map/markers')).length === 5, 'all 5 markers retained (below cap)');
});
