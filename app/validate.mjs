/*
 * validate.mjs — content-module validator (Plan 0438 Group D, 0440 §5 schema).
 * Pure, no throw, WARN-never-blocks. Importable in the browser (panels) and on the
 * server (setModule + /api/modules). A module ALWAYS loads/delivers; this only informs.
 *
 *   import { validate, summarize } from './validate.mjs';
 *   const { warnings } = validate(module, { knownComponents, availableRequires });
 *   // warnings: [{ code, level:'warn'|'info', msg, beatIndex? }]
 *
 * Schema (neutral naming — Library › Series › Module › Section › Sequence › Beat › Layer):
 *   { manifest:{title,version,kind,summary,requirements:{terminalClear,gateTimeoutMs,assets,perUserPush}},
 *     sections:[{id,title,kind,summary,beatIds:[],sequences?:[{id,title,beatIds:[]}]}],
 *     beats:[{id,component,opts,promptId?,target?,requires?,gate?:{user,target},branch?,variantOf?,layers?:[{target|when,opts}]}] }
 */

// The 14 real components in components/, plus 'clear' as a recognised terminal pseudo-beat.
export const DEFAULT_COMPONENTS = [
  'card', 'choice', 'crud', 'dice', 'form', 'image', 'map',
  'narration', 'poll-results', 'scene', 'slider', 'stepper', 'svg-reactive', 'text-input',
];
const TERMINAL_PSEUDO = 'clear';
const INTERACTIVE = new Set(['choice', 'dice', 'text-input', 'slider', 'form']);
const PASSIVE = new Set(['card', 'narration', 'image']);

const pid = (b) => (b && (b.promptId != null ? b.promptId : (b.opts && b.opts.promptId))) || null;

