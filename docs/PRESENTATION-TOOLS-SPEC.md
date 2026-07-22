# Argus Presenter — Presentation Tools Spec

**Status: SPEC / planning — no implementation until approved.**
Version 0.1 · 2026-07-19 · Scope: bell control, verify-watching tool, attendance.

This spec collects the "actual-presentation practical tools" for AP. It starts from
one principle and adds capabilities that obey it.

---

## 0. Design principle — AP is a musical instrument

Every capability is a **control** in one shared vocabulary (`handleControl`'s action
set). Each control is playable **two ways**, both routing to the same `api.*` method:

- **Human** — a button on the control page → `{t:'control', action, args}` → `handleControl`.
- **AI** — an MCP tool in `mcp/tools.mjs` → the same `api.*` method.

A new capability **joins this vocabulary**; it is not bolted on beside it. (This is the
correction that motivated the spec: the bell was MCP-only, not a control.)

---

## 1. Surface overview

| Capability | Control action | MCP tool | Control-page UI | Kind |
|---|---|---|---|---|
| Ring bell | `bell` | `presenter_bell` | 🔔 button | notifier (fire-and-forget) |
| Verify watching | `bell` + `requireAck` | `presenter_verify_watching` | 👁 button | on-demand handshake |
| Eyes-on result | — (query) | `presenter_check_ack` | shown in roster | query |
| Attendance | — (query) | `presenter_attendance` | Attendance overlay | passive / continuous |

---

## 2. Bell control  *(decided: "bell control + verify tool")*

The bell is a **pure notifier**: a gentle chime + persistent banner to get a
backgrounded human's attention. No acknowledgement.

