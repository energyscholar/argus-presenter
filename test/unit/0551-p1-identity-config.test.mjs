/*
 * Plan 0551 P1 — IDENTITY IS DEPLOYMENT CONFIG, AND A HALF-CONFIGURED BLOCK IS A LOUD FAILURE.
 *
 * WHY THESE TESTS EXIST. Plan 0543 shipped the entire OIDC mechanism and it was UNREACHABLE:
 * `createServer` accepted `oidc`/`allowlist`/`tailscale`/`breakGlass`/`revokedNonceFile`, and
 * NOTHING could supply them — no env var, no MCP pass list, and this loader did not read them. So
 * `makeOidcAdapter(null)` set active=false, /auth/login answered a clean 404, and the deployment
 * believed it had sign-in. Verified cold on a phone, 2026-08-08, over the public tunnel.
 *
 * Covers C6 (loud when misconfigured) and the config half of C4 (both launch paths, ONE loader).
 *
 * ⚠ NOTHING HERE BINDS A PORT or touches the real ~/.config. Every case resolves against a
 * throwaway tree via the loader's injectable {env, repoDir}. §ANNEAL F4/E.
 */
import { test, check } from '../../harness/test.mjs';
import {
  identityConfig, normalizeIdentity, identityStartupLine, IdentityConfigError,
  IDENTITY_KEYS, OIDC_REQUIRED_KEYS, CONFIG_BASENAME,
} from '../../lib/deployment-config.mjs';
import { makeAllowlist, makeOidcAdapter } from '../../app/identity.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = () => mkdtempSync(join(tmpdir(), 'ap-0551-p1-'));
const writeConfig = (dir, obj) => { writeFileSync(join(dir, CONFIG_BASENAME), JSON.stringify(obj, null, 2)); return join(dir, CONFIG_BASENAME); };

/** A COMPLETE oidc block. Fake endpoints on example.invalid — never a real client, never a secret. */
const FULL_OIDC = Object.freeze({
  clientId: 'test-client-id.example.invalid',
  clientSecret: 'not-a-real-secret-0551',
  authEndpoint: 'https://idp.example.invalid/authorize',
  tokenEndpoint: 'https://idp.example.invalid/token',
  jwksUri: 'https://idp.example.invalid/jwks',
  issuer: 'https://idp.example.invalid',
  redirectUri: 'https://presenter.example.invalid/auth/callback',
});

const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

test('0551 P1 — the loader reads identity from the deployment config file', async () => {
  const emptyHome = scratch(), noneDir = scratch(), fullDir = scratch();
  try {
    // 1. ABSENT is fine — identity is opt-in and a fresh checkout still runs.
    const bare = identityConfig({ env: { HOME: emptyHome }, repoDir: noneDir });
    check('no config file ⇒ every identity key is null (opt-in, not an error)',
      IDENTITY_KEYS.every((k) => bare[k] === null), JSON.stringify(bare));

    // 2. A config file supplies the whole identity block — the wiring 0543 lacked.
    writeConfig(fullDir, {
      presenterPort: 0,
      oidc: FULL_OIDC,
      allowlist: { 'Someone@Example.invalid ': { role: 'presenter' }, 'other@example.invalid': 'presenter' },
      tailscale: { enabled: true },
      breakGlass: { file: '/tmp/nonexistent-break-glass' },
      revokedNonceFile: '/tmp/ap-0551-revoked.json',
    });
    const id = identityConfig({ env: { HOME: emptyHome }, repoDir: fullDir });
    check('the oidc block is read', !!id.oidc && id.oidc.clientId === FULL_OIDC.clientId, JSON.stringify(id.oidc && Object.keys(id.oidc)));
    check('...and it is enough to make the ADAPTER ACTIVE — the 0543 failure, inverted',
      makeOidcAdapter(id.oidc, { exchangeCode: async () => ({}), fetchJwks: async () => [] }).active === true);
    check('the allowlist is read, trimmed and lowercased', !!id.allowlist && !!id.allowlist['someone@example.invalid'], JSON.stringify(id.allowlist));
    check('...and the shorthand "role" string is accepted', id.allowlist['other@example.invalid'].role === 'presenter');
    check('...and makeAllowlist AGREES with what the loader counted (same key rule)',
      makeAllowlist(id.allowlist).lookup('SOMEONE@example.invalid ').allowed === true);
    check('tailscale is read', !!id.tailscale && id.tailscale.enabled === true, JSON.stringify(id.tailscale));
    check('breakGlass is read', !!id.breakGlass && id.breakGlass.file === '/tmp/nonexistent-break-glass');
    check('revokedNonceFile is read', id.revokedNonceFile === '/tmp/ap-0551-revoked.json');
    check('...and the loader says WHICH file won', id.configPath === join(fullDir, CONFIG_BASENAME) && id.configSource === 'repo', JSON.stringify({ p: id.configPath, s: id.configSource }));
  } finally { for (const d of [emptyHome, noneDir, fullDir]) rmSync(d, { recursive: true, force: true }); }
});

