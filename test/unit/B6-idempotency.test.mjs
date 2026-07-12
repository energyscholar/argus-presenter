/*
 * B6 — explicit op idempotency: opId dedup (re-delivered op = no-op); every verb
 * idempotent; concurrent same-path sets deterministic (last-by-arrival wins, logged).
 */
import { test, expect } from '../../harness/test.mjs';
import { createStore } from '../../app/state.mjs';

const pres = { userId: 'gm', role: 'presenter' };

test('B6 — duplicate opId is a no-op (state + version unchanged)', () => {
  const s = createStore();
  const r1 = s.apply({ path: 'x', verb: 'set', value: 1, opId: 'op-1' }, pres);
  expect(r1.version === 1 && s.get('x') === 1, 'first apply took effect');
  const r2 = s.apply({ path: 'x', verb: 'set', value: 999, opId: 'op-1' }, pres); // re-delivery
  expect(r2 && r2.duplicate === true, 're-delivered op reports duplicate', JSON.stringify(r2));
  expect(s.get('x') === 1, 'state unchanged by duplicate');
  expect(s.version() === 1, 'version not bumped by duplicate');
  expect(s.oplogSince(0).length === 1, 'op-log has one entry');
});

test('B6 — apply-twice-same-opId == apply-once, for every verb', () => {
  const cases = [
    { op: { path: 'a', verb: 'set', value: 5 } },
    { op: { path: 'o', verb: 'merge', value: { k: 1 } } },
    { op: { path: 'items', verb: 'add', value: { id: '7', n: 1 } } },
    { op: { path: 'items', verb: 'remove', value: '7' } },
    { op: { path: 'it/1', verb: 'lock', value: { by: 'u' } } },
    { op: { path: 'it/1', verb: 'unlock' } },
    { op: { path: 'coll', verb: 'clear' } },
  ];
  for (let i = 0; i < cases.length; i++) {
    const s = createStore();
    const opId = 'v-' + i;
    s.apply(Object.assign({ opId }, cases[i].op), pres);
    const once = JSON.stringify(s.state);
    const r = s.apply(Object.assign({ opId }, cases[i].op), pres);
    expect(r.duplicate === true, `${cases[i].op.verb} re-delivery deduped`);
    expect(JSON.stringify(s.state) === once, `${cases[i].op.verb} twice == once`, cases[i].op.verb);
  }
});

test('B6 — add same id twice (distinct opIds) = one item', () => {
  const s = createStore();
  s.apply({ path: 'items', verb: 'add', value: { id: '3', n: 'a' }, opId: 'x1' }, pres);
  s.apply({ path: 'items', verb: 'add', value: { id: '3', n: 'a' }, opId: 'x2' }, pres);
  expect(Object.keys(s.get('items')).length === 1, 'one item despite two distinct-opId adds');
});

test('B6 — concurrent same-path sets: last-by-arrival wins, both logged', () => {
  const s = createStore();
  s.apply({ path: 'p', verb: 'set', value: 1, opId: 'a' }, pres);
  s.apply({ path: 'p', verb: 'set', value: 2, opId: 'b' }, pres);
  expect(s.get('p') === 2, 'last arrival wins (deterministic LWW)');
  expect(s.oplogSince(0).length === 2, 'both durable ops logged', String(s.oplogSince(0).length));
});
