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
