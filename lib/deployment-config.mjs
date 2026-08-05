/*
 * lib/deployment-config.mjs — the LOCAL DEPLOYMENT CONFIG FILE (Plan 0522 P16.1, R1).
 * SERVER-SIDE ONLY (reads the filesystem). Nothing here reaches the browser.
 *
 * WHY THIS EXISTS. The MCP-driven port was a code constant (`AP_STANDARD_PORT = 4300`), and it was
 * WRONG for this deployment. Observed cold 2026-07-30: `presenter_start` bound 127.0.0.1:4300,
 * answered 200 locally, raised the tunnel, reported `active: true` — and the public url returned
 * 502, because this deployment's public ingress forwards to 3000. The tool reported success while
 * no human could reach the session. A port that has to match something OUTSIDE the repo is
 * deployment configuration, not source. It belongs in a file the deployment owns. (Core names no
 * vendor and no hostname — same rule as mcp/tunnel.mjs.)
 *
 * The intent of the constant it replaces is PRESERVED, not dropped: "never let presenter_start
 * default to a random port again". A config file supplies a STABLE, DECLARED port. The declaration
 * simply moved to where the deployment can state it.
 *
 * ── RESOLUTION ORDER (first file found wins; the whole file, not key-by-key) ─────────────────
 *   1. $PRESENTER_CONFIG_FILE      explicit path. If set, it MUST exist and parse — an explicit
 *                                  path that silently falls through is how a deployment ends up
 *                                  running on defaults it never chose.
 *   2. <repo>/presenter-config.json          the checkout's own config. GITIGNORED — local values
 *                                  are never committed; `presenter-config.example.json` is.
 *   3. ${XDG_CONFIG_HOME:-~/.config}/argus-presenter/presenter-config.json     the user's config.
 *   4. built-in defaults           NO FILE IS REQUIRED. A fresh checkout runs, on port 3000.
 *
 * Nearest-wins (explicit > checkout > user > built-in) is the eslint/npm convention: the more
 * specific statement about THIS deployment beats the more general one.
 *
 * ⚠ A found file that does not parse is a LOUD failure, never a silent fall-back to defaults.
 * Falling back would reproduce the very anti-pattern this phase exists to kill: a broken thing
 * reporting success.
 *
 * ⚠ SHAPE: more than one key, by design. P16.2 adds the durable session-log path here and reads it
 * through this same loader. Unknown keys are carried through untouched, so a newer config file
 * against an older checkout degrades to "that key is ignored", not to a crash.
 *
 * Callers resolve ONCE at startup (there is no cache here on purpose — a hot-reloading config is
 * a second lifetime nobody asked for; see plan 0522 §6.3 on persistence sprawl).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));

/** The checkout this module lives in — the repo-local candidate is resolved against it. */
export const REPO_ROOT = join(LIB_DIR, '..');

/** One basename in every location, so a config file is recognisable wherever it is found. */
export const CONFIG_BASENAME = 'presenter-config.json';

/**
 * Built-in defaults — what a checkout with NO config file anywhere runs on.
 * `presenterPort: 3000` is R1: the port the deployment's public ingress actually targets.
 *
 * Plan 0543 P1 — the AUTH POLICY dial. Two keys, both deployment config:
 *   enforceOAuth ∈ {'off','control'}   governs the CONTROL PAGE only (drive-the-presentation).
 *                                       It NEVER governs command-trust (trust:self), which is
 *                                       always identity-gated (loopback / OIDC / tailscale).
 *       'off'     (default) — password OR a verified identity may open the Control page.
 *       'control'          — the Control page requires a verified+allowlisted principal
 *                             (the password is retired for control); requires a break-glass
 *                             credential configured, or the server refuses to start (P3 gate).
 *   allowPasswordCommandOnLAN : boolean (default false) — an explicitly-unsafe escape hatch that
 *       lets a password-holder command Argus ONLY from a non-loopback private-LAN address with NO
 *       forwarding header (never over the tunnel). Off unless a deployer knowingly wants it.
 */
export const AUTH_POLICY_DEFAULTS = Object.freeze({ enforceOAuth: 'off', allowPasswordCommandOnLAN: false });
export const ENFORCE_OAUTH_VALUES = Object.freeze(['off', 'control']);
export const DEPLOYMENT_DEFAULTS = Object.freeze({ presenterPort: 3000, ...AUTH_POLICY_DEFAULTS });

const trimmed = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;

