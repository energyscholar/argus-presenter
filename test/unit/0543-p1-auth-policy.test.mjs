/*
 * Plan 0543 P1 — the AUTH POLICY dial exists as CONFIG, is validated at startup, and is surfaced.
 *
 * P1 is a plumbing slice: no behaviour change beyond the config existing. It proves (a) the two keys
 * default correctly, (b) a bad value is a LOUD startup error (never a silent fall-through to a policy
 * the deployer did not choose), and (c) the current value is readable (what presenter_status shows).
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { normalizeAuthPolicy, AUTH_POLICY_DEFAULTS, DEPLOYMENT_DEFAULTS } from '../../lib/deployment-config.mjs';

test('0543 P1: defaults — enforceOAuth=off, allowPasswordCommandOnLAN=false', async () => {
  const s = await createServer({ port: 0 });
  try {
    const p = s.authPolicy();
    expect(p.enforceOAuth === 'off', 'default enforceOAuth is off', p.enforceOAuth);
    expect(p.allowPasswordCommandOnLAN === false, 'default allowPasswordCommandOnLAN is false', String(p.allowPasswordCommandOnLAN));
  } finally { await s.close(); }
});

test('0543 P1: an explicit control value is surfaced verbatim', async () => {
  const s = await createServer({ port: 0, enforceOAuth: 'control', allowPasswordCommandOnLAN: true, breakGlass: { token: 'bg', loopbackOnly: true } });
  try {
    const p = s.authPolicy();
    expect(p.enforceOAuth === 'control', 'enforceOAuth reads back as control', p.enforceOAuth);
    expect(p.allowPasswordCommandOnLAN === true, 'allowPasswordCommandOnLAN reads back true', String(p.allowPasswordCommandOnLAN));
  } finally { await s.close(); }
});

test('0543 P1: an unknown enforceOAuth value THROWS at startup (no silent default)', async () => {
  let threw = null;
  try { await createServer({ port: 0, enforceOAuth: 'sometimes' }); }
  catch (e) { threw = e; }
  expect(threw && /enforceOAuth/.test(threw.message), 'createServer throws naming enforceOAuth', threw && threw.message);
});

test('0543 P1: a non-boolean allowPasswordCommandOnLAN THROWS at startup', async () => {
  let threw = null;
  try { await createServer({ port: 0, allowPasswordCommandOnLAN: 'yes' }); }
  catch (e) { threw = e; }
  expect(threw && /allowPasswordCommandOnLAN/.test(threw.message), 'createServer throws naming allowPasswordCommandOnLAN', threw && threw.message);
});

test('0543 P1: normalizeAuthPolicy — defaults, accepts, and rejects', () => {
  expect(normalizeAuthPolicy({}).enforceOAuth === 'off', 'empty input yields the default off');
  expect(normalizeAuthPolicy({ enforceOAuth: 'control' }).enforceOAuth === 'control', 'control accepted');
  let threw = false; try { normalizeAuthPolicy({ enforceOAuth: 'on' }); } catch { threw = true; }
  expect(threw, 'legacy 3-state value "on" is rejected (the dial is 2-state now)');
  expect(AUTH_POLICY_DEFAULTS.enforceOAuth === 'off' && DEPLOYMENT_DEFAULTS.enforceOAuth === 'off',
    'the defaults object carries enforceOAuth=off');
});
