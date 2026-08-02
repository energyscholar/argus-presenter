# `test/parked/` — the plan 0530 equivalence instrument, parked

⏸ **Parked, not abandoned. Nothing in this directory is run by `npm test`.**

`harness/test.mjs` discovers `**/*.test.mjs` under `test/`. Nothing here matches that glob, so the
suite no longer asserts fingerprint equality. Both `.mjs` files are still listed by the runner under
*"not a suite, not discovered"* on every run — the parking is visible, never silent.

| file | what it is |
|---|---|
| `equivalence.mjs` | The harness. **Its top-of-file parking notice is the authoritative document** — provenance, the full re-arm procedure, the nondeterminism ledger. |
| `0530-p1-equivalence.mjs` | The three tests (`t0530-p1-01/02/03`). Was `test/unit/0530-p1-equivalence.test.mjs`. |
| `0530-baseline-at-897aa8f.json` | The captured baseline. **This file is the header it cannot carry** — see below. |

## `0530-baseline-at-897aa8f.json` — the header a JSON file cannot hold

A captured artifact must not be annotated: `diff()` walks every top-level key, so a `_parked`
comment key inside the fixture would show up as a spurious difference the next time anyone runs
`verify`. The commit hash therefore lives in the **filename**, and the rest lives here.

- **It describes commit `897aa8f`** on branch `plan-0530` — *"Plan 0530 phase 2c: the gate stops
  depending on when you look at it"*. That tree already contains seam S-A: `app/http-routes.mjs`
  had been lifted out of `createServer()`, and this fingerprint was **unchanged by that move**.
- **It is a behavioural fingerprint**, in four sections: `http` (a fixed request table, ungated and
  gated), `sockets` (welcome frames plus every accepted message type, as presenter and as
  participant), `session` (the store oplog verbatim, snapshot, presence, health, telemetry, durable
  log) and `logs` (every log line emitted, grouped by tag).
- **Do not overwrite it.** It is the historical record of what seam S-A preserved. Re-arming
  captures a *new* file named after the *new* commit.

## Why it is parked

Plan 0530 stopped after seam S-A (Bruce's call, S227); P3–P9 are deferred to a future plan.

- **It could not stay armed.** `t0530-p1-01` asserts equality with the baseline, and plan 0526
  changes behaviour on purpose (surface registry, `peek`/`unpeek`, `scene.facets`). It would go red
  on legitimate work, and the obvious "fix" would be re-capturing the baseline. ⛔ **An equivalence
  baseline that is not serving an active refactor is not a safety net; it is a trap that teaches
  people to re-capture.**
- **It could not be deleted.** Three phases of work; it caught **four real breaks in four
  independent sections**; it is stable at 20/20 quiet and 10/10 under concurrent full-suite load.
  It is the instrument the eventual refactor needs.

⚠ This supersedes the older teardown note in both `.mjs` files' history — *"deleted in 0530 P9, P9
fails if they exist"*. **P9 is not running.**

## Re-arming

**Read the parking notice at the top of `equivalence.mjs`.** It is written for someone who was not
here. Summary only:

    node test/parked/equivalence.mjs stability    # two captures must be identical
    node test/parked/equivalence.mjs capture --out test/parked/0530-baseline-at-<sha>.json
    # repoint BASELINE_PATH, then:
    git mv test/parked/0530-p1-equivalence.mjs test/unit/0530-p1-equivalence.test.mjs

Capture from a **clean tree**, at the commit you are about to refactor. Re-arming adds exactly
**3** tests to the executed count.

You can exercise the parked tests without re-arming — `node test/parked/0530-p1-equivalence.mjs`.
Verified at parking time: **3 passed / 0 failed**, and the fingerprint is still byte-identical to
`0530-baseline-at-897aa8f.json`.

⚠ Two traps found while parking, both invisible to `npm test` because these files are no longer
imported by it. Neither can be caught except by running the parked file directly — **do that after
any edit here.**
1. A block comment cannot contain the discovery glob written literally: the star-slash inside it
   closes the comment. Both `.mjs` files describe discovery in prose for that reason.
2. The harness's CLI guard now compares an **exact basename**. With the previous `endsWith(
   'equivalence.mjs')` it matched `0530-p1-equivalence.mjs` too, so direct-running the test file
   silently ran `verify` and `process.exit(0)`-ed before any test executed.

⛔ **The one rule: when the gate goes red, the answer is never "re-capture the baseline."** Explain
the difference first.

## Nondeterminism ledger

**Handled** (each fenced by `t0530-p1-03` so it cannot quietly grow):

1. **`sawPing` outside the hello-reply window** — a 5 s heartbeat on a clock the capture does not
   control; flipped 2 of 10 sequential runs. Tokenised, and both populations are counted.
2. **The session-log flush timer** — an unref'd `setTimeout(flushNow, 250)`, so what was on disk
   depended on how long the capture took. The harness now awaits `sessionLog.flush()` before every
   read of the log or its directory. No server behaviour changes; a race in the *observer* goes.
3. **Duration and byte fields** — measured elapsed times (`elapsedMs`, `durationMs`, `ageSec`, …)
   are blanked by name, while *configured* durations (`settlingMs`, `ttlMs`, `flushMs`) stay
   comparable. `bytes` is excluded only where it counts session-log bytes (the header line carries
   `pid`, a variable-width decimal: 177 vs 178); the 100+ HTTP body lengths are still compared.

⚠ **Unresolved residual — one, named so it cannot be waved away.** Plan 0530 P2b saw the `logs`
section report **131 log lines where the baseline had 129**, once. It **did not reproduce in 30
captures**; cause unknown. Suspected mechanism: `socketId` is a **per-server counter**, so one
extra connection renumbers every later line and turns a single stray socket into a large,
alarming, entirely spurious diff. ⛔ P2c deliberately did **not** exclude socket ids — that would
blind the gate to real changes in which socket did what. **If a future run shows an unexplained
`logs.*` diff with renumbering, that is the suspect. Investigate it; do not dismiss it as "the
known flake."** It has never been diagnosed, and a real regression would look identical.