/**
 * Validate + normalize the auth-policy pair. THROWS on an unknown value — no silent default (P1):
 * a config that sets enforceOAuth to a typo would otherwise fall through to 'off' and quietly run
 * a policy the deployer never chose. Callable on raw config values (config-load path) or on
 * createServer options (the startup path); both must reject the same way.
 */
export function normalizeAuthPolicy({ enforceOAuth, allowPasswordCommandOnLAN } = {}, where = '(auth policy)') {
  const eo = (enforceOAuth === undefined || enforceOAuth === null) ? AUTH_POLICY_DEFAULTS.enforceOAuth : enforceOAuth;
  if (!ENFORCE_OAUTH_VALUES.includes(eo)) {
    throw new Error(`enforceOAuth in ${where} must be one of ${JSON.stringify(ENFORCE_OAUTH_VALUES)}, got ${JSON.stringify(enforceOAuth)}`);
  }
  const lan = (allowPasswordCommandOnLAN === undefined || allowPasswordCommandOnLAN === null) ? AUTH_POLICY_DEFAULTS.allowPasswordCommandOnLAN : allowPasswordCommandOnLAN;
  if (typeof lan !== 'boolean') {
    throw new Error(`allowPasswordCommandOnLAN in ${where} must be a boolean, got ${JSON.stringify(allowPasswordCommandOnLAN)}`);
  }
  return { enforceOAuth: eo, allowPasswordCommandOnLAN: lan };
}

/**
 * The DECLARED auth policy for this deployment, read from the config file (or built-in defaults),
 * validated. CLI + MCP pass this into createServer so `node app/server.mjs` and presenter_start
 * agree on the policy the same way they already agree on the port.
 */
export function authPolicy(opts = {}) {
  const cfg = loadDeploymentConfig(opts);
  return normalizeAuthPolicy(cfg, cfg.configPath || '(built-in defaults)');
}

/**
 * The candidate paths, in resolution order. Exported so the order is INSPECTABLE (and testable)
 * rather than buried in a loop. `required:true` marks the explicit path, which may not be missed.
 */
export function deploymentConfigCandidates({ env = process.env, repoDir = REPO_ROOT } = {}) {
  const out = [];
  const explicit = trimmed(env.PRESENTER_CONFIG_FILE);
  if (explicit) out.push({ configPath: resolve(explicit), configSource: 'env', required: true });
  out.push({ configPath: join(repoDir, CONFIG_BASENAME), configSource: 'repo', required: false });
  const xdgHome = trimmed(env.XDG_CONFIG_HOME)
    || join(trimmed(env.HOME) || homedir(), '.config');
  out.push({ configPath: join(xdgHome, 'argus-presenter', CONFIG_BASENAME), configSource: 'xdg', required: false });
  return out;
}

/**
 * Read the deployment config. Returns the merged values plus WHERE they came from:
 *   { ...DEPLOYMENT_DEFAULTS, ...fileValues, configPath, configSource }
 * `configSource` is 'env' | 'repo' | 'xdg' | 'built-in'; `configPath` is null for 'built-in'.
 * `env` / `repoDir` are injectable so a test can resolve against a throwaway tree.
 */
export function loadDeploymentConfig({ env = process.env, repoDir = REPO_ROOT } = {}) {
  for (const c of deploymentConfigCandidates({ env, repoDir })) {
    if (!existsSync(c.configPath)) {
      if (c.required) throw new Error(`PRESENTER_CONFIG_FILE points at ${c.configPath}, which does not exist`);
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(readFileSync(c.configPath, 'utf8')); }
    catch (e) { throw new Error(`deployment config ${c.configPath} is not valid JSON: ${(e && e.message) || e}`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`deployment config ${c.configPath} must be a JSON object`);
    }
    return { ...DEPLOYMENT_DEFAULTS, ...parsed, configPath: c.configPath, configSource: c.configSource };
  }
  return { ...DEPLOYMENT_DEFAULTS, configPath: null, configSource: 'built-in' };
}

/**
 * The DECLARED port for this deployment. Absent any config file ⇒ 3000.
 * A port that is not a whole number in 0..65535 is a configuration error and says so — 0 is legal
 * and means "let the OS assign one" (what the tests use).
 */
export function presenterPort(opts = {}) {
  const cfg = loadDeploymentConfig(opts);
  const p = cfg.presenterPort;
  if (!Number.isInteger(p) || p < 0 || p > 65535) {
    throw new Error(`presenterPort in ${cfg.configPath || '(built-in defaults)'} must be a whole number 0..65535, got ${JSON.stringify(p)}`);
  }
  return p;
}
