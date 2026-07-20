/*
 * asr.mjs — the pluggable + WARM speech-recognition seam (Plan 0470, RT-17/25).
 *
 * The default ASR is a PERSISTENT worker process: the model loads ONCE at startup and the
 * worker then serves many segments over a stable line protocol — it is NEVER cold-spawned
 * per segment (that would reload the model each utterance = unusable). AP keeps it warm and
 * watchdog-restarts it on crash. Engine-agnostic: PRESENTER_ASR_CMD names the worker
 * command (default: the faster-whisper wrapper voice/asr-whisper.py). Cold-spawn-per-segment
 * is forbidden and is what T-ASR-WARM proves against.
 *
 * Line protocol (stdin -> stdout, one line each, in order):
 *   in :  <absolute-wav-path>\n
 *   out:  {"text":"...","conf":0.0..1.0,"seq":N?}\n     (one result line per request, FIFO)
 *   out:  {"ready":true}\n                              (optional startup readiness marker, RT-25)
 */
import { spawn } from 'child_process';
import * as log from './log.mjs';

// Split a command string into argv (simple whitespace split; quote-aware for the common case).
function splitCmd(s) {
  const out = []; let cur = '', q = null;
  for (const ch of String(s)) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Create the warm ASR manager.
 *   cmd       : command string (default process.env.PRESENTER_ASR_CMD or the whisper wrapper)
 *   onReady   : called once when the worker signals readiness (or on first successful spawn)
 *   maxQueue  : queue depth cap; over it, the OLDEST pending job is dropped + logged (RT-8)
 *   timeoutMs : per-request answer timeout (a stuck worker never hangs a segment)
 * Returns { recognize(wavPath, seq) -> Promise<{text,conf}|null>, ready(), starts(), close() }.
 */
export function createAsr({ cmd, onReady, maxQueue = 8, timeoutMs = 20000, cwd } = {}) {
  const command = cmd || process.env.PRESENTER_ASR_CMD || 'python3 voice/asr-whisper.py';
  let child = null;
  let closing = false;
  let starts = 0;             // spawn count — T-ASR-WARM asserts this stays 1 across many segments
  let isReady = false;
  let stdoutBuf = '';
  const pending = [];         // FIFO of { resolve, seq, timer }

  function handleLine(line) {
    const s = line.trim(); if (!s) return;
    let obj = null; try { obj = JSON.parse(s); } catch (e) { log.warn('asr', 'bad-line', { line: s.slice(0, 120) }); return; }
    // A readiness marker is a STATUS line, never a job result — it must never consume a pending
    // job (even if one is already queued: the model-load / ready line can race ahead of results).
    if (obj && typeof obj.ready !== 'undefined') { if (obj.ready) markReady(); return; }
    const job = pending.shift();
    if (!job) { log.warn('asr', 'unmatched-result', { line: s.slice(0, 120) }); return; }
    clearTimeout(job.timer);
    job.resolve({ text: String(obj.text || ''), conf: typeof obj.conf === 'number' ? obj.conf : null });
  }

  function markReady() {
    if (isReady) return;
    isReady = true;
    log.info('asr', 'ready', { starts });
    try { onReady && onReady(); } catch (e) {}
  }

  function spawnWorker() {
    if (closing) return;
    const argv = splitCmd(command);
    starts++;
    log.info('asr', 'spawn', { cmd: command, starts });
    child = spawn(argv[0], argv.slice(1), { cwd: cwd || process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let i;
      while ((i = stdoutBuf.indexOf('\n')) >= 0) { const line = stdoutBuf.slice(0, i); stdoutBuf = stdoutBuf.slice(i + 1); handleLine(line); }
    });
    child.stderr.on('data', (d) => log.debug('asr', 'stderr', { msg: String(d).slice(0, 200) }));
    child.on('error', (e) => log.warn('asr', 'spawn-error', { msg: String(e && e.message || e) }));
    child.on('exit', (code) => {
      log.warn('asr', 'exit', { code, closing });
      child = null; isReady = false; stdoutBuf = '';
      // Fail any in-flight jobs so no segment hangs.
      while (pending.length) { const j = pending.shift(); clearTimeout(j.timer); j.resolve(null); }
      if (!closing) setTimeout(spawnWorker, 300);   // watchdog restart (RT-17)
    });
    // Best-effort readiness: some workers don't emit a {ready:true} line. Mark ready shortly
    // after a clean spawn so the "recognizer ready" signal fires even without the marker (RT-25).
    setTimeout(() => { if (child && !isReady) markReady(); }, 150);
  }

  spawnWorker();

  return {
    ready: () => isReady,
    starts: () => starts,
    recognize(wavPath, seq) {
      return new Promise((resolve) => {
        if (!child) { log.warn('asr', 'no-worker', {}); return resolve(null); }
        // Backpressure (RT-8): drop the OLDEST queued job if the queue is saturated.
        while (pending.length >= maxQueue) { const old = pending.shift(); clearTimeout(old.timer); log.warn('asr', 'queue-drop', { depth: pending.length }); old.resolve(null); }
        const timer = setTimeout(() => {
          const idx = pending.findIndex((p) => p.timer === timer);
          if (idx >= 0) pending.splice(idx, 1);
          log.warn('asr', 'timeout', { wavPath });
          resolve(null);
        }, timeoutMs);
        pending.push({ resolve, seq, timer });
        try { child.stdin.write(wavPath + '\n'); } catch (e) { log.warn('asr', 'write-fail', { msg: String(e && e.message || e) }); }
      });
    },
    close() {
      closing = true;
      while (pending.length) { const j = pending.shift(); clearTimeout(j.timer); j.resolve(null); }
      try { child && child.kill(); } catch (e) {}
      child = null;
    },
  };
}
