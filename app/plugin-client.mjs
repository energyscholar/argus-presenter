/**
 * plugin-client.mjs — the engine's own thin shell-out to the private lifecycle CLI.
 *
 * Run 0768 (D8s). The engine never links the lifecycle CLI in-process — it shells out to it via
 * `node <PRESENTER_LIFECYCLE_CLI> verify-load <id@version> --customer <accountId> --json`, exactly
 * the invocation shape every other caller of that CLI uses (`spawnSync`/`execFileSync` with
 * `process.execPath` first, the script path second — never the script path executed directly; the
 * CLI carries no `chmod +x` bit).
 *
 * `PRESENTER_LIFECYCLE_CLI` UNSET is not an error: it means no private lifecycle CLI is present at
 * all (a bare open-source checkout, say), and the engine must still run, loading content UNGATED
 * (R-111, R-221) rather than refusing to boot or gating silently. `lifecycleCliConfigured()` below
 * is a small, standalone predicate a future run can wire into `presenter_health` so that state is
 * visible in the health JSON, not just this module's own stderr line — that wiring is NOT done
 * here (`presenter_health`'s `health()` implementation lives in a file this run does not touch).
 */
import { execFileSync } from 'node:child_process';

export function verifyLoad({ id, version, customer, cliPath = process.env.PRESENTER_LIFECYCLE_CLI } = {}) {
  if (!cliPath) {
    /* R-221: UNSET ⇒ the engine RUNS and loads content UNGATED (R-111) — this is the one branch
       where returning ok:false would be WRONG; the caller must treat this as "let it load". */
    console.error('[plugin-client] lifecycle-cli: ABSENT — content is loading UNGATED (R-111, R-221)');
    return { ok: true, ungated: true, ownsBase: null, baseIntact: null, refusal: null };
  }
  let raw;
  try {
    raw = execFileSync(process.execPath,
      [cliPath, 'verify-load', `${id}@${version}`, '--customer', customer, '--json'],
      { encoding: 'utf8' });
  } catch (e) {
    /* ⛳ R-204 §1: CLI or ledger unreachable at LOAD fails OPEN on the verdict CACHED AT INSTALL —
       no such cache exists yet at this stub's fidelity (a later run's job); this branch is the
       named, flagged gap, never a silent approximation of it. */
    return { ok: false, failedOpen: true, ownsBase: null, baseIntact: null, refusal: 'E-LIFECYCLE-UNREACHABLE' };
  }
  try { return JSON.parse(raw); }
  catch { return { ok: false, ownsBase: null, baseIntact: null, refusal: 'E-LIFECYCLE-BAD-REPLY' }; }
}

/**
 * lifecycleCliConfigured() — a small, standalone predicate a FUTURE run can wire into
 * `presenter_health` so "lifecycle-cli: ABSENT" reaches the health tool's JSON, not just stderr.
 */
export function lifecycleCliConfigured() {
  return !!process.env.PRESENTER_LIFECYCLE_CLI;
}

/* ⛳ NAMED HOOKS, NOT BUILT — both belong beside whatever future call restarts this engine to place
   or reload a plugin; no such restart call site exists in this engine's tracked tree yet (measured:
   grepped for a plugin-install-triggered restart, found none), so both comments live here, together,
   until that call site exists.
   INSERT DRM WITHDRAWAL CODE HERE (R-200): before a restart for content already installed, a
   withdrawal check COULD refuse a revoked release from reaching a still-open session — R-199 keeps
   installed copies serving regardless, so this stays a future option, never a gate today.
   INSERT SAVE-BEFORE-A-KNOWN-KICK CODE HERE (R-220): before any restart this engine schedules to
   place a plugin, a save should run first — no such restart hook exists yet, so this marks where a
   future one would call the plugin's own save, not built here. */
