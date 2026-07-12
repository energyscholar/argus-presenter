/*
 * B3 — permission Strategy: glob table + {self} + presenter override + default-deny.
 */
import { test, expect } from '../../harness/test.mjs';
import { createPermissions } from '../../app/permissions.mjs';

const P = createPermissions();
const part = (id) => ({ userId: id, role: 'participant' });
const pres = { userId: 'gm', role: 'presenter' };
const ai = { userId: 'argus', role: 'ai' };

test('B3 — participant may set OWN vote (self), not another\'s', () => {
  expect(P.can(part('u2'), { path: 'polls/p1/votes/u2', verb: 'set', value: 'yes' }) === true, 'own vote allowed');
  expect(P.can(part('u2'), { path: 'polls/p1/votes/u3', verb: 'set', value: 'yes' }) === false, 'another\'s vote denied (self)');
});

test('B3 — participant default-DENY on ungated paths/verbs', () => {
  expect(P.can(part('u2'), { path: 'polls/p1/open', verb: 'set', value: false }) === false, 'cannot set poll open');
  expect(P.can(part('u2'), { path: 'map/view', verb: 'set', value: {} }) === false, 'cannot set map view');
  expect(P.can(part('u2'), { path: 'random/thing', verb: 'set', value: 1 }) === false, 'unknown path denied');
  expect(P.can(part('u2'), { path: 'polls/p1/votes/u2', verb: 'add', value: 1 }) === false, 'wrong verb denied');
});

test('B3 — participant allowed on explicitly-gated paths', () => {
  expect(P.can(part('u2'), { path: 'map/markers', verb: 'add', value: { id: 'm1' } }) === true, 'add marker allowed');
  expect(P.can(part('u2'), { path: 'map/pointer/u2', verb: 'set', value: {} }) === true, 'own pointer allowed');
  expect(P.can(part('u2'), { path: 'map/pointer/u9', verb: 'set', value: {} }) === false, 'other pointer denied');
  expect(P.can(part('u2'), { path: 'chat', verb: 'add', value: { text: 'hi' } }) === true, 'chat add allowed');
});

test('B3 — controllers (presenter, ai) OVERRIDE', () => {
  expect(P.can(pres, { path: 'polls/p1/open', verb: 'set', value: false }) === true, 'presenter override');
  expect(P.can(pres, { path: 'anything/at/all', verb: 'clear' }) === true, 'presenter any path/verb');
  expect(P.can(ai, { path: 'map/view', verb: 'set', value: {} }) === true, 'ai override');
});

test('B3 — S4: unsafe path denied even for controllers', () => {
  expect(P.can(pres, { path: '__proto__/x', verb: 'set', value: 1 }) === false, 'unsafe path denied for presenter');
});

test('B3 — canRead: default-open; controllers always read', () => {
  expect(P.canRead('participant', 'polls/p1/votes/u2') === true, 'default-open read');
  expect(P.canRead('presenter', 'anything') === true, 'controller reads all');
});
