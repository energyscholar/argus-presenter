#!/usr/bin/env node
/*
 * asr-stub.mjs — a PERSISTENT stub ASR worker for CI (Plan 0470; protocol per Plan 0904 V1.8).
 * No whisper, no network. Loads "once" (this process), then answers one result per request in
 * exactly the protocol app/asr.mjs speaks:
 *     in : "#<id> <n>\n" + <n> bytes of WAV
 *     out: {"id":<id>,"text":"...","conf":0.9}\n
 *
 * Knobs (env, or argv flags that win over env so two stubs in one process tree can differ):
 *   AP_ASR_COUNT_FILE       increment this file's integer on startup (T-ASR-WARM: must stay 1)
 *   AP_ASR_STUB_TEXT        the transcript text (default "hello world")
 *   AP_ASR_STUB_MODE=bytes  answer "bytes:<pcm byte count>" — proves the WHOLE segment arrived
 *   AP_ASR_STUB_DELAY_MS    answer each request this many ms after it arrives (queue tests)
 *   AP_ASR_STUB_LOAD_MS     simulate a slow model load: read nothing and announce nothing for this
 *                           many ms after startup (requests wait in the pipe, as with a real engine)
 *   --die                   exit(3) on the first request (a crashing engine)
 *   --text=<t>              same as AP_ASR_STUB_TEXT
 *   --mode=bytes            same as AP_ASR_STUB_MODE=bytes
 */
import { readFileSync, writeFileSync } from 'fs';

const argv = process.argv.slice(2);
const flag = (n) => { const a = argv.find((x) => x === '--' + n || x.startsWith('--' + n + '=')); return a ? (a.includes('=') ? a.slice(a.indexOf('=') + 1) : true) : null; };

const countFile = process.env.AP_ASR_COUNT_FILE;
if (countFile) {
  let n = 0;
  try { n = parseInt(readFileSync(countFile, 'utf8') || '0', 10) || 0; } catch (e) {}
  try { writeFileSync(countFile, String(n + 1)); } catch (e) {}
}

const TEXT = flag('text') || process.env.AP_ASR_STUB_TEXT || 'hello world';
const MODE = flag('mode') || process.env.AP_ASR_STUB_MODE || 'text';
const DELAY = parseInt(process.env.AP_ASR_STUB_DELAY_MS || '0', 10) || 0;
const DIE = !!flag('die');
const LOAD = parseInt(process.env.AP_ASR_STUB_LOAD_MS || '0', 10) || 0;
let loaded = false;
function finishLoad() {
  loaded = true;
  process.stdout.write(JSON.stringify({ ready: true, recognizer: { side: 'server', engine: 'stub', model: 'none', quant: 'none', version: '1', backend: 'node' } }) + '\n');
  drain();
}

let buf = Buffer.alloc(0);
let want = null;   // { id, n } while reading a body
function answer(id, wav) {
  if (DIE) process.exit(3);
  const pcmBytes = Math.max(0, wav.length - 44);
  const text = MODE === 'bytes' ? 'bytes:' + pcmBytes : TEXT;
  const out = () => process.stdout.write(JSON.stringify({ id, text, conf: 0.9 }) + '\n');
  if (DELAY) setTimeout(out, DELAY); else out();
}
process.stdin.on('data', (d) => { buf = Buffer.concat([buf, d]); if (loaded) drain(); });
function drain() {
  for (;;) {
    if (!want) {
      const nl = buf.indexOf(10); if (nl < 0) return;
      const head = buf.subarray(0, nl).toString('utf8'); buf = buf.subarray(nl + 1);
      const m = /^#(\d+) (\d+)$/.exec(head.trim());
      if (!m) continue;   // not a request header: ignore
      want = { id: Number(m[1]), n: Number(m[2]) };
    }
    if (buf.length < want.n) return;
    const body = buf.subarray(0, want.n); buf = buf.subarray(want.n);
    const id = want.id; want = null;
    answer(id, body);
  }
}
process.stdin.on('end', () => process.exit(0));
if (LOAD) setTimeout(finishLoad, LOAD); else finishLoad();
