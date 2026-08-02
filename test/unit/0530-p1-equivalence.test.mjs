/*
 * Plan 0530 P1 — THE EQUIVALENCE GATE.
 *
 * ⛔ SCAFFOLDING. Deleted by plan 0530 P9 together with `test/harness/equivalence.mjs` and
 *    `test/fixtures/0530-baseline.json`. P9 fails if any of the three survives. This file imports
 *    the harness, so deleting the harness without deleting this file breaks discovery — that is
 *    deliberate: the three go together or not at all.
 *
 * Plan 0530 §2: NO PHASE MAY CHANGE BEHAVIOUR. This is the test that says so out loud. It drives
 * a server through the harness's fixed script, normalises the result, and demands it be identical
 * to the fingerprint captured before the first extraction.
 *
 * ⛓ THE SECOND TEST IS THE POINT. A baseline that has only ever matched is not evidence — it is a
 * file. t0530-p1-02 mutates one field in each of the four sections and requires the comparator to
 * report each one, by path, with both values. And the break was also performed for real: the
 * server's own 404 body was changed to 'not found.' during P1, the harness went red on exactly the
 * routes that serve it, and the change was reverted. A gate you have only seen pass is untested.
 *
 * ⚠ t0530-p1-03 is the empty-instrument guard. A harness that captured nothing would report "no
 * difference" forever, so the fingerprint's own SIZE is asserted: if a refactor silently stops the
 * capture reaching a section, the count falls and this goes red rather than the gate going quiet.
 */
import { test, expect } from '../../harness/test.mjs';
import { captureInChildProcess, diff, coverage, readBaseline, BASELINE_PATH } from '../harness/equivalence.mjs';

/*
 * One capture, shared: it drives three servers and takes ~15 s.
 * ⛓ IN A CHILD PROCESS. `app/log.mjs`'s ring is per-PROCESS, so an in-process capture inside the
 * full suite scoops up log lines from other tests' still-open servers — measured as 40 phantom
 * differences under `npm test` against a baseline that matched perfectly when run alone.
 */
let _fp = null;
async function fingerprint() { if (!_fp) _fp = captureInChildProcess(); return _fp; }

test('t0530-p1-01 — the behavioural fingerprint is identical to the 0530 baseline', async () => {
  const base = readBaseline();
  expect(base != null, 'the baseline fixture exists — capture it with `node test/harness/equivalence.mjs capture`', BASELINE_PATH);
  const fp = await fingerprint();
  const d = diff(base, fp);
  expect(d.length === 0,
    `${d.length} behavioural difference(s) from the baseline — plan 0530 §2 forbids ALL of them`,
    '\n  ' + d.slice(0, 12).map((x) => `${x.path}\n      baseline: ${x.baseline}\n      current : ${x.current}`).join('\n  '));
});

test('t0530-p1-02 — the comparator DETECTS a difference in every section, and says what differed', async () => {
  const fp = await fingerprint();
  const clone = () => JSON.parse(JSON.stringify(fp));

  // Four mutations, one per section of plan 0530 §3, each the smallest change that section can
  // carry: a changed status code, a changed reply field, a changed op path, a changed log message.
  const mutations = [
    {
      what: 'an HTTP status code', path: 'sections.http.bare.not-found.response.status',
      apply: (o) => { o.sections.http.bare['not-found'].response.status = 418; },
    },
    {
      what: 'a socket reply field', path: 'sections.sockets.welcome.participant.frames[0].role',
      apply: (o) => { const f = o.sections.sockets.welcome.participant.frames[0]; f.role = 'sovereign'; },
    },
    {
      what: 'an oplog entry', path: 'sections.session.oplog[0].path',
      apply: (o) => { o.sections.session.oplog[0].path = 'somewhere/else'; },
    },
    {
      what: 'a log line', path: 'logs.session.byTag.conn[0].msg',
      apply: (o) => { o.logs.session.byTag.conn[0].msg = 'a message the server never emitted'; },
    },
  ];

  for (const m of mutations) {
    const broken = clone();
    m.apply(broken);
    const d = diff(fp, broken);
    expect(d.length > 0, `the comparator sees ${m.what} change`, m.path);
    const hit = d.find((x) => x.path === m.path);
    expect(!!hit, `and NAMES the field that changed (${m.what})`, JSON.stringify(d.slice(0, 3)));
    expect(hit && hit.baseline !== hit.current, 'reporting BOTH values, not just that something moved', JSON.stringify(hit));
  }

  // A field that DISAPPEARS is a difference too — the redactor tokenises rather than drops
  // precisely so this stays detectable.
  const dropped = clone();
  delete dropped.sections.session.presence;
  const dd = diff(fp, dropped);
  expect(dd.some((x) => x.path === 'sections.session.presence' && x.current === '<ABSENT>'),
    'a REMOVED field is reported as absent, not silently equal', JSON.stringify(dd.slice(0, 3)));

  // And the control: an unmutated copy is clean. Without this the three above prove only that
  // diff() is noisy.
  expect(diff(fp, clone()).length === 0, 'an identical copy produces ZERO differences');
});

