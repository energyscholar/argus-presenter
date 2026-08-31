/*
 * Plan 0720 B11 — A TOOL'S DECLARED SCHEMA MUST MATCH WHAT ITS HANDLER READS.  A STATIC LINT.
 *
 * ⛔⛔ WHY THIS EXISTS. On 2026-08-30 a plugin tool declared an input property `stations` while its
 * handler destructured `station`. A caller following the DECLARED schema passed `stations`, the
 * handler saw `undefined`, and silently took the OTHER branch — a 200 and a wrong answer, with no
 * error anywhere.
 *
 * ⭐⭐ FOURTEEN PASSING TESTS MISSED IT, and the reason generalises: every one of them called the
 * tool the way the HANDLER wants, because they were written from the implementation.
 * **A test written from the implementation cannot catch a schema/implementation mismatch** — it
 * reproduces the mismatch instead of detecting it. Only comparing the two declarations catches it.
 *
 * ── ⚠ WHY STATIC AND NOT LIVE ───────────────────────────────────────────────────────────────────
 * The first draft ran against a booted server and found NOTHING — `pluginTools()` returns a
 * projection (`name`, `description`, `input`, `plugin`) and deliberately does not expose handlers,
 * so all fifteen tools were skipped. ⭐ It reported `checked 0` and FAILED rather than passing
 * vacuously, which is the only reason the hole was visible. The defect is a source-level
 * inconsistency, so the source is the right place to read it.
 *
 * ⛔ This repo is PUBLIC and domain-free. Nothing here names a tool, a ship or a campaign word; it
 * globs whatever plugin sources the deployment happens to have installed.
 */
import { test, expect } from '../../harness/test.mjs';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGINS = join(ROOT, 'plugins');

/** Every server-side module a plugin ships, one level deep plus the plugin root. */
function pluginSources() {
  if (!existsSync(PLUGINS)) return [];
  const out = [];
  for (const p of readdirSync(PLUGINS)) {
    const dir = join(PLUGINS, p);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.mjs') && !f.endsWith('.test.mjs')) out.push(join(dir, f));
    }
  }
  return out;
}

/**
 * Pull `{ declared[], read[] }` out of each `addTool({ … })` literal.
 *
 * ⚠ Text scanning, and its limits are declared rather than hidden. It finds the `properties: { … }`
 * block and the handler's leading object pattern within one `addTool(` region. Anything it cannot
 * parse is SKIPPED and counted — it reports what it can prove and never invents a verdict.
 */
