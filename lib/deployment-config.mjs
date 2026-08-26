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
 * ⚠⚠ THE WHOLE-FILE TRAP HAS A SECOND VICTIM (Plan 0551 P1). Resolution is WHOLE-FILE, first found
 * wins — NOT key-by-key. A repo-local presenter-config.json that sets only `presenterPort` makes an
 * ~/.config file containing the `oidc` block INVISIBLE: the second file is never opened, OIDC boots
 * INACTIVE, /auth/login answers 404, and nothing says why. Keep EVERY key you care about — port,
 * sessionLogDir, enforceOAuth, oidc, allowlist — in the SAME file. The startup line emitted by
 * identityStartupLine() states which file won and whether OIDC came up, so the trap is audible.
 *
 * Callers resolve ONCE at startup (there is no cache here on purpose — a hot-reloading config is
 * a second lifetime nobody asked for; see plan 0522 §6.3 on persistence sprawl).
 */
import {
  readFileSync, existsSync, writeFileSync, renameSync, unlinkSync,
  openSync, closeSync, statSync, chownSync,
} from 'node:fs';
import { join, dirname, resolve, isAbsolute, sep } from 'node:path';
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

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * Plan 0650 — bindHosts: EXTRA LISTEN ADDRESSES, OPT-IN, WILDCARD REFUSED.
 *
 * WHY IT EXISTS. The tailnet identity path can only work if the server is LISTENING on the tailnet
 * address — a peer that can only reach 127.0.0.1 presents 127.0.0.1, and `tailscale whois` rightly
 * answers "peer not found". Binding loopback only therefore left `enforceOAuth:'control'` with a
 * single usable door: Google, over the PUBLIC tunnel. A control meant to reduce exposure was
 * mandating it. This lets a deployment state the extra address, and nothing else changes.
 *
 * ⛔⛔ ABSENT ⇒ LOOPBACK ONLY. The default does not move, and never should: the whole reason a
 * tailnet bind is safe is that the fabric is authenticated and private.
 * ⛔⛔ 0.0.0.0 / :: / '*' ARE REFUSED AT THE CONFIG BOUNDARY, loudly, by name. They are not a wider
 * version of the same idea — they are the open internet, and the distance between "the tailnet" and
 * "everyone" must not be one careless character.
 *
 * The literal token "tailnet" means "whatever `tailscale ip -4` says this node is", resolved at
 * startup, because that address is assigned by the coordination server and a deployment should not
 * have to hard-code something it does not own. Unresolvable ⇒ a warning and loopback only.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */
export const BIND_WILDCARDS = Object.freeze(['0.0.0.0', '::', '*', '0:0:0:0:0:0:0:0']);

export function normalizeBindHosts(bindHosts, where = '(built-in defaults)') {
  if (bindHosts === undefined || bindHosts === null) return null;
  const arr = Array.isArray(bindHosts) ? bindHosts : [bindHosts];
  const out = [];
  for (const raw of arr) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error(`bindHosts in ${where} must be a list of address strings (or the token "tailnet"), got ${JSON.stringify(raw)}`);
    }
    const h = raw.trim();
    if (BIND_WILDCARDS.includes(h)) {
      throw new Error(`bindHosts in ${where} names ${JSON.stringify(h)} — a WILDCARD BIND IS REFUSED. This option exists to reach an authenticated private fabric (the tailnet), not the open internet. Name the specific address, or the token "tailnet".`);
    }
    if (!out.includes(h)) out.push(h);
  }
  return out.length ? out : null;
}

