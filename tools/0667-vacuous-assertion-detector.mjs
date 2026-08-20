#!/usr/bin/env node
/*
 * tools/0667-vacuous-assertion-detector.mjs — Plan 0667 phase A2 (PTL-201, EX-1).
 *
 * Finds "vacuous assertions": a call to the repo's `expect`/`check` assertion helpers where the
 * CONDITION slot holds a bare string literal instead of a boolean expression. A non-empty string
 * literal is always truthy, so the call can never fail — it looks like a live assertion and tests
 * nothing.
 *
 * ── THE DEFECT SHAPE (plans/0667 §0.1) ──────────────────────────────────────────────────────
 * Three helpers, two argument orders:
 *   harness/test.mjs   expect(cond, msg, detail)   COND-FIRST  — condition is argument 1
 *   harness/test.mjs   check(name, cond, detail)   NAME-FIRST  — condition is argument 2
 *   harness/drive.mjs  expect(name, cond, detail)  NAME-FIRST  — condition is argument 2
 *
 * 137 files alias `check as expect` (or similar), so in THOSE files the local name `expect` is
 * actually NAME-FIRST. Classification must therefore be per LOCAL BINDING, established from each
 * file's own import statement — never assumed from the call's spelling.
 *
 * ── WHY NOT A REGEX ─────────────────────────────────────────────────────────────────────────
 * `expect\(\s*['"]` false-positives on `expect(name, 'seq' in it && 'kind' in it)` — a valid
 * boolean expression that merely BEGINS with a string literal. The only correct test is: is the
 * ENTIRE condition-slot expression, once top-level-comma-split with paren/bracket/brace and
 * quote awareness, nothing but one string (or template) literal token? `'seq' in it && …` fails
 * that test (there is an ` in it && …` tail after the literal) so it is correctly passed. Numeric
 * `a.b + a.c === 18` fails it even more trivially (does not even start with a quote).
 *
 * This file therefore hand-rolls a small state-machine tokenizer (comment / string / template
 * aware) rather than using a library — the repo declares zero deps beyond Node, and this is a
 * bounded, auditable amount of logic.
 *
 * ── FAIL LOUDLY ON THE UNKNOWN (Auditor MINOR finding) ─────────────────────────────────────
 * Only two import shapes are recognised as safe to classify:
 *   (a) `import { a, b as c } from '.../harness/(test|drive).mjs'`
 *   (b) `const { a, b as c } = await import('.../harness/(test|drive).mjs')`
 * Any OTHER shape that reaches these modules — namespace import, default import, re-export,
 * bare `require(...)`, a side-effect-only dynamic import — is reported as UNRECOGNISED and makes
 * the run exit non-zero WITHOUT silently classifying the file. A local wrapper that re-exports
 * `expect`/`check` under a new name from a THIRD file is likewise unrecognised, because this
 * detector only resolves bindings that trace directly to the two harness modules.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────────────────────
 *   node tools/0667-vacuous-assertion-detector.mjs            scan the repo, exit 1 if it finds
 *                                                              a genuine site OR an unrecognised
 *                                                              import shape, exit 0 otherwise.
 *   node tools/0667-vacuous-assertion-detector.mjs --selftest  run the four synthetic fixtures
 *                                                              (plan §A2 acceptance #3) and exit
 *                                                              non-zero if the detector's own
 *                                                              logic is wrong. Always run FIRST,
 *                                                              automatically, before a real scan
 *                                                              — an untested detector's "0 sites"
 *                                                              is not evidence of anything.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/* ── the two harness modules' full, exhaustive export sets and their semantics ─────────────── */
const KNOWN_EXPORTS = {
  test: {
    expect: 'cond-first',   // slot 1 (0-indexed 0) is the condition
    check: 'name-first',    // slot 2 (0-indexed 1) is the condition
    test: 'ignore',
    runRegistered: 'ignore',
  },
  drive: {
    expect: 'name-first',   // slot 2 (0-indexed 1) is the condition
    getBrowser: 'ignore',
    closeBrowser: 'ignore',
    drive: 'ignore',
  },
};
const CONDITION_SLOT = { 'cond-first': 0, 'name-first': 1 };

/* ══════════════════════════════════ CORE PARSER ═══════════════════════════════════════════ */

/**
 * Walk `src` tracking comment/string/template-literal region state. Whenever we are in a `code`
 * region and see `<identifier>(` where identifier is in `names`, capture the raw text between the
 * matching parens (also region-aware, so a `)` inside a nested string/comment/paren doesn't end
 * the call early) and the 1-based line number of the call.
 */
