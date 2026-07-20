/*
 * Plan 0472 P4 — capability crypto lib (unit). Isolates the HMAC/verify contract from the server.
 * Confirms: valid round-trip; tamper → bad-sig; expiry; revocation; empty/absent secret disables;
 * malformed input never throws; and the payload `role` field is IGNORED (no promotion via the token).
 */
import { test, expect } from '../../harness/test.mjs';
import { mintCapability, verifyCapability } from '../../lib/capability.mjs';

const SECRET = 'unit-secret';
const soon = () => Math.floor(Date.now() / 1000) + 300;
const gone = () => Math.floor(Date.now() / 1000) - 30;

test('V0472-cap-lib — round-trip verify returns the scoped payload; role is ignored', () => {
  const tok = mintCapability({ v: 1, sid: 's', role: 'ai', scope: ['speak', 'type'], name: 'Ada', exp: soon(), nonce: 'x1' }, SECRET);
  const v = verifyCapability(tok, SECRET);
  expect(v.ok === true, 'valid token verifies');
  expect(v.payload.nonce === 'x1' && v.payload.name === 'Ada', 'payload identity round-trips', JSON.stringify(v.payload));
  expect(JSON.stringify(v.payload.scope) === JSON.stringify(['speak', 'type']), 'scope round-trips', JSON.stringify(v.payload.scope));
  expect(!('role' in v.payload), 'payload role is DROPPED (server forces participant)', JSON.stringify(v.payload));
});

test('V0472-cap-lib — tampered payload / bad signature is rejected', () => {
  const tok = mintCapability({ v: 1, sid: 's', scope: ['type'], exp: soon(), nonce: 'x2' }, SECRET);
  const [p, s] = tok.split('.');
  expect(verifyCapability(p.slice(0, -1) + (p.slice(-1) === 'A' ? 'B' : 'A') + '.' + s, SECRET).ok === false, 'flipped payload byte rejected');
  expect(verifyCapability(p + '.' + 'AAAA', SECRET).ok === false, 'bad signature rejected');
  expect(verifyCapability(tok, 'wrong-secret').ok === false, 'wrong secret rejected');
});

test('V0472-cap-lib — expiry and revocation enforced', () => {
  expect(verifyCapability(mintCapability({ v: 1, scope: [], exp: gone(), nonce: 'x3' }, SECRET), SECRET).ok === false, 'expired rejected');
  const tok = mintCapability({ v: 1, scope: [], exp: soon(), nonce: 'x4' }, SECRET);
  expect(verifyCapability(tok, SECRET).ok === true, 'valid before revocation');
  expect(verifyCapability(tok, SECRET, { isRevoked: (n) => n === 'x4' }).ok === false, 'revoked nonce rejected');
});

test('V0472-cap-lib — no/empty secret disables; malformed input never throws', () => {
  const tok = mintCapability({ v: 1, scope: [], exp: soon(), nonce: 'x5' }, SECRET);
  expect(verifyCapability(tok, null).ok === false, 'null secret disables verification');
  expect(verifyCapability(tok, '').ok === false, 'empty-string secret disables verification (no insecure default)');
  for (const bad of [undefined, null, '', 'x', 'a.b.c', '.', '..', '{}', 'a'.repeat(9000)]) {
    let threw = false, r;
    try { r = verifyCapability(bad, SECRET); } catch (e) { threw = true; }
    expect(!threw && r && r.ok === false, 'malformed input returns {ok:false} without throwing: ' + JSON.stringify(bad));
  }
});
