import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStoreRoute } from './store-route.mjs';
import { createHttpHandler } from './http-routes.mjs';

function fixture() {
  return { storeDir: mkdtempSync(join(tmpdir(), 'ap-store-')), accountDir: mkdtempSync(join(tmpdir(), 'ap-account-')) };
}
function mockRes() {
  const res = {};
  res.writeHead = (s) => { res._status = s; };
  res.end = (b) => { res._body = b; };
  return res;
}
function writeReleases(dir, cards) { writeFileSync(join(dir, 'releases.json'), JSON.stringify(cards), 'utf8'); }
function writeIndex(dir, body) { writeFileSync(join(dir, 'index.html'), body, 'utf8'); }

test('t0756-01 — no principal refuses 401, never reaches the filesystem (R-188)', () => {
  const { storeDir, accountDir } = fixture();
  rmSync(storeDir, { recursive: true, force: true });
  const route = createStoreRoute({ oidcAuth: { principalForRequest: () => null }, storeDir, accountDir });
  const res = mockRes();
  assert.doesNotThrow(() => route({ url: '/store' }, res));
  assert.equal(res._status, 401);
});

test('t0756-02 — signed-in, no owner-only release, serves index.html bytes', () => {
  const { storeDir, accountDir } = fixture();
  writeReleases(storeDir, [{ releaseId: 'x@1', key: 'abc' }]);
  writeIndex(storeDir, '<html>ok</html>');
  const route = createStoreRoute({ oidcAuth: { principalForRequest: () => ({ provider: 'oidc', sub: 's1' }) }, storeDir, accountDir });
  const res = mockRes();
  route({ url: '/store' }, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.toString(), '<html>ok</html>');
});

test('t0756-03 — owner-only release, empty allow-list, refuses 403 (R-214)', () => {
  const { storeDir, accountDir } = fixture();
  writeReleases(storeDir, [{ releaseId: 'high-and-dry@0.1.0', key: 'abc', licenceState: 'owner-only' }]);
  writeIndex(storeDir, '<html>ok</html>');
  const route = createStoreRoute({ oidcAuth: { principalForRequest: () => ({ provider: 'oidc', sub: 's1' }) }, storeDir, accountDir });
  const res = mockRes();
  route({ url: '/store' }, res);
  assert.equal(res._status, 403);
});

test('t0756-04 — owner-only release, allow-listed account, serves the page', () => {
  const { storeDir, accountDir } = fixture();
  writeReleases(storeDir, [{ releaseId: 'high-and-dry@0.1.0', key: 'abc', licenceState: 'owner-only' }]);
  writeIndex(storeDir, '<html>ok</html>');
  writeFileSync(join(accountDir, 'owner-only-allowlist.tsv'), 'oidc:s1\n', 'utf8');
  const route = createStoreRoute({ oidcAuth: { principalForRequest: () => ({ provider: 'oidc', sub: 's1' }) }, storeDir, accountDir });
  const res = mockRes();
  route({ url: '/store' }, res);
  assert.equal(res._status, 200);
});

test('t0756-05 — a `..` path is refused 400', () => {
  const { storeDir, accountDir } = fixture();
  writeReleases(storeDir, []);
  const route = createStoreRoute({ oidcAuth: { principalForRequest: () => ({ provider: 'oidc', sub: 's1' }) }, storeDir, accountDir });
  const res = mockRes();
  route({ url: '/store/../../etc/passwd' }, res);
  assert.equal(res._status, 400);
});

test('t0756-06 — /store is REGISTERED in the real route table: signed-out refused, signed-in served', () => {
  const { storeDir, accountDir } = fixture();
  writeReleases(storeDir, [{ releaseId: 'x@1', key: 'abc' }]);
  writeIndex(storeDir, '<html>ok</html>');
  let principal = null;
  const oidcAuth = { principalForRequest: () => principal };
  // §2's actual dispatcher, not the standalone handler — proves the REGISTRATION, not just the logic.
  const handler = createHttpHandler({ oidcAuth, storeDir, accountDir });
  const res1 = mockRes();
  handler({ url: '/store', method: 'GET' }, res1);
  assert.equal(res1._status, 401, 'signed-out must be refused through the real dispatcher');
  principal = { provider: 'oidc', sub: 's1' };
  const res2 = mockRes();
  handler({ url: '/store', method: 'GET' }, res2);
  assert.equal(res2._status, 200, 'signed-in must be served through the real dispatcher');
  assert.equal(res2._body.toString(), '<html>ok</html>');
});
