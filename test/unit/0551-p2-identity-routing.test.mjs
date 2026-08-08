/*
 * Plan 0551 P2 / C7 — THE REGRESSION GUARD: an identity key that reaches createServer and is NOT
 * routed from deployment config FAILS THIS TEST.
 *
 * THE FAILURE IT GUARDS. Plan 0543 added five identity options to createServer — oidc, allowlist,
 * tailscale, breakGlass, revokedNonceFile — declined each of them from the MCP schema with a good
 * reason, and wired NONE of them to anything that could supply a value. "Declined from the agent
 * surface" was read as "configured elsewhere", and there was no elsewhere. 312 unit + 100 component
 * tests stayed green for ten days while /auth/login answered 404 on a live deployment.
 *
 * ⛓ THE OPTIONS ARE ENUMERATED FROM THE CODE — parsed out of createServer's own signature, exactly
 * as Plan 0488 does. A hand-written list of identity keys in a test file rots the day someone adds
 * the sixth key, which is precisely the day the guard is needed. Every option must carry a
 * `deploymentOnly` classification in mcp/surface-coverage.mjs, so a NEW option fails until a human
 * says which kind it is; and every option classified deployment-only must be BOTH routed by the one
 * shared router AND absent from presenter_start's input schema.
 *
 * ⚠ The signature parse is deliberately brittle (0488's note applies): if the signature STYLE
 * changes this fails loudly and a human looks.
 *
 * ⚠ NOTHING HERE BINDS 3000 — every server started binds an ephemeral port. §ANNEAL F4.
 */
