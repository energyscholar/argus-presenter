/*
 * Plan 0661 phase 2 — THE LAYER GUARD.
 *
 * A structural check over the seams phases 1/1b/1c cut. Every rule encodes a failure that ALREADY
 * HAPPENED in this refactor, so none is speculative:
 *
 *   L1  no route may be shadowed by an earlier prefix
 *   L2  the wire table must be non-empty, and its keys unique
 *   L3  neither seam may import back into server.mjs
 *   (L4 was attempted and removed — see the note at the foot of this file)
 *
 * ⛔ THIS IS NOT PSS. PSS maps [file location] ↔ [CI context] and is a ROUTER; making it also judge
 *   code would give one mechanism two jobs and a reason to disagree with itself. This is a separate
 *   guard that happens to check structure. [[feedback-pss-is-a-router-not-a-linter]]
 *
 * ⚠ NO PARSER, DELIBERATELY. The obvious implementation walks an AST, but acorn is not a dependency
 *   here and adding one to satisfy a guard would put a new package in the pinned stack — and npm is
 *   unusable in this sandbox, so package.json and the lock would drift apart and break `npm ci` in
 *   CI. L1–L3 read GENERATED lines of fixed shape, where a literal match is honest. L4 does not
 *   approximate the AST at all; it tests the real thing (see below).
 *
 * ⭐ L4 IS THE IMPORTANT ONE, and it is a RUNTIME probe rather than a static one. A handler that
 *   reaches for a binding the context does not supply throws ReferenceError at CALL time, into a
 *   catch that logs at warn — the socket goes quiet and nothing useful is logged. That exact shape
 *   cost this refactor a correct migration, backed out with "I could not explain it". Because the
 *   fault IS a ReferenceError, the honest test is to invoke every handler and assert that none is
 *   raised: a static list can drift, a thrown ReferenceError cannot lie.
 *   [[feedback-enforce-by-construction-not-by-refusal]]
 */
import { test, check } from '../../harness/test.mjs';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';


const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app');
const read = (f) => readFileSync(join(APP, f), 'utf8');
const all = (src, re) => [...src.matchAll(re)].map((m) => m[1]);

test('0661 L1 — no HTTP route is shadowed by an earlier prefix', () => {
  const src = read('http-routes.mjs');
  const exact = all(src, /^\s*exactRoutes\.set\("([^"]+)"/gm);
  const paths = all(src, /^\s*pathRoutes\.set\("([^"]+)"/gm);
  const prefs = all(src, /^\s*prefixRoutes\.push\(\["([^"]+)"/gm);
  check('the three route tables were found', exact.length + paths.length + prefs.length >= 20,
        `exact=${exact.length} path=${paths.length} prefix=${prefs.length}`);
  const bad = [];
  for (const p of prefs)
    for (const k of [...exact, ...paths, ...prefs])
      if (k !== p && k.startsWith(p)) bad.push(`${k} ← swallowed by prefix ${p}`);
  // ⭐ A prefix that swallows another key resolves differently in a TABLE than it did in the ordered
  //   chain the table replaced. That equivalence is the ENTIRE justification for using a table, and
  //   it was measured once, at conversion time. This is what keeps it true.
  check('no route key is swallowed by a prefix', bad.length === 0, bad.join(' · '));
});

test('0661 L2 — the wire action table is populated and its keys are unique', () => {
  const names = all(read('wire-actions.mjs'), /^\s*wireActions\.set\("([^"]+)"/gm);
  // ⛔ An EMPTY table is the failure that started all of this: it cannot throw, so it ships green
  //   and the dispatch beneath it is never executed even once.
  //   [[feedback-an-empty-abstraction-step-ships-unexercised]]
  check('the table is not empty', names.length > 0, `${names.length} actions registered`);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  // An if/else chain is ORDERED; a Map is not. Duplicate keys would silently change which wins.
  check('no duplicate action keys', dupes.length === 0, dupes.join(', '));
});

test('0661 L3 — neither seam imports back into server.mjs', () => {
  for (const f of ['wire-actions.mjs', 'http-routes.mjs']) {
    const back = all(read(f), /^import[^;]*from\s*'([^']*server\.mjs)'/gm);
    // A cycle would mean the seam was cut in the wrong place — the rule http-routes.mjs has carried
    // in a comment since plan 0530 P2, now enforced instead of merely asserted.
    check(`${f} does not import server.mjs`, back.length === 0, back.join(', '));
  }
});

/*
 * ⛔ THERE IS NO L4, AND THAT IS THE FINDING.
 *
 * The rule this file wanted most was "no handler reaches for a binding its context does not
 * supply" — the ReferenceError class that cost this refactor a correct migration. It was written,
 * as a runtime probe: build the table against a permissive Proxy context, invoke every handler, and
 * assert that none raises ReferenceError.
 *
 * ⛔ IT WAS VACUOUS. Negative-tested by deleting `send` from the factory's destructure — a binding
 *   twelve handlers use — the probe still reported PASS. With stub data every handler throws a
 *   TypeError within a line or two and never REACHES the statement that would have raised the
 *   ReferenceError. A runtime probe can only see the bindings on the path it actually executes, and
 *   with stub state that path is almost nothing.
 *
 * ⭐ The static version needs an AST, and acorn is not a dependency here; adding one to satisfy a
 *   guard would put a new package in the pinned stack, and npm is unusable in this sandbox, so
 *   package.json and the lock would drift apart and break `npm ci` in CI. Not worth it, because:
 *
 * ⭐⭐ THE BUG CLASS IS ALREADY COVERED, by test/component/0661-wire-action-table.test.mjs. That test
 *   drives a real `hello` frame through a real server, so it executes the handlers for real rather
 *   than against stubs. It has now caught this exact fault three times: the missing `req` binding,
 *   a populate block that landed outside createServer, and — verified deliberately — the deleted
 *   `send`. A second, weaker check of the same thing would have added confidence without adding
 *   coverage, which is the worst trade a test suite can make.
 *
 * The rule was removed rather than left passing. A guard seen only passing is not a tested guard,
 * and one proven not to fail when it should is worse than none.
 * [[feedback-a-gate-you-have-only-seen-pass-is-untested]]
 */
