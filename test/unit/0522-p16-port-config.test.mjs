/*
 * Plan 0522 P16.1 (R1, I1) — THE PORT IS DEPLOYMENT CONFIG, AND AN UNREACHABLE START IS A FAILURE.
 *
 *   t47 — the port reads from the deployment config file; with no config anywhere ⇒ 3000.
 *   t48 — a failed PUBLIC probe after raising the ingress is reported as a FAILED START, not as a
 *         warning attached to a success.
 *
 * WHY THESE TESTS EXIST. Observed cold 2026-07-30: `presenter_start` bound 127.0.0.1:4300 (a code
 * constant), answered 200 locally, raised the tunnel, reported `active: true` — and the public url
 * returned 502, because this deployment's ingress forwards to 3000. Two failures in one call: a port the
 * repo cannot know is right, and a probe that already knew it was wrong and downgraded itself to
 * `warning:` on a successful return. Nobody could reach the session; the tool said it was up.
 *
 * The port half is also an I1 parity failure in its own right. `4300` lived in FOUR places in
 * mcp/tools.mjs — comment, constant, handler default, and the tool's own JSON-schema description.
 * The schema is what the AI reads. Fix the constant alone and the surface still advertises
 * "default 4300" while the handler uses something else: a documented lie on the agent surface.
 * t47 therefore asserts the SCHEMA and the RESOLVED DEFAULT are the same value, and that no bare
 * 4300 survives in the code (comments recording the history are fine — that is the record).
 *
 * ⚠ NOTHING HERE BINDS 3000. Bruce's live Presenter is on 3000 right now, and it is the ingress
 * target. The default is asserted as a RESOLVED VALUE; every server this file starts binds an
 * ephemeral port (config `presenterPort: 0`, or an explicit `port: 0`). §ANNEAL F4.
 * ⚠ §ANNEAL E — no test here reads or writes the repo's real modules/ directory.
 *
 * Unit tier: no browser. Tunnel commands are env-supplied shell strings, so the whole ingress
 * lifecycle is exercised with `touch`/`test -f` and a throwaway local http server standing in for
 * the public address — no vendor, no sudo, no network (the pattern from tunnel-ingress.test.mjs).
 */
import { test, check } from '../../harness/test.mjs';
import {
  loadDeploymentConfig, deploymentConfigCandidates, presenterPort,
  DEPLOYMENT_DEFAULTS, CONFIG_BASENAME, REPO_ROOT,
} from '../../lib/deployment-config.mjs';
/*
 * NAMESPACE import, deliberately. A missing export must fail as a named TEST, not as an import
 * error that discards the whole file — a file that does not import registers zero tests and the
 * executed count silently drops, which is the P1 defect this batch was born from.
 */
