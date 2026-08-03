# Where plan 0526's cited symbols actually live now

**Plan 0534 wave W3-A** · resolved 2026-08-02 against `plan-0532` @ `d4baac3` · read-only.

Plan `0526-presenter-capabilities-for-the-table-layer.md` was written when `app/server.mjs` was
~3,637 lines. Since then **0529** added ~119 lines, **0530 P2** lifted the 244-line HTTP route table
out into `app/http-routes.mjs`, and **0531/0532** edited around all of it. `app/server.mjs` is now
**3,547 lines**. **Every line number 0526 cites is wrong.** This file is the renewal 0526 P0 asks
for: **symbols by name, with their current home.**

⛓ Use the **name**, not the number. This table will expire too.

---

## 1. The symbols 0526 cites, resolved

| Symbol | Cited in 0526 | **Now** | What it is |
|---|---|---|---|
| `request-poll` | `server.mjs:1241` | **`app/server.mjs:1075`** | ws message branch; emits `poll {type:'request'}` to listeners. One line, no store write. |
| `station-select` | `server.mjs:1256` | **`app/server.mjs:1090`** | ws branch; calls `seatResolver.select()` — **the durable re-seat 0526 P4 must not do**. |
| `station-show` | `server.mjs:1284` | **`app/server.mjs:1118`** | ws branch; renders the seat's own station, or `{ok:false,reason:'no-station'}` when seatless. |
| `renderStationTo` | `server.mjs:1902` | **`app/server.mjs:1736`** | 4-line fn: seat descriptor → `renderDisplay`, falling back to `stationPlaceholder`. Call sites: `:1103`, `:1130`, `:2894`. |
| `byPerson` | `server.mjs:985` | **`app/server.mjs:814`** | folds per-socket conns into **one row per `userId`**, adding `conns`/`contested`. |
| `stageSettledTurn` | (0529 context) | **`app/server.mjs:2038`** | sanitises a settled turn into `settledTurnRing`; ages the overflow into the summarizer. |
| the summary path | — | **`fencedSummary()` `app/server.mjs:2429`** · **`buildSituation()` `app/server.mjs:2435`** · summarizer constructed at **`:2027`** (`createHeuristicSummarizer`, `app/summarizer.mjs`) | `fencedSummary` neutralises `speakers[].userName` and annotates at PARTICIPANT trust; `buildSituation` assembles the bounded working set and advances the consumer cursor. |
| `presence` | `server.mjs:2780`-ish | **`app/server.mjs:836`** (fn) · exported on `api` at **`:2780`** | `byPerson(...)` then `.filter(r => r.userId)`. |
| `targets` | — | **`app/server.mjs:914`** | target string → socket list; resolves `all` / role / `station:<uid>` / userId fan-out. |
| `broadcastDiff` | — | **`app/server.mjs:1429`** | per-recipient read-perm-filtered diff fan-out. |
| `stripVisibility` | — | **`app/server.mjs:1483`** | recursive `opts.items` visibility strip, depth-capped at 16, fail-closed. |
| `sendComponentTo` | — | **`app/server.mjs:1502`** | stamps identity + strips visibility, assembles HTML, sends `t:'content'`. |
| `resyncOrSnapshot` | — | **`app/server.mjs:1280`** | replay from op-log if covered, else full snapshot. |
| the `api` object | — | **`app/server.mjs:2773`** (`const api = {`) | ~330 lines of public surface; `situation` at `:2983`, `stations()` at `:2851`, `stationProject` at `:2927`. |
| `createServer` | — | **`app/server.mjs:173`** (export) · `http.createServer(...)` at **`:549`** | the god function. Its body still ends around `:3510`. |
| the station button | `presenter.html:130` | **`app/presenter.html:130` — STILL CORRECT** | `<button id="cfg-station">▣ My station screen</button>`. Handler at `presenter.html:662`; `station-select` sender at `:682`; share button `:131`/`:664`. |
| `telemetry` client msg | `server.mjs:1237` (P5) | **`app/server.mjs:1071`** | ws branch; counters live in `telem`, view fn `telemetryView()` at **`:340`**. |

### Also cited, and outside `server.mjs`

| Symbol | File | Line | Note |
|---|---|---|---|
| `DEFAULT_COMPONENTS` (P2) | `app/validate.mjs` | **18** | |
| `KNOWN_BEAT_KEYS` (P2.4) | `app/validate.mjs` | **37** | `sectionId` is **not** in it; `onDemand` is (0525 P1.3). |
| `docs/component-manifest.json` (P2) | — | — | **generated**, not hand-edited — source is `harness/core-schemas.mjs:34`, builder `harness/gen-manifest.mjs:26`. |
| `DEFAULT_POLICY` (P3) | `app/permissions.mjs` | **20** | 8 participant-writable globs; `DEFAULT_READ_POLICY` at `:33`. |
| `rovingGroup` / `announce` (P3) | `lib/a11y.js` | **23** / **79** | both present, exported on `window.A11y` (`:94`). |
| `scene` component (P3) | `components/scene/scene.js` | — | |
| `seatResolver` (P4) | `app/server.mjs` | declared **312**, registered **1866** | |
| `stationsActive` / `seatStation` (P4) | `app/server.mjs` | **1694** / near **1708** | |
| `projectStation` (P4) | `app/server.mjs` | ~**1779** | transient render; deliberately never calls `select()`. |

---

## 2. What moved FILE, not just line

**Exactly one thing moved file, and it is none of the cited symbols.**

- **`app/http-routes.mjs` (312 lines, new)** — the HTTP route table, lifted verbatim by 0530 P2.
  It holds `/`, `/control`, `/manage`, `/creator`, the static assets, and the `/api/*` routes
  including **`/api/situation` (`http-routes.mjs:269`)** and `/api/work` (`:288`).
  ⚠ **`buildSituation` itself did NOT move** — only the HTTP route that calls `api.situation`.