function toolsIn(src) {
  const found = [];
  const re = /addTool\(\{/g;
  let m;
  while ((m = re.exec(src))) {
    /* ⛔ A FIXED WINDOW OVERRUNS INTO THE NEXT TOOL and pairs one tool's schema with another's
       handler — the first run reported nine false positives on one tool for exactly that reason.
       Match the brace instead. */
    let d = 0, stop = m.index;
    for (let j = m.index + 'addTool('.length - 1; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}') { d--; if (d === 0) { stop = j + 1; break; } }
    }
    const region = src.slice(m.index, stop);
    const name = (/name:\s*'([^']+)'/.exec(region) || [])[1] || '(unnamed)';

    const props = /properties:\s*\{/.exec(region);
    if (!props) { found.push({ name, skip: 'no properties block' }); continue; }
    // walk braces from the properties block so nested objects do not end it early
    let i = props.index + props[0].length - 1, depth = 0, end = -1;
    for (; i < region.length; i++) {
      if (region[i] === '{') depth++;
      else if (region[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) { found.push({ name, skip: 'unterminated properties block' }); continue; }
    const body = region.slice(props.index + props[0].length, end);

    /* a declared key is `key:` at this level; comments are stripped first so a key NAMED inside a
       warning comment is not mistaken for a declaration — that bit me once already. */
    const clean = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const declared = [];
    const keyRe = /(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*:\s*\{/g;
    let k;
    while ((k = keyRe.exec(clean))) declared.push(k[1]);

    /* ⛔⛔ BRACE-MATCH THE HANDLER'S PATTERN. `\{([^}]*)\}` stops at the FIRST `}`, which in practice
       is an object DEFAULT — `opts = {}`, `requires = []` — so every name AFTER it is invisible and
       is reported as a declared-but-unread property. Run over the CORE surface (plan 0720 RUN B,
       measured 2026-08-31) that expression produced EIGHT offenders and every one was a false
       positive. ⭐ A lint that is mostly noise teaches people to skim it, and skimming is how the
       one true positive gets missed — the very failure this file exists to prevent. */
    const hStart = /handler:\s*(?:async\s*)?\(\s*\{/.exec(region);
    if (!hStart) { found.push({ name, skip: 'handler takes an opaque argument' }); continue; }
    let hd = 0, hEnd = -1, hOpen = hStart.index + hStart[0].length - 1;
    for (let j = hOpen; j < region.length; j++) {
      if (region[j] === '{') hd++;
      else if (region[j] === '}') { hd--; if (hd === 0) { hEnd = j; break; } }
    }
    if (hEnd < 0) { found.push({ name, skip: 'unterminated handler pattern' }); continue; }
    const h = [null, region.slice(hOpen + 1, hEnd)];
    /* ⛔⛔ A REST ELEMENT COLLECTS EVERY REMAINING KEY, so a declared property this handler never
       NAMES is still reachable through it. The lint can prove nothing about such a tool and must
       say so rather than accuse it — the first run flagged fourteen properties across four tools
       that were all read via `...payload`. ⭐ A checker that is mostly noise teaches people to skim
       it, and skimming is how the one true positive gets missed. */
    if (/\.\.\./.test(h[1])) { found.push({ name, skip: 'handler collects a rest element' }); continue; }

    /* Top-level commas only — a comma inside `{a:1, b:2}` or `[1, 2]` is part of a default value,
       not a second parameter. */
    const parts = []; let pd = 0, cur = '';
    for (const ch of h[1]) {
      if (ch === '{' || ch === '[' || ch === '(') pd++;
      else if (ch === '}' || ch === ']' || ch === ')') pd--;
      if (ch === ',' && pd === 0) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    parts.push(cur);
    const read = parts.map((p) => p.trim().split(/[:=]/)[0].trim())
      .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));

    found.push({ name, declared, read });
  }
  return found;
}

test('0720 B11 — the lint can report BAD (a gate seen only passing is untested)', async () => {
  const decoy = `addTool({
    name: 'decoy',
    input: { type: 'object', properties: { misspelled: { type: 'string' } } },
    handler: async ({ correct = null } = {}) => correct,
  });`;
  const [t] = toolsIn(decoy);
  expect(t && t.declared && t.declared.includes('misspelled'), 'the decoy declares its property');
  expect(t.read && !t.read.includes('misspelled'), 'and the lint sees the handler does not read it');
});

test('0720 B11 — every DECLARED input property is one the handler actually reads', async () => {
  const files = pluginSources();
  expect(files.length > 0, 'this deployment has plugin sources to lint', String(files.length));

  const offenders = [], skipped = [];
  let checked = 0;
  for (const f of files) {
    const rel = f.slice(PLUGINS.length + 1);
    for (const t of toolsIn(readFileSync(f, 'utf8'))) {
      if (t.skip) { skipped.push(`${rel}:${t.name} (${t.skip})`); continue; }
      checked++;
      for (const key of t.declared) {
        /* ⛔ THE DIRECTION THAT MATTERS: a declared property the handler never reads is a promise
           the tool does not keep. The caller supplies it, gets a 200, and the value is discarded. */
        if (!t.read.includes(key)) {
          offenders.push(`${rel}:${t.name} declares "${key}" — handler reads [${t.read.join(', ')}]`);
        }
      }
    }
  }
  console.log(`      linted ${checked} tool(s) across ${files.length} file(s); skipped ${skipped.length}`);
  expect(checked > 0, 'the sweep was not vacuous — it compared at least one real tool');
  expect(offenders.length === 0, 'no tool declares an input its handler never reads',
    offenders.join(' | '));
});