/** The DECLARED extra bind addresses for this deployment. Absent ⇒ null ⇒ loopback only. */
export function bindHostsConfig(opts = {}) {
  const cfg = loadDeploymentConfig(opts);
  return normalizeBindHosts(cfg.bindHosts, cfg.configPath || '(built-in defaults)');
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * Plan 0551 P1 — IDENTITY IS DEPLOYMENT CONFIG, AND IT IS READ HERE.
 *
 * WHY THIS EXISTS. Plan 0543 shipped the whole OIDC mechanism — routes, adapter, fail-closed
 * allowlist, trust wiring — and it was UNREACHABLE. `createServer` accepted `oidc`/`allowlist`/
 * `tailscale`/`breakGlass`/`revokedNonceFile`; NOTHING could supply them. No env var, no MCP pass
 * list, and this loader did not read them, so `makeOidcAdapter(null)` set `active=false` and
 * /auth/login answered a clean 404 on a deployment that believed it had sign-in. 312 unit tests and
 * 100 component tests were green the whole time, because every criterion was satisfiable at the
 * code seam and none named the gesture a human makes. Verified cold 2026-08-08 on a phone.
 *
 * THE RULE THAT FOLLOWS: identity is DEPLOYMENT data, exactly like the port and the session-log dir.
 * It is read from the deployment's own file, on the box, by both launch paths — never from an MCP
 * tool argument. An agent that could name its own allowlist could authorize itself. (This is also
 * why the keys are deliberately absent from presenter_start's input schema; see
 * mcp/surface-coverage.mjs, where each is declined WITH a reason.)
 *
 * ⛔ AND THE OTHER RULE: PRESENT-BUT-INCOMPLETE IS A LOUD FAILURE, NEVER AN INERT BOOT (C6). A
 * config that names `oidc` and forgets one key is a deployment that INTENDS sign-in. Booting it
 * with sign-in silently off is the precise bug this plan exists to kill, so it throws by name.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The named startup error for a malformed identity block (C6). NAMED so a caller can tell
 * "your identity config is wrong" apart from "something threw during boot" — and so a human
 * reading a crash sees the category before they read the sentence.
 */
export class IdentityConfigError extends Error {
  constructor(message) { super(message); this.name = 'IdentityConfigError'; }
}

/**
 * The identity keys this loader reads and routes into createServer. EXPORTED because the Plan 0551
 * C7 regression guard enumerates from here and from the createServer signature — never from a list
 * hand-written in a test, which rots the moment a key is added.
 */
export const IDENTITY_KEYS = Object.freeze(['oidc', 'allowlist', 'tailscale', 'breakGlass', 'revokedNonceFile']);

/**
 * Every key an `oidc` block must carry, and why each is required — none is optional and none has a
 * safe default:
 *   clientId / clientSecret     the OAuth client. Without them there is no client at all.
 *   authEndpoint / tokenEndpoint  where the browser is sent, and where the code is exchanged.
 *   redirectUri                 must match the IdP's registered redirect EXACTLY, scheme and path.
 *   issuer                      checked against the ID token's `iss`. Absent, verifyIdToken SKIPS
 *                               the issuer check — a silent security weakening, so it is required.
 *   jwksUri                     ⚠ plan 0551 §5 says "JWKS is fetched by the adapter's own deps",
 *                               which is not the whole truth: defaultOidcDeps().fetchJwks reads
 *                               `config.jwksUri`. Absent, the callback fails at 'jwks-failed' AFTER
 *                               a successful Google sign-in — the worst place to discover it. Core
 *                               may not default it either: this repo names no vendor and no
 *                               hostname (same rule as mcp/tunnel.mjs), so the deployment states it.
 */
export const OIDC_REQUIRED_KEYS = Object.freeze(['clientId', 'clientSecret', 'authEndpoint', 'tokenEndpoint', 'redirectUri', 'issuer', 'jwksUri']);
/** Of those, the ones that must parse as absolute URLs — a typo here is otherwise a runtime 404. */
export const OIDC_URL_KEYS = Object.freeze(['authEndpoint', 'tokenEndpoint', 'redirectUri', 'jwksUri']);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Validate + normalize an `oidc` block. Absent (undefined/null) ⇒ null: OIDC is OPT-IN and a
 * deployment that never mentions it is not misconfigured. Present ⇒ COMPLETE or throw (C6).
 * Unknown keys (e.g. `scope`) are carried through — makeOidcAdapter reads `scope` if present.
 */
export function normalizeOidcConfig(oidc, where = '(built-in defaults)') {
  if (oidc === undefined || oidc === null) return null;
  if (!isPlainObject(oidc)) {
    throw new IdentityConfigError(`oidc in ${where} must be a JSON object (or absent), got ${JSON.stringify(oidc)}`);
  }
  const missing = OIDC_REQUIRED_KEYS.filter((k) => !nonEmptyString(oidc[k]));
  if (missing.length) {
    throw new IdentityConfigError(
      `oidc in ${where} is PRESENT BUT INCOMPLETE — missing or empty: ${missing.join(', ')}. ` +
      `An oidc block means this deployment intends sign-in, so booting with sign-in silently off ` +
      `(/auth/login answering 404) is refused. Required keys: ${OIDC_REQUIRED_KEYS.join(', ')}. ` +
      `Remove the whole oidc block to run without sign-in on purpose. See presenter-config.example.json.`);
  }
  for (const k of OIDC_URL_KEYS) {
    try { new URL(oidc[k]); }
    catch (e) { throw new IdentityConfigError(`oidc.${k} in ${where} must be an absolute URL, got ${JSON.stringify(oidc[k])}`); }
  }
  const out = {};
  for (const [k, v] of Object.entries(oidc)) out[k] = (typeof v === 'string') ? v.trim() : v;
  return out;
}

/**
 * Validate + normalize the allowlist: `{ key: {role, voice?} }` or the shorthand `{ key: 'role' }`.
 * Output entries ALWAYS carry both `role` and a boolean `voice` (default false, fail-closed).
 * Keys are trimmed + lowercased HERE so that what this loader counts and what makeAllowlist()
 * matches are the same set — a key that differs only in case must not be a silent non-match.
 * Absent ⇒ null. `{}` is LEGAL and means "nobody is authorized" (fail-closed), not an error.
 */
export function normalizeAllowlistConfig(allowlist, where = '(built-in defaults)') {
  if (allowlist === undefined || allowlist === null) return null;
  if (!isPlainObject(allowlist)) {
    throw new IdentityConfigError(`allowlist in ${where} must be a JSON object mapping "email-or-tailnet-user" to {"role":"presenter"} (or absent), got ${JSON.stringify(allowlist)}`);
  }
  const out = {};
  for (const [rawKey, v] of Object.entries(allowlist)) {
    const key = String(rawKey).trim().toLowerCase();
    if (!key) throw new IdentityConfigError(`allowlist in ${where} has an empty key — an entry nobody can match is a typo, not a policy`);
    const role = isPlainObject(v) ? v.role : v;
    if (!nonEmptyString(role)) {
      throw new IdentityConfigError(`allowlist entry "${key}" in ${where} must be {"role":"<role>"} or the shorthand "<role>", got ${JSON.stringify(v)} — an entry with no role authorizes nothing and would be silently dropped`);
    }
    /* ⛔⛔ `voice` MUST BE CARRIED THROUGH HERE. This normalizer used to return `{role}` only, so a
     *   config saying {"role":"presenter","voice":true} was validated, counted, logged as a healthy
     *   2-entry allowlist — and arrived at makeAllowlist() with the voice key ALREADY DELETED.
     *   identity.mjs then computed `v.voice === true` ⇒ false, and the grant was refused for a
     *   correctly-configured presenter. Config and consumer were each right; the layer between them
     *   silently dropped the field. Nothing failed, nothing logged: the mic just never appeared.
     *   Cost a full debugging session on 2026-08-25. ⇒ A KEY THIS FUNCTION DOES NOT KNOW ABOUT IS A
     *   KEY THE DEPLOYMENT DOES NOT HAVE. Adding a capability to identity.mjs means adding it here. */
    const voice = isPlainObject(v) ? v.voice : undefined;
    if (voice !== undefined && typeof voice !== 'boolean') {
      throw new IdentityConfigError(`allowlist entry "${key}" in ${where} has voice ${JSON.stringify(voice)} — must be the boolean true or false. The STRING "true" is not true, and a capability that silently reads as false is the bug this check exists to prevent`);
    }
    out[key] = { role: role.trim(), voice: voice === true };
  }
  return out;
}

/** Validate + normalize the tailscale block. Absent ⇒ null. Only `enabled` is meaningful today. */
export function normalizeTailscaleConfig(tailscale, where = '(built-in defaults)') {
  if (tailscale === undefined || tailscale === null) return null;
  if (!isPlainObject(tailscale)) {
    throw new IdentityConfigError(`tailscale in ${where} must be a JSON object like {"enabled":true} (or absent), got ${JSON.stringify(tailscale)}`);
  }
  if (tailscale.enabled !== undefined && typeof tailscale.enabled !== 'boolean') {
    throw new IdentityConfigError(`tailscale.enabled in ${where} must be a boolean, got ${JSON.stringify(tailscale.enabled)}`);
  }
  return { ...tailscale, enabled: tailscale.enabled === true };
}

/**
 * Validate + normalize the break-glass credential. Absent ⇒ null. Present ⇒ must actually carry a
 * credential (`token` or `file`), because createServer's enforceOAuth='control' gate tests for
 * exactly that — an empty `{}` here would pass a config review and fail the startup gate.
 */
export function normalizeBreakGlassConfig(breakGlass, where = '(built-in defaults)') {
  if (breakGlass === undefined || breakGlass === null) return null;
  if (!isPlainObject(breakGlass)) {
    throw new IdentityConfigError(`breakGlass in ${where} must be a JSON object like {"file":"/path/to/break-glass"} (or absent), got ${JSON.stringify(breakGlass)}`);
  }
  if (!nonEmptyString(breakGlass.token) && !nonEmptyString(breakGlass.file)) {
    throw new IdentityConfigError(`breakGlass in ${where} must carry a non-empty "token" or "file" — an empty break-glass block is not a recovery credential, and enforceOAuth:"control" would refuse to start`);
  }
  return { ...breakGlass };
}

/** Validate the durable revoked-nonce store path. Absent ⇒ null (the launch paths derive one). */
export function normalizeRevokedNonceFileConfig(revokedNonceFile, where = '(built-in defaults)') {
  if (revokedNonceFile === undefined || revokedNonceFile === null) return null;
  if (!nonEmptyString(revokedNonceFile)) {
    throw new IdentityConfigError(`revokedNonceFile in ${where} must be a non-empty path string (or absent), got ${JSON.stringify(revokedNonceFile)}`);
  }
  return revokedNonceFile.trim();
}

/** The per-key normalizers, keyed by the createServer option they produce. */
const IDENTITY_NORMALIZERS = Object.freeze({
  oidc: normalizeOidcConfig,
  allowlist: normalizeAllowlistConfig,
  tailscale: normalizeTailscaleConfig,
  breakGlass: normalizeBreakGlassConfig,
  revokedNonceFile: normalizeRevokedNonceFileConfig,
});

/**
 * Validate + normalize every identity key of a raw config object. Callable on config-file values
 * (the load path) or on createServer options, so both reject identically — the same rule
 * normalizeAuthPolicy follows.
 */
export function normalizeIdentity(cfg = {}, where = '(built-in defaults)') {
  const out = {};
  for (const k of IDENTITY_KEYS) out[k] = IDENTITY_NORMALIZERS[k](cfg ? cfg[k] : undefined, where);
  return out;
}

/**
 * The DECLARED identity configuration for this deployment, read from the config file (or built-in
 * defaults = all null), validated. The CLI self-run and presenter_start both call THIS, so
 * `node app/server.mjs` and the MCP tool cannot disagree about who may sign in (C4).
 *
 * Returns the five keys plus `configPath`/`configSource`, so a caller can say WHICH file won —
 * the whole-file resolution trap is otherwise invisible.
 */
export function identityConfig(opts = {}) {
  const cfg = loadDeploymentConfig(opts);
  const where = cfg.configPath || '(built-in defaults)';
  return { ...normalizeIdentity(cfg, where), configPath: cfg.configPath, configSource: cfg.configSource };
}

/**
 * Plan 0551 P2 — THE ONE ROUTER. Turn a resolved identity config into createServer() options,
 * skipping the keys the deployment did not state (so a caller-supplied default — e.g. the
 * revoked-nonce path both launch paths derive from the state dir — survives unless the config
 * overrides it).
 *
 * ⛓ BOTH LAUNCH PATHS CALL THIS ONE FUNCTION. `node app/server.mjs` and the presenter_start MCP
 * tool cannot drift apart about who may sign in, because there is only one place that decides
 * (C4). It iterates IDENTITY_KEYS, so a key added there is routed by both paths at once — and the
 * C7 guard fails if a key reaches createServer without arriving here.
 */
export function identityServerOptions(identity = {}) {
  const opts = {};
  for (const k of IDENTITY_KEYS) if (identity[k] !== undefined && identity[k] !== null) opts[k] = identity[k];
  return opts;
}

/**
 * Every createServer() option that is DEPLOYMENT CONFIG ONLY: resolved from the deployment's file
 * by both launch paths, and never a caller/agent knob. The Plan 0551 C7 guard asserts this set
 * equals the set of options marked `deploymentOnly:true` in mcp/surface-coverage.mjs, and that
 * none of them appears in presenter_start's input schema.
 *
 * ⛔ `port` is NOT here: its DEFAULT comes from this file (presenterPort()), but it is a legitimate
 * per-call argument, so it is a caller knob whose default is deployment config — a different thing.
 */
export const DEPLOYMENT_ROUTED_OPTIONS = Object.freeze([
  'sessionLogDir', 'enforceOAuth', 'allowPasswordCommandOnLAN', 'bindHosts', ...IDENTITY_KEYS,
]);

/**
 * The one-line startup summary. ⛔ STATE ONLY — whether OIDC came up, and HOW MANY allowlist
 * entries there are. NEVER the allowlist's contents, never the client id, never the secret: this
 * line goes to a log ring that /api/debug can serve.
 *
 * It exists because INERT MUST BE VISIBLE FROM THE OUTSIDE. 0543's failure was legible nowhere:
 * the server started, said nothing about identity, and answered 404 to the one route that mattered.
 */
export function identityStartupLine(identity = {}) {
  const where = identity.configPath || '(built-in defaults — no config file found)';
  const size = identity.allowlist ? Object.keys(identity.allowlist).length : 0;
  const oidc = identity.oidc
    ? 'OIDC sign-in ACTIVE'
    : 'OIDC sign-in INACTIVE (no oidc block) — /auth/login will 404 and no sign-in control is shown';
  const list = identity.allowlist
    ? `allowlist ${size} ${size === 1 ? 'entry' : 'entries'}${size === 0 ? ' (fail-closed: nobody is authorized to command)' : ''}`
    : 'allowlist ABSENT (fail-closed: nobody is authorized to command)';
  const ts = (identity.tailscale && identity.tailscale.enabled) ? ' · tailscale identity ON' : '';
  return `identity: ${oidc} · ${list}${ts} · from ${where}`;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * Plan 0675 (phase 0 of 0674) — ROOMS: A CONTEXT IS A ROOM, AND A ROOM'S CAPABILITIES ARE CONFIG.
 *
 * ⭐ THIS BLOCK IS DELIBERATELY INERT. It adds a SCHEMA, a WRITER and a STARTUP LINE. Nothing here
 * decides which plugins load, what is recorded, or which port/host is bound — phases 1–2 wire that
 * up. A reader who expects `rooms` to change behaviour today is reading the wrong phase. (Branch by
 * abstraction: build the seam first, switch over later.)
 *
 * THE SHAPE:
 *     "rooms": {
 *       "<room-name>": { "port": 3001, "bindHosts": ["loopback","tailnet"],
 *                        "plugins": ["ops-console"], "record": "none", "voice": false,
 *                        "label": "the table" }
 *     },
 *     "defaultRoom": { "plugins": [], "record": "none", "voice": false }
 *
 * ⚠ ROOM NAMES AND PLUGIN NAMES ARE THE DEPLOYMENT'S STRINGS, NEVER THIS FILE'S. The names above
 * are placeholders and must stay placeholders: core names no vendor, no hostname and no game —
 * the same rule mcp/tunnel.mjs follows — and two repo-wide guards (t0514-28 over the core
 * directories, t0531-01 over every tracked file) fail if a real one is written here. See
 * test/BASELINE-0675.md §3: both guards were ALREADY RED at this phase's baseline, so a new
 * offence would not move them pass→fail and the ordinary green check would never see it.
 *
 * ── THE DEFECT THIS SCHEMA EXISTS TO PREVENT, in full, because it already happened ─────────────
 * On 2026-08-25 (`61588c0`) the ALLOWLIST normalizer rebuilt `{role, voice}` as `{role}`. The
 * config was right and the consumer was right; the layer between them deleted the capability.
 * Nothing threw, nothing logged, and a correctly-configured presenter simply had no microphone. It
 * cost a full debugging session. Three rules follow, and they are ENFORCED below rather than
 * remembered:
 *
 *   1. ⛔ NEVER REBUILD A ROOM OBJECT FROM A KNOWN FIELD LIST. Spread the whole entry, overlay the
 *      validated keys. A key this file does not know about is still the deployment's key. (G2.)
 *   2. ⛔ A WRONG-TYPED CAPABILITY THROWS BY NAME. `voice: "true"` is a string, and a string that
 *      silently reads as false is the exact shape of the bug above. So is `record: true`. (G3.)
 *   3. ⛔ ABSENT MEANS THE FAIL-CLOSED VALUE — `plugins: []`, `record: "none"`, `voice: false`.
 *      Never "inherit", never "whatever the other room had", never "whatever is on disk". (G1.)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The named startup error for a malformed `rooms` / `defaultRoom` block, an unresolvable
 * `PRESENTER_ROOM`, or a refused config write. NAMED for the same reason IdentityConfigError is: a
 * human reading a crash should see the CATEGORY before they read the sentence, and a caller should
 * be able to tell "your room config is wrong" apart from "something threw during boot".
 */
export class RoomConfigError extends Error {
  constructor(message) { super(message); this.name = 'RoomConfigError'; }
}

/** The env var naming which room section THIS process serves. Absent ⇒ `defaultRoom`. */
export const ROOM_ENV = 'PRESENTER_ROOM';

/**
 * Every key a normalized room carries. EXPORTED so tests and later phases enumerate from HERE
 * rather than from a hand-written list that rots the moment a capability is added.
 *
 * ⚠ This is the set of keys that are VALIDATED AND DEFAULTED. It is emphatically NOT the set of
 * keys a room may HAVE — unknown keys ride through untouched (rule 1 above).
 */
export const ROOM_KEYS = Object.freeze(['port', 'bindHosts', 'plugins', 'record', 'voice', 'label', 'profile', 'pluginsDir', 'transcriptDir']);

/**
 * The fail-closed value of every room key when the config does not state it (rule 3).
 * `port` / `bindHosts` / `label` are null — "not stated", which for a bind means loopback only and
 * for a port means "nothing in this phase binds from here anyway".
 *
 * A FUNCTION, not a frozen constant, so every room gets its OWN `plugins` array. Two rooms sharing
 * one array instance is a mutation aliasing bug waiting for phase 2 to write it.
 */
export function roomDefaults() {
  return { port: null, bindHosts: null, plugins: [], record: 'none', voice: false, label: null, profile: null, pluginsDir: null, transcriptDir: null };
}

/** `"none"`, or a retention duration like `30d` / `12h` / `90m`. Anything else is a typo. */
const RECORD_DURATION_RE = /^[1-9][0-9]*[smhdw]$/;

/**
 * Validate + normalize ONE room section. `where` names the file and `roomName` names the room, so
 * an error says WHICH of five rooms is wrong instead of leaving a human to bisect the file.
 *
 * Absent (undefined/null) ⇒ a full fail-closed room. That is deliberate, and it is what makes
 * `defaultRoom` optional: a deployment that names no default still gets `{plugins:[],
 * record:'none', voice:false}` rather than something inherited from elsewhere.
 */
/**
 * ⛔⛔ A ROOM PATH MAY NOT LIVE INSIDE THE RELEASE TREE. (Plan 0684 R2, and it applies to every
 * room path, not only the transcript one.)
 *
 * WHY, concretely. The deployment is a release pipeline that keeps TEN releases and prunes the
 * rest. `PRESENTER_TRANSCRIPT_DIR` defaulted to `join(__dirname, '..', '.transcripts')` — i.e.
 * INSIDE whichever release happens to be running. So enabling recording without setting it does
 * not fail: it works, visibly, writing transcripts into the current release; the next deploy
 * starts a NEW release with an empty directory, and the prune eventually DELETES the old one
 * along with everything recorded into it. Data loss that looks exactly like success at every
 * moment you might check.
 *
 * ⇒ A relative path is refused (it resolves against the process's cwd, which for a systemd unit
 * is whatever WorkingDirectory says — the release tree again), and so is any absolute path that
 * resolves inside this checkout.
 *
 * ⚠ The comparison is against `REPO_ROOT`, which IS the release tree for a deployed process
 * (`/srv/argus/current/...`) and is the checkout for a developer. Both are the right answer: in
 * neither case should durable data live in the code tree.
 */
function normalizeRoomPath(value, key, at) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RoomConfigError(`${at} has ${key} ${JSON.stringify(value)} — must be a non-empty absolute path string (or absent)`);
  }
  const raw = value.trim();
  if (!isAbsolute(raw)) {
    throw new RoomConfigError(`${at} has ${key} ${JSON.stringify(raw)} — must be an ABSOLUTE path. A relative one resolves against the process's working directory, which for a deployed unit is the release tree, and a release tree is pruned.`);
  }
  const abs = resolve(raw);
  if (abs === REPO_ROOT || abs.startsWith(REPO_ROOT + sep)) {
    throw new RoomConfigError(`${at} has ${key} ${JSON.stringify(raw)}, which is INSIDE the release tree (${REPO_ROOT}) — refused. The pipeline keeps 10 releases and prunes the rest, so anything stored there is deleted on a later deploy while appearing to work until then. Point it at durable storage outside the tree.`);
  }
  return abs;
}

