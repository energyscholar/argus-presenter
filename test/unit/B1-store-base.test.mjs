/*
 * B1 — store base: get(path) / _setPath over a nested null-proto tree, with
 * S4 path sanitization (no prototype pollution).
 */
import { test, expect } from '../../harness/test.mjs';
import { createStore, sanitizePath } from '../../app/state.mjs';

test('B1 — _setPath creates nested nodes; get reads them', () => {
  const s = createStore();
  expect(s._setPath('polls/p1/votes/u2', 'yes') === true, 'set nested');
  expect(s.get('polls/p1/votes/u2') === 'yes', 'get leaf', String(s.get('polls/p1/votes/u2')));
  const votes = s.get('polls/p1/votes');
  expect(votes && votes.u2 === 'yes', 'intermediate node holds leaf');
  expect(s.get('nope/missing') === undefined, 'missing path is undefined');
});

test('B1 — tree uses null-proto nodes (no inherited keys)', () => {
  const s = createStore();
  s._setPath('a/b', 1);
  const node = s.get('a');
  expect(Object.getPrototypeOf(node) === null, 'node has null prototype');
});

test('B1 — S4: unsafe paths rejected, no prototype pollution', () => {
  const s = createStore();
  expect(sanitizePath('__proto__/x') === null, '__proto__ path rejected');
  expect(sanitizePath('a/../b') === null, 'traversal rejected');
  expect(sanitizePath('a/prototype/b') === null, 'prototype segment rejected');
  expect(sanitizePath('') === null, 'empty path rejected');
  expect(s._setPath('__proto__/polluted', true) === false, '_setPath refuses unsafe path');
  expect(({}).polluted === undefined, 'Object.prototype not polluted');
  expect(sanitizePath('polls/p1/votes/u2').length === 4, 'valid path splits into 4 segments');
});
