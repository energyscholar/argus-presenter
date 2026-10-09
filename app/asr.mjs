/*
 * asr.mjs — the pluggable + WARM speech-recognition seam (Plan 0470, RT-17/25; Plan 0904 V1.1/V1.8).
 *
 * The default ASR is a PERSISTENT worker process: the model loads ONCE at startup and the
 * worker then serves many segments over a stable protocol — it is NEVER cold-spawned
 * per segment (that would reload the model each utterance = unusable). AP keeps it warm and
 * watchdog-restarts it on crash. Engine-agnostic: PRESENTER_ASR_CMD names the worker
 * command (default: the faster-whisper wrapper voice/asr-whisper.py). Cold-spawn-per-segment
 * is forbidden and is what T-ASR-WARM proves against.
 *
 * ── Protocol (Plan 0904 V1.8: BYTES, NOT A PATH) ────────────────────────────────────────────
 *   in :  "#<id> <n>\n" followed by exactly <n> bytes of WAV (16 kHz mono PCM16)
 *   out:  {"id":<id>,"text":"...","conf":0.0..1.0}\n          one result line per request
 *   out:  {"ready":true,"recognizer":{...}}\n                  optional startup marker (RT-25)
 * No file is written anywhere: the worker may therefore run on another host behind any command
 * that carries stdin/stdout (`ssh <host> python3 …`). Results are matched by `id`, so a late
 * answer to a timed-out request can never be handed to the next request (the old FIFO could).
 *
 * ── Every request resolves with a VALUE, never null (Plan 0904 V1.1) ─────────────────────────
 *   { ok:true,  text, conf }
 *   { ok:false, reason }   reason ∈ 'no-worker' | 'queue' | 'timeout' | 'worker-exit' | 'wav'
 * Queue policy under saturation is DROP-NEWEST: the request that would overflow the queue is
 * answered { ok:false, reason:'queue' } at once, and every request already waiting keeps its place.
 * (It used to drop the OLDEST silently — the utterance that had waited longest.)
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
 *   maxQueue  : queue depth cap; a request past it is answered {ok:false, reason:'queue'}
 *   timeoutMs : per-request answer timeout (a stuck worker never hangs a segment)
 * Returns { recognize(wav:Buffer, seq) -> Promise<{ok,text?,conf?,reason?}>, ready(), starts(),
 *           recognizer(), pid(), depth(), command, close() }.
 */
export function createAsr({ cmd, onReady, maxQueue = 8, timeoutMs = 20000, cwd } = {}) {
  const command = cmd || process.env.PRESENTER_ASR_CMD || 'python3 voice/asr-whisper.py';
  let child = null;
  let closing = false;
  let starts = 0;             // spawn count — T-ASR-WARM asserts this stays 1 across many segments
  let isReady = false;
  let stdoutBuf = '';
  let nextId = 0;
  let recognizer = null;      // what the worker says it is (ready line); null until it says
  const pending = new Map();  // id -> { resolve, seq, timer }

  function settle(id, value) {
    const job = pending.get(id); if (!job) return false;
    pending.delete(id); clearTimeout(job.timer); job.resolve(value); return true;
  }

  function handleLine(line) {
    const s = line.trim(); if (!s) return;
    let obj = null; try { obj = JSON.parse(s); } catch (e) { log.warn('asr', 'bad-line', { line: s.slice(0, 120) }); return; }
    // A readiness marker is a STATUS line, never a job result.
    if (obj && typeof obj.ready !== 'undefined') {
      if (obj.recognizer && typeof obj.recognizer === 'object') recognizer = obj.recognizer;
      if (obj.ready) markReady();
      return;
    }
    // Match by id. A worker that answers without one is served in arrival order (oldest first).
    let id = (obj && (typeof obj.id === 'number' || typeof obj.id === 'string')) ? Number(obj.id) : null;
    if (id === null || !pending.has(id)) {
      if (id !== null) { log.warn('asr', 'late-result', { id }); return; }   // its request already timed out: drop, never mis-deliver
      const first = pending.keys().next(); if (first.done) { log.warn('asr', 'unmatched-result', { line: s.slice(0, 120) }); return; }
      id = first.value;
    }
    settle(id, { ok: true, text: String(obj.text || ''), conf: typeof obj.conf === 'number' ? obj.conf : null });
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
    const me = spawn(argv[0], argv.slice(1), { cwd: cwd || process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    child = me;
    me.stdout.setEncoding('utf8');
    me.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let i;
      while ((i = stdoutBuf.indexOf('\n')) >= 0) { const line = stdoutBuf.slice(0, i); stdoutBuf = stdoutBuf.slice(i + 1); handleLine(line); }
    });
    me.stdin.on('error', (e) => log.warn('asr', 'stdin-error', { msg: String(e && e.message || e) }));
    me.stderr.on('data', (d) => log.debug('asr', 'stderr', { msg: String(d).slice(0, 200) }));
    me.on('error', (e) => log.warn('asr', 'spawn-error', { msg: String(e && e.message || e) }));
    me.on('exit', (code) => {
      log.warn('asr', 'exit', { code, closing });
      if (child === me) { child = null; isReady = false; stdoutBuf = ''; }
      // Fail every in-flight job BY NAME so no segment hangs and none is mistaken for silence.
      for (const id of [...pending.keys()]) settle(id, { ok: false, reason: 'worker-exit' });
      if (!closing) setTimeout(spawnWorker, 300);   // watchdog restart (RT-17)
    });
    // Best-effort readiness: some workers don't emit a {ready:true} line (RT-25).
    setTimeout(() => { if (child === me && !isReady) markReady(); }, 150);
  }

  spawnWorker();

  return {
    command,
    ready: () => isReady,
    starts: () => starts,
    recognizer: () => recognizer,
    pid: () => (child && child.pid) || null,
    depth: () => pending.size,
    recognize(wav, seq) {
      return new Promise((resolve) => {
        if (!Buffer.isBuffer(wav) || wav.length < 44) return resolve({ ok: false, reason: 'wav' });
        if (!child) { log.warn('asr', 'no-worker', {}); return resolve({ ok: false, reason: 'no-worker' }); }
        // Backpressure (RT-8, Plan 0904): DROP-NEWEST — the queue is full, so THIS request is refused
        // by name and every request already waiting keeps its place.
        if (pending.size >= maxQueue) { log.warn('asr', 'queue-drop-newest', { depth: pending.size, seq }); return resolve({ ok: false, reason: 'queue' }); }
        const id = ++nextId;
        const timer = setTimeout(() => { log.warn('asr', 'timeout', { id, seq }); settle(id, { ok: false, reason: 'timeout' }); }, timeoutMs);
        pending.set(id, { resolve, seq, timer });
        try { child.stdin.write(`#${id} ${wav.length}\n`); child.stdin.write(wav); }
        catch (e) { log.warn('asr', 'write-fail', { msg: String(e && e.message || e) }); settle(id, { ok: false, reason: 'worker-exit' }); }
      });
    },
    close() {
      closing = true;
      for (const id of [...pending.keys()]) settle(id, { ok: false, reason: 'no-worker' });
      try { child && child.kill(); } catch (e) {}
      child = null;
    },
  };
}