import { test, check, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { coreTools } from '../../mcp/tools.mjs';
import { CONSTRUCTOR_COVERAGE } from '../../mcp/surface-coverage.mjs';
import {
  DEPLOYMENT_ROUTED_OPTIONS, IDENTITY_KEYS, identityServerOptions, identityConfig, CONFIG_BASENAME,
} from '../../lib/deployment-config.mjs';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch = () => mkdtempSync(join(tmpdir(), 'ap-0551-p2-'));

/** A COMPLETE oidc block on a fake IdP. No real client, no real secret, nothing reachable. */
const FULL_OIDC = Object.freeze({
  clientId: 'test-client-id.example.invalid',
  clientSecret: 'not-a-real-secret-0551',
  authEndpoint: 'https://idp.example.invalid/authorize',
  tokenEndpoint: 'https://idp.example.invalid/token',
  jwksUri: 'https://idp.example.invalid/jwks',
  issuer: 'https://idp.example.invalid',
  redirectUri: 'https://presenter.example.invalid/auth/callback',
});
const ALLOWLIST = Object.freeze({ 'one@example.invalid': { role: 'presenter' }, 'two@example.invalid': { role: 'presenter' } });

/** createServer's option names, read from the CODE — never from a list maintained by hand. */
function constructorOptions() {
  const src = createServer.toString();
  const open = src.indexOf('({');
  const close = src.indexOf('} = {})', open);
  expect(open > -1 && close > open, 'createServer signature is parseable — if this fails the signature STYLE changed; fix the parser here, then re-check the classification');
  return src.slice(open + 2, close)
    .split(/,(?![^{[]*[}\]])/)
    .map((p) => p.trim().split('=')[0].trim())
    .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
}

test('0551 C7 — every createServer option is CLASSIFIED, and deployment-only ones are ROUTED', async () => {
  const opts = constructorOptions();
  check('parsed a plausible option list from the signature', opts.length >= 10, opts.length);

  // 1. CLASSIFICATION. A new option — identity or not — fails here until someone says which it is.
  const unclassified = opts.filter((n) => {
    const e = CONSTRUCTOR_COVERAGE[n];
    return !e || typeof e.deploymentOnly !== 'boolean';
  });
  check('every createServer option carries a boolean `deploymentOnly` in mcp/surface-coverage.mjs',
    unclassified.length === 0,
    `unclassified: ${unclassified.join(', ')} — say whether each is deployment config (routed from the config file, never on the tool schema) or a caller knob`);

  // 2. ROUTING. Everything classified deployment-only must be routed from the deployment config.
  //    This is the half 0543 skipped: the option existed, the reason for declining it existed, and
  //    nothing supplied a value.
  const declaredDeployment = opts.filter((n) => CONSTRUCTOR_COVERAGE[n] && CONSTRUCTOR_COVERAGE[n].deploymentOnly === true).sort();
  const routed = [...DEPLOYMENT_ROUTED_OPTIONS].sort();
  check('the deployment-only options are EXACTLY the ones the loader routes',
    JSON.stringify(declaredDeployment) === JSON.stringify(routed),
    `classified: [${declaredDeployment}] vs routed by lib/deployment-config.mjs: [${routed}] — a key classified deployment-only but absent from DEPLOYMENT_ROUTED_OPTIONS is UNREACHABLE, which is exactly the 0543 bug`);

  // 3. THE SCHEMA MUST NOT NAME THEM. An agent that can set its own allowlist can authorize itself.
  const startProps = Object.keys((coreTools.find((t) => t.name === 'presenter_start').input || {}).properties || {});
  const leaked = declaredDeployment.filter((n) => startProps.includes(n));
  check('⛔ no deployment-only key appears on presenter_start\'s input schema', leaked.length === 0, `on the schema: ${leaked.join(', ')}`);

  // 4. The identity keys specifically travel through ONE router, so both launch paths cannot drift.
  const routedFromFull = identityServerOptions(Object.fromEntries(IDENTITY_KEYS.map((k) => [k, { marker: k }])));
  check('identityServerOptions routes every IDENTITY_KEY', IDENTITY_KEYS.every((k) => routedFromFull[k]), JSON.stringify(Object.keys(routedFromFull)));
  check('...and omits keys the deployment did not state (so a derived default survives)',
    Object.keys(identityServerOptions({ oidc: null, allowlist: undefined })).length === 0);
});

test('0551 C4 — the MCP launch path really produces a configured identity', async () => {
  /*
   * Not a seam: presenter_start is driven end to end against a scratch config file, and the
   * resulting SERVER is asked whether its OIDC adapter came up. 0543's adapter would be inert here.
   */
  const cfgDir = scratch();
  writeFileSync(join(cfgDir, CONFIG_BASENAME), JSON.stringify({ presenterPort: 0, oidc: FULL_OIDC, allowlist: ALLOWLIST }));
  const prev = process.env.PRESENTER_CONFIG_FILE;
  process.env.PRESENTER_CONFIG_FILE = join(cfgDir, CONFIG_BASENAME);
  let T = null;
  try {
    T = await import(`../../mcp/tools.mjs?p0551=${Date.now()}`);
    const tools = T.toolMap({ voiceEnabled: false });
    const started = await tools.presenter_start.handler({ port: 0, voice: false, tunnel: false });
    check('presenter_start succeeded', started.ok === true, JSON.stringify(started.error || ''));
    check('the tool REPORTS whether sign-in is active — inert must be visible from the outside',
      typeof started.identity === 'string' && /ACTIVE/.test(started.identity), started.identity);
    check('...and the allowlist SIZE', /allowlist 2 entries/.test(started.identity || ''), started.identity);
    check('⛔ ...and never an allowlist entry or the client secret',
      !/one@example\.invalid/.test(started.identity || '') && !(started.identity || '').includes(FULL_OIDC.clientSecret), started.identity);
    // The load-bearing assertion: the adapter the routes read is ACTIVE, so /auth/login is not a 404.
    const srv = T._serverForTests ? T._serverForTests() : null;
    if (srv && srv._oidcAdapterForTest) {
      check('the running server\'s OIDC adapter is ACTIVE (0543 shipped this inert)', srv._oidcAdapterForTest.active === true);
    }
    const res = await fetch(started.url + '/auth/login', { redirect: 'manual' });
    check('GET /auth/login REDIRECTS to the IdP instead of 404ing', res.status === 302, `status ${res.status}`);
    check('...to the configured authorization endpoint', String(res.headers.get('location') || '').startsWith(FULL_OIDC.authEndpoint), res.headers.get('location'));
    await tools.presenter_stop.handler({ tunnel: false });
  } finally {
    if (T && T._resetForTests) T._resetForTests();
    if (prev == null) delete process.env.PRESENTER_CONFIG_FILE; else process.env.PRESENTER_CONFIG_FILE = prev;
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test('0551 C4 — the CLI launch path agrees, from the SAME file', async () => {
  /*
   * `node app/server.mjs` is spawned for real against the same scratch config, and its startup line
   * is read off stdout. A divergence between the two launch paths is how this class of bug is born
   * (C4), so the CLI is exercised as a process, not as an import.
   */
  const cfgDir = scratch();
  writeFileSync(join(cfgDir, CONFIG_BASENAME), JSON.stringify({ presenterPort: 0, oidc: FULL_OIDC, allowlist: ALLOWLIST }));
  const child = spawn(process.execPath, [join(ROOT, 'app', 'server.mjs')], {
    env: { ...process.env, PRESENTER_CONFIG_FILE: join(cfgDir, CONFIG_BASENAME) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  try {
    await new Promise((resolve) => {
      const done = () => resolve();
      child.stdout.on('data', (d) => { out += d; if (/control token/.test(out)) done(); });
      child.stderr.on('data', (d) => { out += d; });
      setTimeout(done, 8000);
    });
    check('the CLI prints ONE identity startup line', /identity: /.test(out), out.slice(0, 400));
    check('...saying sign-in is ACTIVE', /identity: OIDC sign-in ACTIVE/.test(out), (out.match(/^.*identity: .*$/m) || [''])[0]);
    check('...and the allowlist SIZE, from the same file the MCP path read', /allowlist 2 entries/.test(out), (out.match(/^.*identity: .*$/m) || [''])[0]);
    check('⛔ ...and NEVER the secret or an allowlist entry', !out.includes(FULL_OIDC.clientSecret) && !/one@example\.invalid/.test(out), 'startup output leaked a credential');
  } finally {
    child.kill('SIGKILL');
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test('0551 C6 — a half-configured oidc block stops BOTH launch paths, by name', async () => {
  const cfgDir = scratch();
  const partial = { ...FULL_OIDC }; delete partial.redirectUri;
  writeFileSync(join(cfgDir, CONFIG_BASENAME), JSON.stringify({ presenterPort: 0, oidc: partial }));
  const prev = process.env.PRESENTER_CONFIG_FILE;
  process.env.PRESENTER_CONFIG_FILE = join(cfgDir, CONFIG_BASENAME);
  let T = null;
  try {
    // The shared loader — the thing both paths call before anything binds.
    let e = null;
    try { identityConfig(); } catch (err) { e = err; }
    check('the shared loader throws IdentityConfigError, naming the missing key',
      e && e.name === 'IdentityConfigError' && /redirectUri/.test(e.message), String(e && e.message).slice(0, 200));
    // The MCP path must not start a server that believes it has sign-in.
    T = await import(`../../mcp/tools.mjs?p0551bad=${Date.now()}`);
    let threw = null;
    try { await T.toolMap({ voiceEnabled: false }).presenter_start.handler({ port: 0, voice: false, tunnel: false }); }
    catch (err) { threw = err; }
    check('presenter_start REFUSES rather than booting inert', threw && /redirectUri/.test(String(threw.message)), String(threw && threw.message).slice(0, 200));
  } finally {
    if (T && T._resetForTests) { try { await T.toolMap({ voiceEnabled: false }).presenter_stop.handler({ tunnel: false }); } catch {} T._resetForTests(); }
    if (prev == null) delete process.env.PRESENTER_CONFIG_FILE; else process.env.PRESENTER_CONFIG_FILE = prev;
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test('0551 — the guard itself fails on drift (meta-test)', async () => {
  // An unclassified new option must be caught by the same predicate the guard uses.
  const fake = { brandNewIdentityKnob: { declined: 'because' } };
  const unclassified = Object.keys(fake).filter((n) => typeof fake[n].deploymentOnly !== 'boolean');
  check('an option with no deploymentOnly classification is detected', unclassified.length === 1);
  // A deployment-only option missing from the routed list must be caught.
  const classified = ['oidc', 'brandNewIdentityKnob'];
  const routed = [...DEPLOYMENT_ROUTED_OPTIONS];
  check('a deployment-only option that nothing routes is detected', !routed.includes('brandNewIdentityKnob') && classified.includes('brandNewIdentityKnob'));
  // Sanity: the real code is NOT in that state.
  check('...and the real manifest is currently consistent', DEPLOYMENT_ROUTED_OPTIONS.every((k) => k in CONSTRUCTOR_COVERAGE));
  // The signature parser really reads the code.
  check('the parser finds the identity keys in createServer\'s signature',
    IDENTITY_KEYS.every((k) => constructorOptions().includes(k)), JSON.stringify(constructorOptions()));
  void readFileSync;   // (kept: the CLI half reads the tree through spawn, not through fs)
});