export function normalizeRoomConfig(room, where = '(built-in defaults)', roomName = '(defaultRoom)') {
  const at = `room "${roomName}" in ${where}`;
  if (room !== undefined && room !== null && !isPlainObject(room)) {
    throw new RoomConfigError(`${at} must be a JSON object (or absent), got ${JSON.stringify(room)}`);
  }
  const src = room || {};
  const d = roomDefaults();

  /* port — absent ⇒ null. Present ⇒ a real, bindable port. ⚠ 0 is REFUSED here although
   * presenterPort() legitimately allows it: 0 means "let the OS choose", and a room's port is the
   * boundary other things address it by (the ingress rule, the sibling room's MCP target, the
   * smoke check). An ephemeral one cannot be any of those. */
  let port = d.port;
  if (src.port !== undefined && src.port !== null) {
    if (!Number.isInteger(src.port) || src.port < 1 || src.port > 65535) {
      throw new RoomConfigError(`${at} has port ${JSON.stringify(src.port)} — must be a whole number 1..65535 (0 is refused for a room: a room's port is an address other things must be able to name)`);
    }
    port = src.port;
  }

  /* bindHosts — THE SAME normalizer the deployment-wide key uses, so a wildcard bind is refused
   * here for exactly the reason it is refused there, and a room cannot become the wider door.
   * Absent ⇒ null ⇒ loopback only. */
  let bindHosts = d.bindHosts;
  if (src.bindHosts !== undefined && src.bindHosts !== null) {
    bindHosts = normalizeBindHosts(src.bindHosts, at);
  }

  /* plugins — an ARRAY OF STRINGS. ⛔ The bare string throws. It is the natural typo, and it is a
   * dangerous one: JavaScript iterates a string CHARACTER BY CHARACTER, so a room configured
   * `"plugins": "ops-console"` would load eleven plugins named `o`, `p`, `s`, … i.e. none at all,
   * fail-closed by accident, and report nothing. */
  let plugins = d.plugins;
  if (src.plugins !== undefined && src.plugins !== null) {
    if (!Array.isArray(src.plugins)) {
      throw new RoomConfigError(`${at} has plugins ${JSON.stringify(src.plugins)} — must be an ARRAY of plugin-name strings, e.g. ["ops-console"]. A bare string is not a one-element list; iterated, it is a list of its own characters`);
    }
    const seen = [];
    for (const p of src.plugins) {
      if (typeof p !== 'string' || !p.trim()) {
        throw new RoomConfigError(`${at} has a plugin entry ${JSON.stringify(p)} — every entry must be a non-empty plugin-name string`);
      }
      if (!seen.includes(p.trim())) seen.push(p.trim());
    }
    plugins = seen;
  }

  /* record — "none" or a duration. ⛔ `true` throws. A boolean reads as "on" to a human and as
   * neither a duration nor "none" to the code, and a retention policy nobody declared is how a
   * transcript outlives the consent that permitted it. */
  let record = d.record;
  if (src.record !== undefined && src.record !== null) {
    if (typeof src.record !== 'string' || (src.record !== 'none' && !RECORD_DURATION_RE.test(src.record))) {
      throw new RoomConfigError(`${at} has record ${JSON.stringify(src.record)} — must be the string "none" or a retention duration like "30d" (s|m|h|d|w). The BOOLEAN true is not a retention policy, and a capability that silently reads as false is the bug this check exists to prevent`);
    }
    record = src.record;
  }

  /* voice — a real boolean. ⛔ The STRING "true" throws. This is the `61588c0` trap, verbatim. */
  let voice = d.voice;
  if (src.voice !== undefined && src.voice !== null) {
    if (typeof src.voice !== 'boolean') {
      throw new RoomConfigError(`${at} has voice ${JSON.stringify(src.voice)} — must be the boolean true or false. The STRING "true" is not true, and a capability that silently reads as false is the bug this check exists to prevent`);
    }
    voice = src.voice;
  }

  /* profile — the BEHAVIOUR PROFILE this room runs under (0473's PROFILES table: floor control,
   * shedding, settling, digest). ⛔ VALIDATED AS A STRING HERE AND NOTHING MORE. Cross-checking the
   * name against the profile table is A4·R1's job, deliberately: `app/profiles.mjs` is a browser-
   * reachable app module and this is a server-side config reader, so importing it here to reject an
   * unknown name would couple the two for a check the phase that CONSUMES the profile must make
   * anyway. Absent ⇒ null, which means "this room states no profile" — never "inherit the default
   * profile", because a room silently running somebody else's floor policy is exactly G1's failure. */
  let profile = d.profile;
  if (src.profile !== undefined && src.profile !== null) {
    if (typeof src.profile !== 'string' || !src.profile.trim()) {
      throw new RoomConfigError(`${at} has profile ${JSON.stringify(src.profile)} — must be a non-empty profile-name string (or absent)`);
    }
    profile = src.profile.trim();
  }

  /* pluginsDir — WHERE this room's plugins are read from. Absent ⇒ null ⇒ the in-code default
   * (`<repo>/plugins`), which is the right answer for a checkout and is documented as the fallback
   * rather than the only source of truth (G13).
   *
   * ⚠ AND IT IS DELIBERATELY *NOT* HELD TO THE RELEASE-TREE RULE that `transcriptDir` is held to.
   * Plugins are CODE: they ship inside the release, `/srv/argus/current/plugins` is the correct
   * value on the live box, and refusing it would refuse the normal arrangement. The release-tree
   * prohibition exists for DURABLE DATA, which is destroyed by a prune. Code is replaced by one. */
  let pluginsDir = d.pluginsDir;
  if (src.pluginsDir !== undefined && src.pluginsDir !== null) {
    if (typeof src.pluginsDir !== 'string' || !src.pluginsDir.trim()) {
      throw new RoomConfigError(`${at} has pluginsDir ${JSON.stringify(src.pluginsDir)} — must be a non-empty path string (or absent)`);
    }
    pluginsDir = src.pluginsDir.trim();
  }

  /* transcriptDir — ⛔⛔ WHERE THE RECORDING GOES, AND IT MAY NOT BE THE RELEASE TREE. See
   * normalizeRoomPath above for the full defect. Absent ⇒ null, and a room that RECORDS with a
   * null transcript dir is refused at resolution (assertRecordingIsDurable) rather than quietly
   * defaulting into the code tree the way `PRESENTER_TRANSCRIPT_DIR` does today. */
  let transcriptDir = d.transcriptDir;
  if (src.transcriptDir !== undefined && src.transcriptDir !== null) {
    transcriptDir = normalizeRoomPath(src.transcriptDir, 'transcriptDir', at);
  }

  /* label — human-facing only, never load-bearing. Absent ⇒ null. */
  let label = d.label;
  if (src.label !== undefined && src.label !== null) {
    if (typeof src.label !== 'string' || !src.label.trim()) {
      throw new RoomConfigError(`${at} has label ${JSON.stringify(src.label)} — must be a non-empty string (or absent)`);
    }
    label = src.label.trim();
  }

  /* ⛔⛔ THE WHOLE-OBJECT ROUND-TRIP (G2). The spread comes FIRST and the validated keys are
   * overlaid on top, so every key this file has never heard of survives. Writing
   *     return { port, bindHosts, plugins, record, voice, label };
   * here would be `61588c0` re-committed under a new name — and it would LOOK tidier, which is
   * exactly why the rule has to be written down next to the code that obeys it. */
  return { ...src, port, bindHosts, plugins, record, voice, label, profile, pluginsDir, transcriptDir };
}

