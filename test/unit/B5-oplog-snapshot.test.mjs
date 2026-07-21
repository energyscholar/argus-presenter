/*
 * B5 — bounded op-log + versioning + role-filtered snapshot (Memento).
 */
import { test, expect } from '../../harness/test.mjs';
import { createStore } from '../../app/state.mjs';
import { createPermissions } from '../../app/permissions.mjs';

const pres = { userId: 'gm', role: 'presenter' };
const part = { userId: 'u', role: 'participant' };   // Plan 0471 C3: snapshot() takes an actor {role,userId}

test('B5 — apply increments version and records the op-log', () => {
  const s = createStore();
  const r1 = s.apply({ path: 'a', verb: 'set', value: 1 }, pres);
  const r2 = s.apply({ path: 'b', verb: 'set', value: 2 }, pres);
  expect(r1.version === 1 && r2.version === 2, 'monotonic versions', `${r1.version},${r2.version}`);
  expect(s.version() === 2, 'store version = 2');
  const log = s.oplogSince(0);
  expect(log.length === 2 && log[0].by === 'gm' && log[1].path === 'b', 'op-log records by+path', JSON.stringify(log));
  expect(s.oplogSince(1).length === 1, 'oplogSince filters by version');
});

test('B5 — replay the op-log into a fresh store reproduces state', () => {
  const s = createStore();
  s.apply({ path: 'polls/p/votes/u1', verb: 'set', value: 'yes' }, pres);
  s.apply({ path: 'polls/p/votes/u2', verb: 'set', value: 'no' }, pres);
  s.apply({ path: 'polls/p/votes/u1', verb: 'set', value: 'no' }, pres); // LWW
  const original = JSON.stringify(s.snapshot(pres).state);

  const fresh = createStore();
  for (const e of s.oplogSince(0)) fresh.apply({ path: e.path, verb: e.verb, value: e.value }, pres);
  expect(JSON.stringify(fresh.snapshot(pres).state) === original, 'replay reproduces state', original);
});

test('B5 — snapshot(actor) filters unreadable slices (S7, Plan 0471 C3 default-deny), keeps arrays intact', () => {
  // Default-DENY: 'secret' has a controller-only rule; 'public' is explicitly allowed for all.
  const perms = createPermissions(undefined, [
    { glob: 'secret', roles: ['presenter', 'ai'] },                          // controller-only (prefix)
    { glob: 'public', roles: ['participant', 'presenter', 'ai'] },           // shared (prefix)
  ]);
  const s = createStore({ permissions: perms });
  s.apply({ path: 'secret/x', verb: 'set', value: 42 }, pres);
  s.apply({ path: 'public/opts', verb: 'set', value: [1, 2, 3] }, pres);

  const partSnap = s.snapshot(part).state;
  expect(partSnap.secret === undefined, 'participant cannot see the secret slice at all (denied → dropped)', JSON.stringify(partSnap.secret));
  expect(Array.isArray(partSnap.public.opts) && partSnap.public.opts.length === 3, 'array value preserved as array', JSON.stringify(partSnap.public.opts));

  const gmSnap = s.snapshot(pres).state;
  expect(gmSnap.secret.x === 42, 'presenter sees secret.x', JSON.stringify(gmSnap.secret));
  expect(s.snapshot(pres).version === 2, 'snapshot carries the version');
});

test('B5 — op-log is bounded', () => {
  const s = createStore();
  for (let i = 0; i < 1050; i++) s.apply({ path: 'k/n' + i, verb: 'set', value: i }, pres);
  expect(s.oplogSince(0).length <= 1000, 'op-log capped at OPLOG_MAX', String(s.oplogSince(0).length));
  expect(s.version() === 1050, 'version keeps counting past the cap');
});
