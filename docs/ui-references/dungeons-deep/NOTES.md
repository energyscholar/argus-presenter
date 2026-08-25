# Dungeons Deep — UI reference for the Traveller / starship-ops plugin

Screenshots captured by Bruce 2026-08-23/24 from **Dungeons Deep** (beta), the product of
**Portalis AI, Inc.** (Austin TX; J. Todd Coleman + Josef Hall, creators of Wizard101).
`portalis.ai` 301-redirects to `dungeonsdeep.ai` — the company has effectively become the game.
Compressed to WebP 2026-08-25 (7.6 MB → 0.59 MB, 1600px wide) — originals were transient.

> ⏸ **DISCUSSION DEFERRED.** Bruce, 2026-08-25: *"I agree with most of your analysis but also saw some
> things you missed. We'll discuss this later. For now defer, as we need to get AP fully structured
> first."* ⇒ These are Argus's observations only. **`dd-02` and `dd-03` are not yet reviewed.**

| file | what it shows |
|---|---|
| `dd-01-2026-08-23.webp` | shrine scene, NPC portrait in chat panel, quest journal with task list |
| `dd-02-2026-08-23.webp` | *not yet reviewed* |
| `dd-03-2026-08-23.webp` | *not yet reviewed* |
| `dd-04-2026-08-24.webp` | end-of-beta state, party roster, Events feed with equipment changes |

## Layout — three columns
**Left rail (persistent):** party cards — portrait, level badge, class glyph, HP bar (green, `31/31`),
resource bar (blue, `8/8`), progress bar (gold, `%`), and a **controlling-player tag** under the card
(`Thorongil`). Below: Inventory with gold count, **Quest Journal** (expandable quest → checkable task
list, completed tasks struck through), Maps, subscription status, and the signed-in user at the bottom.
**Centre:** scene art, an NPC nameplate anchored over it (`Sister Jessa / Shopkeeper`), a **time-of-day
clock** top-right (`2:38pm`, `3:48am`), a floating tool bar (text size, zoom ±, reset, **TALK** mic,
split view, layers, settings) and a `SHOW GRID` toggle.
**Right rail:** `Party 1` header with a **`Discord Chat`** button; a tab strip (text / audio / video);
a **status pill** — `Awaiting Player Response…`; a `FIX` button; then GM narration bubbles, an input
reading *"Type a message to your GM…"*, and a separate **Events** panel beneath.

## ⭐ What is worth borrowing

1. **⭐⭐ TWO STREAMS, NOT ONE LOG.** Prose narration and mechanical state-changes are *visually
   distinct feeds*: the GM's fiction sits in the chat column, while `Thrum equipped Radiant Scroll of
   Burning Hands` and `Task Complete — Talk to Sister Jessa` go to **Events**. AP already has both
   halves — `present_text` and the op log — and currently interleaves them. **This is the single
   cheapest, highest-value borrow.**
2. **⭐⭐ THE `FIX` BUTTON.** A one-click correction affordance beside the AI GM's output. An honest
   admission that an AI GM *will* get things wrong, designed for rather than hidden. Directly relevant
   to an autonomous-GM demo: the failure mode is visible and recoverable instead of embarrassing.
3. **⭐ EXPLICIT TURN STATE.** `Awaiting Player Response…` as a persistent pill means nobody wonders
   whose move it is. AP computes this already (the floor state, `evaluateFloor`) and never shows it.
4. **Roster cards with live vitals** — maps onto AP stations/seats plus the ship-record sheet; the
   controlling-player tag is exactly our seat→user binding made visible.
5. **Quest journal with strikethrough completion** — maps onto beats/mission tracking.
6. **Time-of-day clock** — cheap, high flavour, and Traveller cares about the clock (watches, jump
   transit). Ours would read in ship time.
7. **NPC nameplate + large portrait in the conversation panel** — we have NPC handling; the portrait
   slot is where their original digital-avatar product survives inside the game.

## ⚠ Two notes that are not design
- **They route table voice through Discord** (`Discord Chat` button) — the same choice Bruce has made
  for the Traveller room. Independent convergence on Discord-for-voice is a mild validation of
  deferring AP's own table voice.
- ⛔ **Their ToS takes an unrestricted, perpetual, irrevocable, worldwide, royalty-free licence on any
  feedback, bug report, suggestion or idea, without compensation.** ⇒ **Do not send design ideas,
  critiques, or improvement suggestions through their feedback channels.** A demo link and a plain note
  are safe; "here is what I would fix about your product" is a licence grant. Carry this into any
  outreach.
