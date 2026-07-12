/*
 * B4 — apply(op,actor): validate → permission → reduce → stamp by → diff|null.
 * Identity is server-authoritative (from the actor), never the payload (S1).
 */
import { test, expect } from '../../harness/test.mjs';
import { createStore, validOp } from '../../app/state.mjs';

const part = (id) => ({ userId: id, role: 'participant' });
const pres = { userId: 'gm', role: 'presenter' };

test('B4 — permitted op applies, returns diff + authoritative by', () => {
  const s = createStore();
  const r = s.apply({ path: 'polls/p1/votes/u2', verb: 'set', value: 'yes' }, part('u2'));
  expect(r && r.diff && r.diff['polls/p1/votes/u2'] === 'yes', 'diff has the vote', JSON.stringify(r));
  expect(r.by === 'u2', 'by stamped from actor, not payload', String(r && r.by));
  expect(s.get('polls/p1/votes/u2') === 'yes', 'state updated');
});

test('B4 — denied op returns null and does NOT mutate', () => {
  const s = createStore();
  const before = JSON.stringify(s.state);
  const r = s.apply({ path: 'polls/p1/votes/u3', verb: 'set', value: 'yes' }, part('u2')); // not self
  expect(r === null, 'denied -> null');
  expect(JSON.stringify(s.state) === before, 'no mutation on deny');
});

test('B4 — presenter override applies control ops', () => {
  const s = createStore();
  const r = s.apply({ path: 'polls/p1/open', verb: 'set', value: false }, pres);
  expect(r && s.get('polls/p1/open') === false, 'presenter closed the poll', JSON.stringify(r));
  expect(r.by === 'gm', 'by = presenter id');
});

test('B4 — malformed ops rejected (S10)', () => {
  const s = createStore();
  expect(validOp({ path: 'a', verb: 'set', value: 1 }) === true, 'valid op recognised');
  expect(validOp({ path: '__proto__/x', verb: 'set', value: 1 }) === false, 'unsafe path invalid');
  expect(validOp({ path: 'a', verb: 'frob' }) === false, 'unknown verb invalid');
  expect(validOp({ verb: 'set', value: 1 }) === false, 'missing path invalid');
  const big = { path: 'a', verb: 'set', value: 'x'.repeat(70 * 1024) };
  expect(validOp(big) === false, 'oversized value invalid (S6)');
  expect(s.apply(big, pres) === null, 'apply rejects malformed even for presenter');
});

test('B4 — identity from actor, not payload (S1)', () => {
  const s = createStore();
  // op payload lies about who it is; apply must ignore it and use the actor.
  const r = s.apply({ path: 'polls/p1/votes/u2', verb: 'set', value: 'yes', userId: 'attacker' }, part('u2'));
  expect(r.by === 'u2', 'by comes from the connection actor, not the payload userId', String(r.by));
});
