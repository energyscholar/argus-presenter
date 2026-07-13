import { test, expect } from '../../harness/test.mjs';
import { resolveNext } from '../../app/branch.mjs';

test('branch: choice value routes', () => {
  expect(resolveNext({ component: 'choice', branch: { yes: 'a', no: 'b' } }, { value: 'no' }) === 'b',
    'choice no -> b');
});

test('branch: dice OK meets target', () => {
  expect(resolveNext({ component: 'dice', gate: { target: 8 }, branch: { ok: 'ok', fail: 'f' } }, { value: 9 }) === 'ok',
    'dice 9 >= 8 -> ok');
});

test('branch: dice FAIL below target', () => {
  expect(resolveNext({ component: 'dice', gate: { target: 8 }, branch: { ok: 'ok', fail: 'f' } }, { value: 5 }) === 'f',
    'dice 5 < 8 -> f');
});

test('branch: ifFlag precedence and default', () => {
  expect(resolveNext({ branch: { default: 'clean', ifFlag: { dm2: 'dm' } } }, {}, { dm2: true }) === 'dm',
    'flag dm2 truthy -> dm');
  expect(resolveNext({ branch: { default: 'clean', ifFlag: { dm2: 'dm' } } }, {}, {}) === 'clean',
    'no flag -> default clean');
});

test('branch: linear next', () => {
  expect(resolveNext({ branch: { next: 'n' } }, {}) === 'n', 'linear -> n');
});

test('branch: no branch returns null', () => {
  expect(resolveNext({ component: 'card' }, {}) === null, 'no branch -> null');
});
