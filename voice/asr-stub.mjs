#!/usr/bin/env node
/*
 * asr-stub.mjs — a PERSISTENT stub ASR worker for CI (Plan 0470). No whisper, no network.
 * Loads "once" (this process), then echoes a fixed transcript per wav-path line — exactly the
 * warm line-protocol shape app/asr.mjs drives. T-ASR-WARM points PRESENTER_ASR_CMD here.
 *
 * If AP_ASR_COUNT_FILE is set, this worker INCREMENTS that file's integer on startup. A warm
 * worker (spawned once, reused) leaves it at 1 across many segments; cold-spawn-per-segment
 * would grow it — which is exactly the failure T-ASR-WARM catches.
 */
import { readFileSync, writeFileSync } from 'fs';

const countFile = process.env.AP_ASR_COUNT_FILE;
if (countFile) {
  let n = 0;
  try { n = parseInt(readFileSync(countFile, 'utf8') || '0', 10) || 0; } catch (e) {}
  try { writeFileSync(countFile, String(n + 1)); } catch (e) {}
}

const TEXT = process.env.AP_ASR_STUB_TEXT || 'hello world';
process.stdout.write(JSON.stringify({ ready: true }) + '\n');

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) process.stdout.write(JSON.stringify({ text: TEXT, conf: 0.9 }) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