test('0551 P1 (C6) — a PRESENT-BUT-INCOMPLETE identity block throws a NAMED startup error', async () => {
  // The whole point: silent inertness is the bug. A deployment that names `oidc` intends sign-in.
  for (const missing of OIDC_REQUIRED_KEYS) {
    const partial = { ...FULL_OIDC };
    delete partial[missing];
    const e = threw(() => normalizeIdentity({ oidc: partial }, '/x/presenter-config.json'));
    check(`omitting oidc.${missing} throws`, !!e, 'no throw');
    check(`...as a NAMED IdentityConfigError`, e instanceof IdentityConfigError && e.name === 'IdentityConfigError', e && e.name);
    check(`...naming the missing key and the file`, e && e.message.includes(missing) && e.message.includes('/x/presenter-config.json'), e && e.message);
  }
  const empty = threw(() => normalizeIdentity({ oidc: { ...FULL_OIDC, clientSecret: '   ' } }, '/x/c.json'));
  check('an EMPTY required value counts as missing (a cleared field is not a default)',
    empty instanceof IdentityConfigError && /clientSecret/.test(empty.message), empty && empty.message);
  check('a non-object oidc throws', threw(() => normalizeIdentity({ oidc: 'yes' }, '/x')) instanceof IdentityConfigError);
  check('a non-URL endpoint throws rather than 404ing at runtime',
    /absolute URL/.test(String(threw(() => normalizeIdentity({ oidc: { ...FULL_OIDC, tokenEndpoint: 'oauth2.googleapis.com/token' } }, '/x')))));
  check('an allowlist entry with no role throws — it would otherwise be silently dropped',
    threw(() => normalizeIdentity({ allowlist: { 'a@b.invalid': {} } }, '/x')) instanceof IdentityConfigError);
  check('a non-object allowlist throws', threw(() => normalizeIdentity({ allowlist: ['a@b.invalid'] }, '/x')) instanceof IdentityConfigError);
  check('a non-boolean tailscale.enabled throws', threw(() => normalizeIdentity({ tailscale: { enabled: 'yes' } }, '/x')) instanceof IdentityConfigError);
  check('an EMPTY breakGlass block throws (it is not a recovery credential)',
    threw(() => normalizeIdentity({ breakGlass: {} }, '/x')) instanceof IdentityConfigError);
  check('an empty revokedNonceFile throws', threw(() => normalizeIdentity({ revokedNonceFile: '' }, '/x')) instanceof IdentityConfigError);

  // The converse — the complete block must NOT throw, or the guard is just "always fail".
  check('a COMPLETE oidc block is accepted', threw(() => normalizeIdentity({ oidc: FULL_OIDC }, '/x')) === null);
  check('an EMPTY allowlist {} is legal and means "nobody" (fail-closed, not an error)',
    threw(() => normalizeIdentity({ allowlist: {} }, '/x')) === null);
});

test('0551 P1 — the startup line makes INERTNESS visible, and leaks nothing', async () => {
  const off = identityStartupLine({});
  check('with no oidc the line SAYS /auth/login will 404', /INACTIVE/.test(off) && /404/.test(off), off);
  check('...and that an absent allowlist authorizes nobody', /fail-closed/.test(off), off);
  const on = identityStartupLine({ oidc: FULL_OIDC, allowlist: { 'a@b.invalid': { role: 'presenter' }, 'c@d.invalid': { role: 'presenter' } }, configPath: '/etc/x.json' });
  check('with oidc configured the line says ACTIVE', /ACTIVE/.test(on), on);
  check('...and the allowlist SIZE', /allowlist 2 entries/.test(on), on);
  check('...and WHICH file won (the whole-file trap is otherwise invisible)', on.includes('/etc/x.json'), on);
  // OPSEC: the line goes to a log ring a debug endpoint can serve.
  check('⛔ the line NEVER carries the client secret', !on.includes(FULL_OIDC.clientSecret), on);
  check('⛔ the line NEVER carries the client id', !on.includes(FULL_OIDC.clientId), on);
  check('⛔ the line NEVER carries an allowlist entry', !/a@b\.invalid/.test(on), on);
});

test('0551 P1 — the WHOLE-FILE trap is real for identity too, and documented', async () => {
  /*
   * Resolution is whole-file, first found wins. This is the trap that already claimed
   * sessionLogDir; identity is its second victim. The test PINS the behaviour rather than
   * wishing it away — the remedy is the documentation, not a key-by-key merge (which would make
   * "which file is my allowlist in?" unanswerable).
   */
  const home = scratch(), repo = scratch();
  try {
    const xdgDir = join(home, '.config', 'argus-presenter');
    mkdirSync(xdgDir, { recursive: true });
    writeConfig(xdgDir, { oidc: FULL_OIDC, allowlist: { 'a@b.invalid': 'presenter' } });
    const env = { HOME: home };
    check('the user config alone supplies identity', !!identityConfig({ env, repoDir: repo }).oidc);
    writeConfig(repo, { presenterPort: 0 });   // a checkout config that mentions ONLY the port
    const shadowed = identityConfig({ env, repoDir: repo });
    check('⚠ a repo config with only presenterPort SHADOWS the user config entirely', shadowed.oidc === null, JSON.stringify(shadowed));
    check('...and the startup line names the file that won, so the trap is audible',
      identityStartupLine(shadowed).includes(join(repo, CONFIG_BASENAME)), identityStartupLine(shadowed));
  } finally { for (const d of [home, repo]) rmSync(d, { recursive: true, force: true }); }
});