test('t0530-p1-03 — the instrument is not empty: the fingerprint covers every section', async () => {
  const fp = await fingerprint();
  const c = coverage(fp);
  const floors = { httpBare: 30, httpGated: 60, welcomes: 10, messageProbes: 50, oplogEntries: 10, logLines: 100, logTags: 10, pingsCompared: 10, bytesCompared: 100 };
  for (const [k, floor] of Object.entries(floors)) {
    expect(c[k] >= floor, `the fingerprint still covers ${k} (>= ${floor})`, `${k}=${c[k]}`);
  }

  /*
   * ⛓ P2b — THE HEARTBEAT EXCLUSION MAY NOT GROW, IN EITHER DIRECTION.
   *
   * `sawPing` was a false-positive generator: 10 sequential `verify` runs on an UNCHANGED tree gave
   * 8 EQUIVALENT and 2 DIFFERENT, both DIFFERENT runs reporting only
   * `sections.sockets.messages.station-show@participant.sawPing`. The cause is the 5 s heartbeat
   * (`app/server.mjs:763`) landing on whichever probe socket happens to be open. It is now compared
   * ONLY in the hello-reply window, where the ping is the deterministic X3 RTT probe, and carries a
   * named token in the 55 post-welcome windows (52 message probes + 3 session sockets).
   *
   * The `pingsCompared` floor above stops the exclusion eating the 10 windows that DO carry
   * behaviour. This ceiling stops it spreading to windows nobody has justified. A phase that trips
   * either has widened a deliberate loss of evidence: justify it in the splitPings block, or undo it.
   */
  expect(c.pingsExcluded === 55,
    'the heartbeat exclusion still covers exactly the 55 post-welcome windows — no more, no fewer',
    `pingsExcluded=${c.pingsExcluded}`);

  /*
   * ⛓ P2c — THE SESSION-LOG BYTE EXCLUSION MAY NOT GROW EITHER, IN EITHER DIRECTION.
   *
   * `/api/session-log` STATS A DIRECTORY, so what it reported depended on whether the log's 250 ms
   * flush timer had fired yet: 10 sequential captures on an UNCHANGED tree gave 9 EQUIVALENT and 1
   * DIFFERENT, the odd one reporting 20 differences in that one route and nothing else. The probe is
   * now flushed before it fires and reads its OWN directory, so the CONTENT is deterministic and
   * fully compared — including the provenance entry the old baseline froze as an empty array.
   *
   * What is left is the arithmetic the harness cannot own: the log's header carries `pid`, so its
   * byte totals follow the process table's decimal width. Fifteen `bytes` fields count session-log
   * bytes (12 across the two credentialled /api/session-log reads, 3 in the session section) and
   * carry the token; the other 100+ are HTTP body lengths and are REAL EVIDENCE. The floor above
   * stops the exclusion eating them; this ceiling stops it spreading by even one field.
   */
  expect(c.bytesExcluded === 15,
    'the session-log byte exclusion still covers exactly 15 fields — no more, no fewer',
    `bytesExcluded=${c.bytesExcluded}`);
  expect(!JSON.stringify(fp.sections).includes('<CAPTURE-FAILED>'),
    'no section threw during capture — a thrown section would compare equal to a thrown baseline',
    JSON.stringify(fp.sections).slice(0, 300));
});