function findCalls(src, names) {
  const calls = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdentPart = (c) => /[A-Za-z0-9_$]/.test(c);

  function skipRegion(startIdx, startState) {
    // Consumes a comment/string/template starting at startIdx (pointing AT the opening
    // delimiter char that has NOT yet been consumed by the caller). Returns index just past it.
    let j = startIdx;
    if (startState === 'line-comment') {
      while (j < n && src[j] !== '\n') j++;
      return j;
    }
    if (startState === 'block-comment') {
      j += 2; // past '/*'
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      return j < n ? j + 2 : n;
    }
    // sq / dq / tpl: startIdx points AT the opening quote char.
    const quote = src[startIdx];
    j = startIdx + 1;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === quote) { j++; break; }
      j++;
    }
    return j;
  }

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && c2 === '/') { const j = skipRegion(i, 'line-comment'); i = j; continue; }
    if (c === '/' && c2 === '*') {
      const startLine = line;
      const j = skipRegion(i, 'block-comment');
      line += src.slice(i, j).split('\n').length - 1;
      i = j;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const startText = src.slice(i, i + 1);
      const j = skipRegion(i, c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl');
      line += src.slice(i, j).split('\n').length - 1;
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      const ident = src.slice(i, j);
      let k = j;
      while (k < n && /[ \t]/.test(src[k])) k++; // same-line whitespace only before '('
      if (names.has(ident) && src[k] === '(') {
        const callLine = line;
        const argStart = k + 1;
        let depth = 1;
        let m = argStart;
        while (m < n && depth > 0) {
          const mc = src[m];
          const mc2 = src[m + 1];
          if (mc === '\n') { line++; m++; continue; }
          if (mc === '(') { depth++; m++; continue; }
          if (mc === ')') { depth--; if (depth === 0) break; m++; continue; }
          if (mc === '/' && mc2 === '/') { m = skipRegion(m, 'line-comment'); continue; }
          if (mc === '/' && mc2 === '*') {
            const s = m; m = skipRegion(m, 'block-comment'); line += src.slice(s, m).split('\n').length - 1; continue;
          }
          if (mc === "'" || mc === '"' || mc === '`') {
            const s = m; m = skipRegion(m, mc === "'" ? 'sq' : mc === '"' ? 'dq' : 'tpl');
            line += src.slice(s, m).split('\n').length - 1; continue;
          }
          m++;
        }
        const argsText = src.slice(argStart, m);
        calls.push({ name: ident, line: callLine, argsText });
        i = m + 1;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }
  return calls;
}

/** Top-level comma split of an argument list, paren/bracket/brace/quote/template aware. */
function splitArgs(argsText) {
  const args = [];
  let depth = 0;
  let cur = '';
  const n = argsText.length;
  let i = 0;
  while (i < n) {
    const c = argsText[i];
    const c2 = argsText[i + 1];
    if (c === '(' || c === '[' || c === '{') { depth++; cur += c; i++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; cur += c; i++; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      let body = c;
      while (j < n) {
        if (argsText[j] === '\\') { body += argsText.slice(j, j + 2); j += 2; continue; }
        if (argsText[j] === quote) { body += quote; j++; break; }
        body += argsText[j]; j++;
      }
      cur += body; i = j; continue;
    }
    if (c === '/' && c2 === '/') { let j = i; while (j < n && argsText[j] !== '\n') j++; cur += argsText.slice(i, j); i = j; continue; }
    if (c === '/' && c2 === '*') { let j = i + 2; while (j < n && !(argsText[j] === '*' && argsText[j + 1] === '/')) j++; j = Math.min(j + 2, n); cur += argsText.slice(i, j); i = j; continue; }
    if (c === ',' && depth === 0) { args.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  if (cur.trim().length > 0 || args.length > 0) args.push(cur);
  return args.map((a) => a.trim());
}

/** True iff `text` (already trimmed) is ENTIRELY one string/template literal — nothing before or after it. */
function isBareLiteral(text) {
  if (text.length < 2) return false;
  const q = text[0];
  if (q !== "'" && q !== '"' && q !== '`') return false;
  let i = 1;
  while (i < text.length - 1) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === q) return false; // the literal closes before the slot ends -> something follows
    i++;
  }
  return text[text.length - 1] === q;
}

/* ══════════════════════════════════ IMPORT RESOLUTION ═════════════════════════════════════ */

const MODULE_RE = /harness\/(test|drive)\.mjs/;

/** Parse a `{ a, b as c, ... }` specifier body into [{orig, local}]. */
function parseSpecifiers(body) {
  return body.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (m) return { orig: m[1], local: m[2] };
    return { orig: s, local: s };
  });
}

