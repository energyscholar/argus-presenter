/*
 * V1 — content-module validator (Plan 0438 Group D). Warn-never-block: pure, no throw.
 */
import { test, expect } from '../../harness/test.mjs';
import { validate, summarize } from '../../app/validate.mjs';

test('V — a clean module yields zero warnings and zero info', () => {
  const clean = {
    manifest: { title: 'X', requirements: { terminalClear: true, gateTimeoutMs: 180000 } },
    beats: [
      { component: 'narration', promptId: 'a-intro' },
      { component: 'choice', promptId: 'a-pick' },
      { component: 'dice', promptId: 'a-roll' },
    ],
  };
  const s = summarize(validate(clean));
  expect(s.warn === 0 && s.info === 0, 'clean = 0 warn / 0 info', JSON.stringify(s));
});

test('V — a bad module trips the expected WARN codes and never throws', () => {
  const bad = { beats: [
    { component: 'frobnicate', promptId: 'a:colon' },
    { component: 'choice' },
    { component: 'dice', promptId: 'a:colon' },
  ] };
  const codes = summarize(validate(bad)).warnings.map((w) => w.code);
  expect(codes.includes('V3-unknown-component'), 'V3 unknown component', JSON.stringify(codes));
  expect(codes.includes('V4-promptid-colon'), 'V4 colon in promptId', JSON.stringify(codes));
  expect(codes.includes('V6-interactive-no-promptid'), 'V6 interactive w/o promptId', JSON.stringify(codes));
  expect(codes.includes('V5-dup-promptid'), 'V5 duplicate promptId', JSON.stringify(codes));
});

test('V — an empty module warns V2 and still returns (never blocks)', () => {
  const s = summarize(validate({ beats: [] }));
  expect(s.warnings.some((w) => w.code === 'V2-empty'), 'V2 empty', JSON.stringify(s));
});

test('V — driver-owned concerns are INFO not WARN (terminal-clear, gate-timeout)', () => {
  const noManifest = { beats: [{ component: 'narration', promptId: 'x' }] };
  const s = summarize(validate(noManifest));
  expect(s.warn === 0, 'no WARN from missing manifest/terminal', JSON.stringify(s));
  expect(s.infos.some((i) => i.code === 'V7-no-terminal-affordance'), 'V7 is info', JSON.stringify(s));
});
