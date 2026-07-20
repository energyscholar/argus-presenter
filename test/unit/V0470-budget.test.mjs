/*
 * T-BUDGET (Plan 0470, Phase A) — the heaviness gate. The default page must add ONLY the
 * sub-1KB Tier-0 stub; Tier-1 (capture + worklet) is budget-bounded; Tier-1 references NO
 * WebAssembly. These budgets are CI-gated INVARIANTS — loosening one to pass oversized code
 * inverts the whole point of the plan (drift guard).
 */
import { test, expect } from '../../harness/test.mjs';
import { readFileSync } from 'fs';
import { gzipSync } from 'zlib';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib');
const sizeOf = (f) => { const raw = readFileSync(join(LIB, f)); return { raw: raw.length, gzip: gzipSync(raw).length, text: raw.toString('utf8') }; };

// Budgets from the plan's "Heaviness evaluation & byte budget" section.
const STUB_RAW = 1500, STUB_GZIP = 800;
const TIER1_RAW = 30 * 1024, TIER1_GZIP = 10 * 1024;

test('T-BUDGET Tier-0 stub is within budget (<=1500B raw / <=800B gzip)', () => {
  const s = sizeOf('voice-stub.js');
  console.log(`  voice-stub.js raw=${s.raw} gzip=${s.gzip}`);
  expect(s.raw <= STUB_RAW, `stub raw <= ${STUB_RAW}`, s.raw);
  expect(s.gzip <= STUB_GZIP, `stub gzip <= ${STUB_GZIP}`, s.gzip);
});

test('T-BUDGET Tier-1 (capture + worklet) is within budget (<=30KB raw / <=10KB gzip)', () => {
  const cap = sizeOf('voice-capture.mjs'), wk = sizeOf('voice-worklet.js');
  const raw = cap.raw + wk.raw, gzip = cap.gzip + wk.gzip;
  console.log(`  tier1 raw=${raw} gzip=${gzip} (capture raw=${cap.raw} worklet raw=${wk.raw})`);
  expect(raw <= TIER1_RAW, `tier1 raw <= ${TIER1_RAW}`, raw);
  expect(gzip <= TIER1_GZIP, `tier1 gzip <= ${TIER1_GZIP}`, gzip);
});

test('T-BUDGET Tier-1 references NO WebAssembly (.wasm)', () => {
  for (const f of ['voice-capture.mjs', 'voice-worklet.js']) {
    const { text } = sizeOf(f);
    expect(!/\.wasm/.test(text), `${f} contains no ".wasm" reference`);
  }
});

test('T-BUDGET the stub does NOT statically import Tier 1 (laziness by construction, RT-10)', () => {
  const { text } = sizeOf('voice-stub.js');
  // A static `import ... from '/lib/voice-capture'` would defeat T-LAZY. Only dynamic import() is allowed.
  expect(!/import\s+[^(]*from\s+['"]\/lib\/voice-capture/.test(text), 'no static import of voice-capture');
  expect(/import\(/.test(text), 'stub reaches Tier 1 via dynamic import()');
});
