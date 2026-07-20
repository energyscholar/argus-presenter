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
const DEFAULTS = { maxNotes: 40, noteTextCap: 120, textCap: 4000, maxSpeakers: 20 };

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