/**
 * Which of a room's keys the CONFIG stated, and which fell back to the fail-closed default.
 * Kept SEPARATE from the value so the startup line can say `voice=false(default)` — an invisible
 * resolution is the trap that cost 2026-08-25, and G12 exists to make it audible from outside.
 */
export function roomValueSources(room) {
  const src = isPlainObject(room) ? room : {};
  const out = {};
  for (const k of ROOM_KEYS) out[k] = (src[k] !== undefined && src[k] !== null) ? 'config' : 'default';
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * Plan 0684 R1 — THE CAPABILITY KEYS COME FROM THE CONFIG FILE, AND ENV IS A DOCUMENTED FALLBACK.
 *
 * WHY (guard G13, Bruce 2026-08-25): *"make sure that configurable stuff … is in the config file
 * and not hardcoded"*. Today `PRESENTER_PROFILE`, `PRESENTER_VOICE_ENABLED`, `PRESENTER_PLUGINS_DIR`,
 * `PRESENTER_TRANSCRIPT_DIR` and `PRESENTER_MCP_HTTP` live in a systemd unit's `Environment=` lines.
 * That is one process's capability set expressed in a place no second room can have its own copy of,
 * and it is invisible to anything that reads the deployment's config file. So the config file is
 * where a room states them, and the environment variable remains as the FALLBACK a deployment may
 * still use — documented, reported by source, and never silently preferred over the file.
 *
 * ⛔ PRECEDENCE IS config > env > fail-closed default, and the SOURCE OF EVERY VALUE IS REPORTED.
 * `voice false(default)` and `voice false(env)` are the same value and completely different facts;
 * 2026-08-25 turned on exactly that difference.
 *
 * ⛔⛔ AN ENV VALUE OF THE WRONG SHAPE THROWS BY NAME (G3). This is the whole point and it is where
 * the existing readers are weakest: `envVoiceEnabled()` is `/^(1|true|on|yes)$/i.test(...)`, so
 * `PRESENTER_VOICE_ENABLED=ture` — or `=TRUE ` with a stray space in a unit file, or `=enabled` —
 * reads as FALSE, silently, and the microphone is gone with no error anywhere. That is `61588c0`
 * arriving through a different door. Here an unrecognised token is a named startup error.
 *
 * ⛔ `record` HAS NO ENV FALLBACK, DELIBERATELY. It is a RETENTION POLICY ("none" | "30d"), not a
 * switch, and the nearest existing variable (`PRESENTER_TRANSCRIPT_PERSIST`) is a boolean. Mapping
 * a boolean onto a duration means INVENTING a retention nobody wrote down, and a transcript kept
 * for a period nobody declared is how it outlives the consent that permitted it. A deployment that
 * wants recording states the duration in the config file.
 *
 * ⚠ PHASE 0b IS STILL INERT. Nothing below is consumed for behaviour: the existing readers in
 * `app/server.mjs`, `mcp/server.mjs` and `harness/plugins.mjs` are untouched and still read their
 * own env vars directly. This layer RESOLVES AND REPORTS. The phase that wires each consumer is
 * the phase that gets to change what loads.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The capability keys this layer resolves, and the environment variable that may stand in for each.
 * ⛔ `record` is absent from this map ON PURPOSE — see the note above. `port`, `bindHosts` and
 * `label` are absent because they are not capabilities: two of them are the deployment-wide keys
 * that already have their own resolvers, and `label` is decoration.
 */
export const CAPABILITY_ENV = Object.freeze({
  profile: 'PRESENTER_PROFILE',
  voice: 'PRESENTER_VOICE_ENABLED',
  pluginsDir: 'PRESENTER_PLUGINS_DIR',
  transcriptDir: 'PRESENTER_TRANSCRIPT_DIR',
});

/** Every key `resolveRoomCapabilities` answers for, in startup-line order. */
export const CAPABILITY_KEYS = Object.freeze(['profile', 'voice', 'record', 'pluginsDir', 'transcriptDir']);

/** The tokens a boolean environment variable may use. Anything else is a typo, and typos throw. */
export const ENV_TRUE_TOKENS = Object.freeze(['1', 'true', 'on', 'yes', 'y', 'enabled']);
export const ENV_FALSE_TOKENS = Object.freeze(['0', 'false', 'off', 'no', 'n', 'disabled']);

/**
 * Parse ONE capability from its environment variable.
 * @returns the parsed value, or `undefined` when the variable is absent/blank (⇒ fall through to
 * the fail-closed default). ⛔ Never returns a coerced-from-garbage value: garbage throws.
 */
export function parseCapabilityEnv(key, raw) {
  const name = CAPABILITY_ENV[key];
  const v = trimmed(raw);
  if (v === null) return undefined;                     // unset, or set to empty — treated as unset

  if (key === 'voice') {
    const low = v.toLowerCase();
    if (ENV_TRUE_TOKENS.includes(low)) return true;
    if (ENV_FALSE_TOKENS.includes(low)) return false;
    throw new RoomConfigError(`${name}=${JSON.stringify(raw)} is not a boolean — use one of ${ENV_TRUE_TOKENS.join('/')} or ${ENV_FALSE_TOKENS.join('/')}. ⛔ REFUSING to read an unrecognised token as "off": a capability that silently reads as false is the 61588c0 defect, and a mistyped unit file is exactly how it arrives.`);
  }
  if (key === 'pluginsDir') return v;      /* a path, and NOT release-tree-checked — plugins are code, see above */
  if (key === 'transcriptDir') return normalizeRoomPath(v, key, `environment variable ${name}`);
  if (key === 'profile') return v;

  throw new RoomConfigError(`${key} has no environment fallback (see CAPABILITY_ENV)`);
}

/**
 * ⭐ RESOLVE A ROOM'S CAPABILITIES: config > env > fail-closed default, WITH the source of each.
 *
 * @param room    the NORMALIZED room (from `normalizeRoomConfig`).
 * @param sources `roomValueSources(rawRoom)` — which keys the CONFIG actually stated. It must be
 *                computed on the RAW room, because a normalized `record:'none'` / `voice:false` is
 *                indistinguishable from the fail-closed default by value alone.
 * @param env     the environment to read the fallbacks from.
 * @returns `{ values, sources }`, `sources[k] ∈ 'config' | 'env' | 'default'`.
 *
 * ⛔ NOTE THE SHAPE OF THE LOOP. It reads a declared key list and asks the SAME question of each,
 * rather than rebuilding an object field by field with per-key special cases — the difference
 * between a table and a hand-written constructor is the difference `61588c0` turned on.
 */
export function resolveRoomCapabilities(room, sources = {}, env = process.env) {
  const r = isPlainObject(room) ? room : roomDefaults();
  const d = roomDefaults();
  const values = {};
  const from = {};
  for (const k of CAPABILITY_KEYS) {
    if (sources[k] === 'config') { values[k] = r[k]; from[k] = 'config'; continue; }
    const envName = CAPABILITY_ENV[k];
    if (envName) {
      const fromEnv = parseCapabilityEnv(k, env && env[envName]);
      if (fromEnv !== undefined) { values[k] = fromEnv; from[k] = 'env'; continue; }
    }
    values[k] = (r[k] === undefined) ? d[k] : r[k];
    from[k] = 'default';
  }
  return { values, sources: from };
}

/**
 * ⛔⛔ Plan 0684 R2 — A ROOM THAT RECORDS MUST SAY WHERE, AND IT IS A NAMED STARTUP ERROR IF IT
 * DOES NOT.
 *
 * THE DEFECT, in full. `PRESENTER_TRANSCRIPT_DIR` defaults to `join(__dirname, '..',
 * '.transcripts')` — inside the release the process is running from. The pipeline keeps TEN
 * releases and prunes the rest. So a deployment that turns recording on and forgets the directory
 * does not fail: it writes transcripts, they appear, `presenter_health` reports the directory and a
 * growing count, and every check a human might make says it is working. The next deploy starts a
 * new release with an empty directory, and the prune eventually deletes the old one and everything
 * in it. There is no moment at which this looks broken.
 *
 * ⇒ RECORDING WITHOUT A DURABLE DESTINATION IS REFUSED. Not warned about — refused. A warning is
 * a line in a log nobody reads until the transcripts are already gone.
 *
 * ⚠ WHY IT IS CHECKED HERE AND NOT IN `normalizeRoomConfig`: the destination may legitimately come
 * from `$PRESENTER_TRANSCRIPT_DIR` (R1's documented fallback), and the schema normalizer is pure —
 * it never sees an environment. So the requirement is asserted at RESOLUTION, where config and env
 * have already been reconciled and the value that would actually be used is known.
 *
 * ⚠ AND ONLY FOR THE ROOM THIS PROCESS SERVES. A sibling room's transcript directory is that
 * process's business, and it will refuse to start for itself. Checking every declared room here
 * would mean one room's typo takes down a room that is configured correctly.
 */
export function assertRecordingIsDurable(values = {}, sources = {}, where = '(built-in defaults)', roomName = '(defaultRoom)') {
  const record = values.record;
  if (!record || record === 'none') return;              // not recording ⇒ nothing to require
  if (values.transcriptDir) return;                      // stated, and already path-validated
  throw new RoomConfigError(
    `room "${roomName}" in ${where} declares record ${JSON.stringify(record)} but names NO transcriptDir, ` +
    `and $${CAPABILITY_ENV.transcriptDir} is not set either. REFUSING to start. ` +
    `The in-code fallback resolves INSIDE the release tree (${REPO_ROOT}); the deploy pipeline keeps ten ` +
    `releases and prunes the rest, so recording there works — visibly, at every moment you might check — ` +
    `and is then deleted by a later prune. Set "transcriptDir" on this room to an absolute path outside ` +
    `the release tree, or set record to "none".` +
    (sources.record === 'config' ? '' : ` (record was resolved from: ${sources.record || 'default'})`));
}

/**
 * Validate + normalize the whole `rooms` map.
 *
 * ⭐ Absent ⇒ null, which is LEGAL and means "no room model configured" — NOT an error. That is
 * precisely what keeps this phase inert against the live deployment, whose config has no `rooms`
 * key at all and must go on behaving byte-for-byte as it did.
 */
export function normalizeRoomsConfig(rooms, where = '(built-in defaults)') {
  if (rooms === undefined || rooms === null) return null;
  if (!isPlainObject(rooms)) {
    throw new RoomConfigError(`rooms in ${where} must be a JSON object mapping a room name to its capabilities (or absent), got ${JSON.stringify(rooms)}`);
  }
  const out = {};
  for (const [rawName, v] of Object.entries(rooms)) {
    const name = String(rawName).trim();
    if (!name) throw new RoomConfigError(`rooms in ${where} has an empty room name — a room nothing can select is a typo, not a policy`);
    out[name] = normalizeRoomConfig(v, where, name);
  }
  return out;
}

/**
 * WHICH ROOM DOES THIS PROCESS SERVE? (T2)
 *
 * `$PRESENTER_ROOM` names a key of `rooms{}`. Absent ⇒ `defaultRoom`, fail-closed.
 *
 * ⛔⛔ NAMED-BUT-NOT-DECLARED IS A NAMED STARTUP ERROR, NEVER A FALL-THROUGH TO `defaultRoom`.
 * A process that boots with the WRONG capabilities is worse than one that refuses to boot: it looks
 * healthy, it answers, and it is quietly serving somebody else's policy — the wrong plugin set, the
 * wrong recording rule. A typo in a systemd unit file is exactly how that happens, so the typo has
 * to be fatal. This is the same ruling `normalizeOidcConfig` makes about a half-stated oidc block:
 * PRESENT-BUT-WRONG IS LOUD, NEVER INERT.
 *
 * ⚠ PHASE 0: the returned value is REPORTED AND NOTHING ELSE. No caller consumes it for behaviour.
 *
 * @returns {{name, room, source, sources, configPath, configSource}} — `source` says where the
 * room SELECTION came from ('env' | 'default'); `sources` maps each room key to 'config'|'default'.
 */
export function resolveRoom(env = process.env, config = {}) {
  const cfg = config || {};
  const where = cfg.configPath || '(built-in defaults)';
  const wanted = trimmed(env && env[ROOM_ENV]);

  if (!wanted) {
    const room = normalizeRoomConfig(cfg.defaultRoom, where, '(defaultRoom)');
    const sources = roomValueSources(cfg.defaultRoom);
    const cap = resolveRoomCapabilities(room, sources, env);
    assertRecordingIsDurable(cap.values, cap.sources, where, '(defaultRoom)');
    return {
      name: null,
      room,
      source: 'default',
      sources,
      capabilities: cap.values,
      capabilitySources: cap.sources,
      configPath: cfg.configPath || null,
      configSource: cfg.configSource || null,
    };
  }

  const rooms = normalizeRoomsConfig(cfg.rooms, where);
  if (!rooms || !Object.prototype.hasOwnProperty.call(rooms, wanted)) {
    const known = rooms ? Object.keys(rooms) : [];
    throw new RoomConfigError(
      `${ROOM_ENV}=${JSON.stringify(wanted)} names a room that is not declared in ${where}. ` +
      (known.length
        ? `Declared rooms: ${known.join(', ')}. `
        : `There is no "rooms" block there at all. `) +
      `REFUSING to fall through to defaultRoom: a process that boots with the WRONG capabilities ` +
      `looks healthy, answers, and serves a policy nobody chose — which is the failure this check ` +
      `exists to prevent. Fix the name, or declare the room.`);
  }

  const room = rooms[wanted];
  const sources = roomValueSources(cfg.rooms[wanted]);
  const cap = resolveRoomCapabilities(room, sources, env);
  assertRecordingIsDurable(cap.values, cap.sources, where, wanted);
  return {
    name: wanted,
    room,
    source: 'env',
    sources,
    capabilities: cap.values,
    capabilitySources: cap.sources,
    configPath: cfg.configPath || null,
    configSource: cfg.configSource || null,
  };
}

/**
 * The DECLARED room for this process, read from the deployment's own file (or built-in defaults),
 * validated. Mirrors identityConfig() exactly — ONE loader, both launch paths, no divergence. A
 * caller that resolves the room some other way is how 0543's class of bug is born.
 */
export function roomConfig(opts = {}) {
  const cfg = loadDeploymentConfig(opts);
  return resolveRoom(opts.env || process.env, cfg);
}

/**
 * THE ROOM STARTUP LINE (T3, and guard G12) — the resolved picture, WITH THE SOURCE OF EVERY VALUE.
 *
 * It exists because AN INVISIBLE RESOLUTION IS THE TRAP. The 2026-08-25 microphone failure was
 * legible nowhere: the config said `voice:true`, the server came up, and not one line anywhere
 * stated what had actually been resolved. So this prints the VALUE and WHERE IT CAME FROM — the
 * same shape `sessionLogDirSource` already uses, generalised to every room key.
 *
 * ⛔ STATE ONLY, and there is nothing about a room that is a credential — there must go on being
 * nothing. No OIDC client id, no client secret, no allowlist entry: this line reaches a log ring
 * that /api/debug can serve, and identityStartupLine() is under the same rule for the same reason.
 *
 * ⚠ It says PHASE 0 out loud. A line that reports `plugins ops-console(config)` while the process
 * has in fact loaded whatever `PRESENTER_PROFILE` said would be a worse instrument than no line —
 * so until phase 2 wires it, the line states that it is reporting, not describing.
 */
export function roomStartupLine(resolved = {}) {
  const r = resolved.room || roomDefaults();
  const s = resolved.sources || {};
  /* Plan 0684 R1 — a capability's value AND its source now come from the resolver, because `env`
   * is a third answer to "where did this come from" and `voice false(default)` vs `voice
   * false(env)` are the same value and different facts. Keys the resolver does not answer for
   * (port, bindHosts, label) fall back to the config/default split, unchanged. */
  const cap = isPlainObject(resolved.capabilities) ? resolved.capabilities : null;
  const capFrom = resolved.capabilitySources || {};
  const val = (k) => (cap && Object.prototype.hasOwnProperty.call(cap, k)) ? cap[k] : r[k];
  const from = (k) => `(${(cap && capFrom[k]) || s[k] || 'default'})`;
  const name = resolved.name
    ? `${resolved.name} (${resolved.source || 'env'})`
    : `(defaultRoom — ${ROOM_ENV} unset)`;
  const where = resolved.configPath || '(built-in defaults — no config file found)';
  const plugins = (r.plugins && r.plugins.length) ? r.plugins.join(',') : 'NONE';
  const binds = (r.bindHosts && r.bindHosts.length) ? r.bindHosts.join(',') : 'loopback-only';
  const unset = (v) => (v === null || v === undefined) ? 'unset' : v;
  return `room: ${name}`
    + ` · port ${unset(r.port)}${from('port')}`
    + ` · bindHosts ${binds}${from('bindHosts')}`
    + ` · plugins ${plugins}${from('plugins')}`
    + ` · record ${val('record')}${from('record')}`
    + ` · voice ${val('voice')}${from('voice')}`
    + ` · profile ${unset(val('profile'))}${from('profile')}`
    + ` · pluginsDir ${unset(val('pluginsDir'))}${from('pluginsDir')}`
    + ` · transcriptDir ${unset(val('transcriptDir'))}${from('transcriptDir')}`
    + ` · from ${where}`
    + ` · ⚠ PHASE 0: REPORTED ONLY — no capability here is wired to behaviour yet`;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * Plan 0675 T4 — ONE WRITER (guard G7: one config file, MANY READERS, ONE WRITER AT A TIME).
 *
 * Process-per-room means SEVERAL PROCESSES READ THIS FILE. The moment anything writes it, four
 * things must hold or a deployment loses its own configuration:
 *
 *   1. ⛔ THE WHOLE DOCUMENT ROUND-TRIPS. `presenter-config.json` holds the OIDC clientSecret IN
 *      CLEARTEXT, plus the allowlist, plus `//`-comment keys a human left for the next human, plus
 *      keys this module has never heard of. A writer that reconstructs the file from the keys it
 *      knows is not a bug, it is a SECURITY INCIDENT: it silently deletes the credential half of
 *      the deployment and the symptom arrives at the next restart. So: parse, mutate ONE section,
 *      re-serialise. Key order survives because JSON.parse/stringify preserve insertion order for
 *      string keys and nothing here enumerates. This is guard G2 again, one layer down.
 *   2. ⛔ THE WRITE IS ATOMIC. temp + rename IN THE SAME DIRECTORY (rename is only atomic within a
 *      filesystem). A reader opening the file mid-write sees the old file or the new one, never
 *      half of either — and a crash before the rename leaves the original untouched.
 *   3. ⛔ MODE 0600 SURVIVES. The file is a credential store. A temp file created at the ambient
 *      umask and renamed over a 0600 file would WIDEN the permissions of the secret, quietly and
 *      permanently. The mode is read from the original and applied AT OPEN, never by a later chmod:
 *      a temp file that exists at 0644 for even an instant has already exposed it.
 *   4. ⛔ THE AUDIT LINE NAMES THE ACTOR AND THE SECTION, NEVER THE VALUE. Logging what was written
 *      to a file that holds a secret is the same incident as dropping it.
 *
 * ⚠ NO HTTP SURFACE IN THIS PHASE, and no MCP tool. The function exists and is unit-tested;
 * nothing calls it yet. An agent that could name its own plugin set could authorize itself, so the
 * surface that eventually calls this is a decision for a later plan, not a convenience for this one.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/** Advisory-lock filename suffix, and the age past which a held lock is presumed dead. */
export const CONFIG_LOCK_SUFFIX = '.lock';
export const CONFIG_LOCK_STALE_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Take the advisory lock. `wx` (O_CREAT|O_EXCL) so exactly one caller wins the create.
 *
 * ⚠ A STALE LOCK IS STOLEN, NOT WAITED ON. A writer killed between create and unlink would
 * otherwise wedge every future write of this file forever — a permanent outage in place of a
 * transient race, which is the worse failure of the two.
 */
async function acquireConfigLock(lockPath, { staleMs = CONFIG_LOCK_STALE_MS, timeoutMs = 10_000, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try { writeFileSync(fd, `${process.pid}\n`); } catch { /* the lock's CONTENT is a courtesy */ }
      closeSync(fd);
      return;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let age;
      try { age = now() - statSync(lockPath).mtimeMs; } catch { age = -1; }   // vanished ⇒ retry at once
      if (age > staleMs) { try { unlinkSync(lockPath); } catch { /* someone else stole it first */ } continue; }
      if (now() > deadline) {
        throw new RoomConfigError(`could not take the config write lock ${lockPath} within ${timeoutMs}ms — another writer is holding it. (A lock older than ${staleMs}ms is treated as stale and stolen, so this means a writer is genuinely active.)`);
      }
      await sleep(10);
    }
  }
}

/** The document's own indentation, so a rewrite does not reformat a human's file. Default 2. */
function detectJsonIndent(raw) {
  const m = /\n([ \t]+)"/.exec(String(raw));
  if (!m) return 2;
  return m[1].includes('\t') ? '\t' : m[1].length;
}

/**
 * Write ONE top-level section of the deployment config file: atomically, under the advisory lock,
 * preserving every other byte of meaning in the document.
 *
 * @param {string}  section   the top-level key to set (e.g. 'rooms').
 * @param {*}       value     its new value. `undefined` DELETES the key.
 * @param {object}  o
 * @param {string}  o.actor   who is making the change, recorded in the audit line. REQUIRED — an
 *                            unattributed edit to a file holding the OIDC clientSecret is not an
 *                            audit trail.
 * @returns {Promise<{configPath, section, actor}>}
 */
export async function writeConfigSection(section, value, o = {}) {
  const { actor, env = process.env, repoDir = REPO_ROOT, log = console.log, _hooks = {} } = o;
  if (typeof section !== 'string' || !section.trim()) {
    throw new RoomConfigError(`writeConfigSection needs a non-empty top-level section name, got ${JSON.stringify(section)}`);
  }
  if (typeof actor !== 'string' || !actor.trim()) {
    throw new RoomConfigError(`writeConfigSection needs an {actor} — an unattributed edit to a file holding the OIDC clientSecret is not an audit trail`);
  }
  const configPath = o.configPath || loadDeploymentConfig({ env, repoDir }).configPath;
  if (!configPath) {
    throw new RoomConfigError(`writeConfigSection found no deployment config file to write (resolution order: $PRESENTER_CONFIG_FILE, <repo>/${CONFIG_BASENAME}, XDG). REFUSING to create one: a config file invented in a directory nobody chose is a deployment running on settings it never declared`);
  }

  const lockPath = configPath + CONFIG_LOCK_SUFFIX;
  await acquireConfigLock(lockPath, o.lock || {});
  const tmpPath = `${configPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    /* READ → MUTATE → WRITE, all INSIDE the lock. Reading before taking the lock is exactly how
     * "both calls completed and one of the two changes vanished" happens: the second writer would
     * serialise a document it read before the first one landed. */
    const raw = readFileSync(configPath, 'utf8');
    let doc;
    try { doc = JSON.parse(raw); }
    catch (e) { throw new RoomConfigError(`deployment config ${configPath} is not valid JSON — REFUSING to overwrite it, because a rewrite from a partial parse would destroy the one copy of the clientSecret: ${(e && e.message) || e}`); }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new RoomConfigError(`deployment config ${configPath} must be a JSON object — refusing to overwrite it`);
    }

    if (value === undefined) delete doc[section]; else doc[section] = value;

    const mode = (() => { try { return statSync(configPath).mode & 0o777; } catch { return 0o600; } })();
    const body = JSON.stringify(doc, null, detectJsonIndent(raw)) + (raw.endsWith('\n') ? '\n' : '');
    writeFileSync(tmpPath, body, { mode, flag: 'wx' });
    // Ownership, best-effort and never fatal: if we cannot chown we are not root, in which case we
    // are already the owner and there is nothing to preserve.
    try {
      const st = statSync(configPath);
      if (typeof process.getuid === 'function' && (st.uid !== process.getuid() || st.gid !== process.getgid())) {
        chownSync(tmpPath, st.uid, st.gid);
      }
    } catch { /* not permitted ⇒ leave ours */ }

    // A test seam, and the only way to prove requirement 2 without killing a process mid-write.
    if (typeof _hooks.beforeRename === 'function') await _hooks.beforeRename({ tmpPath, configPath });

    renameSync(tmpPath, configPath);

    // ⛔ THE SECTION AND THE ACTOR. NEVER THE VALUE.
    log(`config: ${configPath} — section ${JSON.stringify(section)} ${value === undefined ? 'REMOVED' : 'written'} by ${actor} (value not logged: this file holds the OIDC clientSecret in cleartext)`);
    return { configPath, section, actor };
  } finally {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best effort */ }
    try { unlinkSync(lockPath); } catch { /* already stolen as stale */ }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * Plan 0675 T5 — SIGHUP RE-READS THE CONFIG, AND A BAD FILE DOES NOT KILL THE ROOM.
 *
 * ⛔ A RUNNING ROOM MUST NOT DIE BECAUSE SOMEBODY FAT-FINGERED AN EDIT. The reload is best-effort
 * BY DESIGN: valid ⇒ swap and log which top-level KEYS changed; invalid ⇒ keep the old config, log
 * loudly, stay up. Exiting on a bad reload would turn a typo in an unrelated section into an outage
 * of whatever that room was in the middle of — and the person who could fix it is the person whose
 * editor is open.
 *
 * ⛔ VALIDATE BEFORE SWAPPING. A file that PARSES is not a file that is CORRECT. A malformed rooms
 * or identity block must not become the live configuration merely because JSON.parse liked it.
 *
 * ⛔ KEY NAMES, NEVER VALUES. This process's config file holds the OIDC clientSecret; printing the
 * diff would print the secret the moment somebody rotated it — i.e. exactly when the line is most
 * likely to be read and pasted somewhere.
 *
 * ⚠ INSTALLING A HANDLER MEANS SIGHUP NO LONGER TERMINATES THE PROCESS. That is the point, and it
 * is the ONE externally-visible behaviour this otherwise-inert phase changes. It is installed only
 * by the CLI self-run, never by createServer() and never by a test.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/** Top-level keys whose serialised value differs. NAMES ONLY — the caller must never see values. */
function changedTopLevelKeys(a = {}, b = {}) {
  const skip = new Set(['configPath', 'configSource']);
  const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter((k) => !skip.has(k));
  const out = [];
  for (const k of keys.sort()) {
    if (JSON.stringify(a ? a[k] : undefined) !== JSON.stringify(b ? b[k] : undefined)) out.push(k);
  }
  return out;
}

/**
 * Install the SIGHUP config reloader.
 *
 * @returns {{current, reload, dispose}} — `reload()` is on the handle so a test can drive the whole
 * path without sending a real signal to the test runner's own process.
 */
export function installConfigReloader({ env = process.env, repoDir = REPO_ROOT, log = console.log, signal = 'SIGHUP', install = true } = {}) {
  const fallback = () => ({ ...DEPLOYMENT_DEFAULTS, configPath: null, configSource: 'built-in' });
  let current;
  try { current = loadDeploymentConfig({ env, repoDir }); }
  catch (e) {
    log(`config reload: INITIAL load failed, running on built-in defaults — ${(e && e.message) || e}`);
    current = fallback();
  }

  const reload = () => {
    let next;
    try {
      next = loadDeploymentConfig({ env, repoDir });
      const where = next.configPath || '(built-in defaults)';
      // Parses is not correct. Validate everything this file knows how to validate BEFORE swapping.
      normalizeRoomsConfig(next.rooms, where);
      normalizeRoomConfig(next.defaultRoom, where, '(defaultRoom)');
      normalizeIdentity(next, where);
      normalizeAuthPolicy(next, where);
    } catch (e) {
      log(`config reload REFUSED — keeping the PREVIOUS configuration; the process stays up. ${(e && e.name) || 'Error'}: ${(e && e.message) || e}`);
      return { ok: false, changed: [], error: (e && e.message) || String(e) };
    }
    const changed = changedTopLevelKeys(current, next);
    current = next;
    log(changed.length
      ? `config reloaded from ${next.configPath || '(built-in defaults)'} — changed keys: ${changed.join(', ')} (key names only: this file holds the OIDC clientSecret)`
      : `config reloaded from ${next.configPath || '(built-in defaults)'} — no keys changed`);
    return { ok: true, changed, error: null };
  };

  const onSignal = () => { reload(); };
  if (install) process.on(signal, onSignal);
  return {
    current: () => current,
    reload,
    dispose: () => { if (install) process.removeListener(signal, onSignal); },
  };
}
