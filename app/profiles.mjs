/*
 * Plan 0473 P1 — SESSION-TYPE PROFILES (the config-knob foundation later phases read from).
 *
 * THE SPINE (per the plan): ONE working-set engine, its behaviour configured by the session's
 * PROFILE. Profiles are DATA — a table of knobs — NOT forks in code. Adding/tuning a use case is a
 * config edit, never a rewrite. This module establishes the config OBJECT + selection + readability
 * ONLY: NO knob is CONSUMED here. Later phases (P2 settling, P4 queue, P5 budget, P6 floor, P7
 * summary/digest) READ these knobs; they must NEVER branch on the profile NAME.
 *
 * Knob shape (every profile carries the same keys — that is what keeps the engine generic):
 *   name            — the profile's own name
 *   shedding        — ambient-shedding policy: 'none' | 'summarize' | 'host'   (F-1/F-4)
 *   settlingMs      — fragment→turn settling window in ms (latency vs completeness)   (F-2)
 *   perTurnBudget   — { mode:'soft'|'tight', byRole:{ <role>: ms } }   (F-3/H, per-role/trust)
 *   floorThresholds — { enabled, ...tuning }   (load-based floor control; off for 1 speaker)
 *   digestContent   — which digest section the situation surfaces: 'conversation'|'gm'|'class'|'host' (F-5)
 *   queuePolicy     — { mode, enqueue, maxPending, ttlMs?, ... }   work-queue behaviour (F-6/F-11):
 *                     enqueue='all' ⇒ every directed turn is a work item (wearable: solo, all directed);
 *                     enqueue='questions' ⇒ only question/request turns enqueue (multi-user: ambient shed);
 *                     maxPending bounds the pending queue; ttlMs ages stale pending items out (P4).
 *
 * DRIFT GUARD: consume knobs, never the name. `selectProfile(name)` is a pure DATA lookup.
 */

// Named settling tiers so the ms values are legible + reusable across profiles (consumed in P2).
const SETTLING = { SHORT: 400, MEDIUM: 1200 };   // ms

// A generous, soft per-turn budget for a trusted solo speaker (consumed in P5). Wearable = never
// hard-cut; a wrap-up cue only. Keyed by role/trust so budgets stay per-role, never global (F-3/H).
const GENEROUS_MS = 120000;   // 2 min — "generous" for the solo wearable

export const DEFAULT_PROFILE = 'wearable';

// The profile table. `wearable` (P1–P8) and `rpg` (P10) are FULLY WIRED — every knob is consumed by
// the generic engine. `teaching`/`guest` are DATA PLACEHOLDERS with their plan-table knob values filled
// in so they are already data-selectable, but `wired:false` marks them as NOT yet driving behaviour —
// their scenario tests land failing-first in P11/P12 as those use cases come online. Config, not code.
export const PROFILES = {
  // wearable (solo, trusted): every directed turn is a work item — never shed. Snappy turns. Soft,
  // generous budget (wrap-up cue only). No floor (one speaker). The digest IS the conversation.
  wearable: {
    name: 'wearable',
    wired: true,
    shedding: 'none',                                   // F-1: never shed/deprioritize directed input
    settlingMs: SETTLING.SHORT,                         // F-2: short window ⇒ snappy turn-taking
    perTurnBudget: { mode: 'soft', byRole: {            // F-3: generous + SOFT (wrap-up cue only)
      self: GENEROUS_MS, ai: GENEROUS_MS, presenter: GENEROUS_MS, participant: GENEROUS_MS,
    } },
    floorThresholds: { enabled: false },                // off — one speaker, no floor control
    digestContent: 'conversation',                      // F-5: the digest is the conversation
    queuePolicy: { mode: 'trivial', enqueue: 'all', maxPending: 1 },   // trivial — every directed turn is work; 1 pending exchange (P4)
  },

  // --- DATA PLACEHOLDERS (wired:false) — knobs from the plan table; NOT wired to behaviour in P1. ---

  // rpg (~6 + GM): ambient = SUMMARIZE into continuity (never discard narrative); GM digest.
  // WIRED in P10 — every knob below is CONSUMED by the generic engine (shedding→queue enqueue policy,
  // digestContent→the digest seam, settling/budget/floor), so this is DATA, not a per-name code fork.
  rpg: {
    name: 'rpg',
    wired: true,
    shedding: 'summarize',                              // F-4: shed = summarize-not-discard
    settlingMs: SETTLING.MEDIUM,
    perTurnBudget: { mode: 'soft', byRole: { self: GENEROUS_MS, gm: GENEROUS_MS, participant: 60000 } },
    floorThresholds: { enabled: true },                 // on under load
    digestContent: 'gm',                                // F-5: scene/initiative/dice/NPC (pluggable)
    queuePolicy: { mode: 'actions-to-gm', enqueue: 'questions' },   // ambient narrative shed from the queue (P4/P10)
  },

  // teaching (many students + teacher): ambient shed→summary, questions kept; explicit moderation
  // OVERRIDES auto-floor (F-7); similar questions DEDUPE/CLUSTER at class scale (F-6).
  // WIRED in P11 — every knob below is CONSUMED by the generic engine (shedding→enqueue policy,
  // queuePolicy.cluster→the cheap dedupe/cluster path, floorThresholds.moderationOverrides→the
  // moderation-floor precedence seam, digestContent='class'→the digest seam), so this is DATA, not a
  // per-name code fork.
  teaching: {
    name: 'teaching',
    wired: true,
    shedding: 'summarize',
    settlingMs: SETTLING.MEDIUM,
    perTurnBudget: { mode: 'soft', byRole: { self: GENEROUS_MS, presenter: GENEROUS_MS, participant: 45000 } },
    floorThresholds: { enabled: true, moderationOverrides: true },   // F-7: teacher moderation wins over auto floor
    digestContent: 'class',                             // hands/quiz/poll state
    // F-6: only questions enqueue (ambient shed→summary), and at class scale SIMILAR questions cluster into
    // ONE queue item (`cluster:true`) — 20 near-simultaneous "same" questions stay glanceable, not 20 rows.
    queuePolicy: { mode: 'dedupe-cluster', enqueue: 'questions', cluster: true },
  },

  // guest (scoped, untrusted): as host session, but TIGHT budget + aggressive floor; guest items
  // mediated + flagged untrusted (F-8 security lands in P9).
  guest: {
    name: 'guest',
    wired: false,
    shedding: 'host',                                   // as host session
    settlingMs: SETTLING.MEDIUM,
    perTurnBudget: { mode: 'tight', byRole: { guest: 20000 } },      // F-3/H tight
    floorThresholds: { enabled: true, aggressive: true },
    digestContent: 'host',
    queuePolicy: { mode: 'mediated', enqueue: 'questions', flagUntrusted: true },   // guest items mediated (P4/P12)
  },
};

/**
 * Select a profile's knobs by name. Pure DATA lookup — NO per-profile code path (drift guard). An
 * unknown / null / non-string name falls back CLEANLY to the default (wearable) rather than throwing,
 * so a bad session-start argument can never crash the server.
 */
export function selectProfile(name) {
  const p = (typeof name === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, name))
    ? PROFILES[name] : null;
  return p || PROFILES[DEFAULT_PROFILE];
}
