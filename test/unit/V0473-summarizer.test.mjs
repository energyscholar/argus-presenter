/*
 * Plan 0473 P7 — the DEFAULT rolling-summary updater (heuristic seam) in ISOLATION.
 *
 * Locks the F-10 seam contract + the boundedness/eviction behaviour of the cheap incremental
 * heuristic — NO LLM, NO new dependency. The engine (server.mjs) holds one of these behind a single
 * `summarizer` reference and calls ONLY {kind,onTurnAged,onShed,view}; anything with the same shape
 * (a future Haiku worker / agent-assist) can replace it without touching the engine.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createHeuristicSummarizer } from '../../app/summarizer.mjs';

// Seam contract: the object exposes exactly the swap interface, all functions.
test('seam contract: {kind,onTurnAged,onShed,view} — the swappable interface the engine calls', () => {
  const s = createHeuristicSummarizer();
  expect('kind is heuristic (default, no LLM)', s.kind === 'heuristic', s.kind);
  expect('onTurnAged is a function', typeof s.onTurnAged === 'function', typeof s.onTurnAged);
  expect('onShed is a function', typeof s.onShed === 'function', typeof s.onShed);
  expect('view is a function', typeof s.view === 'function', typeof s.view);
  const v = s.view();
  expect('view() reports its source (the seam identity)', v.source === 'heuristic', v.source);
  expect('empty view: zero continuity counts', v.turnsSummarized === 0 && v.sheddedFolded === 0, JSON.stringify(v));
});

// Continuity counts are monotone + never lost even after detail is evicted; the serialized view is BOUNDED.
test('bounded + eviction: many folded turns keep counts but cap the serialized view; oldest detail evicted', () => {
  const s = createHeuristicSummarizer({ maxNotes: 40 });
  const N = 5000;
  for (let i = 0; i < N; i++) s.onTurnAged({ userId: 'u1', userName: 'Bruce', text: 'aged turn marker-' + i + ' with filler words' });
  const v = s.view();
  expect('turnsSummarized counts ALL folded turns (continuity never lost)', v.turnsSummarized === N, String(v.turnsSummarized));
  const size = JSON.stringify(v).length;
  expect('serialized view stays BOUNDED (< 8KB) after ' + N + ' folds', size < 8000, size + ' bytes');
  // the MOST RECENT aged-out detail is retained; the OLDEST detail is evicted (that is what keeps it bounded).
  expect('recent aged detail retained (marker-' + (N - 1) + ')', new RegExp('marker-' + (N - 1) + '\\b').test(v.text), v.text.slice(-120));
  expect('oldest detail evicted (marker-0 gone)', !/\bmarker-0\b/.test(v.text), 'marker-0 unexpectedly retained');
});

// Per-speaker rollup is bounded (distinct-speaker cap → aggregate bucket) so it can't grow unbounded.
test('per-speaker rollup is bounded — speakers beyond the cap aggregate, never grow the view', () => {
  const s = createHeuristicSummarizer({ maxSpeakers: 5 });
  for (let i = 0; i < 100; i++) s.onTurnAged({ userId: 'u' + i, userName: 'User' + i, text: 'x' });
  const v = s.view();
  expect('distinct speakers bounded to the cap (+ at most one aggregate bucket)', v.speakers.length <= 6, String(v.speakers.length));
  const bucket = v.speakers.find((x) => x.other === true);
  expect('overflow speakers are aggregated, not dropped', bucket && bucket.turns > 0, JSON.stringify(v.speakers));
});

// onShed folds the P6 backpressure count (never silent), independent of the turn detail.
test('onShed accumulates the P6 shed count (never silent)', () => {
  const s = createHeuristicSummarizer();
  s.onShed(3); s.onShed(2);
  expect('sheddedFolded accumulates the shed count', s.view().sheddedFolded === 5, String(s.view().sheddedFolded));
  s.onShed(-9); s.onShed('nope');
  expect('bad shed inputs are ignored (bounded, non-negative)', s.view().sheddedFolded === 5, String(s.view().sheddedFolded));
});
