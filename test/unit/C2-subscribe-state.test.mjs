/*
 * C2 — Argus.subscribeState(prefix,handler): fires per changed path at/under the
 * prefix on a 'diff' host message; segment-aware (no false 'p1' vs 'p10' match).
 */
import { test, expect } from '../../harness/test.mjs';
import { loadBridge } from './_bridge-harness.mjs';

test('C2 — subscribeState fires for in-prefix paths only', () => {
  const { Argus, injectHost } = loadBridge();
  const hits = [];
  Argus.subscribeState('polls/p1', (path, value) => hits.push([path, value]));
  injectHost({ type: 'diff', diff: { 'polls/p1/votes/u2': 'yes', 'map/view': { x: 1 }, 'polls/p10/x': 1 } });

  expect(hits.length === 1, 'exactly one in-prefix path fired', JSON.stringify(hits));
  expect(hits[0][0] === 'polls/p1/votes/u2' && hits[0][1] === 'yes', 'correct path+value', JSON.stringify(hits[0]));
});

test('C2 — non-diff host messages are ignored; unsubscribe stops delivery', () => {
  const { Argus, injectHost } = loadBridge();
  let count = 0;
  const off = Argus.subscribeState('map', () => { count++; });
  injectHost({ type: 'poll-update', tally: {} });   // not a diff -> ignored
  expect(count === 0, 'non-diff ignored');
  injectHost({ type: 'diff', diff: { 'map/view': { x: 1 } } });
  expect(count === 1, 'diff delivered');
  off();
  injectHost({ type: 'diff', diff: { 'map/view': { x: 2 } } });
  expect(count === 1, 'no delivery after unsubscribe');
});

test('C2 — empty prefix subscribes to all paths', () => {
  const { Argus, injectHost } = loadBridge();
  const paths = [];
  Argus.subscribeState('', (p) => paths.push(p));
  injectHost({ type: 'diff', diff: { 'a/b': 1, 'c': 2 } });
  expect(paths.length === 2, 'all paths delivered', JSON.stringify(paths));
});
