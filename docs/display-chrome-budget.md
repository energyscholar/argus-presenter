# The display chrome budget — the stage is the product, chrome is the exception

**Bruce, S229 2026-08-03:** *"there's the issue of keeping the presenter display screen clean, without
lots of floating dohickies. We did have it as just the green dot, no other always-present controls.
Clean. Now we also have other components beginning to clutter the display. Careful of that."*

**He is right, and this document exists so the next addition has to argue its case.**

## Measured, not remembered — a BARE deployment, 1280×800, no plugin, no content

| element | position | size | what it is |
|---|---|---|---|
| `led-btn` | fixed, top-right | 26×26 | settings opener |
| `led` | top-right | 10×10 | **the green dot** — the original, and for a long time the only one |
| `ap-seat-k` | top-left | 30×14 | "Role" |
| `ap-seat-v` | top-left | 94×18 | "👁 Observer" |
| `who` | fixed, bottom-left | 240×12 | `participant · Guest (anon-…)` |
| `ap-echo` | fixed, bottom | 1280×6 | full-width strip |
| `ap-chat-input` | bottom | 1074×30 | the participant's only way to talk back |
| `ap-chat-send` | bottom | 60×30 | "Send" |

⇒ **8 always-present elements occupying all four edges, ~44 px of permanent furniture across the
full width at the bottom.** This is the FLOOR — before a single plugin, surface or content module.

### ⛳ RE-MEASURED after plan 0537 P4.1 — **8 → 7, and the bottom bar is gone**

Same page, same 1280×800 bare deployment, measured with the same method (every laid-out element in
the fixed chrome layer, excluding the stage). **The rule says a rising count must be said out loud;
this one FELL, which is worth saying just as plainly.**

| element | position | size | change |
|---|---|---|---|
| `led-btn` | fixed, top-right | 26×26 | — |
| `led` | top-right | 10×10 | — |
| `ap-seat-k` | top-left | 30×14 | — |
| `ap-seat-v` | top-left | 94×18 | — |
| `who` | fixed, bottom-left | 153×12 | — |
| `ap-echo` | fixed, bottom | 1280×6 | dropped from `bottom:38px` to `bottom:6px` |
| `ap-chat-input` | ~~bottom, 1074×30~~ | — | ⛳ **SUMMONED** — moved into the right-edge panel |
| `ap-chat-send` | ~~bottom, 60×30~~ | — | ⛳ **SUMMONED** |
| `ap-chat-tab` | fixed, right edge | 20×85 | ⚠ **NEW** — the one always-present part that remains |

⇒ **7 always-present elements. Bottom furniture 44 px → 20 px** (`who` + the echo strip; the
full-width bar is gone entirely).

**Why the tab is allowed to be permanent when the input is not.** The reply channel is on this
document's own short list — *"a participant with nothing to say back is an audience, not a
participant"* — so it cannot simply be deleted. But that argument justifies **discoverability**, not
**a text box**: what a participant must know without being told is *that they can speak*, and a 20×85
edge tab says that in 1/12th the pixels a 1134×30 bottom bar spent saying it. The panel behind it is
summoned, costs nothing when closed, and ESC or the tab closes it.

⚠ **Two counts, one page — state your method or the comparison is worthless.** A raw sweep of the
fixed layer returns **10 before / 8 after**, because it also counts the `ap-seat` and `ap-chat`
*containers* that the table above lists only by their children. The 8→7 figures are on the table's
basis. Both deltas are −2 and −1 respectively; neither number is wrong, and quoting one against the
other would invent a regression that did not happen.

⚠ Note `ap-seat` renders **"Role 👁 Observer" on a deployment with no stations declared**, though
`paintSeat()` documents *"No registry, or a uid this deployment does not know ⇒ render NOTHING …
a blank badge is worse than no badge: it reads as a broken seat."* **Worth checking whether that
guard is doing what it says.**

## ⛓ The rule

**An element earns PERMANENCE only if the participant needs it WITHOUT KNOWING THEY NEED IT.**

That is a short list, and it is short on purpose:
- **liveness** — you must know you are connected, because a frozen screen and a quiet moment look
  identical (the green dot's whole reason for being);
- **identity** — who the room thinks you are, because acting as the wrong person is silent;
- **the reply channel** — a participant with nothing to say back is an audience, not a participant.

**Everything else must be SUMMONED or TRANSIENT.** If a participant can be expected to *want* it at a
moment they can recognise, it does not belong on screen the rest of the time.

## ⭐ The answer to "where does this UI go?" is PEEK, and it already works

`peek` is the proven alternative and it costs no chrome: **participant-initiated, full-screen,
default-deny per surface, with a badge that names what you are looking at and clicks to go back, and
it leaves nothing behind.** Verified by screenshot 2026-08-02 rendering the crew deck in full.

⇒ **A new surface should be PEEKABLE, not permanent.** One row in a plugin manifest, zero pixels
spent when nobody is looking.

## The distinction that decides cases

- ✅ **Making existing chrome do more is CHEAP** — it spends no new pixels. Plan 0535 expands the
  role chip that is *already there* into a seating chart. **That is the good pattern.**
- ⛔ **Adding a new always-present affordance is EXPENSIVE**, and the cost is permanent and paid by
  every participant in every session, including the ones who never use it.

**Applied, S229:** the air raft was proposed as *"a small display token in upper left, near Roles"*
plus a full panel. ⛳ **The token was CUT and the full-screen peek kept** — you summon the raft when
it matters, and a vehicle nobody is flying occupies no corner of anyone's screen.

## Before adding anything always-present, answer these

1. **Would a participant notice its absence without being told?** If no → make it peekable.
2. **Can it ride an element already on screen?** Expanding beats adding.
3. **Is it needed in EVERY session, or only in some?** Only-in-some ⇒ it is content, not chrome.
4. **What does it cost the participant who never uses it?** That cost is the real price, and it is
   paid forever.
5. **Does it survive the count?** Re-run the inventory above. **If the number went up, say so out
   loud** — this crept from 1 to 8 without anyone deciding to.