export function validate(module, ctx = {}) {
  const warnings = [];
  const warn = (code, msg, beatIndex) => warnings.push({ code, level: 'warn', msg, beatIndex });
  const info = (code, msg, beatIndex) => warnings.push({ code, level: 'info', msg, beatIndex });

  const known = new Set([...(ctx.knownComponents || DEFAULT_COMPONENTS), TERMINAL_PSEUDO]);
  const avail = ctx.availableRequires ? new Set(ctx.availableRequires) : null;
  const m = module || {};
  const beats = Array.isArray(m.beats) ? m.beats : [];
  const sections = Array.isArray(m.sections) ? m.sections : [];
  const req = (m.manifest && m.manifest.requirements) || {};

  if (!m.manifest) info('V1-no-manifest', 'module has no manifest (title/version/requirements)');
  if (beats.length === 0) { warn('V2-empty', 'module has zero beats'); return { warnings }; }

  // --- beat id index (V11) ---
  const idIndex = new Map();      // id -> first index
  beats.forEach((b, i) => {
    if (b && b.id != null) { if (idIndex.has(b.id)) warn('V11-dup-beat-id', `beat ${i}: duplicate id "${b.id}" (also beat ${idIndex.get(b.id)})`, i); else idIndex.set(b.id, i); }
  });
  const beatIdSet = new Set(idIndex.keys());

  // --- per-beat checks ---
  const promptSeen = new Map();  // promptId -> index (interactive, non-variant only) — V5
  let passiveRun = 0;
  beats.forEach((b, i) => {
    const comp = b && b.component;
    if (!comp || !known.has(comp)) warn('V3-unknown-component', `beat ${i}: unknown component "${comp}"`, i);

    const p = pid(b);
    if (p && String(p).includes(':')) warn('V4-promptid-colon', `beat ${i}: promptId "${p}" contains ':' — use '-'`, i);
    // V5 dup-promptId: only among INTERACTIVE beats that are NOT declared variants (variantOf).
    if (p && INTERACTIVE.has(comp) && !b.variantOf) {
      if (promptSeen.has(p)) warn('V5-dup-promptid', `beat ${i}: interactive promptId "${p}" also at beat ${promptSeen.get(p)}`, i);
      else promptSeen.set(p, i);
    }
    if (INTERACTIVE.has(comp) && !p) warn('V6-interactive-no-promptid', `beat ${i}: ${comp} has no promptId`, i);

    // V13 dice needs a gate.target to compare a roll; a branch{ok,fail} needs gate; gated beat needs gate.user.
    if (comp === 'dice') {
      const g = b.gate || {};
      if (b.branch && (b.branch.ok || b.branch.fail) && typeof g.target !== 'number') warn('V13-dice-no-gate', `beat ${i}: dice branch has no gate.target to compare the roll`, i);
      if (b.gate && !b.gate.user) warn('V13-dice-no-gate', `beat ${i}: gated beat has no gate.user`, i);
    }

    // V12 branch targets must exist among beat ids.
    if (b.branch && typeof b.branch === 'object') {
      const targets = [];
      for (const k of Object.keys(b.branch)) {
        const v = b.branch[k];
        if (k === 'ifFlag' && v && typeof v === 'object') Object.values(v).forEach((t) => targets.push(t));
        else if (typeof v === 'string') targets.push(v);
      }
      targets.forEach((t) => { if (t && t !== TERMINAL_PSEUDO && !beatIdSet.has(t)) warn('V12-branch-target-missing', `beat ${i}: branch target "${t}" is not a beat id`, i); });
    }

    // V18 layer target shape (per-user variant): target must look like a userId/role, or `when` present.
    if (Array.isArray(b.layers)) b.layers.forEach((L, li) => {
      if (L && L.target == null && L.when == null) info('V18-layer-target', `beat ${i} layer ${li}: neither target nor when specified`, i);
    });

    if (avail && Array.isArray(b.requires)) b.requires.forEach((r) => { if (!avail.has(r)) info('V9-requires-unknown', `beat ${i}: requires "${r}" not in available set`, i); });

    if (PASSIVE.has(comp)) { passiveRun++; if (passiveRun === 3) info('V8-passive-run', `beats ${i - 2}-${i}: 3+ passive beats in a row (pacing smell)`, i); } else passiveRun = 0;
  });

  // --- section / sequence structure (V14-V17) ---
  const secIds = new Set();
  const inSomeSection = new Set();
  sections.forEach((s, si) => {
    if (s.id != null) { if (secIds.has(s.id)) warn('V17-dup-section-id', `section ${si}: duplicate id "${s.id}"`); else secIds.add(s.id); }
    const sBeatIds = Array.isArray(s.beatIds) ? s.beatIds : [];
    sBeatIds.forEach((bid) => { if (!beatIdSet.has(bid)) warn('V14-section-beatid-missing', `section "${s.id || si}": beatId "${bid}" is not a beat id`); else inSomeSection.add(bid); });
    if (Array.isArray(s.sequences)) s.sequences.forEach((sq) => {
      (sq.beatIds || []).forEach((bid) => {
        if (!beatIdSet.has(bid)) warn('V14-section-beatid-missing', `sequence "${sq.id}": beatId "${bid}" is not a beat id`);
        else { inSomeSection.add(bid); if (!sBeatIds.includes(bid)) info('V16-sequence-subset', `sequence "${sq.id}" beat "${bid}" is not in parent section "${s.id}" beatIds`); }
      });
    });
  });
  // V15 orphan beats (only meaningful if sections are declared)
  if (sections.length) beats.forEach((b, i) => { if (b.id != null && !inSomeSection.has(b.id)) info('V15-orphan-beat', `beat ${i} ("${b.id}") is in no section`, i); });

  // V7 terminal affordance: a clear pseudo-beat, a branch that clears, or a manifest declaration.
  const hasTerminalClear = beats.some((b) => b && (b.component === TERMINAL_PSEUDO || (b.branch && b.branch.clear))) || req.terminalClear === true;
  if (!hasTerminalClear) info('V7-no-terminal-affordance', 'no terminal clear beat and manifest.requirements.terminalClear not declared — clients may stick on the last beat');

  // V10 declared gate timeout too short for humans
  if (typeof req.gateTimeoutMs === 'number' && req.gateTimeoutMs < 60000) info('V10-gate-timeout-short', `manifest gateTimeoutMs=${req.gateTimeoutMs} < 60000 (human-latency risk)`);

  // V19 (SCH-1) advisory-only, module-level (not per-beat, to avoid noise): a module with beats
  // but zero numeric durationSec anywhere → no time estimate rolls up in the GM outline.
  const anyDuration = beats.some((b) => b && Number.isFinite(b.durationSec));
  if (!anyDuration) info('V19-no-duration', 'no beat carries a numeric durationSec — no time estimate in the outline');

  return { warnings };
}

export function summarize(result) {
  const w = (result.warnings || []).filter((x) => x.level === 'warn');
  const i = (result.warnings || []).filter((x) => x.level === 'info');
  return { warn: w.length, info: i.length, warnings: w, infos: i };
}
