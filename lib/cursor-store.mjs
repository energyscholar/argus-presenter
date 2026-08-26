/*
 * Plan 0687 R3 + R4 — DURABLE DELIVERY STATE, INDEPENDENT OF RECORDING.
 *
 * ⛔ G10 (0674 §5): durability precedes eviction; cursors are recoverable.
 * ⛔ RT-6 / 0687 R3: replay must survive a restart in a room that records NOTHING. The demo room
 *    is `record:"none"` — there is no ledger to recover from, so the delivery layer keeps its OWN
 *    small file and NEVER asks whether recording is on. Recording is a policy about content the
 *    humans in the room consented to; a cursor is a policy about whether the agent lost a turn.
 *    Coupling them is how "replay works, but only if you were also recording" gets shipped.
 *
 * TWO FILES, both tiny, both per-room (one directory per room, given by the caller):
 *
 *   delivery-cursors.json   the cursor book + the seq high-water mark. Written whole, atomically
 *                           (temp + rename), mode 0600. It is small and rewritten in full, so a
 *                           torn write is impossible: either the old file or the new one is there.
 *
 *   delivery-spill.jsonl    ⛔ G6/R4. The in-memory ring holds 500. When an entry falls off the
 *                           end while some delivery consumer has NOT acked it, the WHOLE entry is
 *                           appended here first (G2 — never rebuilt from a field list), so a
 *                           replay-from-ack reads PAST the eviction boundary instead of silently
 *                           truncating at it. Entries every consumer has acked are dropped on
 *                           compaction; entries discarded with nowhere to spill are COUNTED and
 *                           LOGGED by the caller, never dropped in silence.
 *
 * ⭐ Why the seq high-water is persisted with the cursors: the inbox ring is in-memory, so `seq`
 * would restart at 1 after a restart and a persisted `acked: 7` would swallow the first seven new
 * turns. Resuming the counter above the high-water keeps every persisted position meaningful.
 * The SESSION id still changes — the ring really is empty — and consumers can see that.
 *
 * ⛔ Not configured ⇒ no file, and the caller says so out loud at startup (G1 fail-closed, G6 no
 * silent skip). It is not an error; it is a stated, visible default.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';

export const CURSOR_FILE = 'delivery-cursors.json';
export const SPILL_FILE = 'delivery-spill.jsonl';
const FORMAT = 1;

/**
 * @param {object} opts
 * @param {string|null} opts.dir  the room's state directory. null/'' ⇒ an INERT store.
 * @param {{warn:Function,info:Function}} [opts.log]
 */
export function createCursorStore({ dir = null, log = null } = {}) {
  const configured = !!(dir && String(dir).trim());
  const root = configured ? String(dir) : null;
  const cursorPath = configured ? join(root, CURSOR_FILE) : null;
  const spillPath = configured ? join(root, SPILL_FILE) : null;
  const warn = (ev, d) => { if (log && log.warn) log.warn('cursor', ev, d); };

  let writeFailures = 0;

  function ensureDir() { mkdirSync(root, { recursive: true, mode: 0o700 }); }

  return {
    configured,
    dir: root,
    cursorPath,
    spillPath,

    /**
     * Read the persisted state. Returns `{ present, book, inboxSeq }`.
     * A missing, unreadable or malformed file reads as ABSENT — never as a guess, and never
     * fatal. A cursor we cannot trust must not silently pretend to be a position.
     */
    load() {
      if (!configured || !existsSync(cursorPath)) return { present: false, book: null, inboxSeq: 0 };
      try {
        const raw = JSON.parse(readFileSync(cursorPath, 'utf8'));
        if (!raw || raw.v !== FORMAT) { warn('cursor-file-unknown-format', { v: raw && raw.v }); return { present: false, book: null, inboxSeq: 0 }; }
        const seq = Number(raw.inboxSeq);
        return { present: true, book: raw.cursors || null, inboxSeq: Number.isFinite(seq) && seq > 0 ? seq : 0 };
      } catch (err) {
        warn('cursor-file-unreadable', { msg: String((err && err.message) || err) });
        return { present: false, book: null, inboxSeq: 0 };
      }
    },

    /** Write the whole document atomically. Never throws — a failure is counted and logged. */
    save({ cursors, inboxSeq }) {
      if (!configured) return false;
      try {
        ensureDir();
        const tmp = cursorPath + '.tmp';
        writeFileSync(tmp, JSON.stringify({ v: FORMAT, inboxSeq, cursors, updatedAt: Date.now() }) + '\n', { mode: 0o600 });
        renameSync(tmp, cursorPath);
        return true;
      } catch (err) {
        writeFailures++;
        warn('cursor-save-fail', { msg: String((err && err.message) || err), writeFailures });
        return false;
      }
    },

    /**
     * Append ONE evicted-but-unacked entry, WHOLE (G2). Returns true when it is durable.
     * A false return is the caller's cue to COUNT the discard — it is never a silent drop.
     */
    spill(entry) {
      if (!configured) return false;
      try {
        ensureDir();
        appendFileSync(spillPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
        return true;
      } catch (err) {
        writeFailures++;
        warn('cursor-spill-fail', { msg: String((err && err.message) || err), writeFailures });
        return false;
      }
    },

    /**
     * Every spilled entry with `seq > afterSeq`, in seq order. A line that does not parse is
     * counted, not skipped in silence: the return carries `{ entries, unreadableLines }`.
     */
    readSpill(afterSeq = 0) {
      if (!configured || !existsSync(spillPath)) return { entries: [], unreadableLines: 0 };
      let text = '';
      try { text = readFileSync(spillPath, 'utf8'); }
      catch (err) { warn('cursor-spill-unreadable', { msg: String((err && err.message) || err) }); return { entries: [], unreadableLines: 0 }; }
      const entries = []; let unreadableLines = 0;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e && typeof e.seq === 'number' && e.seq > afterSeq) entries.push(e);
        } catch (err) { unreadableLines++; }
      }
      entries.sort((a, b) => a.seq - b.seq);
      if (unreadableLines) warn('cursor-spill-unreadable-lines', { unreadableLines });
      return { entries, unreadableLines };
    },

    /** Drop spilled entries at or below `throughSeq` — everyone has acked them. */
    compactSpill(throughSeq) {
      if (!configured || !existsSync(spillPath)) return 0;
      const { entries } = this.readSpill(throughSeq);
      try {
        if (!entries.length) { unlinkSync(spillPath); return 0; }
        const tmp = spillPath + '.tmp';
        writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
        renameSync(tmp, spillPath);
        return entries.length;
      } catch (err) {
        writeFailures++;
        warn('cursor-compact-fail', { msg: String((err && err.message) || err), writeFailures });
        return entries.length;
      }
    },

    stats() { return { configured, dir: root, writeFailures }; },
  };
}
