# BASELINE-0675 — the green baseline the whole 0674 programme is judged against

**Plan:** 0675 T0 (= 0676 A1·R0, closing red-team finding RT-8).
**Recorded:** 2026-08-25, on `penguin`, from a clean checkout of `master`, **before any source edit**.
**Baseline sha:** `52168b7fa40d04b48e30066fb26f21ef40795104` (`master`; HEAD is the Dungeons Deep UI-reference docs commit)
**Command:** `node harness/test.mjs` (= `npm test`), the whole suite, no `--only`.
**Wall clock:** ~10 min. **Discovery:** 265 `*.test.mjs` files.

> ⛔ **WHY THIS FILE EXISTS.** The weekly suite was RED, so "npm test green" is not a usable
> done-criterion: a phase could go green by breaking nothing *and* by breaking something that was
> already broken, and nobody could tell the two apart. Every later phase's green claim is judged
> **against this record**, never against zero. A new failure is yours; an old one is not; and
> neither may be hidden.

---

## 1. THE RESULT

```
708 passed / 9 failed   [component:103/106  live:210/211  unit:395/400]
```

⚠ **Counting note, recorded rather than papered over:** the log carries **709** lines beginning
`PASS  ` against a summary of **708**. The harness is the only thing in the tree that prints that
prefix, so one extra line is almost certainly a CHILD PROCESS spawned by a test inheriting stdout
(several tests shell out to `node app/server.mjs`). It is one line and it does not change any
failure's identity. **Compare against the SUMMARY LINE and the failure list below, not against a
`grep -c`.**

## 2. THE FAIL SET — 9 tests, and what each one is

⛔ **Do not fix these.** They are not phase 0's work. Triage only, as T0 requires: the last column
answers the one question that matters, *does this failure touch config resolution?*

| # | Test | Cause, as the run reported it | Touches `lib/deployment-config.mjs`? |
|---|---|---|---|
| 1 | `0522 t12/t13 — the dropdown lists ALL + people + declared stations, and defaults to ALL on every load` | component/UI — station dropdown contents | **No.** Unrelated to config resolution. |
| 2 | `t0529-p2-06 — PLAYER-VISIBLE COST IS NONE: the audience page never requests a catalogue route` | component — audience page issues a catalogue request it should not | **No.** Unrelated to config resolution. |
| 3 | `t0559-27 — EVERY station that declares a screen paints, not just the first` | component — station screens; the S250 "stations 14/15 null" item | **No.** Unrelated to config resolution. |
| 4 | `t0584-C2 — THE ROSTER SELECT SENDS A CREWMATE TO THE OTHER HULL, and the mover keeps their station` | live e2e — crew-move | **No.** Unrelated to config resolution. |
| 5 | `t0531-01 — NO campaign vocabulary in ANY tracked file` | **1 tracked file:** `docs/ui-references/dungeons-deep/NOTES.md` | **No** — but see §3, it SCANS every tracked file. |
| 6 | `t0531-02 / t0581-H1 — campaign vocabulary in ANY COMMIT TREE` | **1 commit:** `52168b7 2026-08-25 docs/ui-references/dungeons-deep/NOTES.md` | **No** — but see §3. |
| 7 | `t0514-28 — CORE carries no machine and no domain vocabulary` | **1 hit:** `mcp/server.mjs` line 52, a comment naming the retired v0 plugin | **No** — but see §3, its grep path INCLUDES `lib/`. |
| 8 | `t0532-01 — NO tracked code or config file reads from the retired plugin source repo` | **1 file:** `mcp/server.mjs` | **No** — but see §3. |
| 9 | `t0571-01 — the pip carries a STABLE ID in all thirteen stations` | 14 station SVGs generated where the test expects 13 | **No.** Unrelated to config resolution. |

⭐ **Five of the nine are ONE root cause each, and two of those root causes are a single commit.**
#5 and #6 are both the HEAD commit's new `docs/ui-references/dungeons-deep/NOTES.md`; #7 and #8 are
both one comment line in `mcp/server.mjs`. Neither is a code defect.

