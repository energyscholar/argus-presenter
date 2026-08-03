/*
 * Plan 0473 P7 — ROLLING SUMMARY: the continuity layer BEYOND the recent-N turns.
 *
 * A live session is UNBOUNDED in duration; the situation digest surfaces only the last-N turns
 * (P3). Without a summary, an agent (or a solo wearable over a long conversation) goes AMNESIAC
 * past N. The rolling summary retains context that has SCROLLED OUT of the recent-N window so it
 * is never lost — while itself staying BOUNDED (it must not grow with session length).
 *
 * F-10 SEAM (pluggable): the summarizer is a SWAPPABLE unit. The DEFAULT (below) is a CHEAP
 * INCREMENTAL HEURISTIC updater — NO LLM, NO new dependency, NO agent-cognition-by-default. The
 * engine feeds it aged-out turns (onTurnAged) + shed-ambient counts (onShed) as they SETTLE/AGE,
 * and reads a bounded snapshot (view) at serve time. Because it is PRECOMPUTED incrementally and
 * view() is a pure read, situation() NEVER blocks on summary computation.
 *
 * To swap in a future cheap-model (Haiku) worker or an agent-assist presenter_set_summary, provide
 * another object with the SAME shape { kind, onTurnAged, onShed, view } — the engine holds it behind
 * a single `summarizer` reference and calls only this interface. NONE of those is built here, and
 * Tier-1 / situation() must NEVER hard-depend on an LLM (a drift-guard in the plan).
 *
 * Interface (the seam contract):
 *   kind                       — identifier of the active summarizer (surfaced in view().source)
 *   onTurnAged({userId,userName,text,turnId})
 *                              — fold ONE turn that has just aged out of the recent-N window
 *   onShed(n)                  — fold N ambient turns shed by the P6 reactive backstop (count, never silent)
 *   view()                     — a BOUNDED plain snapshot: {source,turnsSummarized,sheddedFolded,speakers,text}
 */

// Default heuristic knobs. Every one BOUNDS the summary so it can never grow with session length:
//   maxNotes    — size of the FIFO of compact aged-out-turn notes (oldest DETAIL evicted first)
//   noteTextCap — per-note verbatim text cap
//   textCap     — hard char cap on the serialized `text` headline
//   maxSpeakers — distinct speakers tracked by name (overflow lumped into an aggregate bucket)
//
// ⛓ Plan 0532 P4 — WHY textCap IS 3600 AND NOT 4000.
//
// The summary is served FENCED (plan 0529 P1): app/untrusted.mjs annotate() writes the sanitized
// `text` a SECOND time inside delimiters, as `fenced`. So the served object carries the headline
// TWICE, and its size is about 2 × textCap + 337 bytes of envelope. At textCap 4000 a saturated
// summary served 8,338 bytes against the < 8000 bound that
// test/live/V0473-rolling-summary.test.mjs:70 has asserted since 0473 — a bound NO saturated
// summary could satisfy at any cap above 3831. The duplication arrived with the fence; the cap
// never moved to meet it, and the bound went on passing only because its own fixture reached
// about 1.5 KB and never approached saturation (t0529-g1-03 is the test that finally drove it).
//
// 3600 rather than the measured ceiling of 3831: 2 × 3600 + 337 = 7,537, leaving ~460 bytes of
// margin for the envelope to grow (another trust field, a longer marker) without silently
// re-breaching a bound that only saturation reveals.
//
// ⚠ THE COST IS REAL AND IS NOT HIDDEN: an agent reading the situation now sees a headline up to
// 400 characters shorter — roughly three of the forty retained notes. The note FIFO is unchanged;
// what is trimmed is the tail of the serialized headline, i.e. the OLDEST retained detail.
// ⛔ The alternative — raising the assertion — is the named drift signal and was not on the table.
export const SUMMARY_DEFAULTS = { maxNotes: 40, noteTextCap: 120, textCap: 3600, maxSpeakers: 20 };
const DEFAULTS = SUMMARY_DEFAULTS;

/**
 * The DEFAULT rolling-summary updater: a cheap, incremental, heuristic accumulator. It keeps
 *   (a) monotone CONTINUITY COUNTS (turnsSummarized, sheddedFolded) — never lost, so the consumer
 *       always sees HOW MUCH older context exists even after detail is evicted;
 *   (b) a bounded per-speaker turn-count rollup; and
 *   (c) a bounded FIFO of compact per-turn notes (recent aged-out detail; oldest evicted).
 * No ML, no NLP, no I/O — pure in-memory O(1)-per-turn folding.
 */
export function createHeuristicSummarizer(opts = {}) {
  const { maxNotes, noteTextCap, textCap, maxSpeakers } = { ...DEFAULTS, ...opts };
  const state = {
    turnsSummarized: 0,       // total turns folded out of the recent-N window (continuity count)
    sheddedFolded: 0,         // ambient turns folded from the P6 reactive shed (never silent)
    notes: [],                // bounded FIFO: {userName, text} — oldest DETAIL evicted first
    speakers: new Map(),      // userId -> {userName, turns} (bounded distinct count)
    otherSpeakerTurns: 0,     // turns from speakers beyond the maxSpeakers cap (aggregate bucket)
  };

  function onTurnAged(note = {}) {
    state.turnsSummarized++;
    // per-speaker rollup (bounded number of distinct speakers; the rest aggregate into a bucket)
    const uid = note.userId == null ? '?' : note.userId;
    if (state.speakers.has(uid)) state.speakers.get(uid).turns++;
    else if (state.speakers.size < maxSpeakers) state.speakers.set(uid, { userName: note.userName || null, turns: 1 });
    else state.otherSpeakerTurns++;
    // bounded FIFO of compact notes — this is where OLD DETAIL is evicted so the summary stays bounded
    const text = String(note.text || '').slice(0, noteTextCap);
    if (text) {
      state.notes.push({ userName: note.userName || null, text });
      while (state.notes.length > maxNotes) state.notes.shift();
    }
  }

  // Fold N ambient turns shed by the P6 reactive backstop into the summary as a COUNT (never silent).
  // The shed turns' content is already represented via onTurnAged (every settled turn is staged), so
  // this dimension records the backpressure magnitude, not a second copy of the text.
  function onShed(n = 0) { const k = Math.max(0, Math.floor(Number(n) || 0)); state.sheddedFolded += k; }

  function view() {
    const speakers = [...state.speakers.values()].map((s) => ({ userName: s.userName, turns: s.turns }));
    if (state.otherSpeakerTurns > 0) speakers.push({ userName: null, other: true, turns: state.otherSpeakerTurns });
    // a bounded, human/agent-legible headline of the retained aged-out detail
    const text = state.notes.map((n) => `${n.userName || '?'}: ${n.text}`).join(' | ').slice(0, textCap);
    return {
      source: 'heuristic',            // F-10: which summarizer produced this (the pluggable-seam identity)
      turnsSummarized: state.turnsSummarized,
      sheddedFolded: state.sheddedFolded,
      speakers,
      text,
    };
  }

  return { kind: 'heuristic', onTurnAged, onShed, view };
}
