/*
 * V1 — content-module validator (Plan 0438 Group D). Warn-never-block: pure, no throw.
 */
import { test, expect } from '../../harness/test.mjs';
import { validate, summarize } from '../../app/validate.mjs';

test('V — a clean module yields zero warnings and zero info', () => {
  const clean = {
    manifest: { title: 'X', defaultBeatId: 'a-intro', requirements: { terminalClear: true, gateTimeoutMs: 180000 } },
    beats: [
      { id: 'a-intro', component: 'narration', promptId: 'a-intro', durationSec: 30 },
      { component: 'choice', promptId: 'a-pick' },
      { component: 'dice', promptId: 'a-roll' },
    ],
  };
  const s = summarize(validate(clean));
  expect(s.warn === 0 && s.info === 0, 'clean = 0 warn / 0 info', JSON.stringify(s));
});

test('V — a bad module trips the expected WARN codes and never throws', () => {
  const bad = { beats: [
    { component: 'frobnicate', promptId: 'x' },        // V3 unknown component
    { component: 'choice' },                            // V6 interactive w/o promptId
    { component: 'choice', promptId: 'a:dup' },         // V4 colon
    { component: 'dice', promptId: 'a:dup' },           // V4 colon + V5 dup (two INTERACTIVE share a promptId)
  ] };
  const codes = summarize(validate(bad)).warnings.map((w) => w.code);
  expect(codes.includes('V3-unknown-component'), 'V3 unknown component', JSON.stringify(codes));
  expect(codes.includes('V4-promptid-colon'), 'V4 colon in promptId', JSON.stringify(codes));
  expect(codes.includes('V6-interactive-no-promptid'), 'V6 interactive w/o promptId', JSON.stringify(codes));
  expect(codes.includes('V5-dup-promptid'), 'V5 duplicate promptId (interactive)', JSON.stringify(codes));
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

test('V — V12 flags a branch target that is not a beat id (dead-end typo)', () => {
  const m = { manifest: { requirements: { terminalClear: true } }, beats: [
    { id: 'a', component: 'choice', promptId: 'a', branch: { x: 'nope', y: 'b' } },
    { id: 'b', component: 'card' } ] };
  const codes = summarize(validate(m)).warnings.map((w) => w.code);
  expect(codes.includes('V12-branch-target-missing'), 'V12 catches missing branch target', JSON.stringify(codes));
});

test('V — V5 does NOT flag declared variants sharing a promptId', () => {
  const m = { manifest: { requirements: { terminalClear: true } }, beats: [
    { id: 'q1', component: 'choice', promptId: 'pick' },
    { id: 'q2', component: 'choice', promptId: 'pick', variantOf: 'pick' } ] };
  const codes = summarize(validate(m)).warnings.map((w) => w.code);
  expect(!codes.includes('V5-dup-promptid'), 'V5 excludes variantOf', JSON.stringify(codes));
});

test('V — a terminal clear beat is clean (V7 satisfied, not V3-unknown)', () => {
  const m = { beats: [{ id: 'a', component: 'narration', promptId: 'a' }, { id: 'z', component: 'clear' }] };
  const r = summarize(validate(m));
  expect(!r.warnings.some((w) => w.code === 'V3-unknown-component'), "'clear' is a known terminal pseudo-component", JSON.stringify(r.warnings));
  expect(!r.infos.some((i) => i.code === 'V7-no-terminal-affordance'), 'clear beat satisfies V7', JSON.stringify(r.infos));
});

test('V — V14 flags a section beatId with no matching beat', () => {
  const m = { manifest: { requirements: { terminalClear: true } }, sections: [{ id: 's', beatIds: ['a', 'ghost'] }], beats: [{ id: 'a', component: 'card' }] };
  const codes = summarize(validate(m)).warnings.map((w) => w.code);
  expect(codes.includes('V14-section-beatid-missing'), 'V14 catches bad section ref', JSON.stringify(codes));
});

test('V19 — a module with beats but no durationSec gets the advisory info', () => {
  const m = { beats: [{ component: 'narration', promptId: 'a' }, { component: 'card' }] };
  const codes = summarize(validate(m)).infos.map((i) => i.code);
  expect(codes.includes('V19-no-duration'), 'V19 fires when no beat has a duration', JSON.stringify(codes));
});

test('V19 — any beat carrying a numeric durationSec suppresses the advisory', () => {
  const m = { beats: [{ component: 'narration', promptId: 'a', durationSec: 120 }, { component: 'card' }] };
  const infos = summarize(validate(m)).infos.map((i) => i.code);
  expect(!infos.includes('V19-no-duration'), 'V19 suppressed once a duration is present', JSON.stringify(infos));
});
