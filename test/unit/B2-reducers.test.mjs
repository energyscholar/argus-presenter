/*
 * B2 — per-verb reducer: set/merge/add/remove/lock/unlock/clear. Each verb is
 * order-invariant / IDEMPOTENT (apply twice == once).
 */
import { test, expect } from '../../harness/test.mjs';
import { createStore } from '../../app/state.mjs';

const snap = (s) => JSON.stringify(s.state);

test('B2 set — last-write-wins + idempotent', () => {
  const s = createStore();
  s.reduce({ path: 'a/b', verb: 'set', value: 1 });
  expect(s.get('a/b') === 1, 'set leaf');
  s.reduce({ path: 'a/b', verb: 'set', value: 2 });
  expect(s.get('a/b') === 2, 'LWW overwrites');
  const before = snap(s);
  s.reduce({ path: 'a/b', verb: 'set', value: 2 });
  expect(snap(s) === before, 'set twice same == once (idempotent)');
  const diff = s.reduce({ path: 'a/b', verb: 'set', value: 3 });
  expect(JSON.stringify(diff) === JSON.stringify({ 'a/b': 3 }), 'diff reports the changed path', JSON.stringify(diff));
});

test('B2 merge — shallow merge + idempotent', () => {
  const s = createStore();
  s.reduce({ path: 'o', verb: 'merge', value: { x: 1 } });
  s.reduce({ path: 'o', verb: 'merge', value: { y: 2 } });
  expect(s.get('o').x === 1 && s.get('o').y === 2, 'both keys merged');
  const before = snap(s);
  s.reduce({ path: 'o', verb: 'merge', value: { y: 2 } });
  expect(snap(s) === before, 'merge same twice == once');
});

test('B2 add — id-keyed; add-twice-same-id == one', () => {
  const s = createStore();
  s.reduce({ path: 'items', verb: 'add', value: { id: '3', name: 'a' } });
  s.reduce({ path: 'items', verb: 'add', value: { id: '3', name: 'a' } });
  expect(Object.keys(s.get('items')).length === 1, 'one item after add-twice-same-id', Object.keys(s.get('items')).join(','));
  s.reduce({ path: 'items', verb: 'add', value: { id: '4', name: 'b' } });
  expect(Object.keys(s.get('items')).length === 2, 'distinct id adds a second');
  expect(s.get('items/3').name === 'a' && s.get('items/4').name === 'b', 'items keyed by id');
});

test('B2 remove — id-keyed; remove-twice == gone (no throw)', () => {
  const s = createStore();
  s.reduce({ path: 'items', verb: 'add', value: { id: '3' } });
  s.reduce({ path: 'items', verb: 'remove', value: '3' });
  expect(s.get('items/3') === undefined, 'removed by id');
  const before = snap(s);
  s.reduce({ path: 'items', verb: 'remove', value: '3' });
  expect(snap(s) === before, 'remove twice is a no-op');
});

test('B2 lock/unlock — owner set/cleared; idempotent', () => {
  const s = createStore();
  s.reduce({ path: 'items/3', verb: 'lock', value: null }, 'u1');
  expect(s.get('items/3/lock') === 'u1', 'lock owner = actor', String(s.get('items/3/lock')));
  s.reduce({ path: 'items/3', verb: 'lock', value: { by: 'u2' } }, 'u1');
  expect(s.get('items/3/lock') === 'u2', 'explicit by wins');
  const before = snap(s);
  s.reduce({ path: 'items/3', verb: 'lock', value: { by: 'u2' } }, 'u1');
  expect(snap(s) === before, 'lock same twice == once');
  s.reduce({ path: 'items/3', verb: 'unlock' });
  expect(s.get('items/3/lock') === undefined, 'unlock clears');
  const after = snap(s);
  s.reduce({ path: 'items/3', verb: 'unlock' });
  expect(snap(s) === after, 'unlock twice == once');
});

test('B2 clear — resets a subtree; terminal + idempotent', () => {
  const s = createStore();
  s.reduce({ path: 'coll/a', verb: 'set', value: 1 });
  s.reduce({ path: 'coll/b', verb: 'set', value: 2 });
  s.reduce({ path: 'coll', verb: 'clear' });
  expect(Object.keys(s.get('coll')).length === 0, 'subtree cleared', JSON.stringify(s.get('coll')));
  const before = snap(s);
  s.reduce({ path: 'coll', verb: 'clear' });
  expect(snap(s) === before, 'clear twice == once');
});

test('B2 unknown verb / bad path -> null diff, no mutation', () => {
  const s = createStore();
  const b = snap(s);
  expect(s.reduce({ path: 'a', verb: 'frobnicate', value: 1 }) === null, 'unknown verb -> null');
  expect(s.reduce({ path: '__proto__/x', verb: 'set', value: 1 }) === null, 'bad path -> null');
  expect(snap(s) === b, 'no mutation on invalid op');
});