- **0530 stopped after seam S-A** (`4017b4c`, *P-STOP*). No further decomposition landed, so
  **every other symbol 0526 names is still inside `createServer()`'s closure in `app/server.mjs`**.
  0526's design assumption — that these are reachable from the closure — **still holds**.

**Nothing 0526 cites has been renamed or deleted.** Every symbol resolves.

---

## 3. The two known hazards — checked at source

**(a) "`presence()` projects over SOCKETS not userIds" — ⛔ REFUTED. It projects over PEOPLE.**
`presence()` (`server.mjs:836`) is `byPerson(...)` + `.filter(r => r.userId)`, and `byPerson`
(`:814`) keys an index by `c.userId`, merging every additional socket into the existing row while
incrementing `row.conns` and setting `row.contested = true`. Fixed by **0522 P3**; the comment block
at `:797–811` records it. 0526 §1 already deleted its v1 P1 on this basis and is **correct**.
⚠ Two residues that survive: an **unidentified** socket (`!c.userId`) still gets its own row inside
`byPerson` (filtered out by `presence()`, but **not** by `pushPresence()`'s roster at `:854`), and
`usersAtStation` (`:908`) / `socketsAtStation` are socket-walks that dedupe separately.

**(b) "`const api` sits in its temporal dead zone at wiring time" — ✅ CONFIRMED, verbatim.**
`http.createServer(createHttpHandler({...}))` is at **`server.mjs:549`**; `const api = {` is at
**`server.mjs:2773`** — **2,224 lines below it**. The ctx is passed a **getter**, with the reason in
the code at `:555–558`:

> `⚠ A GETTER, NOT A VALUE. `const api` is declared ~2,400 lines below this call, so it is in the
> temporal dead zone right now and reading it here would throw.`

⇒ **Any 0526 phase that adds something to `ctx` for `http-routes.mjs` and needs `api`, or needs
anything else declared low in `createServer`, must pass a getter, not a value.** A plain reference
throws `ReferenceError` at boot, and it will throw at **module load**, not under test.

---

## 4. Things that will make 0526's later phases harder than the plan assumes

1. **⛔ 0526 §3's premise is HALF STALE — and the half that is left is the harder half.**
   The plan says `docs/component-manifest.json` **and** `DEFAULT_COMPONENTS` each list 14, both
   missing `navmap` and `prose`. Measured now: `components/` = **16**, the manifest = **16**
   (`navmap` and `prose` both present), `DEFAULT_COMPONENTS` = **14**, still missing **both**.
   0525 P5 (`b5169fd`) fixed it by adding entries to **`harness/core-schemas.mjs`** — it **never
   touched `app/validate.mjs`** (`git show b5169fd -- app/validate.mjs` is empty).
   ⇒ P2.1 must add **`navmap` AND `prose`** to `DEFAULT_COMPONENTS`; the "do not re-add navmap"
   caution applies to the **manifest**, not to the validator.
2. **⚠ P2.2's test partly exists and does not cover the list that is wrong.**
   `test/unit/0525-p5-core-schema-coverage.test.mjs` already asserts
   `components/` ≡ `coreSchemas` ≡ generated manifest. **`DEFAULT_COMPONENTS` is in none of the
   three.** P2.2 should extend that test rather than mint a fourth list-comparison.
3. **⚠ The manifest is generated. Hand-editing `docs/component-manifest.json` will be reverted**
   by `harness/gen-manifest.mjs`. Edit `harness/core-schemas.mjs`.
4. **⚠ A live defect that collides with P2's acceptance** (`docs/deferred-defects.md`, 0534 W1-A):
   `moduleSummary()` (`server.mjs:394`) calls `summarize(validate(module))` **with no
   `knownComponents`**, so every **plugin-registered** component is reported `V3-unknown-component`
   forever — `s15-full` shows 5 such warnings on a module that is fine. **Any acceptance criterion
   phrased as "zero warnings" cannot be met until this is fixed.**
5. **⚠ `sectionId` is genuinely absent from `KNOWN_BEAT_KEYS`** (`validate.mjs:37`) — P2.4 stands.
6. **⚠ `peek` / `unpeek` / `surfaceId` do not exist anywhere** in `app/`, `lib/` or `components/`
   (grepped). P4 is greenfield, and P4's naming seam is real: `station-select` (`:1090`),
   `station-default` (`:1110`), `station-show` (`:1118`), `station-share` (`:1137`),
   `station-project` (control action, `:1369`) are **five** existing put-something-on-a-screen
   messages, all in one `else if` chain between `:1090` and `:1180`.
7. **⚠ `stationsActive()` gates `station-show` (`:1128`) — a seatless participant currently gets
   `{ok:false, reason:'no-station'}`.** P4's acceptance requires a **seatless participant to peek**,
   so `peek` cannot simply be routed through the existing `stationsActive()` guard.
8. **⚠ `renderStationTo` takes `(ws, c, seat)` and reads `seat.descriptor`** — it is *seat*-shaped,
   not *surface*-shaped. P4's "reuses `renderStationTo`" needs either a surface→descriptor adapter
   or a second entry point; the current signature will not accept a `surfaceId`.
9. **⚠ The plan's baseline "~505 executed" predates 0529/0530/0531/0532.** Re-measure at P0; do not
   report a delta against 505.
10. **ℹ `GENERATOR-BRIEF.md` §2 says `server.mjs` is 3,677 lines and `createServer()` is 3,472.**
    Both are stale — it is **3,547** now. The brief's *instruction* (never read it end to end)
    stands.