**No failing test exercises config resolution.** The T0 stop-condition ("if any failing test touches
`lib/deployment-config.mjs`, stop and report") is therefore NOT triggered on its stated meaning —
but §3 records a real hazard that the pass/fail column alone would hide.

## 3. ⛔⛔ THE HAZARD THE PASS/FAIL COLUMN HIDES — READ BEFORE EDITING `lib/`

Four of the nine failures (#5–#8) are **repo-wide SCANS, and they are ALREADY RED.** A test that is
already failing cannot fail *harder*: adding a new offending line to it moves nothing from pass to
fail, so **the ordinary green-against-baseline check is BLIND to a regression in these four.**

Two of them read files this phase edits:

- `t0514-28` greps **`app harness mcp lib components`** — which includes `lib/deployment-config.mjs`
  — case-insensitively and word-boundary, for a list of **13 machine-and-domain tokens**: the state
  machine's own nouns, the game system's published name, one setting noun, and seven seat titles.
- `t0531-01` reads **every tracked file** (`git ls-files`) for hashed campaign names plus **9
  plaintext generic tokens**: two session ids, the game system's published name, three setting
  nouns, and three pieces of kit/faction vocabulary.

⛔ **BOTH TOKEN LISTS ARE DELIBERATELY NOT REPRODUCED HERE.** Read them at their source,
`test/unit/0514-p0-machine.test.mjs` (`TOKENS` in `t0514-28`, `GENERIC_TOKENS` above `t0531-01`).
That file is the ONLY entry on the guard's allow-list, precisely because a guard cannot help
containing the vocabulary it hunts for — and this record is not on that list. Copying the tokens
into it would make this very file the next violation.

⇒ **Consequence for plan 0675, and it is not cosmetic:** the plan's own worked example names one
room, and that room's one plugin, using **two words that are both on those lists**. **Writing either
literal into `lib/`, `app/`, `mcp/`, `harness/`, `components/` or any tracked test file re-offends
these guards silently.**
Phase 0 therefore uses neutral room and plugin names in every comment, default and test fixture.
The room name is a deployment's string; it is not a value this code may embed.

⇒ **The check every later link must run** is not `pass/fail` but the HIT LIST. Both must still be
exactly:

```
t0514-28   →  exactly ONE hit, in mcp/server.mjs line 52 (a comment naming the retired v0 plugin)
t0531-01   →  exactly ONE file: docs/ui-references/dungeons-deep/NOTES.md
t0531-02   →  exactly ONE commit: 52168b7 (2026-08-25), same file
t0532-01   →  exactly ONE file: mcp/server.mjs
```

A hit list that GROWS is a regression even though the test's pass/fail state did not move.

## 4. HOW TO JUDGE A LATER RUN GREEN

1. The summary line still reads **`708 passed / 9 failed`** or better — and better means a
   pre-existing failure was fixed deliberately, never that one vanished.
2. The nine failures in §2 are **unchanged in number AND identity**.
3. The four scan hit-lists in §3 are **unchanged in content**, not merely still-red.
4. Any test added by a later phase passes.

## 5. THE PASS SET

709 `PASS` lines, listed in §6 in sorted order (see the counting note in §1). The tier split is the
authoritative shape: `component 103/106 · live 210/211 · unit 395/400`.

## 6. PASS SET, VERBATIM

- `0488 — every api method is covered or reasonedly declined`
- `0488 — every createServer() option is covered or reasonedly declined`
- `0488 — the guard itself fails on drift (meta-test)`
- `0488 — voice tools are covered as DECLARED, not through the env gate`
- `0493 D: a subscriber cannot send ops (read-only)`
- `0493 D: ws subscribe replays the unread backlog from the shared cursor (R1)`
- `0493 E1: unrelated speech is never mistaken for an echo`
- `0493 E2: near-silence boilerplate is flagged, conf carried, still delivered`
- `0493 R1: re-arm preserves the cursor and replays the gap (never re-baselines at live)`
- `0493 S10: each named mode flips and is confirmed via status`
- `0493 S11: markardown escapes untrusted/dangerous text, never executes it`
- `0493 S11: present_text escapes untrusted text through the api`
- `0493 S12: a turn lands over ws at ASR latency; subscriber is not a participant`
- `0493 S12: socket close ends the watch; the poll fallback continues from the cursor`
- `0493 S13: a TTS loopback is flagged echo:true and not delivered (poll path)`
- `0493 S13: the ws path skips echo loopbacks too`
- `0493 S1: a spoken turn arrives through the PVS consumer`
- `0493 S2: multiple turns delivered in order, none dropped`
- `0493 S3: R1/R2 — a manual read does not consume the PVS backlog; both turns replay`
- `0493 S4: a dropped range surfaces a visible ⚠ N turns missed marker (R3)`
- `0493 S5: pvsStop is idempotent and leaves no orphan cursor`
- `0493 S6: PVS survives connection churn; turns across it are not lost`
- `0493 S7: trust and untrusted fencing survive PVS delivery`
- `0493 S8: default comms mode is presenter`
- `0493 S8: mode is carried on every delivered envelope`
- `0493 S9: long content is not truncated server-side; the card scrolls`
- `0493 S9: present_text delivers a prose card to a connected client (positive observation)`
- `0493 S9: renderMarkdown produces the expected block + inline structure`
- `0493 modes: an unknown mode is refused, the prior mode survives`
- `0493 modes: presenter_mode tool is declared and delegates`
- `0493 modes: pvsStart accepts an initial mode; commsMode round-trips`
- `0522 P5 — a per-user layer survives a send addressed to that user's STATION`
- `0522 R14 — after a disk change, a click ships the beat that is ON SCREEN, not the one at that index`
- `0522 R4 — the control-page click STAGES; ▶ Start and auto-follow still PUBLISH`
- `0522 t01 — after module-changed the control page beat count equals DISK`
- `0522 t02 — the live beat survives invalidation, resolved by ID not index`
- `0522 t03 — invalidation with shifted beat ids changes NOTHING for players`
- `0522 t04 — two sockets on one derived userId collapse to ONE roster row`
- `0522 t05 — two LIVE sockets on one userId → one row, contested, count 2`
- `0522 t06 — the stale socket is reaped → the contested marker clears`
- `0522 t07 — staging mutates NO durable state (I3)`
- `0522 t08 — show_beat still PUBLISHES IMMEDIATELY on both surfaces (R4 regression guard)`
- `0522 t09 — staging is PER-CALLER, and send_beat reports the recipients it reached (I5)`
- `0522 t10 — a single target travels as an ARRAY and narrows delivery to exactly those people`
- `0522 t10 — the control page ships every beat with `targets` as an ARRAY, default included`
- `0522 t11 — a candidate staged for a target is rendered AS that target, not as the presenter`
- `0522 t11 — picking a target changes what the PREVIEW renders, stations included`
- `0522 t14 — STAGED and LIVE are visually distinct in a SCREENSHOT, by pixels not by class name`
- `0522 t15 — a send that reaches NOBODY says so, as loudly as one that works (I5)`
- `0522 t16 (server) — staging over an UNSENT candidate reports what it destroyed`
- `0522 t16 — staging over an UNSENT beat never discards it silently, and GO still ships (I4/I5)`
- `0522 t16a (R18) — the MCP surface's lack of stage_beat/send_beat is DECLARED, not a gap`
- `0522 t17 — full screen renders the preview at scale(1), and GO is out of reach (R9)`
- `0522 t18 — ESC exits full screen, the Press ESC hint is present and barely visible (R8)`
- `0522 t19 — a degrade during full-screen interaction does not destroy the operator's input`
- `0522 t20 — the preview sandbox is allow-scripts and ONLY allow-scripts (no allow-forms)`
- `0522 t21 — a form submitted in the PREVIEW produces no answer on the real channel; the drop is recorded`
- `0522 t22 — a shared form is INTERACTIVE in the docked preview: real click, real typing, handler fires (R7)`
- `0522 t23 — a persisted moduleId is PRESELECTED on the next load`
- `0522 t24 — PRESELECT DOES NOT LOAD: opening a second control page changes NOTHING for players`
- `0522 t25 — a persisted module that is GONE yields no selection and no error (I4)`
- `0522 t26 — the option LABEL is the title; counts and summary live in title=`
- `0522 t27 — ⚠ and (ERR) markers stay in the LABEL, not in the tooltip`
- `0522 t28 — nothing is dropped for a missing field: no status, no kind, or a nonsense status`
- `0522 t29 — the picker is grouped by kind, groups A–Z and members A–Z by title`
- `0522 t30 (R13) — Show All Modules reveals BOTH working AND retired, and the setting sticks`
- `0522 t31 — the LOADED module is never hidden, and neither is the sticky default`
- `0522 t32 — RETIRE MOVES the module into _archive/ and never unlinks it`
- `0522 t32b — the curation list shows what the picker hides: broken modules and symlink state`
- `0522 t32c/t33b — Manage Modules is a separate page; retire MOVES; a symlink refuses visibly`
- `0522 t33 — a write to a SYMLINKED module is refused with a reason; the target is byte-identical`
- `0522 t34 — module writes require the control credential, UNCONDITIONALLY (R15 / SHAPE-A7)`
- `0522 t35 — a seat sees its own station label WITHOUT opening the config panel`
- `0522 t35a — no plugin declares stations ⇒ NOTHING is rendered`
- `0522 t35b — the ambient label FOLLOWS a station change, and does not fossilise the welcome`
- `0522 t36 — the roster row carries mirror + spotlight + set-station, and set-station routes through the 0514 resolver`
- `0522 t37 — a PARTICIPANT cannot set another seat's station: refused by name, and the seat is unchanged`
- `0522 t37a — the gate holds on BOTH surfaces (control page AND api/MCP), and admits a controller on both`
- `0522 t37b — an UNOCCUPIED target is refused by name, not answered ok:true`
- `0522 t38 — the station tier is COLLAPSED on first render`
- `0522 t39 — no plugin declares stations ⇒ the tier is ABSENT, entirely`
- `0522 t40 — the tier renders with NO module loaded, and survives a module change`
- `0522 t41 — projecting a station to the room leaves EVERY seat's stationUid unchanged`
- `0522 t42 (R18) — the ▣ projection is on the MCP surface, is the SAME capability, and still writes no seat`
- `0522 t43 — the DEFAULT log path resolves outside any git repository`
- `0522 t44 — an UNWRITABLE log directory does not take down the session`
- `0522 t45 — reading the log requires the ai/presenter control credential`
- `0522 t46 — the log ROTATES at the cap and does not grow unbounded`
- `0522 t47 — the port reads from the deployment config file; absent config ⇒ 3000`
- `0522 t48 — a failed public probe after raising the ingress is a FAILED START`
- `0522 t49 — Ad-hoc push is CLOSED on first load, and every accordion remembers what the operator did`
- `0522 t50 — at 1366×768 the enlarged dock does not overlap in-flow content (asserted from a screenshot)`
- `0522 t51 — the session log SURVIVES PROCESS EXIT (start, emit ops, kill, read back)`
- `0525 t73 — presenter_beats reports onDemand on a marked beat and OMITS the key on every other one`
- `0525 t74 — the GM outline MARKS an on-demand beat, marks nothing else, and stages it exactly as before`
- `0525 t75 — next_beat from the beat BEFORE an on-demand beat still lands ON it (R5: no skip, ever)`
- `0525 t76 — a RECORDING session reports enabled, its directory and a growing count, and NOT ONE entry`
- `0525 t77 — a NON-RECORDING session says so WITH THE REASON, and still carries not one entry`
- `0525 t78 — the whole session walk runs on COMMITTED content, and the on-demand marker holds on it`
- `0525 t79 — a seat link DERIVES its userId and discards the one asked for; a reload derives the SAME one; a non-seat link still honours it`
- `0525 t80 — every core component has a field schema, and every field schema has a core component`
- `0525 t81 — openControl waits for the welcome frame: held on purpose, the un-waited read is 0 and the waited read is the whole registry`
- `0526 P2 t80b — components/ ≡ core-schemas ≡ DEFAULT_COMPONENTS: all three, both directions`
- `0526 P2 — a component absent from DEFAULT_COMPONENTS IS reported (the check is live, not vacuous)`
- `0526 P2 — every real component validates clean with NO knownComponents ctx`
- `0526 P2 — sectionId is a declared beat key, so 0527 P2 renames quietly`
- `0531 t61 — every seat knows where it is sitting, without opening Config (P13)`
- `0531 t62 — the deck loads and VALIDATES, and the outline renders every beat AND every section`
- `0531 t63 — ⛔ STAGING DOES NOT SHIP: the presenter clicks a beat and the room does NOT change`
- `0531 t64 — GO ships, and only then`
- `0531 t65 — a per-seat send is addressed in the wire form, and reaches exactly one seat`
- `0531 t66 — ⚠ sending to an EMPTY post is LOUD, not silently successful`
- `0531 t67 — R4's split is real: a beat row STAGES, an arrow SHIPS`
- `0531 t69 — the post tier projects to the room and re-seats NOBODY (I3)`
- `0531 t70 — a display RELOAD does not double-count the roster`
- `0531 t71 — the DURABLE LOG caught the session, and refuses an uncredentialed read`
- `0531 t72 — ⛔ the source deck was never written to`
- `0531 t83 — the cue sheet an AI reads and the outline a human reads mark the SAME beats`
- `0531 t84 — presenter_health's session-log block, on a REAL five-browser session, says ENABLED and names its directory`
- `0531 t85 — ⛔ → from the beat before an on-demand beat still LANDS ON IT and SHIPS it, by exactly one step (R5)`
- `0534 t-w4c-01 — a participant reaches a declared surface from the page alone, by UID`
- `0534 t-w4c-02 — "you are peeking" is legible WITHOUT Settings, and the badge is the way back`
- `0534 t-w4c-03 — no surfaces declared ⇒ NO control at all, not an empty one`
- `0537 P2 — a peer sees ordinary chat; /gm reaches the GM alone, and the sender is told so`
- `0537 P2 — the /gm receipt handler survives the voice strip (chat is NOT voice)`
- `0537 P3 — `/roll` from the chat input reaches the same one roller`
- `0537 P3 — one roll, one outcome: every participant sees the same numbers, computed server-side`
- `0537 P4 — the message panel is summoned, the tab stays reachable, and the chrome count holds at 7`
- `0539 P1 — A types, B reads; the aside stays private; hostile text stays text; rolls show their arithmetic`
- `0543 P1: a non-boolean allowPasswordCommandOnLAN THROWS at startup`
- `0543 P1: an explicit control value is surfaced verbatim`
- `0543 P1: an unknown enforceOAuth value THROWS at startup (no silent default)`
- `0543 P1: defaults — enforceOAuth=off, allowPasswordCommandOnLAN=false`
- `0543 P1: normalizeAuthPolicy — defaults, accepts, and rejects`
- `0543 P2 (T14): a valid ID token verifies and yields the principal`
- `0543 P2 (T14): forged / expired / wrong-aud / replayed-nonce / alg-none / no-key are ALL refused`
- `0543 P2 (T5 core): allowlist is FAIL-CLOSED — a hit authorizes, everything else is fenced`
- `0543 P2 (T7 core): loopback peer WITH a forwarding header is REMOTE — the cloudflared trap`
- `0543 P2: /auth/login is a clean 404 when OIDC is not configured`
- `0543 P2: /auth/login redirects to the IdP with state + PKCE when OIDC is configured`
- `0543 P2: /auth/logout redirects and clears the session cookie (OIDC configured)`
- `0543 P2: OIDC adapter is INACTIVE (and inert) without config`
- `0543 P2: OIDC adapter — begin/complete login, session cookie, principalForRequest`
- `0543 P2: OIDC — missing state and unknown state are refused; state is single-use`
- `0543 P2: a non-loopback peer is never local; a null request is never local (fail-safe)`
- `0543 P2: an empty / absent allowlist authorizes NOBODY`
- `0543 P2: createServer accepts allowlist + tailscale config and starts`
- `0543 P2: isTrueLoopback — loopback peer with NO forwarding header is local`
- `0543 P2: parseCookies is lenient and never throws`
- `0543 P2: pkcePair — challenge is base64url(sha256(verifier))`
- `0543 P2: tailscale — a DIRECT peer resolves; a forwarded (tunnel) request does not`
- `0543 P4: a revoked nonce SURVIVES a restart (persisted to the nonce file)`
- `0543 P4: mint_cap / revoke_cap MCP tools — seat-slug sid, /?cap= url, revoke by nonce`
- `0543 P4: mint_cap fails cleanly when guest links are disabled (no cap secret)`
- `0543 T1 (UC1): Bruce via a verified+allowlisted identity is SELF; his turn reaches Argus UNFENCED`
- `0543 T10 (A-offline): Bruce AND Gen via direct-tailnet identity both reach SELF with no OIDC`
- `0543 T11 (A-breakglass gate): enforceOAuth=control with NO break-glass configured REFUSES to start`
- `0543 T12 (A-expiry): a verified session that expires mid-conversation prompts RE-AUTH`
- `0543 T13 (I1): a participant asserting role:ai, and forged/expired caps, NEVER reach self`
- `0543 T2 (UC1/2-remote): OIDC-verified + allowlisted ⇒ SELF, attributed; command executes (unfenced)`
- `0543 T3 (UC3): an anonymous /?cap= guest is HEARD but fenced; never a command; not blocked`
- `0543 T4/T5 (E-guard): OIDC allowlisted ⇒ self, NOT-allowlisted ⇒ fenced participant + "not authorized"`
- `0543 T6 (D): a REMOTE holder of the correct password gets a control role but its command is FENCED`
- `0543 T7 (loopback guard): a loopback connection with NO verified identity NEVER grants self`
- `0543 T8 (B): an unauthenticated user at enforceOAuth=control CONNECTS (fenced), no forced login`
- `0543 T9 (C-voice): voice channel ≠ trust — the mic switch is independent, a verified speaker is self + attributed`
- `0551 C4 — the CLI launch path agrees, from the SAME file`
- `0551 C4 — the MCP launch path really produces a configured identity`
- `0551 C6 — a half-configured oidc block stops BOTH launch paths, by name`
- `0551 C7 — every createServer option is CLASSIFIED, and deployment-only ones are ROUTED`
- `0551 P1 (C6) — a PRESENT-BUT-INCOMPLETE identity block throws a NAMED startup error`
- `0551 P1 — the WHOLE-FILE trap is real for identity too, and documented`
- `0551 P1 — the loader reads identity from the deployment config file`
- `0551 P1 — the startup line makes INERTNESS visible, and leaks nothing`
- `0551 P3 — /api/auth-state reports oidcActive, and an anonymous caller may ask`
- `0551 P3 — /auth/login is reachable when configured, and 404s when it is not`
- `0551 P3 — signed in AND allowlisted reads self; signed in and NOT reads fenced`
- `0551 P3 — the sign-in control exists in BOTH clients and ships HIDDEN`
- `0551 — the guard itself fails on drift (meta-test)`
- `0650 bind — extra hosts are OPT-IN, wildcards are REFUSED, and the default does not move`
- `0650 §3.1 ⭐⭐ A FORGED tailscale-user-login header does NOT grant control`
- `0650 §3.1b — the resolver reads the SOCKET, and prefers it over a contradicting header`
- `0650 §3.1c — the address and whois parsers refuse what they must`
- `0650 §3.2 ⭐ a GENUINE tailnet peer IS granted presenter under enforceOAuth=control`
- `0650 §3.2b — a genuine tailnet peer who is NOT allowlisted is still fenced`
- `0650 §3.3 — anonymous still gets participant, and the page still serves 200`
- `0650 §3.4 ⭐ break-glass grants ONCE, then is SPENT`
- `0650 §3.5 — break-glass is refused from a NON-loopback peer, and refused after its TTL`
- `0650 §3.5b — /auth/break-glass is a clean 404 when the deployment has no credential`
- `0650 §3.6 — an ABSENT or ERRORING tailscale yields null: no throw, no grant, no hang`
- `0650 §3.6b — a HUNG whois does not hang the connection: the gate opens on its deadline`
- `0661 L1 — no HTTP route is shadowed by an earlier prefix`
- `0661 L2 — the wire action table is populated and its keys are unique`
- `0661 L3 — neither seam imports back into server.mjs`
- `0661 — a hello frame round-trips through the action table (dispatch is not swallowing)`
- `A1 — city-grid renders ONLY via the fixture preset`
- `A1 — core map default is a neutral grid (no preset art)`
- `A1 — core map source contains no domain art; the plugin does`
- `A2 — choice neutral default is Yes/No`
- `A2 — each core component renders with empty opts (neutral default, no crash)`
- `A2 — zero domain-content tokens in components/ and lib/`
- `A3 — zero domain-content tokens across app/harness/mcp/lib/components`
- `A4 — a manifest parses; components + requires + preset correct`
- `A4 — an absent plugin reads as absent, it does not throw`
- `A4 — loadManifests() keys manifests by name`
- `A5 — manifest lists ALL core components, each with fields`
- `A5 — regenerates deterministically and matches the committed file`
- `A6 — pure-core assemble has ZERO plugin bytes`
- `A6 — requires:[example] bundles core + exactly that closure`
- `A6 — resolveClosure: [] -> pure core; [example] -> only example`
- `A7 — core push = no plugin; plugin push = city-grid preset`
- `AUT-1 — AUTH gate: no token → 403; correct token → 200`
- `AUT-1 — POST writes a module; it then appears in the registry + fetchable`
- `AUT-1 — path traversal id → 400, nothing written outside MODULES_DIR`
- `AUT-2 — a new module file on disk pushes {t:module-changed} to control roles`
- `AUT-3 — creator: in-browser validate flags unknown component + preview renders via the server pipeline`
- `AUT-3-save — creator save() writes to the registry; load() re-populates the editor (round-trip)`
- `AUTH-1 — no token configured → control role granted (backward-compat / LAN-open)`
- `AUTH-1 — token configured, correct token in hello → control role granted`
- `AUTH-1 — token configured, no token in hello → control role denied (participant)`
- `AUTH-ROLE — /api/auth advertises {gated,seed} and NEVER leaks the hash or password`
- `AUTH-ROLE — /api/auth reports ungated when no credential configured`
- `AUTH-ROLE — back-compat: no rolePassword ⇒ ungated, presenter granted with NO token`
- `AUTH-ROLE — rolePassword gates presenter: correct seeded hash granted, wrong denied`
- `B1 — S4: unsafe paths rejected, no prototype pollution`
- `B1 — _setPath creates nested nodes; get reads them`
- `B1 — idle shows the branding SVG; /branding route serves it`
- `B1 — tree uses null-proto nodes (no inherited keys)`
- `B2 add — id-keyed; add-twice-same-id == one`
- `B2 clear — resets a subtree; terminal + idempotent`
- `B2 lock/unlock — owner set/cleared; idempotent`
- `B2 merge — shallow merge + idempotent`
- `B2 remove — id-keyed; remove-twice == gone (no throw)`
- `B2 set — last-write-wins + idempotent`
- `B2 unknown verb / bad path -> null diff, no mutation`
- `B2 — poll-results pushed after a vote seeds the real tally (not 0)`
- `B3 — S4: unsafe path denied even for controllers`
- `B3 — canRead (Plan 0471 C3): default-DENY; self vote readable; controllers read all`
- `B3 — controllers (presenter, ai) OVERRIDE`
- `B3 — participant allowed on explicitly-gated paths`
- `B3 — participant default-DENY on ungated paths/verbs`
- `B3 — participant may set OWN vote (self), not another's`
- `B4 — denied op returns null and does NOT mutate`
- `B4 — identity from actor, not payload (S1)`
- `B4 — malformed ops rejected (S10)`
- `B4 — permitted op applies, returns diff + authoritative by`
- `B4 — presenter override applies control ops`
- `B5 — apply increments version and records the op-log`
- `B5 — op-log is bounded`
- `B5 — replay the op-log into a fresh store reproduces state`
- `B5 — snapshot(actor) filters unreadable slices (S7, Plan 0471 C3 default-deny), keeps arrays intact`
- `B6 — add same id twice (distinct opIds) = one item`
- `B6 — apply-twice-same-opId == apply-once, for every verb`
- `B6 — concurrent same-path sets: last-by-arrival wins, both logged`
- `B6 — duplicate opId is a no-op (state + version unchanged)`
- `C1 — Argus.op emits a well-formed op message`
- `C1 — a >256KB frame does NOT kill the server; other clients keep working`
- `C1 — each op gets a distinct opId`
- `C2 — a bare `null` frame does NOT kill the server`
- `C2 — empty prefix subscribes to all paths`
- `C2 — non-diff host messages are ignored; unsubscribe stops delivery`
- `C2 — subscribeState fires for in-prefix paths only`
- `C3 — a peer never sees another's vote (live); voter sees own; controller sees all`
- `C3 — permitted op applies and broadcasts a diff to clients`
- `C4 — a fresh client receives a snapshot carrying current state + version`
- `C4 — browser client applies the snapshot (overlay state inspector populated)`
- `C4 — hostile userName renders inert in the control user-list (no live img)`
- `C5 — component op reaches the store; diff returns into the component`
- `C6 — a late client renders the currently pushed component`
- `C6 — a late participant renders the open poll choice`
- `CLI-1 — /api/modules lists real modules only; parses-but-not-a-module is filtered out`
- `CLI-1 — `node app/server.mjs 0` prints the three entry URLs (control line present)`
- `CTRL-auth — gated: control downgraded (no users) → password unlock → presenter → users visible`
- `D1 — all mode: everyone gets the AGGREGATE; still no raw peer votes`
- `D1 — control mode: only controllers get the tally; participants get no aggregate`
- `D1 — openPoll seeds polls/{pid} spec + open in the store`
- `D2 — vote shim writes the store; another user's vote is denied (self)`
- `D3 — poll-results recomputes tally from polls/{pid}/votes diffs`
- `D4 — closePoll sets open=false; a later vote is denied`
- `D5 — poll-results.js no longer handles poll-update`
- `D5 — re-delivered vote op is idempotent (count unchanged)`
- `D5 — server.mjs has zero recordResult / pushUpdate`
- `DEF-1 — a module WITHOUT a default stays on branding at load (cascade fallback)`
- `DEF-1 — setModule auto-shows the manifest default (title) beat to a live client`
- `DEF-1 — show_default (Home) re-shows the title after advancing; clear (STOP) → branding`
- `DEL1 — a targeted layer overrides base opts for its user only`
- `DEL2 — auto-follow advances the panel via the branch table (right → beat b)`
- `DEL3 — a plain section (no sequences) still renders beats directly (no .seq)`
- `DEL3 — a section with sequences renders a nested .seq tier with all beats split across sequences`
- `E1 — map/view op mirrors the presenter pan/zoom to a viewer`
- `E2 — a click writes an attributed marker to the store; peer sees it`
- `E3 — presenter pointer op shows on a viewer; pointer op is not logged`
- `E4 — a late viewer seeds the current map view from the snapshot`
- `E4 — a peer marker auto-expires client-side (is-fading)`
- `E5 — server.mjs has no relayMap and no map-* relay message types`
- `F1 — crud renders seeded items; diffs add/remove rows`
- `F2 — add emits an add op with the field values`
- `F2 — editing a field emits a merge op`
- `F2 — remove emits a remove op with the item id`
- `F3 — a PRESENTER overrides another user's lock`
- `F3 — an item locked by ANOTHER user blocks this user's edit`
- `F3 — clicking lock on an unlocked item emits a lock op`
- `F3 — the lock OWNER may edit their locked item`
- `G1 — a gm/ slice diff is broadcast to the presenter, never to a player`
- `G1 — a late player's snapshot omits the gm/ slice; presenter's includes it`
- `G2 — canSeeVisibility gates gm items to controllers`
- `G2 — server no longer strips via an ad-hoc visibility literal`
- `H1 — no legacy relay message literals remain`
- `H1 — rolePassword-gated (no controlToken): unauth POST → 403; ROLE_HASH → 200`
- `H1 — server has no dead relay identifiers`
- `H1/P12 — ungated (no credential) FAILS CLOSED: the write is refused and nothing is written`
- `HAR — CSP on HTML routes; ETag/304 on static assets`
- `I1 — step a 3-beat module; viewer advances in lockstep`
- `I2 — a human builds a 2-beat module from the pick-list and displays it`
- `I3 — AI appends a beat; human displays the merged module`
- `I4 — save a module, reload it in a fresh session, display it`
- `INTER — two users take different stations concurrently; answers stay separate`
- `INV-COMPONENTS — all 14 components render (non-blank) for a participant under default-deny read`
- `KBD1 — keyboard transport: arrows/Space/digit jump/Escape + typing guard`
- `L1 — a participant-writable collection is capped; oldest evicted, newest kept`
- `L1 — a small collection is untouched (no eviction below the cap)`
- `LED1 — /control shows exactly ONE visible connectivity LED (#led2 in #led-btn)`
- `M2 — unknown ackIds are dropped; only an outstanding chime accepts an ack; chimes are capped`
- `M3 — lastResults is bounded and a >64KB value is rejected`
- `M4 — closing a participant pushes a fresh presence roster to the presenter`
- `MON-1 — reset_user retargets a user to the role display, not branding`
- `MON2 — view-as thumbnail renders the target user's live display`
- `MSG — every answering component delivers its answer to the store`
- `MSG-D — cross-client propagation, digest agreement, reconnect convergence, isolation`
- `NEUTRAL — gm role gets NO presence feed and is NOT counted as a controller; presenter/ai still are`
- `OBS-B3 — health surfaces render/apply faults, and benign denials do not degrade it`
- `OBS-B4 — re-opening a poll starts with a clean tally`
- `OPSEC — a participant NEVER receives presence with IPs; a presenter does`
- `P1 — /control pushes a component + opens a poll (same store effect as MCP)`
- `P1 — a non-presenter control message is ignored (S1/S2)`
- `P2 — presenter B and the AI observe presenter A's copresent signal; participant does not`
- `P3 — chat disabled with no listener, enabled + delivered when a listener attaches; not to non-listeners`
- `P4 — role picker: participant → presenter via Config overlay (client + server)`
- `P4 — token pass-through: control token gates presenter, ?token= grants it`
- `P5 — a participant gets NO Show-Control button`
- `P5 — expand /control overlay from Config, then collapse back to Config`
- `P5.5 — presenter password gate: prompt → denied (wrong) → granted (correct)`
- `PRIM-mirror — target user display html is pushed back to the requesting control client`
- `PRIM-results — result reaches presenter/ai/gm only; participant gets none`
- `PV1 — Live Preview: autofocus push does not scroll; dock is fixed left of #led-btn`
- `QS1 — participant: button hidden`
- `QS1 — presenter-granted: button visible, named window.open to /control with page token`
- `QS1 — silent downgrade (gated server, wrong token): button hidden despite ?role=presenter`
- `S220 — a failing start command surfaces the error and does not claim success`
- `S220 — a hung command is killed at the deadline and does not wedge startup`
- `S220 — active but UNREACHABLE is reported, not silently passed — on BOTH branches`
- `S220 — already up ⇒ no second start, and still verified`
- `S220 — an ingress we did NOT raise is left alone, unless forced`
- `S220 — down: runs stop; absent a stop command it says so instead of pretending`
- `S220 — no ingress configured ⇒ inert, and presenter_start is unaffected`
- `S220 — presenter_start raises the ingress and returns the PUBLIC url`
- `S220 — presenter_start tunnel:false binds locally only`
- `S220 — presenter_tunnel exposes status/start/stop explicitly`
- `S220 — the STATE overrules the exit code, both directions`
- `S220 — up: runs the start command, waits for active, VERIFIES the public url`
- `SCH1 — a module with no durations shows no "~…min" estimate text`
- `SCH1 — timed beats roll up a module total and a per-section estimate`
- `SCH2 — /api/series lists series; series file is NOT listed as a module`
- `SCH2 — /api/series/:id resolves its modules in order (with titles)`
- `SCH2 — GM panel: choosing a series queues module 1; "Next in series" advances to module 2`
- `SHAKE-1a — default-page cascade: branding → title → beat → Home → STOP→branding`
- `SHAPE-A2 — forged roles are downgraded to participant`
- `SHAPE-A3 — gm-only content at depth 2 never reaches a participant payload`
- `SHAPE-A4 — a second socket claiming a live userId does not orphan the first`
- `SHAPE-A7 — an uncredentialed module write is refused`
- `T-ASR-SEAM completed segment -> {t:transcript} to presenter + AP ring (stub ASR)`
- `T-ASR-WARM worker spawned ONCE, serves >=3 segments without re-spawning`
- `T-BACKPRESSURE-COUNTED: ambient overflow shed with an explicit surfaced count; work items preserved`
- `T-BARGE-IN (interrupt): user speech during TTS → barge_in + interruption recorded + speaking cleared`
- `T-BARGE-IN (no false fire): no barge_in when the agent is not speaking`
- `T-BARGE-IN (own-turn): AI reply joins the conversation as a trust:self item in situation + inbox`
- `T-BARGE-IN (zero-when-off): the barge-in cue is fenced — absent from the served OFF page`
- `T-BINARY gated by active session, exempt from durable-op cap, byte-rate capped (RT-6/7)`
- `T-BOUNDED-WORKING-SET: thousands of items ⇒ response under a fixed cap, never full history`
- `T-BUDGET Tier-0 stub is within budget (<=1500B raw / <=800B gzip)`
- `T-BUDGET Tier-1 (capture + worklet) is within budget (<=30KB raw / <=10KB gzip)`
- `T-BUDGET Tier-1 references NO WebAssembly (.wasm)`
- `T-BUDGET the stub does NOT statically import Tier 1 (laziness by construction, RT-10)`
- `T-CAP-EXPIRY — a token whose exp is in the past is rejected`
- `T-CAP-NOSECRET — with no PRESENTER_CAP_SECRET configured, ALL cap tokens are rejected (links disabled)`
- `T-CAP-REVOKE — a revoked nonce is rejected even though HMAC + exp are valid`
- `T-CAP-SCOPE — guest may speak/type but push/poll/reload/drive is REFUSED, and a cap never bypasses the control gate`
- `T-CAP-TAMPER — any payload edit / bad HMAC ⇒ no grant; garbage tokens do not crash the connection`
- `T-CAP-VERIFY — valid unexpired unrevoked token grants role=participant + scope + name; input reaches inbox (attributed)`
- `T-CHAT-FIRSTCLASS typed text lands in the inbox (server-attributed) AND still drives the chat display`
- `T-CLAIM-AGING: presenter_claim sets owner/status (server-tracked); stale PENDING ages out after TTL, CLAIMED survives`
- `T-DUAL-CONSUMER: human digest (HTTP) + AI situation (api) share one queue — resolve/claim reflected both ways`
- `T-E2E-SR (stubbed) fake-audio WAV -> client DSP/VAD -> WARM stub ASR -> transcript in AP`
- `T-FLOOR-CONTROL: overload emits wrap/hold + gates new input at the source; load clears → go`
- `T-HUMAN-DIGEST: control.html renders a bounded digest (room + prioritized queue + one-click resolve)`
- `T-INBOX-LONGPOLL a pending waiter is drained (resolved) on server close (no dangling wait)`
- `T-INBOX-LONGPOLL immediate-if-ready / blocks-then-wakes / timeout-empty / no waiter leak`
- `T-INBOX-PERSIST typed text is ephemeral by default; opt-in appends to JSONL (RT-26 uniformity)`
- `T-INBOX-TOOL presenter_inbox({since}) interleaves voice+text by seq with a cursor`
- `T-INBOX-UNIFIED voice + typed text land in ONE ring, seq-ordered, server-attributed`
- `T-LAZY zero voice/wasm bytes while disabled; Tier-1 loads only after enable()`
- `T-LONG-UTTERANCE (F1) a >2s burst arrives WHOLE (no truncation); force-cut still bounds a 30s+ babble`
- `T-MCP presenter_voice_enable + presenter_transcript (cursored) on the tool surface`
- `T-MCP-ZERO-WHEN-OFF: all voice + core tools present when ON`
- `T-MCP-ZERO-WHEN-OFF: voice-capture tools ABSENT when off; core tools present`
- `T-MCP-ZERO-WHEN-OFF: voiceTools contains exactly the two voice-capture tools; none leak into core`
- `T-PRIVACY deny: denied mic surfaces an error, NO capture, NO badge (uncoerceable)`
- `T-PRIVACY grant: badge appears only after capture starts; one-click stop halts it`
- `T-PROACTIVE-FIRST: floor hold engages before the reactive sheddedCount rises`
- `T-PROFILE-SCAFFOLD (a): a session has an active profile (default wearable), readable via api.profile()`
- `T-PROFILE-SCAFFOLD (b): wearable knobs readable + match the plan defaults`
- `T-PROFILE-SCAFFOLD (c): a different named profile returns its own knobs (data-selectable)`
- `T-PROFILE-SCAFFOLD (d): unknown profile name falls back to the default (no throw)`
- `T-RECONNECT open segment starved of frames is flushed/discarded + logged; state resets (RT-14)`
- `T-RESOLVE: presenter_resolve moves the item OUT of pending (server-tracked); gone from situation().queue`
- `T-SCENARIO-GUEST (MILESTONE): cap-granted guest → tight budget/floor engage sooner, injection fenced, drive refused, Argus mediates`
- `T-SCENARIO-GUEST budget plumbing: a long-winded guest gets a WRAP-UP cue then a graceful CLOSE (never silent)`
- `T-SCENARIO-GUEST contrast: a TRUSTED wearable user under the SAME flood is NOT held + gets the GENEROUS budget`
- `T-SCENARIO-RPG (MILESTONE): 6 players + GM → ambient summarized-not-discarded, question-to-GM prioritized, GM digest, per-speaker fenced`
- `T-SCENARIO-TEACHING (MILESTONE): many students + teacher → similar questions cluster, moderation overrides auto floor, class digest, students fenced`
- `T-SCENARIO-WEARABLE (MILESTONE): long solo conversation → nothing shed, low-latency, bounded, faces coherent`
- `T-SECURE (RT-23) enable() errors clearly when AudioWorklet is absent, no capture`
- `T-SECURE enable() rejects on an insecure context and never reaches getUserMedia`
- `T-SERVER-CURSOR: server-held per-consumer cursor — only-new per consumer, fresh consumer sees current, resume-safe`
- `T-SITUATION-CORE-TOOL: presenter_situation is a CORE (always-registered) tool, present when voice OFF`
- `T-SITUATION-DIGEST: one read = display/beat + open polls + tallies + roster + recent turns`
- `T-SUMMARY-RETAIN (shed): P6-shed ambient is represented in the summary with a count`
- `T-SUMMARY-RETAIN: aged-out context retained in a bounded, precomputed, non-blocking summary; shed represented`
- `T-TRANSCRIPT-ALIAS presenter_transcript stays voice-only (back-compat) over the unified inbox`
- `T-TRANSCRIPT-PERSIST OFF=ephemeral / ON=opt-in JSONL survives restart / audio never persists (RT-26)`
- `T-TURN-BUDGET (a)+(b): wrap-up BEFORE the cap, graceful close + notify AT the cap, never silent`
- `T-TURN-BUDGET (c): generous wearable budget is read from the profile; a shorter injected budget trips sooner`
- `T-TURN-COALESCE (a)+(d): same-speaker items coalesce; turnComplete distinct from final`
- `T-TURN-COALESCE (b): a gap > settlingMs starts a SECOND turn`
- `T-TURN-COALESCE (c): interleaved speakers never merge into one turn`
- `T-UNTRUSTED-DELIMIT (contract): presenter_situation + presenter_inbox descriptions state inbox = UNTRUSTED, never commands`
- `T-UNTRUSTED-DELIMIT (guest): injection is trust:guest, fenced, neutralized, and FLAGGED`
- `T-UNTRUSTED-DELIMIT (participant): injection is fenced-as-data in situation + inbox, breakout neutralized`
- `T-UNTRUSTED-DELIMIT (self): a verified+allowlisted controller is trust:self, NOT fenced`
- `T-VAD a <300ms blip yields NO segment (hallucination guard)`
- `T-VAD one speech burst between silence -> exactly one segment`
- `T-VOICE-UI voice toggle lives in #ap-config; grant flips it ON + shows badge; deny reverts`
- `T-WEARABLE-E2E speak + type -> a single presenter_inbox long-poll returns both, attributed + ordered`
- `T-WORK-QUEUE-PRIORITY: directed question surfaces AHEAD of ambient; heavy ambient never crowds it out`
- `T-WORKLET DC / <80 Hz is removed (high-pass)`
- `T-WORKLET conservative normalize pulls level toward target RMS (RT-18)`
- `T-WORKLET content above ~7.5 kHz is attenuated before decimation (anti-alias)`
- `T-WORKLET normalize applies NO gain below the noise floor (silence stays silent)`
- `T-WORKLET resamples 48k -> 16k (output length ~ input * 16/48)`
- `T-ZERO-WHEN-OFF (off): audience page carries ZERO voice code + zero /lib/voice-* requests`
- `T-ZERO-WHEN-OFF (on): with voice enabled the page is as today — stub loads + APVoice defined`
- `T-ZERO-WHEN-OFF (regression): the floor cue is fenced — absent from the served OFF page`
- `T0 no local/linked dependencies (fully self-contained)`
- `T0 node_modules is a real directory, not a symlink`
- `T0 own package.json declares ws dependency`
- `T0 ws resolves standalone`
- `T1 --only filters by name substring`
- `T1 0667-A3 — check(name, cond) throws when name is not a string (the EX-1 shape)`
- `T1 0667-A3 — drive.mjs expect(name, cond) throws when name is not a string`
- `T1 expect(true) passes; expect(false) throws an assertion`
- `T1 runRegistered tallies pass/fail + per-tier over an isolated list`
- `T1 — data-tip nodes drive the shared styled tooltip`
- `T1 — tooltip hides on pan/zoom start`
- `T2 client (lib/log.mjs): AP_LOG flag suppresses below-threshold`
- `T2 server OPSEC: gm-only field value redacted from participant view, shown to presenter`
- `T2 server: below-threshold lines suppressed, at/above recorded`
- `T2 — click + pointer emit CONTENT-space fractions under pan+zoom`
- `T2 — cursors:"off" renders none and skips non-presenter emission`
- `T2 — markers stay pinned to the content point under pan/zoom, constant size`
- `T2 — per-user cursors: two peers render tinted + named, self suppressed`
- `T3 MCP presenter_debug returns a state snapshot + op-log tail`
- `T3 overlay: conn open + socketId + captured content message; state inspector present`
- `T3 server.debugDump() has presence, connections, state.polls, opLog`
- `T3 — dense data-tip overlay wires every node (neutral fixture)`
- `T3 — local dev module beat wires its overlay (skips when absent)`
- `T4 — initial view is zoom-to-fit (contain): whole SVG visible at intrinsic aspect`
- `T4 — map viewport fills the display (full-bleed host, label bar only)`
- `T4 — neutralGrid fallback still renders, sized square, contained`
- `T5 — a marker op renders an animated radar ping, tinted per user, content-anchored`
- `T5 — ping fades over the last second and is removed by ~6 s`
- `T5 — ping still at full strength at ~3.5 s`
- `TF1 — Now Playing toggle: hides via config overlay, persists across reload, default visible`
- `TF1 — presenter-screen button: named window.open, same-origin URL, page token; geometry`
- `TOC1 — outline section/sequence jump buttons: show_beat + details state untouched + empty tiers`
- `V — V12 flags a branch target that is not a beat id (dead-end typo)`
- `V — V14 flags a section beatId with no matching beat`
- `V — V5 does NOT flag declared variants sharing a promptId`
- `V — a bad module trips the expected WARN codes and never throws`
- `V — a clean module yields zero warnings and zero info`
- `V — a terminal clear beat is clean (V7 satisfied, not V3-unknown)`
- `V — an empty module warns V2 and still returns (never blocks)`
- `V — driver-owned concerns are INFO not WARN (terminal-clear, gate-timeout)`
- `V0472-cap-lib — expiry and revocation enforced`
- `V0472-cap-lib — no/empty secret disables; malformed input never throws`
- `V0472-cap-lib — round-trip verify returns the scoped payload; role is ignored`
- `V0472-cap-lib — tampered payload / bad signature is rejected`
- `V19 — a module with beats but no durationSec gets the advisory info`
- `V19 — any beat carrying a numeric durationSec suppresses the advisory`
- `V20 — a module with beats but no manifest.defaultBeatId gets the advisory info`
- `V20 — declaring manifest.defaultBeatId suppresses the advisory`
- `X1 — fresh connect gets a full snapshot; reconnect replays only missed ops`
- `X2 — 100 pointer ops: 0 op-log growth, no version bump, bounded broadcast`
- `X3 — presenter_debug surfaces RTT, fan-out, and denial counts`
- `X4 — a silent connection shows stale within N s`
- `X4 — health green when live; reports throughput and sizes`
- `X5 — peer-reactive session: peer-catalysis > teacher-dependency; density > 0`
- `X6 — durable-op flood is throttled; server stays responsive`
- `X7 — S5: conn-namespaced opId — a reused client opId cannot suppress a peer`
- `X7 — proto pollution / default-deny / oversized / malformed all rejected; server responsive`
- `a real name`
- `bounded + eviction: many folded turns keep counts but cap the serialized view; oldest detail evicted`
- `branch: choice value routes`
- `branch: dice FAIL below target`
- `branch: dice OK meets target`
- `branch: ifFlag precedence and default`
- `branch: linear next`
- `branch: no branch returns null`
- `delivery — showBeat routes by target and merges promptId into opts`
- `onShed accumulates the P6 shed count (never silent)`
- `per-speaker rollup is bounded — speakers beyond the cap aggregate, never grow the view`
- `registry — /api/modules discovers + validates; path-traversal id is rejected`
- `rep 01 — choice: click / keyboard / change-of-mind / identity / ready`
- `rep 02 — poll: 5-user aggregation, change-of-mind LWW, close guard`
- `rep 03 — scene: multi-component surface + validation`
- `rep 04 — poll-results: vote-slice diffs update bars + counts`
- `rep 05 — live poll: presenter results update as participants vote`
- `rep 06 — slider -> svg-reactive via in-page bus`
- `rep 07 — mcp surface drives a full poll + push + reload + close`
- `rep 08 — display: narration + card reveal + image`
- `rep 09 — gm scene: narration + card + dice + choice`
- `rep 10 — teaching stepper: lesson -> concept -> knowledge check`
- `rep 11 — a plugin contributes a component and a scene that round-trips`
- `rep 12 — form: validation + multi-field submit`
- `rep 13 — visibility: GM-only content stripped from player channel`
- `rep 14 — map: peer-to-peer named click (user -> all)`
- `rep 15 — shared-list: user A add propagates to B; presenter lock blocks B`
- `seam contract: {kind,onTurnAged,onShed,view} — the swappable interface the engine calls`
- `t0514-00 — the system plugin is installed (every Phase 0 test below needs it)`
- `t0514-01 — a duplicate stationUid THROWS at load`
- `t0514-02 — a missing / unresolvable stationDefaultUid THROWS`
- `t0514-03 — a plugin with NO `stations` key loads clean and the registry is empty (teaching untouched)`
- `t0514-04 / t0514-05 — station-select seats the CALLER only; an unknown uid lands on the default`
- `t0514-06 — NO stationCode appears in any wire frame`
- `t0514-07 — ?stationUID=1&name=Wren ⇒ userId captain-wren, userName Wren`
- `t0514-08 — ?stationUID=4 seats Sensors; empty / non-numeric / unknown / absent ALL seat the default`
- `t0514-08b — the RETIRED string forms are inert: a cosmetic ?station= cannot move a seat`
- `t0514-09 — a missing name ⇒ NAME UNKNOWN, displayed literally, and a stable -anon seat`
- `t0514-10 — reconnecting on the SAME LINK returns the same userId; station + spotlight survive (D3)`
- `t0514-11 — ?role= means ONLY the privilege axis; the station alias is RETIRED`
- `t0514-12 — the station selector is ABSENT when no plugin declares stations`
- `t0514-13 — options carry value={stationUid}, grouped by `group`, ordered by `sortOrder``
- `t0514-14 / t0514-15 — a station with no screen renders the CORE generic placeholder, built from registry values only`
- `t0514-14b — a station WITH an svgFile renders that artwork; a MISSING one degrades to the placeholder`
- `t0514-16 — a station screen is shareable via the 0508 spotlight, and the sharer's STORED descriptor is byte-identical before and after`
- `t0514-17 — the roster carries a STATION column`
- `t0514-18 — TWO plugins declaring stations is a HARD ERROR`
- `t0514-19 — two Gunner links with different names get DISTINCT userIds and neither displaces the other`
- `t0514-19b — two CAPTAIN links with different names likewise (the single-occupancy branch is GONE)`
- `t0514-20 — station-default restores branding for the CALLER only and leaves displayByUser intact`
- `t0514-23 — orthogonal regions advance INDEPENDENTLY: an alert event does not disturb nav`
- `t0514-24 — a nested transition resolves to the correct LEAF`
- `t0514-25 — a guard BLOCKS a transition and the machine stays exactly where it was`
- `t0514-26 — an unknown event is IGNORED, never thrown`
- `t0514-27 — each region publishes its active state to the store at ships/<shipId>/<region>`
- `t0514-28b — the chart is DATA: adding a region is a plugin edit, not a core edit`
- `t0514-29 — a plugin with NO `server` key loads clean and registers nothing (teaching untouched)`
- `t0514-30 — a `server` module that THROWS on import is logged and does NOT take the server down`
- `t0514-31 — station → present_module → THE STATION STILL RESOLVES (the live failure)`
- `t0514-32 — station + a transient per-seat push → module load → the station resolves, the transient push is GONE`
- `t0514-33 — seat A shares via the spotlight → seat B's station is unchanged`
- `t0514-34 — disconnect + reconnect on the same seat link → same userId, same station`
- `t0514-35 — reloading the system plugin returns every seat to the default station, and it is LOGGED`
- `t0514-36 — displayByUser CLEARING behaviour is unchanged (a guard against "fixing" it)`
- `t0514-37 — no station LABEL or CODE appears anywhere under the ship namespace (occupancy is UID-only)`
- `t0514-38 — joining a station WRITES OCCUPANCY TO THE MACHINE, both indexes agreeing`
- `t0514-39 — CORE holds no seat→station store; it asks the plugin and forgets`
- `t0514-41 — maxOccupants is RECORDED AND DELIBERATELY NOT ENFORCED`
- `t0514-42 — NO seat resolver registered ⇒ stations are INERT, and the server stays healthy`
- `t0514-43 — disconnect calls release() and the seat LEAVES occupants`
- `t0514-43b — one PERSON on two sockets is not released until the LAST one goes`
- `t0514-44 — a bad ?stationUID= derives its userId from the RESOLVED station, not the raw param`
- `t0514-45 — a PARTICIPANT can READ the ship alert, and a component watching it is not blank`
- `t0514-46 — the machine writes as `system` (accepted); the same write as `participant` is DENIED`
- `t0526-01 — a deployment that declares no surfaces has an empty registry, and every lookup refuses BY NAME`
- `t0526-02 — a declared surface is addressable by id and resolves to a renderable descriptor`
- `t0526-03 — refusals fire by name: an undeclared id, and a surface that never said it was peekable`
- `t0526-04 — a malformed registry throws AT LOAD, never at the first viewer`
- `t0526-05 — a screen too big for plugin.json is read from a file at load; a missing file degrades to the placeholder`
- `t0526-06 — ⛓ a surface SURVIVES present_module: same id, same bytes, still renders after the module that replaced the screen`
- `t0526-07 — ⛓ a peek changes ONLY the peeker's screen: the other participant and the presenter see nothing`
- `t0526-08 — unpeek returns to what the room is showing NOW, including a beat that moved during the peek`
- `t0526-09 — ⛔ DEFAULT-DENY: a surface that never said it was peekable is refused BY NAME, and nothing renders`
- `t0526-09b — a deployment that declares no surfaces refuses every peek, and unpeek is still safe`
- `t0526-10 — a peek DISTURBS NOTHING: display state byte-identical, module and beat untouched, a later joiner still lands on the beat`
- `t0526-11 — a participant with no station screen of their own can still peek, and the welcome tells them what there is`
- `t0529-01 — 21 turns of live sentinels + a hostile display name: the served situation carries NO bare fence sentinel`
- `t0529-02 — the rolling summary is served FENCED and labelled untrusted, with its content intact`
- `t0529-03 — clustered askers/variants and the roster identity columns are neutralized too`
- `t0529-g1-01 — in a live five-browser session, a player's own browser is refused the catalogue while the GM desk reads it`
- `t0529-g1-02 — a REAL browser types 21 turns under a hostile display name, and the served situation carries no bare sentinel`
- `t0529-g1-03 — SATURATION: the summarizer driven to its cap, fenced, measured against the bound V0473:70 asserts`
- `t0529-p2-01 — on a GATED server the four catalogue reads refuse anonymous and serve a credentialed caller`
- `t0529-p2-02 — an UNGATED server fails closed on all four, and the same fixture proves the content was really there`
- `t0529-p2-03 — a rolePassword deployment gates the catalogue with the SAME credential (no second auth scheme)`
- `t0529-p2-04 — all SEVEN catalogue call sites work on a gated server (the GM desk is whole)`
- `t0529-p2-05 — the SAME seven surfaces come up EMPTY with no credential (t04 is not passing on an open server)`
- `t0529-p3-01 — ATTACK: two people, one seat link, one name → the roster fires `contested:``
- `t0529-p3-02 — BENIGN TWIN: one person, laptop + phone → the detector fires the same way`
- `t0529-p3-03 — the two cases are NOT separable from the roster alone (THE FINDING)`
- `t0532-02 — every installed plugin has every file its OWN manifest declares`
- `t0532-03 — NO milieu register in the MCP tool surface (an agent reads these to choose a tool)`
- `t0532-04 — NO milieu register in user-visible page text (comments excluded, deliberately)`
- `t0532-p3-01 — an UNCONFIGURED server refuses with a reason code AND a message naming what to configure`
- `t0532-p3-02 — a CONFIGURED server refuses identically for "sent none" and "sent wrong", and never names its configuration`
- `t0532-p3-03 — a CREDENTIALED read is unaffected: same 200, same content, and no reason field`
- `t0532-p3-04 — UNCONFIGURED server: the control page shows a notice naming what to configure`
- `t0532-p3-05 — CONFIGURED server, no credential: the notice is up and describes the CALLER, not the server`
- `t0532-p3-06 — CONFIGURED server, credentialed: no notice at all, and the picker fills`
- `t0532-p3b-01 — UNCONFIGURED server: the creator names what to configure, on BOTH call sites`
- `t0532-p3b-02 — CONFIGURED server, no credential: the notice describes the CALLER, not the server`
- `t0532-p3b-03 — the notice costs ~one line, and Save / Load still fits the column at 800x600`
- `t0532-p3b-04 — CONFIGURED server, credentialed: no notice at all, and the picker fills`
- `t0539-bd-01 — the arithmetic adds up, and the shape is {label, value}`
- `t0539-bd-02 — an authoritative total that contradicts the shown arithmetic is SHOWN, not hidden`
- `t0539-bd-03 — an EMPTY modifier list degrades to the plain total (0539 P1.7: land the field now)`
- `t0539-bd-04 — garbage in the model degrades, never throws (this runs inside a live chat log)`
- `t0539-bd-05 — a label is TEXT, never markup: text() has no HTML semantics and render() uses no innerHTML`
- `t0539-bd-06 — signed rendering: a contribution reads as an operation, not a quantity`
- `t0539-bd-generic — the model is NOT roll-specific: a station-skill stack renders identically`
- `t0539-p31 — an empty credential is an ERROR for BOTH the password and the token, symmetrically`
- `t0559-26 — ⛔ a station screen PAINTS: the art has real width AND real height`
- `t0559-28 — the alert pip lands ON the art, inside the frame, at 16:10 and 4:3`
- `t0559-29 — the full-bleed affordance survives WITHOUT the map component on the page`
- `t0559-30 — ⛔ a seated station's alert band SHOWS current state and CHANGES with the ship`
- `t0565-01 — ⭐ THE CAPTAIN GIVES AN ORDER AND THIRTEEN STATIONS CHANGE`
- `t0565-02 — ⛔ THE DENY: a seat without the order is REFUSED, IN WORDS`
- `t0571-01b — the art stays SCRIPT-FREE: the pip is painted from outside, never by the SVG`
- `t0571-02 — ⭐ THE PIP FOLLOWS THE SHIP through UNKNOWN → GREEN → YELLOW → RED → GREEN, on a seat that gives no orders`
- `t0571-03 — ⭐ the tooltip and the colours come from the CHART: the component holds NO copy of either`
- `t0571-03b — every alert state carries a tooltip, and `unknown`’s does not read like an alert level`
- `t0571-04 — ⛔ AN UNHEARD STATION DOES NOT CLAIM A CONDITION: the at-rest pip wears NO condition colour`
- `t0571-05 — ⭐ THE SELECT ISSUES THE SAME ORDER THE BUTTON DID, and the buttons are gone`
- `t0571-05b — ⭐ `unknown` CANNOT BE ORDERED, and it is structural: the order set is exactly the three`
- `t0571-06 — ⛔ THE DENY STILL SPEAKS: a seat without the order is refused IN WORDS, and the select goes back`
- `t0571-06b — ⛔ A REFUSED ORDER SNAPS THE SELECT BACK TO THE TRUE STATE, and says why in words`
- `t0571-07a — ⛔ NO ALERT BAND SURVIVES ON ANY STATION — the four states are one 5.5-unit square`
- `t0571-08 — ⭐⭐ THE SCREEN IS ROOMIER: the alert feature occupies a fraction of what it did`
- `t0572-02 (state) — ⛔ THE DAMAGE REGION'S SYSTEMS ARE THE HULL CLASS'S, and a hull with no drives has no drive rows`
- `t0572-03 — ⛔ A SYSTEM THAT HAS NEVER REPORTED DOES NOT CLAIM FUNCTIONAL, and ASSESS is what changes that`
- `t0572-05 / t0572-06 — ⛔ A NON-DC SEAT IS REFUSED IN WORDS, and the right is the SEAT's, not the person's`
- `t0572-08 / -14 / -02 / -03 / -10 / -12 — ⭐⭐ THE DAMAGE CONTROL STATION, PAINTED, AND BROKEN AND FIXED BY CLICKS`
- `t0572-10 (state) — ⭐ INFLICT -> OBSERVE -> REPAIR, the round trip, through the store`
- `t0572-12 — ⭐⭐ THE PANEL HIT AND THE COMBAT HIT TAKE THE SAME CODE PATH, and only the CAUSE differs`
- `t0572-13 / t0572-05 / t0572-06 — ⛔ A PLAYER CANNOT FIRE THE PANEL, AND A NON-DC SEAT IS REFUSED IN WORDS`
- `t0572-13 — ⛔ A SEATED PLAYER CANNOT FIRE THE INFLICT PANEL; A CONTROLLER CAN; the refusal is IN WORDS`
- `t0572-B1 — the HULL BAR is a real pool with a size, and an unreadable class reads "No report" rather than a wreck`
- `t0575-02 — ⭐⭐ TWO SHIPS COMMISSIONED: each has its OWN alert, identity and occupancy`
- `t0575-02a — ships.json is a LIST, and the old singleton still loads as a fleet of one`
- `t0575-02b — a hand-edited fleet file cannot half-commission a hull`
- `t0575-02c — ⛔ AN UNKNOWN shipId IS REFUSED, never quietly applied to the primary`
- `t0575-02p — ⭐ THE HULL A SEAT IS ON IS THE HULL WHOSE NAME IT WEARS, AND WHOSE ALERT IT SHOWS`
- `t0575-03 — ⭐⭐ MOVE ONE PERSON THROUGH THE SAME CODE PATH, AND FIND THE MODEL INTACT`
- `t0575-03b — ⭐ AND THE BULK CASE IS THE SAME CALL WITH THE LIST LEFT OUT`
- `t0575-03c — ⛔ AN UNKNOWN DESTINATION IS REFUSED, and nobody moves`
- `t0575-03d — ⭐ A PLACE WITHOUT STATIONS IS A VALID DESTINATION (this is the away party)`
- `t0575-03p — ⭐⭐ OCCUPANCY IS DERIVED: change a PERSON, and the station follows`
- `t0575-03p — ⭐⭐ THE CREW CHANGES SHIP AND THE STATION RE-DRESSES TO THE NEW HULL`
- `t0575-03q — a person is refused a seat on a place with no stations, and the refusal is REPORTED`
- `t0575-03r — the LIVE seat path writes a PERSON, and both store projections agree with it`
- `t0575-04 — ⛔⛔ THE GUNNER OF SHIP A IS REFUSED A GUNNER ACTION ON SHIP B`
- `t0575-04b — ⭐ THE PLACE CHECK RUNS BEFORE THE SEAT CHECK, and the ORDER is the whole guard`
- `t0575-04c — the ORIGINAL rule still holds: the wrong seat on the RIGHT ship is refused`
- `t0575-04d — a person the ship has never seen, and other nonsense, are ANSWERS not crashes`
- `t0575-04e — ⛔ THE GUARD FOLLOWS THE PERSON: leave the ship, lose the authority`
- `t0575-04p — ⛔⛔ AN ORDER ADDRESSED TO ANOTHER HULL IS REFUSED, AND THE REFUSAL IS ON THE GLASS`
- `t0575-05 — ⭐ A PERSON ON A WORLD OR AN EVA POINT HOLDS NO stationUid, AND NOTHING BREAKS`
- `t0575-05a — a WORLD and an EVA point are places, and they have NO stations`
- `t0575-05b — a non-ship place cannot acquire stations or a hull class, whatever the file said`
- `t0575-05c — a malformed place declaration is REFUSED and writes nothing`
- `t0575-05d — the COMMISSIONED SHIP is a place, filed under its own shipId`
- `t0575-05e — a PARTICIPANT can READ the place registry (read is default-DENY)`
- `t0575-06 — ⭐⭐ A STUB PROMOTES TO FULL WITH POOLED HITS SPLIT INTO END/STR/DEX`
- `t0575-06b — ⚠ THE TWO TIERS DISAGREE IN THE MIDDLE, AND THAT IS DECLARED, NOT HIDDEN`
- `t0575-06c — a pool that cannot be split is REFUSED, and declared characteristics win`
- `t0575-06d — promotion through the REGISTRY: mid-scene, once, and it builds the machine`
- `t0575-07 — ⛔ needsFullState DEFAULTS FALSE: 40 stubs make 40 RECORDS and ZERO MACHINES`
- `t0575-08a — ⭐ THE DISPLAY FACE IS BUILT FROM THE CHART, and the component holds NO table`
- `t0575-08b — ⛔ HEALTH NOBODY RECORDED READS `unknown`, NOT `unharmed` (the 1c ruling, for people)`
- `t0575-08c — the five conditions, each by its own tier’s published rule`
- `t0575-08d — a person’s two faces are PUBLISHED TOGETHER, and the display one is DERIVED`
- `t0575-08e — the component is DECLARED, so its bytes actually ship`
- `t0575-08p — ⭐ A PERSON’S CONDITION IS RENDERED FROM THE SERVER’S DISPLAY FACE`
- `t0575-09 — ⭐ BRUCE’S SENTENCE: set CONDITION GREEN once, restart, and it is still green`
- `t0575-09b — ⛔⛔ A SHIP AT BATTLE STATIONS SURVIVES A RESTART, STILL AT BATTLE STATIONS`
- `t0575-09c — a CORRUPT persisted state restores as `unknown`, never as a guess and never `normal``
- `t0575-09c2 — every OTHER way a saved state can be wrong also reads as absent`
- `t0575-09d — TWO SHIPS persist INDEPENDENTLY; restoring one never writes the other board`
- `t0575-09d-real — ⭐ THE PHASE-9 TEST, RE-RUN AGAINST THE REAL ships.json`
- `t0575-09e — the state dir is XDG state by default, NEVER the plugin directory or the checkout`
- `t0575-09f — a shipId cannot escape the state directory`
- `t0575-09g — a write failure is REPORTED, not swallowed, and never throws`
- `t0581-C1 — ⭐⭐ A MOVED PERSON KEEPS THEIR stationUid ON THE DESTINATION HULL`
- `t0581-C2 — the destination HAS NO SUCH STATION ⇒ Observer, read from the manifest`
- `t0581-C3 — the destination station is FULL ⇒ Observer. ⛔ Never bump, never refuse`
- `t0581-F1 — ⛔ no acceptance test stands down because gitignored deployment data is missing`
- `t0581-H2 — every accepted-history entry still resolves and sits behind the scan marker`
- `t0584-C1 / t0584-C4 — ⭐⭐ THE CAPTAIN SWITCHES HIS OWN HULL BY CLICKING A SELECT, and the guard follows him`
- `t0584-C1b — ⛔ A SEAT THAT MAY NOT MOVE PEOPLE GETS NO CONTROL, and a hostile client is refused IN WORDS`
- `t0584-C3 — ⭐⭐ THE AWAY PARTY: a world and an EVA point are in the same dropdown, and landing there takes the seat`
