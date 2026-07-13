/*
 * DEF-1 — V20 default-page advisory (pure validator, unit tier). A module with beats
 * but no manifest.defaultBeatId gets the V20-no-default INFO (advisory, never WARN);
 * declaring a defaultBeatId suppresses it. Live-tier cascade behaviour is in test/live/def-page.
 */
import { test, expect } from '../../harness/test.mjs';
import { validate, summarize } from '../../app/validate.mjs';

test('V20 — a module with beats but no manifest.defaultBeatId gets the advisory info', () => {
  const m = { manifest: { requirements: { terminalClear: true } }, beats: [
    { id: 'a', component: 'narration', promptId: 'a', durationSec: 30 },
    { id: 'b', component: 'card' },
  ] };
  const s = summarize(validate(m));
  expect(s.warn === 0, 'V20 never WARNs', JSON.stringify(s));
  expect(s.infos.some((i) => i.code === 'V20-no-default'), 'V20 fires when no defaultBeatId', JSON.stringify(s.infos.map((i) => i.code)));
});

test('V20 — declaring manifest.defaultBeatId suppresses the advisory', () => {
  const m = { manifest: { defaultBeatId: 'a', requirements: { terminalClear: true } }, beats: [
    { id: 'a', component: 'narration', promptId: 'a', durationSec: 30 },
    { id: 'b', component: 'card' },
  ] };
  const infos = summarize(validate(m)).infos.map((i) => i.code);
  expect(!infos.includes('V20-no-default'), 'V20 suppressed once defaultBeatId is present', JSON.stringify(infos));
});