- **Control action:** `case 'bell': api.chime(a)` in `handleControl`.
- **MCP:** `presenter_bell({message?, target?})` → `api.chime({message, target})`.
- **Control page:** a 🔔 button (the GM can ring it too).
- **`api.chime` gains `bell` (default true):** carried in the `{t:'chime'}` frame so the
  client can show the banner **without** sound when a caller wants silent (used by
  verify-watching's `bell:false`). Client `onChime` plays audio unless `m.bell === false`.
- Audio still needs one page click to unlock (Chrome autoplay); the banner is the
  reliable no-interaction signal.

## 3. Verify-watching tool  *(eyes-on / not-AFK, on-demand)*

A **tool that plays the bell control** with a confirmation handshake. The banner shows a
CONFIRM ("I'm watching") button; the click is a timestamped eyes-on ack.

- **Mechanism:** `api.chime({..., requireAck:true, ackId})` (already built) — refactor the
  current `presenter_ready{requireAck}` into this named tool.
- **MCP:** `presenter_verify_watching({message?, target?, ackId?, bell?})`. `bell:false`
  = ask silently (banner only).
- **Control page:** a 👁 button.
- **Poll result:** `presenter_check_ack({ackId})` → `{acked, by:[…ts], pending:[…]}`.
- Each confirmation also updates the viewer's `eyesOn` timestamp (feeds Attendance).

> **Migration note:** `presenter_ready` (with baked-in `requireAck`) is replaced by
> `presenter_bell` + `presenter_verify_watching`. Update `DRIVING-VIA-MCP.md` and memory.

---

## 4. Attendance  *(NEW — passive, continuous liveness)*

### 4.1 Purpose
Verify-watching is *on-demand and binary* ("prove it now"). **Attendance is passive and
continuous** — always-available room awareness with no prompt. It answers: who is here,
and **how many seconds since each person last touched an interactive control.**

### 4.2 Mechanic — `lastActive` per connection
We already track `lastSeen`, but that updates on the passive RTT **pong** (keepalive), so
it cannot distinguish "connected but AFK." Attendance needs a **separate** timestamp
bumped **only on deliberate human interaction** *(decision: deliberate actions only)*:

| Bumps `lastActive` | Does NOT bump it |
|---|---|
| store ops — chat, slider, form, **pointer** (`handleOp`) | pong / ping (keepalive) |
| eyes-on CONFIRM click (`{t:'ack'}`) | reconnect |
| poll vote (an op → `handleOp`) | presence refresh |
| beat answer / continue (`{t:'result'}`) | server-driven redisplay |

So **`lastSeen` = connection alive; `lastActive` = human alive.** Attendance keys off
`lastActive`. (Pointer moves count — they are deliberate ops.)

### 4.3 Status — configurable thresholds
Tool/overlay params `activeSec`, `afkSec`. **Defaults: active < 30s · idle 30–120s ·
AFK ≥ 120s.** Derived per user from `idleSec = now − lastActive`.

### 4.4 Roster data model (per user)
```
{ userId, userName, role,
  connectedSec,          // since connect
  idleSec,               // since lastActive  ← the headline number
  status,                // 'active' | 'idle' | 'afk'  (from thresholds)
  eyesOnAgoSec | null,   // since last explicit verify-watching confirm
  display,               // what they're currently seeing
  ip, socketId }         // CONTROL-ONLY (redacted for participants — see 4.5)
```
Plus a summary: `{ active, idle, afk, total }`.

### 4.5 Access & role-gating — the Attendance overlay
Reached via the **green connectivity dot → Config overlay → an "Attendance" icon**, which
opens a **big clean roster overlay**. Available to **both** presenter and participant, with
**role-gated content**:

- **Presenter / ai (control):** full roster — IP, socketId, display, status, eyes-on —
  **plus per-user action buttons** (see 4.7).
- **Participant:** **read-only, redacted** — names, roles, status only. **No IP,
  no socketId, no exact display id.** A "who's in the room" view.

**Delivery — request/reply (not constant push).** Respects the existing rule that
participants get no standing presence feed. When a user opens the overlay, the client
sends `{t:'attendance-request'}`; the server replies `{t:'attendance', roster, summary}`
**role-redacted for the requester**. While the overlay is open, the client re-requests
every ~2s (and re-renders ages on a 1s tick for smooth counting). Closing stops it.

> **RESOLVED (2026-07-19, plan 0466) — participant roster visibility.** Presenter-gated,
> **default OFF**: attendees do not see each other's roster unless the presenter turns on a
> "roster visible to attendees" setting. Presenter/ai **always** see the full roster
> regardless. With the gate OFF, a participant `attendance-request` is answered self-only.

### 4.6 MCP tool
`presenter_attendance({activeSec?, afkSec?})` → full roster + summary (the AI is a
controller, so it gets the unredacted view). Poll-on-demand *(decision)*; proactive AFK
push alerts are **deferred**.

### 4.7 Control-page action buttons (in the overlay, control version)
Per-user row buttons that "do stuff" — each is a control routed through `handleControl`:
- **↺ Reset to default** (`reset_user` — already exists).
- **👁 Verify this user** (`bell`+requireAck targeted at that userId).
- **🔔 Ring this user** (targeted `bell`).
- *(future: spotlight / mirror their view / remove — out of scope v0.1.)*

### 4.8 Wiring map
1. **`app/server.mjs`** — init `c.lastActive` at hello; bump it in `handleOp`, the `ack`
   handler, and the beat-result handler; add `lastActive` to `presence()`/`pushPresence`;
   add `api.attendance({activeSec, afkSec, viewerRole})` returning full-or-redacted roster;
   add `{t:'attendance-request'}` handler that replies role-redacted.
2. **`mcp/tools.mjs`** — add `presenter_attendance`; (from §2–3) rename `presenter_ready`
   → `presenter_bell`, add `presenter_verify_watching`.
3. **`app/presenter.html`** & **`app/control.html`** — Attendance icon in the Config
   overlay; the roster overlay (role-aware render); 1s age tick + 2s re-request while open;
   control version adds the §4.7 buttons.
4. **Client interaction paths** — no change; ops/ack/results already flow (they just now
   also bump `lastActive` server-side).

---

## 5. Decisions — RESOLVED 2026-07-19 (voice session; see plan 0466)
1. **Participant roster visibility** (§4.5) — **presenter-gated, default OFF**; presenter/ai
   always full. Gate OFF ⇒ participant request answered self-only.
2. **Reconnect & `lastActive`** — **reconnect is NOT activity.** A reconnecting user is a new
   connection; stays AFK until they actually interact. `connectedSec` resets. No carry-forward
   by userId.
3. **Tool names** — **`presenter_bell`, `presenter_verify_watching`, `presenter_attendance`.**
   `presenter_ready` is removed (accepted breaking change).
4. **Redaction set for participants** — **names + role + status only**, status shown as a
   colored dot (🟢 active / 🟡 idle / 🔴 afk). No IP, no socketId, no exact display id.

## 6. Deferred (not v0.1)
- **Throttle the CONTROL/presenter view's information exposure (OPSEC).** Presenter/ai currently
  get full access to everything; accepted for now (single control user). A future plan must limit
  what the control view exposes. Record a `TODO(opsec)` at the unredacted-roster assembly point.
- Proactive AFK **push** alerts to the AI/control (poll-only for now).
- Additional per-user controls (spotlight, mirror, remove).
- Full "instrument consistency" audit of every existing capability.
- **North star (long-horizon):** Presenter → fully-remote CLI-equivalent surface (phone + Discord
  voice + browser; speak-in / respond-in-presenter, "dressed like the command line"). Needs strong
  validation before trusted for live remote use.
