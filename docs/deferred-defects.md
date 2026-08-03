# Deferred defects — X1 and X5

Two defects were found during plan 0529, judged real, and **deliberately left unfixed**. Bruce's
ruling, S227: *"I've no idea what to do about this. Document & defer."* Plan 0532 P5 is that
write-up and it changed no code.

This file exists so the next person can decide whether either one is urgent **without
re-deriving it**. Every claim below was re-checked against the source on **2026-08-02** and every
number was measured, not quoted from an earlier report — where the earlier report was wrong, this
file says so.

Explained here:

- `test/live/X1-resync.test.mjs`
- `test/live/X5-raf.test.mjs`

⚠ **Neither test asserts the defect it is named for.** Both are currently red for an unrelated
reason (see *Not this defect* under each), so a green run would not tell you either of these was
fixed. Nothing in the suite watches them.

⚠ **Line numbers move.** They are given because a description without one is unusable, not because
they are stable. `app/server.mjs` was **3,547 lines** when this was written. The earlier note on X1
cited `:1180-1183` and `:1198`; plan 0530 P2 extracted the HTTP route table into
`app/http-routes.mjs` and everything after it shifted up by roughly 150 lines. **The mechanism was
unchanged; the numbers were wrong.** Expect the same of these. Grep for the function names.

---

## X1 — a reconnecting client receives the same ops twice

### What happens

A client that reconnects and reports a `lastVersion` is meant to receive **only** the ops it
missed. It also receives, a second time, every op that was committed while it was connecting.

### Where it is now

| what | where |
|---|---|
| the socket joins the broadcast set | `app/server.mjs:932` — `conns.set(...)`, at **connect**, before any `hello`, with the default `role: 'participant'` |
| the `hello` handler seats the connection | `app/server.mjs:1010-1017` — `seatResolver.select(...)` |
| ...and sends the welcome | `app/server.mjs:1021` |
| ...and only **then** computes the resync window | `app/server.mjs:1032` — `resyncOrSnapshot(ws, c, m.lastVersion)` |
| the window itself | `app/server.mjs:1280-1296` — `store.oplogSince(lastVersion)`, evaluated **at call time** |
| the live broadcast | `app/server.mjs:1429-1441` — `broadcastDiff()` iterates **every** socket in `conns` |

⛓ **The exposed window is wider than the earlier note said.** It does not open at seating; it opens
at `:932`, when the socket joins `conns`. *Anything* committed between the socket connecting and
`:1032` — an HTTP request, a tool call, a timer — is broadcast live to that socket and then replayed
to it. Seating is simply the one producer that fires on **every** connection, which is why it is the
copy you always see.

### Observed, not argued

Reproduce it in about fifteen lines: open a socket, wait, then send `hello` with a `lastVersion`
from before the connection. A run on 2026-08-02, with the deployment's own plugin loaded:

```
lastVersion reported: 5
diff versions received, in order: [6, 7, 6, 7]     <- 6 and 7 delivered twice
resync: {"t":"resync","from":5,"to":7,"count":2}
op-log:
  v1..v3  by=<plugin>   (boot)
  v4, v5  by=ctl        crud/a, crud/b
  v6      by=<plugin>   .../stations/13/occupants   <- written during seating, at :1015
  v7      by=<plugin>   .../seats/u1/stationUid     <- written during seating, at :1015
```

Both duplicated payloads were byte-identical to their live copies.

### Why it is harmless today — and why the stated reason was not the right one

The earlier note said the duplicate is safe because the ops are idempotent `set`s, and that `add`
verbs *"exist in the op-log and would not be"*. **The second half does not hold.** What travels on
the wire is a **diff**: an absolute `path → value` map. Every verb is resolved to absolute
assignment before it leaves the server (`app/state.mjs:145-190`) — `add`'s diff is
`{ '<path>/<id>': value }` and `remove`'s is `{ '<path>/<id>': null }`. Replaying either one twice
assigns the same path the same value. **The wire format, not the verb, is what makes the duplicate
safe**, and it is safe for all seven verbs (`app/state.mjs:259`).

### What would have to be true for it to bite

Judge urgency from these four, in order of how close each is:

1. **A component that treats a diff as an event rather than as state.**
   `lib/bridge.js:105-116` — `subscribeState(prefix, handler)` invokes `handler(path, value, msg)`
   once **per message**. Folding a value into state is idempotent; counting, appending to a list,
   starting an animation, playing a sound or advancing anything is **not**. One such handler and
   this defect is live. ⇒ **This is the one to check first**, and it is a property of content, not
   of core — so it can become true without any change to the server.
2. **A verb whose diff is relative rather than absolute** — an increment, an append-delta, a
   set-union. None exists today; the seven verbs are all absolute. Adding one turns a latent bug
   into a corruption bug on the same day.
3. **Reordering.** An `add` that hits the collection cap emits eviction `null`s in its own diff
   (`app/state.mjs:163-172`). Delivered live-then-replay, in order, the second copy is identical and
   harmless. If the two ever interleaved differently, a stale eviction could remove a key a newer op
   had re-added.
4. **Telemetry.** `X3`'s fan-out figure counts the duplicate broadcasts, so fan-out reads slightly
   high on every connection. Cosmetic, but it is a number someone may quote.

### The shape of a fix — deliberately not applied

Either capture `store.version()` **before** the socket can receive a live broadcast and compute the
window from that, or hold this socket's broadcasts until `resyncOrSnapshot` has run. Both are small
edits in an awkward place: the first needs a version captured at `:932` and carried through the
`hello` handler; the second introduces a per-socket queue and its own ordering questions. Neither is
free, and nothing today is broken by leaving it — which is the whole reason it was deferred.

