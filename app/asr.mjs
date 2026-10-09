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
 *   out:  {"ready":true,"recognizer":{...}}\n                  optional startup marker (RT-25): identity only;
 *         readiness is the ANSWER to a warm-up request sent at spawn (see createAsr)
 * No file is written anywhere: the worker may therefore run on another host behind any command
 * that carries stdin/stdout (`ssh <host> python3 …`). Results are matched by `id`, so a late
 * answer to a timed-out request can never be handed to the next request (the old FIFO could).
 *
 * ── Every request resolves with a VALUE, never null (Plan 0904 V1.1) ─────────────────────────
 *   { ok:true,  text, conf }
 *   { ok:false, reason }   reason ∈ 'no-worker' | 'queue' | 'timeout' | 'worker-exit' | 'wav' | 'not-ready'
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

// The warm-up request: 0.5 s of 16 kHz mono PCM16 silence in a WAV container. The worker must
// ANSWER it (any text, empty included) before the manager calls itself ready.
function warmupWav() {
  const pcm = Buffer.alloc(16000);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * Create the warm ASR manager.
 *   cmd       : command string (default process.env.PRESENTER_ASR_CMD or the whisper wrapper)
 *   onReady   : called when the worker has ANSWERED the warm-up request (state -> 'ready')
 *   onFault   : called (code, detail) once when warm-up fails (state -> 'failed')
 *   maxQueue  : queue depth cap; a request past it is answered {ok:false, reason:'queue'}
 *   timeoutMs : per-request answer timeout, counted from when the request is WRITTEN to a ready worker
 *   warmupMs  : bound on the warm-up answer (env PRESENTER_ASR_WARMUP_MS, default 120 s)
 *
 * ── State (the cold-start fix) ────────────────────────────────────────────────────────────────
 *   loading : spawned; a short silence WAV has been sent through the normal protocol and not yet
 *             answered. Requests are HELD here (bounded by maxQueue, drop-newest), not written and
 *             not timed, so a model that is still loading cannot eat the first utterance.
 *   ready   : the worker answered the warm-up request. Held requests are written, in order.
 *   failed  : no warm-up answer within warmupMs, the worker exited before answering, or it said
 *             {"ready":false}. Held requests are answered {ok:false, reason:'not-ready'}; new ones
 *             are refused the same way. A later warm-up answer (a respawned or slow worker) recovers.
 * A {"ready":true} line from the worker is recorded (recognizer identity) but is NOT readiness.
 *
 * Returns { recognize(wav:Buffer, seq) -> Promise<{ok,text?,conf?,reason?}>, ready(), state(),
 *           starts(), recognizer(), pid(), depth(), command, close() }.
 */
export function createAsr({ cmd, onReady, onFault, maxQueue = 8,
  timeoutMs = parseInt(process.env.PRESENTER_ASR_TIMEOUT_MS || '', 10) || 20000,
  warmupMs = parseInt(process.env.PRESENTER_ASR_WARMUP_MS || '', 10) || 120000, cwd } = {}) {
  const command = cmd || process.env.PRESENTER_ASR_CMD || 'python3 voice/asr-whisper.py';
  let child = null;
  let closing = false;
  let starts = 0;             // spawn count — T-ASR-WARM asserts this stays 1 across many segments
  let state = 'loading';      // 'loading' | 'ready' | 'failed'
  let stdoutBuf = '';
  let nextId = 0;
  let warmId = null;          // id of the outstanding warm-up request of the current worker
  let warmTimer = null;       // bounds the wait for the warm-up answer
  let childBroken = false;    // the current worker said {"ready":false}: its answers are not readiness
  let recognizer = null;      // what the worker says it is (ready line); null until it says
  const pending = new Map();  // id -> { resolve, seq, timer, wav, sent }

  function settle(id, value) {
    const job = pending.get(id); if (!job) return false;
    pending.delete(id); clearTimeout(job.timer); job.resolve(value); return true;
  }

  function write(id) {
    const job = pending.get(id); if (!job) return;
    job.sent = true;
    const wav = job.wav; job.wav = null;
    job.timer = setTimeout(() => { log.warn('asr', 'timeout', { id, seq: job.seq }); settle(id, { ok: false, reason: 'timeout' }); }, timeoutMs);
    try { child.stdin.write(`#${id} ${wav.length}\n`); child.stdin.write(wav); }
    catch (e) { log.warn('asr', 'write-fail', { msg: String(e && e.message || e) }); settle(id, { ok: false, reason: 'worker-exit' }); }
  }

  function handleLine(line) {
    const s = line.trim(); if (!s) return;
    let obj = null; try { obj = JSON.parse(s); } catch (e) { log.warn('asr', 'bad-line', { line: s.slice(0, 120) }); return; }
    // A readiness marker is a STATUS line, never a job result — and never readiness by itself.
    if (obj && typeof obj.ready !== 'undefined') {
      if (obj.recognizer && typeof obj.recognizer === 'object') recognizer = obj.recognizer;
      if (obj.ready === false) { childBroken = true; fail('the worker reported it cannot load' + (obj.error ? ': ' + String(obj.error).slice(0, 200) : '')); }
      return;
    }
    let id = (obj && (typeof obj.id === 'number' || typeof obj.id === 'string')) ? Number(obj.id) : null;
    // The warm-up answer. A worker that answers without an id answers the warm-up first.
    if (warmId !== null && (id === warmId || id === null)) { warmId = null; if (!childBroken) markReady(); return; }
    // Match by id. A worker that answers without one is served in arrival order (oldest written first).
    if (id === null || !pending.has(id)) {
      if (id !== null) { log.warn('asr', 'late-result', { id }); return; }   // its request already timed out: drop, never mis-deliver
      const first = [...pending.entries()].find(([, j]) => j.sent); if (!first) { log.warn('asr', 'unmatched-result', { line: s.slice(0, 120) }); return; }
      id = first[0];
    }
    settle(id, { ok: true, text: String(obj.text || ''), conf: typeof obj.conf === 'number' ? obj.conf : null });
  }

  function markReady() {
    if (state === 'ready' || !child) return;
    clearTimeout(warmTimer); warmTimer = null;
    state = 'ready';
    log.info('asr', 'ready', { starts, held: pending.size });
    for (const [id, job] of [...pending.entries()]) if (!job.sent) write(id);   // flush the held queue, in order
    try { onReady && onReady(); } catch (e) {}
  }

  function fail(detail) {
    if (closing) return;
    clearTimeout(warmTimer); warmTimer = null;
    for (const [id, job] of [...pending.entries()]) if (!job.sent) settle(id, { ok: false, reason: 'not-ready' });
    if (state === 'failed') return;
    state = 'failed';
    log.warn('asr', 'warmup-failed', { detail });
    try { onFault && onFault('asr-warmup-failed', detail); } catch (e) {}
  }

  function spawnWorker() {
    if (closing) return;
    const argv = splitCmd(command);
    starts++;
    log.info('asr', 'spawn', { cmd: command, starts });
    const me = spawn(argv[0], argv.slice(1), { cwd: cwd || process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    child = me; childBroken = false;
    me.stdout.setEncoding('utf8');
    me.stdout.on('data', (chunk) => {
      if (child !== me) return;
      stdoutBuf += chunk;
      let i;
      while ((i = stdoutBuf.indexOf('\n')) >= 0) { const line = stdoutBuf.slice(0, i); stdoutBuf = stdoutBuf.slice(i + 1); handleLine(line); }
    });
    me.stdin.on('error', (e) => log.warn('asr', 'stdin-error', { msg: String(e && e.message || e) }));
    me.stderr.on('data', (d) => log.debug('asr', 'stderr', { msg: String(d).slice(0, 200) }));
    me.on('error', (e) => log.warn('asr', 'spawn-error', { msg: String(e && e.message || e) }));
    me.on('exit', (code) => {
      log.warn('asr', 'exit', { code, closing });
      if (child === me) { child = null; stdoutBuf = ''; warmId = null; }
      // Fail every job BY NAME so no segment hangs and none is mistaken for silence.
      for (const id of [...pending.keys()]) settle(id, { ok: false, reason: 'worker-exit' });
      if (closing) return;
      if (state === 'ready') state = 'loading';   // the respawn must answer its own warm-up
      else if (state === 'loading') fail('the worker exited (code ' + code + ') before answering the warm-up request');
      setTimeout(spawnWorker, 300);   // watchdog restart (RT-17)
    });
    // Readiness is an ANSWER: send the warm-up through the same bytes-on-stdin protocol.
    if (state === 'loading' && !warmTimer) {
      warmTimer = setTimeout(() => { warmTimer = null; if (state === 'loading') fail('no warm-up answer within ' + warmupMs + ' ms'); }, warmupMs);
    }
    const wav = warmupWav();
    warmId = ++nextId;
    try { me.stdin.write(`#${warmId} ${wav.length}\n`); me.stdin.write(wav); }
    catch (e) { log.warn('asr', 'write-fail', { msg: String(e && e.message || e) }); }
  }

  spawnWorker();

  return {
    command,
    ready: () => state === 'ready',
    state: () => state,
    starts: () => starts,
    recognizer: () => recognizer,
    pid: () => (child && child.pid) || null,
    depth: () => pending.size,
    recognize(wav, seq) {
      return new Promise((resolve) => {
        if (!Buffer.isBuffer(wav) || wav.length < 44) return resolve({ ok: false, reason: 'wav' });
        if (state === 'failed') { log.warn('asr', 'not-ready', { seq }); return resolve({ ok: false, reason: 'not-ready' }); }
        if (!child) { log.warn('asr', 'no-worker', {}); return resolve({ ok: false, reason: 'no-worker' }); }
        // Backpressure (RT-8, Plan 0904): DROP-NEWEST — the queue is full, so THIS request is refused
        // by name and every request already waiting (held or written) keeps its place.
        if (pending.size >= maxQueue) { log.warn('asr', 'queue-drop-newest', { depth: pending.size, seq }); return resolve({ ok: false, reason: 'queue' }); }
        const id = ++nextId;
        pending.set(id, { resolve, seq, timer: null, wav, sent: false });
        if (state === 'ready') write(id);
        else log.info('asr', 'held', { id, seq, depth: pending.size });   // loading: held, not timed
      });
    },
    close() {
      closing = true;
      clearTimeout(warmTimer); warmTimer = null;
      for (const id of [...pending.keys()]) settle(id, { ok: false, reason: 'no-worker' });
      try { child && child.kill(); } catch (e) {}
      child = null;
    },
  };
}