/**
 * Resolve every local binding in `src` that traces to harness/test.mjs or harness/drive.mjs.
 * Returns { bindings: Map<localName, 'cond-first'|'name-first'>, unrecognised: [{line, text}] }.
 * `bindings` only contains assertion-function locals (KNOWN_EXPORTS[...] !== 'ignore'); anything
 * mapped to an export name NOT in KNOWN_EXPORTS[mod] is itself pushed to `unrecognised`.
 */
function resolveImports(src) {
  const bindings = new Map();
  const unrecognised = [];
  const consumed = []; // [start, end) ranges already accounted for by a recognised form

  const lineAt = (idx) => src.slice(0, idx).split('\n').length;

  // (a) static named import: `import { ... } from '....harness/(test|drive).mjs'`
  {
    const re = /import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]*)\2/g;
    let m;
    while ((m = re.exec(src))) {
      const mod = m[3].match(MODULE_RE);
      if (!mod) continue;
      consumed.push([m.index, m.index + m[0].length]);
      const which = mod[1]; // 'test' | 'drive'
      for (const { orig, local } of parseSpecifiers(m[1])) {
        const cls = KNOWN_EXPORTS[which][orig];
        if (cls === undefined) {
          unrecognised.push({ line: lineAt(m.index), text: `import specifier '${orig}' is not a known export of harness/${which}.mjs (line: ${m[0].trim()})` });
        } else if (cls !== 'ignore') {
          bindings.set(local, cls);
        }
      }
    }
  }

  // (b) dynamic destructured import: `const { ... } = await import('....harness/(test|drive).mjs')`
  {
    const re = /\{([^}]*)\}\s*=\s*await\s+import\(\s*(['"])([^'"]*)\2\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      const mod = m[3].match(MODULE_RE);
      if (!mod) continue;
      consumed.push([m.index, m.index + m[0].length]);
      const which = mod[1];
      for (const { orig, local } of parseSpecifiers(m[1])) {
        const cls = KNOWN_EXPORTS[which][orig];
        if (cls === undefined) {
          unrecognised.push({ line: lineAt(m.index), text: `dynamic-import specifier '${orig}' is not a known export of harness/${which}.mjs (line: ${m[0].trim()})` });
        } else if (cls !== 'ignore') {
          bindings.set(local, cls);
        }
      }
    }
  }

  // (c) catch-all: any OTHER `from '...harness/(test|drive).mjs'` or bare `import('...')`/
  // `require('...')` reference not already consumed above -> unrecognised import shape
  // (namespace import, default import, re-export, side-effect import, require()).
  {
    const re = /(?:from\s*(['"])([^'"]*)\1|(?:import|require)\(\s*(['"])([^'"]*)\3\s*\))/g;
    let m;
    while ((m = re.exec(src))) {
      const spec = m[2] !== undefined ? m[2] : m[4];
      if (!spec || !MODULE_RE.test(spec)) continue;
      const start = m.index;
      const end = m.index + m[0].length;
      const already = consumed.some(([cs, ce]) => start >= cs && end <= ce);
      if (!already) {
        unrecognised.push({ line: lineAt(start), text: `unrecognised import shape reaching ${spec} (line: ${m[0].trim()})` });
      }
    }
  }

  return { bindings, unrecognised };
}

/* ══════════════════════════════════ PER-FILE SCAN ═════════════════════════════════════════ */

/**
 * Scan one file's source for vacuous-assertion sites and unrecognised import shapes.
 * Returns { findings: [{line, name, class, argsText}], unrecognised: [{line, text}] }.
 * `findings` covers BOTH `expect(` and `check(` — indeed any local name at all, since the class
 * map is keyed by local binding, not by the literal spelling `expect`/`check`.
 */
export function scanSource(src) {
  const { bindings, unrecognised } = resolveImports(src);
  if (bindings.size === 0) return { findings: [], unrecognised };

  const calls = findCalls(src, new Set(bindings.keys()));
  const findings = [];
  for (const call of calls) {
    const cls = bindings.get(call.name);
    const slot = CONDITION_SLOT[cls];
    const args = splitArgs(call.argsText);
    const condArg = args[slot];
    if (condArg !== undefined && isBareLiteral(condArg)) {
      findings.push({ line: call.line, name: call.name, class: cls, argsText: call.argsText.trim() });
    }
  }
  return { findings, unrecognised };
}

/* ══════════════════════════════════ REPO WALK ═════════════════════════════════════════════ */

function listMjsFiles(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) listMjsFiles(p, out);
    else if (entry.endsWith('.mjs')) out.push(p);
  }
}

function scanRepo() {
  const files = [];
  for (const top of ['test', 'tools', 'plugins', 'app']) {
    const p = join(ROOT, top);
    try { if (statSync(p).isDirectory()) listMjsFiles(p, files); } catch { /* absent, skip */ }
  }
  // harness/*.mjs itself is the DEFINITION, not a consumer — excluded from the risky population.
  files.sort();

  const allFindings = [];
  const allUnrecognised = [];
  for (const abs of files) {
    const rel = relative(ROOT, abs);
    const src = readFileSync(abs, 'utf8');
    const { findings, unrecognised } = scanSource(src);
    for (const f of findings) allFindings.push({ file: rel, ...f });
    for (const u of unrecognised) allUnrecognised.push({ file: rel, ...u });
  }
  return { findings: allFindings, unrecognised: allUnrecognised, fileCount: files.length };
}

/* ══════════════════════════════════ SELFTEST (plan §A2 acceptance #3) ═════════════════════ */

const FIXTURES = [
  {
    label: 'known-bad name-first site (check(name, cond) with a literal in slot 2)',
    src: `import { test, check } from '../../harness/test.mjs';\n` +
         `test('x', () => {\n` +
         `  check('the thing happened', 'it did', 'detail');\n` +
         `});\n`,
    expectFinding: true,
  },
  {
    label: 'known-bad cond-first site (expect(cond, msg) with a literal in slot 1)',
    src: `import { test, expect } from '../../harness/test.mjs';\n` +
         `test('x', () => {\n` +
         `  expect('this always passes', 'should have been a real condition');\n` +
         `});\n`,
    expectFinding: true,
  },
  {
    label: `false positive #1 — valid boolean beginning with a string literal ('seq' in it && ...)`,
    src: `import { test, check as expect } from '../../harness/test.mjs';\n` +
         `test('x', () => {\n` +
         `  expect('shape', 'seq' in it && 'kind' in it && typeof it.seq === 'number');\n` +
         `});\n`,
    expectFinding: false,
  },
  {
    label: 'false positive #2 — numeric addition, not string concatenation (a.b + a.c === 18)',
    src: `import { test, expect } from '../../harness/test.mjs';\n` +
         `test('x', () => {\n` +
         `  expect(a.b + a.c === 18, 'sums correctly');\n` +
         `});\n`,
    expectFinding: false,
  },
];

function runSelftest() {
  let ok = true;
  console.log('── 0667 detector selftest ──');
  for (const fx of FIXTURES) {
    const { findings, unrecognised } = scanSource(fx.src);
    if (unrecognised.length > 0) {
      ok = false;
      console.log(`FAIL  ${fx.label} — unexpected unrecognised-import report: ${JSON.stringify(unrecognised)}`);
      continue;
    }
    const got = findings.length > 0;
    if (got === fx.expectFinding) {
      console.log(`ok    ${fx.label}`);
    } else {
      ok = false;
      console.log(`FAIL  ${fx.label} — expected finding=${fx.expectFinding}, got ${got} (findings: ${JSON.stringify(findings)})`);
    }
  }
  return ok;
}

/* ══════════════════════════════════ CLI ═══════════════════════════════════════════════════ */

function main() {
  const selftestOk = runSelftest();
  if (!selftestOk) {
    console.log('\n⛔ SELFTEST FAILED — the detector itself is wrong. Not trusting a repo scan built on it.');
    process.exit(2);
  }
  if (process.argv.includes('--selftest')) {
    console.log('\nselftest only, as requested — exiting.');
    process.exit(0);
  }

  console.log('\n── 0667 detector: scanning repo ──');
  const { findings, unrecognised, fileCount } = scanRepo();
  console.log(`scanned ${fileCount} .mjs files under test/, tools/, plugins/, app/`);

  if (unrecognised.length > 0) {
    console.log(`\n⛔ ${unrecognised.length} UNRECOGNISED IMPORT SHAPE(S) — cannot classify, not silently skipping:`);
    for (const u of unrecognised) console.log(`  ${u.file}:${u.line}  ${u.text}`);
  }

  if (findings.length > 0) {
    console.log(`\n⛔ ${findings.length} GENUINE VACUOUS-ASSERTION SITE(S):`);
    for (const f of findings) {
      console.log(`  ${f.file}:${f.line}  ${f.name}(${f.argsText})  [${f.class}, slot ${CONDITION_SLOT[f.class] + 1}]`);
    }
  }

  if (findings.length === 0 && unrecognised.length === 0) {
    console.log('\n0 genuine sites, 0 unrecognised import shapes.');
  }

  process.exit((findings.length > 0 || unrecognised.length > 0) ? 1 : 0);
}

main();