### Not this defect

`X1-resync.test.mjs` is red right now on `expect failed: version=3 after seed` (actual **8**),
because the loaded plugin writes 3 ops at boot before the test seeds its own. That is one of the
known plugin artifacts and has nothing to do with the duplication.

---

## X5 — `presenter_raf` understates both of its own ratios

### What happens

`presenter_raf` reports `peerCatalysisRatio` and `teacherDependencyRatio`. Both divide by the
**entire** op-log, including ops attributed to neither participants nor facilitators. Those ops are
in the denominator of both ratios and the numerator of neither, so **both ratios read lower than the
behaviour they describe** — and they fall further the longer a session runs.

### Where it is now

`app/server.mjs:3470-3492`, the `raf:` member of the returned api object. The arithmetic:

```js
const total       = entries.length;                                  // EVERY role
const peerVisible = entries.filter(e => e.role === 'participant' && canRead(...)).length;
const teacher     = entries.filter(e => CONTROLLERS.has(e.role)).length;   // 'ai' | 'presenter'
peerCatalysisRatio      = peerVisible / total;
teacherDependencyRatio  = teacher     / total;
```

The third role is `system`. `serverApply(op, actor)` defaults its actor to
`{ userId: 'server', role: 'system' }` (`app/server.mjs:1309-1310`), and it is called for:

| what | where | ops |
|---|---|---|
| advancing one beat | `:1621` | 1 per beat |
| loading a module | `:3292-3293`, `:3389` | 2-3 |
| opening a poll | `:2809-2814` | 4-5 |
| closing a poll | `:3268` | 1-2 |
| any plugin write | `:1835` | plugin's own |

### Measured 2026-08-02

Using `X5-raf.test.mjs`'s own fixture — one facilitator op, four participant ops, of which two are
peer-visible:

| state of the op-log | `totalOps` | `peerCatalysisRatio` | `teacherDependencyRatio` |
|---|---|---|---|
| what the fixture is designed to show | 5 | **0.400** | **0.200** |
| as the test actually runs (3 system ops at boot) | 8 | 0.250 | 0.125 |
| after **one** poll is opened and closed (+7 system ops) | 15 | 0.133 | 0.067 |

Understatement: **1.60x** in the middle row, **3.01x** in the last. Both ratios, by the same factor,
since the fault is entirely in the shared denominator.

⛓ **It is not a fixed 1.6x.** One poll costs more denominator than the whole plugin boot, and every
beat advanced adds another system op. **The ratios decline as a session gets longer with no change
whatsoever in how people are behaving.**

### Why this one matters more than a red test

`presenter_raf` is the instrument for the direction the product is being taken:
participant-to-participant interaction. As it stands it is a gauge that drifts down with session
length.

⇒ **Do not read any `presenter_raf` number as a real change until this is fixed.** Two sessions are
comparable only if they carry the same count of bookkeeping ops, and they never do. A longer session
will look like less peer catalysis; a session with more polls will look like much less.

Distinguish this from a real effect already on the record: plan 0471 C3 (default-deny reads) moved
measured peer catalysis 0.8 → 0.4 because private votes genuinely stopped being peer-visible. That
was behaviour. **This is arithmetic**, and mistaking the second for the first is exactly the failure
this note exists to prevent.

### The shape of a fix — deliberately not applied

Either drop non-human roles from the denominator —

```js
const attributable = entries.filter(e => e.role !== 'system');
```

— or keep `total` and report the system count beside it so a reader can normalise. Both are a couple
of lines. Neither is a patch, because **either one changes every number `presenter_raf` has ever
produced**, including any already written down. That is a decision about a published instrument, not
a bug fix, which is why it stopped here.

### Not this defect

`X5-raf.test.mjs` is red right now on `expect failed: five ops logged` (actual **8**) — the same 3
boot ops. Fixing the denominator would not make it green; the test asserts `totalOps === 5`, and
`totalOps` is the raw op-log count by design.

### `/api/modules` warns on every PLUGIN component — `validate()` is called without `knownComponents`

`moduleSummary()` (`app/server.mjs:394`) calls `summarize(validate(module))` with no context, so the
known-component set is `DEFAULT_COMPONENTS` — core only. Any module using a plugin-registered
component is reported as `V3-unknown-component` in the picker forever: one 53-beat authored module
shows `warn: 5`, all five of them `ship-status`, on a module that is fine. `validate()` already accepts
`{ knownComponents }`; the plugin registry already knows the names. Found while building
`repertory/tools/resolve-refs.mjs` (0534 W1-A) — out of scope there. ⚠ Anything whose acceptance is
"zero warnings" must therefore avoid plugin components, or fix this first.

### A beat taller than the viewport loses its top, unreachably — the content page is flex-centred

Measured 0534 W2 with the crew deck at 1280x720: closed, the page fits (`scrollHeight == clientHeight`).
Open one `card.reveal` and `scrollHeight` becomes 1014 while `window.scrollY` is already **0** and the
scene title's `getBoundingClientRect().top` is **-246** — the overflow goes *above* the scroll origin,
so no amount of scrolling brings it back; `maxScroll` is 294 and all of it is downward. Still true at
1920x1080 (`titleTop: -66`) and marginal at 1920x1200 (`-6`). The usual cause is a vertically-centred
flex container (`align-items:center`) around content that can exceed the viewport; the fix is the
standard `margin:auto` on the child, or `justify-content:flex-start` past a threshold. Out of scope
for W2 — the deck itself fits at both ratios with reveals closed.
