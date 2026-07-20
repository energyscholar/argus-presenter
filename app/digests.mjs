/*
 * app/digests.mjs — Plan 0473 P5/P10: the DIGEST-CONTENT SEAM (F-5, "digest content per session-type").
 *
 * THE SPINE invariant: ONE working-set engine, its behaviour configured by DATA knobs — never a
 * per-profile code fork. Different session types want different profile-specific views layered onto the
 * shared situation digest: the wearable wants just the conversation; an RPG GM wants a GM view
 * (questions-to-GM + recent player actions, plus the mcp-gm scene/initiative/dice); a class wants a
 * class view; a host session wants the host's. This module is the SEAM that makes that a DATA lookup
 * (keyed by the profile's `digestContent` knob VALUE — exactly like selectProfile keys on a name),
 * NOT an `if (profile === 'rpg')` branch in the engine.
 *
 * Contract: `buildDigest(kind, ctx)` looks up a builder by the `digestContent` knob value and returns a
 * bounded, additive `digest` section (or `null` when the profile wants no extra section). The builder
 * reads ONLY the already-assembled, already-trust-annotated (P9) working-set pieces handed in via `ctx`
 * — it computes nothing itself and never blocks. To add a new session-type view (teaching/guest), add a
 * builder here keyed by its knob value; the engine code does not change. `ctx` shape:
 *   { queue:[itemView...], recentTurns:[coalescedTurn...] }   (both already fenced-as-data where untrusted)
 *
 * P10 ships `conversation` (wearable) + `gm` (rpg); P11 adds `class` (teaching). `host` is intentionally
 * NOT built here (P12); an unregistered knob value falls back to `null` (no section), never throws.
 */

const MAX_DIGEST_ITEMS = 20;   // bound every digest list like the rest of the working set

// A directed (question/action-to-GM) work item = DIRECTED priority (2), set by the queue engine.
const PRIORITY_DIRECTED = 2;

const DIGESTS = {
  // wearable: the digest IS the conversation (recentTurns already carry it) — no extra section.
  conversation: () => null,

  // rpg GM view. GM-relevant fields DERIVED from the working set: the questions/actions directed at the
  // GM (the queue's directed items) + the recent player actions (the coalesced recent turns). The
  // scene/initiative/dice/NPC fields are a declared SEAM/PLACEHOLDER for the separate mcp-gm system —
  // this phase wires the working-set-derived view, NOT a full mcp-gm integration.
  gm: (ctx = {}) => ({
    kind: 'gm',
    // questions/actions the players have directed at the GM — the judgment items, already prioritized.
    questionsToGm: (ctx.queue || []).filter((w) => w && w.priority >= PRIORITY_DIRECTED).slice(0, MAX_DIGEST_ITEMS),
    // recent player actions/roleplay at the table (verbatim, bounded, fenced-as-data where untrusted).
    recentActions: (ctx.recentTurns || []).slice(-MAX_DIGEST_ITEMS),
    // ---- mcp-gm SEAM (placeholder; populated by the separate GM system, not this phase) ----
    scene: null,
    initiative: null,
    dice: null,
  }),

  // teaching CLASS view (P11). Class-relevant fields DERIVED from the working set: the pending
  // questions (already DEDUPED/CLUSTERED by the queue engine — each clustered item carries a `count` +
  // its `askers`) and the queue depth, so the teacher/agent sees "N students asked about X" at a glance
  // rather than 20 separate rows. `handsRaised` counts the STUDENTS waiting (a cluster of N = N hands),
  // which is larger than the (bounded) number of queue items. poll/quiz are a declared SEAM/PLACEHOLDER
  // for the separate poll/quiz specifics — this phase wires the working-set-derived class view.
  class: (ctx = {}) => {
    const queue = ctx.queue || [];
    const questions = queue.filter((w) => w && w.priority >= PRIORITY_DIRECTED).slice(0, MAX_DIGEST_ITEMS);
    return {
      kind: 'class',
      // the clustered questions (each carries count + askers where it clustered) — glanceable at scale.
      questions,
      // depth of the ACTIONABLE queue (bounded); NOT the raw number of students (see handsRaised).
      queueDepth: queue.length,
      // students waiting = sum of cluster counts (a cluster of N students = N raised hands).
      handsRaised: questions.reduce((n, w) => n + (w.count || 1), 0),
      // ---- poll/quiz SEAM (placeholder; populated by the separate poll/quiz system, not this phase) ----
      poll: null,
      quiz: null,
    };
  },
};

/**
 * Build the profile-specific digest section for `kind` (a `digestContent` knob value) from the
 * already-assembled working-set `ctx`. Pure DATA lookup + a cheap read — never a profile-NAME branch,
 * never blocking. Unknown/absent kinds fall back cleanly to `null` (no extra section).
 */
export function buildDigest(kind, ctx = {}) {
  const build = (typeof kind === 'string' && Object.prototype.hasOwnProperty.call(DIGESTS, kind)) ? DIGESTS[kind] : null;
  return build ? build(ctx) : null;
}
