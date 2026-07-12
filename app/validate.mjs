/*
 * validate.mjs — content-module validator (Plan 0438 Group D, POC).
 * Pure, no throw, WARN-never-blocks. Importable in the browser (panels) and on the
 * server (setModule logs warnings for observability). A module ALWAYS loads/delivers;
 * this only informs. See plan 0438 §3 for the rule catalogue.
 *
 *   import { validate } from './validate.mjs';
 *   const { warnings } = validate(module, { knownComponents, availableRequires });
 *   // warnings: [{ code, level:'warn'|'info', msg, beatIndex? }]
 */

// The 14 components shipped in components/ (default; override via ctx.knownComponents).
export const DEFAULT_COMPONENTS = [
  'card', 'choice', 'crud', 'dice', 'form', 'image', 'map',
  'narration', 'poll-results', 'scene', 'slider', 'stepper', 'svg-reactive', 'text-input',
];
// Components that collect a response and therefore need a promptId to gate/collect.
const INTERACTIVE = new Set(['choice', 'dice', 'text-input', 'slider', 'form']);
// Passive (display-only) components — a long run of these is a pacing smell (INFO).
const PASSIVE = new Set(['card', 'narration', 'image']);

const pid = (beat) => (beat && (beat.promptId != null ? beat.promptId : (beat.opts && beat.opts.promptId))) || null;

export function validate(module, ctx = {}) {
  const warnings = [];
  const warn = (code, msg, beatIndex) => warnings.push({ code, level: 'warn', msg, beatIndex });
  const info = (code, msg, beatIndex) => warnings.push({ code, level: 'info', msg, beatIndex });

  const known = new Set(ctx.knownComponents || DEFAULT_COMPONENTS);
  const avail = ctx.availableRequires ? new Set(ctx.availableRequires) : null; // null = unknown (best-effort)
  const m = module || {};
  const beats = Array.isArray(m.beats) ? m.beats : [];

  // INFO — advisory; the driver/manifest, not the module, owns some of these.
  if (!m.manifest) info('V1-no-manifest', 'module has no manifest (title/version/requirements)');

  // V2 — empty
  if (beats.length === 0) { warn('V2-empty', 'module has zero beats'); return { warnings }; }

  const seen = new Map(); // promptId -> first index
  let passiveRun = 0;
  const req = (m.manifest && m.manifest.requirements) || {};

  beats.forEach((b, i) => {
    const comp = b && b.component;
    // V3 — unknown component
    if (!comp || !known.has(comp)) warn('V3-unknown-component', `beat ${i}: unknown component "${comp}"`, i);

    const p = pid(b);
    // V4 — promptId contains ':' (breaks #id selectors)
    if (p && String(p).includes(':')) warn('V4-promptid-colon', `beat ${i}: promptId "${p}" contains ':' — use '-'`, i);
    // V5 — duplicate promptId (variants of one decision may legitimately repeat; flagged for review)
    if (p) { if (seen.has(p)) warn('V5-dup-promptid', `beat ${i}: promptId "${p}" also at beat ${seen.get(p)}`, i); else seen.set(p, i); }
    // V6 — interactive beat with no promptId (can't gate/collect)
    if (INTERACTIVE.has(comp) && !p) warn('V6-interactive-no-promptid', `beat ${i}: ${comp} has no promptId`, i);

    // V9 — requires unknown (best-effort; server-side has the real registry)
    if (avail && Array.isArray(b.requires)) b.requires.forEach((r) => { if (!avail.has(r)) info('V9-requires-unknown', `beat ${i}: requires "${r}" not in available set`, i); });

    // V8 — >2 consecutive passive beats (advisory)
    if (PASSIVE.has(comp)) { passiveRun++; if (passiveRun === 3) info('V8-passive-run', `beats ${i - 2}-${i}: 3+ passive beats in a row (pacing smell)`, i); } else passiveRun = 0;
  });

  // V7 — no terminal affordance (a clear beat OR a manifest declaration)
  const hasTerminalClear = beats.some((b) => b && (b.component === 'clear' || (b.branch && b.branch.clear))) || req.terminalClear === true;
  if (!hasTerminalClear) info('V7-no-terminal-affordance', 'no terminal clear beat and manifest.requirements.terminalClear not declared — clients may stick on the last beat');

  // V10 — declared gate timeout too short for humans
  if (typeof req.gateTimeoutMs === 'number' && req.gateTimeoutMs < 60000) info('V10-gate-timeout-short', `manifest gateTimeoutMs=${req.gateTimeoutMs} < 60000 (human-latency risk)`);

  return { warnings };
}

// Convenience: split by level.
export function summarize(result) {
  const w = (result.warnings || []).filter((x) => x.level === 'warn');
  const i = (result.warnings || []).filter((x) => x.level === 'info');
  return { warn: w.length, info: i.length, warnings: w, infos: i };
}