import * as presenterTools from '../../mcp/tools.mjs';
import { createServer as httpServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const AP_STANDARD_PORT = presenterTools.AP_STANDARD_PORT;
const TOOL = Object.fromEntries((presenterTools.coreTools || []).map((t) => [t.name, t]));
const scratch = () => mkdtempSync(join(tmpdir(), 'ap-0522-p16-'));
const writeConfig = (dir, obj) => { const p = join(dir, CONFIG_BASENAME); writeFileSync(p, JSON.stringify(obj)); return p; };

/** A throwaway public address: an http server on an ephemeral port. */
async function fakePublic(status = 200) {
  const srv = httpServer((req, res) => { res.writeHead(status); res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => new Promise((r) => srv.close(r)) };
}

/** An address that REFUSES: bind an ephemeral port, learn it, give it back. */
async function deadPublic() {
  const p = await fakePublic(200);
  await p.close();
  return p.url;
}

const TUNNEL_KEYS = ['PRESENTER_TUNNEL_START', 'PRESENTER_TUNNEL_STOP', 'PRESENTER_TUNNEL_CHECK', 'PRESENTER_PUBLIC_URL'];
function setTunnelEnv(o = {}) { for (const k of TUNNEL_KEYS) { if (o[k] == null) delete process.env[k]; else process.env[k] = o[k]; } }

/** A flag file stands in for the ingress unit, so start/stop/check really affect each other. */
function fakeUnit(dir) {
  const flag = join(dir, 'ingress-up');
  return { PRESENTER_TUNNEL_START: `touch ${flag}`, PRESENTER_TUNNEL_STOP: `rm -f ${flag}`, PRESENTER_TUNNEL_CHECK: `test -f ${flag}` };
}

/*
 * A FRESH copy of mcp/tools.mjs, because AP_STANDARD_PORT is resolved once at import — which is
 * the point (one value feeds both the handler default and the schema, so they cannot drift). Each
 * copy owns its own server singleton, so the same copy must do the cleanup.
 */
let freshN = 0;
const freshTools = () => import(`../../mcp/tools.mjs?p16=${++freshN}`);

// ── t47 ──────────────────────────────────────────────────────────────────────────────────────
test('0522 t47 — the port reads from the deployment config file; absent config ⇒ 3000', async () => {
  const emptyRepo = scratch(), emptyHome = scratch();
  const withRepo = scratch(), xdgOnly = scratch(), explicitDir = scratch();
  try {
    // 1. NO FILE ANYWHERE. A fresh checkout must run, and run on 3000.
    const bare = loadDeploymentConfig({ env: { HOME: emptyHome }, repoDir: emptyRepo });
    check('no config file anywhere ⇒ presenterPort 3000', bare.presenterPort === 3000, JSON.stringify(bare));
    check('...and it says so: configSource "built-in", no path', bare.configSource === 'built-in' && bare.configPath === null, JSON.stringify(bare));
    check('...and the built-in default is declared, not implicit', DEPLOYMENT_DEFAULTS.presenterPort === 3000);
    check('no repo-local config file is REQUIRED to run', presenterPort({ env: { HOME: emptyHome }, repoDir: emptyRepo }) === 3000);

    // 2. A config file supplies the port.
    writeConfig(withRepo, { presenterPort: 4321 });
    const fromRepo = loadDeploymentConfig({ env: { HOME: emptyHome }, repoDir: withRepo });
    check('a repo-local config file supplies the port', fromRepo.presenterPort === 4321, JSON.stringify(fromRepo));
    check('...and reports where it came from', fromRepo.configSource === 'repo' && fromRepo.configPath === join(withRepo, CONFIG_BASENAME));

    // 3. Resolution order, declared and inspectable: env > repo > xdg > built-in.
    const xdgDir = join(xdgOnly, 'argus-presenter');
    mkdirSync(xdgDir, { recursive: true });
    writeConfig(xdgDir, { presenterPort: 5555 });
    const xdgEnv = { HOME: emptyHome, XDG_CONFIG_HOME: xdgOnly };
    check('XDG config is used when the checkout has none', loadDeploymentConfig({ env: xdgEnv, repoDir: emptyRepo }).presenterPort === 5555);
    check('the checkout beats the user config (nearest wins)', loadDeploymentConfig({ env: xdgEnv, repoDir: withRepo }).presenterPort === 4321);
    const explicitPath = writeConfig(explicitDir, { presenterPort: 6789 });
    const explicitEnv = { ...xdgEnv, PRESENTER_CONFIG_FILE: explicitPath };
    const fromEnv = loadDeploymentConfig({ env: explicitEnv, repoDir: withRepo });
    check('an explicit PRESENTER_CONFIG_FILE beats both', fromEnv.presenterPort === 6789 && fromEnv.configSource === 'env', JSON.stringify(fromEnv));
    const order = deploymentConfigCandidates({ env: explicitEnv, repoDir: withRepo }).map((c) => c.configSource);
    check('the order is inspectable: env, repo, xdg', JSON.stringify(order) === JSON.stringify(['env', 'repo', 'xdg']), JSON.stringify(order));
    check('...and HOME/.config is the XDG fallback', deploymentConfigCandidates({ env: { HOME: '/nowhere' } })
      .some((c) => c.configPath === join('/nowhere', '.config', 'argus-presenter', CONFIG_BASENAME)));

    // 4. A BROKEN config is loud. Silently falling back to defaults is the anti-pattern this
    //    whole phase exists to kill: a broken thing reporting success.
    const badDir = scratch();
    writeFileSync(join(badDir, CONFIG_BASENAME), '{ not json');
    let threw = null;
    try { loadDeploymentConfig({ env: { HOME: emptyHome }, repoDir: badDir }); } catch (e) { threw = e; }
    check('unparseable config throws, naming the file', threw && /not valid JSON/.test(threw.message) && threw.message.includes(badDir), String(threw && threw.message));
    threw = null;
    try { loadDeploymentConfig({ env: { HOME: emptyHome, PRESENTER_CONFIG_FILE: join(badDir, 'absent.json') }, repoDir: emptyRepo }); } catch (e) { threw = e; }
    check('an explicit path that does not exist throws rather than falling through', threw && /does not exist/.test(threw.message), String(threw && threw.message));
    threw = null;
    try { presenterPort({ env: { HOME: emptyHome }, repoDir: (() => { const d = scratch(); writeConfig(d, { presenterPort: 'three thousand' }); return d; })() }); } catch (e) { threw = e; }
    check('a non-numeric port throws rather than binding something surprising', threw && /whole number/.test(threw.message), String(threw && threw.message));
    rmSync(badDir, { recursive: true, force: true });

    // 5. SHAPE — more than one key. P16.2 stores the durable-log path in this same file, so an
    //    unknown key must survive the loader untouched (and an older checkout must not choke).
    const multi = scratch();
    writeConfig(multi, { presenterPort: 4321, somethingP162WillAdd: '/var/log/x' });
    const m = loadDeploymentConfig({ env: { HOME: emptyHome }, repoDir: multi });
    check('unknown keys are carried through, not dropped or fatal', m.somethingP162WillAdd === '/var/log/x' && m.presenterPort === 4321);
    rmSync(multi, { recursive: true, force: true });

    // 6. THE MCP SURFACE — the four sites move together. The schema the AI reads must state the
    //    port the handler actually uses, and no bare 4300 may survive in the code.
    check('AP_STANDARD_PORT is the CONFIGURED port, not a literal', AP_STANDARD_PORT === presenterPort(), `${AP_STANDARD_PORT} vs ${presenterPort()}`);
    const desc = (TOOL.presenter_start && TOOL.presenter_start.input.properties.port.description) || '';
    check('the tool schema advertises that same default', desc.includes(String(AP_STANDARD_PORT)), desc);
    check('...and no longer advertises 4300 unless that IS the configured port', !/4300/.test(desc) || AP_STANDARD_PORT === 4300, desc);
    const code = readFileSync(join(REPO_ROOT, 'mcp', 'tools.mjs'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')       // block comments: the history of 4300 belongs there
      .replace(/^[ \t]*\/\/.*$/gm, '');
    check('no 4300 literal survives in tools.mjs CODE', !/4300/.test(code),
      (code.match(/^.*4300.*$/m) || [''])[0].trim());

    // 7. THE HANDLER really reads it. Config says 0 ⇒ the OS assigns; the old code would have
    //    bound the constant. Nothing here goes near 3000.
    const zeroDir = scratch();
    writeConfig(zeroDir, { presenterPort: 0 });
    const prevCfg = process.env.PRESENTER_CONFIG_FILE;
    process.env.PRESENTER_CONFIG_FILE = join(zeroDir, CONFIG_BASENAME);
    let T2 = null;
    try {
      T2 = await freshTools();
      check('a fresh import resolves the default from the config file', T2.AP_STANDARD_PORT === 0, String(T2.AP_STANDARD_PORT));
      const started = await T2.toolMap({ voiceEnabled: false }).presenter_start.handler({ voice: false, tunnel: false });
      const bound = Number(new URL(started.url).port);
      check('presenter_start with NO port argument uses the configured default', bound > 0 && bound !== 3000 && bound !== 4300, started.url);
      await T2.toolMap({ voiceEnabled: false }).presenter_stop.handler({ tunnel: false });
    } finally {
      if (T2) T2._resetForTests();
      if (prevCfg == null) delete process.env.PRESENTER_CONFIG_FILE; else process.env.PRESENTER_CONFIG_FILE = prevCfg;
      rmSync(zeroDir, { recursive: true, force: true });
    }
  } finally {
    for (const d of [emptyRepo, emptyHome, withRepo, xdgOnly, explicitDir]) rmSync(d, { recursive: true, force: true });
  }
});

// ── t48 ──────────────────────────────────────────────────────────────────────────────────────
test('0522 t48 — a failed public probe after raising the ingress is a FAILED START', async () => {
  const dir = scratch();
  const cfgDir = scratch();
  writeConfig(cfgDir, { presenterPort: 0 });
  const prevCfg = process.env.PRESENTER_CONFIG_FILE;
  process.env.PRESENTER_CONFIG_FILE = join(cfgDir, CONFIG_BASENAME);
  const unit = fakeUnit(dir);
  let T = null;
  try {
    // The ingress comes UP, and the address a participant opens refuses. That is exactly
    // 2026-07-30 with a 502 instead of a refusal: the unit is fine, the target is wrong.
    const dead = await deadPublic();
    setTunnelEnv({ ...unit, PRESENTER_PUBLIC_URL: dead });
    T = await freshTools();
    const tools = T.toolMap({ voiceEnabled: false });
    const failed = await tools.presenter_start.handler({ port: 0, voice: false, tunnelTimeoutMs: 1200 });

    check('the ingress really was raised (this is not a start-command failure)',
      failed.tunnel && failed.tunnel.active === true, JSON.stringify(failed.tunnel));
    check('the start is reported as FAILED, in the field a caller branches on', failed.ok === false, JSON.stringify({ ok: failed.ok, startFailed: failed.startFailed }));
    check('...and it is an error, not a warning hung off a success',
      typeof failed.error === 'string' && failed.error.length > 0 && failed.warning === undefined, JSON.stringify({ error: failed.error, warning: failed.warning }));
    check('...naming the only diagnosis available without dashboard access',
      /ingress target does not match the configured port/i.test(failed.error || ''), failed.error);
    check('...and the unreachable address, so the human can check it', (failed.error || '').includes(dead) || failed.publicUrl === dead, JSON.stringify({ publicUrl: failed.publicUrl }));
    check('the local bind is still reported, so the session is recoverable', /^http:\/\/127\.0\.0\.1:\d+$/.test(failed.url || ''), failed.url);
    await tools.presenter_stop.handler({});
    T._resetForTests();

    // THE CONVERSE — a probe that answers must still be a success, or the fix is just "always
    // fail" and the tool becomes unusable.
    const live = await fakePublic(200);
    try {
      setTunnelEnv({ ...unit, PRESENTER_PUBLIC_URL: live.url });
      T = await freshTools();
      const ok = await T.toolMap({ voiceEnabled: false }).presenter_start.handler({ port: 0, voice: false, tunnelTimeoutMs: 8000 });
      check('a public url that ANSWERS is still a successful start', ok.ok === true && !ok.error, JSON.stringify({ ok: ok.ok, error: ok.error }));
      check('...and still carries the address a participant opens', ok.publicUrl === live.url, ok.publicUrl);
      await T.toolMap({ voiceEnabled: false }).presenter_stop.handler({});
    } finally { await live.close(); }
  } finally {
    if (T) T._resetForTests();
    setTunnelEnv({});
    if (prevCfg == null) delete process.env.PRESENTER_CONFIG_FILE; else process.env.PRESENTER_CONFIG_FILE = prevCfg;
    rmSync(dir, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
  }
});
