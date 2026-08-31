/*
 * app/board-document.mjs — THE BOARD IS A DOCUMENT **AND** IT IS LIVE KEYS.
 * This file is the ONE place the two representations meet.
 *
 * ⭐⭐ WHY TWO REPRESENTATIONS AT ALL, when one would obviously be simpler.
 *
 *   the DOCUMENT — one JSON object   → authoring · capture · restore · hand-off · REST
 *   PER-KEY live state (`<board>/<id>`) → drags, and it is the only shape that does not lose them
 *
 * Both, because each is wrong for the other's job, and both failures were MEASURED on this server
 * rather than reasoned about (plan 0720 B3): 8 clients writing 8 keys in one tick ⇒ 8 of 8 retained;
 * the same 8 clients appending to ONE collection-level key ⇒ **1 of 8**. Seven writes lost per
 * round, SILENTLY — every op accepted, acknowledged, and gone. So the live board cannot be one
 * object. And a board that is only N loose keys cannot be captured, restored, handed over or
 * reasoned about as a thing, which is the other half of the problem.
 *
 * ⇒ `serialise` reads the live keys and emits one object. `deserialise` turns one object back into
 *   per-key writes. Neither touches a socket, a browser or a clock, so the riskiest conversion in
 *   the batch is a UNIT test instead of a live one.
 *
 * ── ⛔ THREE RULES, EACH ALREADY PAID FOR ────────────────────────────────────────────────────────
 *
 * 1. ⛔⛔ `serialise` READS LIVE STATE. It is handed a STORE, never a roster, and that is a
 *    structural choice, not a convention: the failure it prevents is that a capture built from the
 *    AUTHORED positions replays the opening layout on restore, so every add, removal or restart
 *    silently teleports the whole board back to where the fight started, mid-fight, for everyone,
 *    with no error. A function that can only see the store cannot make that mistake.
 *    ⚠ And a test on a FRESH board cannot catch it either — authored and current positions are
 *    identical until somebody drags something. The drag is the whole test.
 *
 * 2. ⛔ KEYS BEGINNING `_` AND THE `lock` FIELD ARE THE HOST'S, NOT THE BOARD'S. A participant
 *    holds `lock`/`unlock` on `shared/**`; a record lock writes `<id>/lock` and a leaf lock writes
 *    `<collection>/_locks/<leaf>` (app/state.mjs). A generic sweep scoops both up and hands them
 *    back as tokens — so a lock would render as a piece sitting on the board. ⭐ This is the exact
 *    reason a DEFINED serialiser earns its keep over a generic subtree dump: it knows what a board
 *    IS, and a dump can only know what a subtree looks like.
 *
 * 3. ⛔ NEVER `clear`. `clear` broadcasts `{path:{}}` as its own diff, so every connected client
 *    renders a blank board between the wipe and the re-writes, and a drop that lands in that window
 *    resurrects a token that was supposed to be gone. Removal is per-key `remove`, one op each.
 *
 * ⚠ WHAT THE ROUND-TRIP TEST IS, EXACTLY: a SCHEMA-DRIFT test. It catches a field added on one side
 *   and forgotten on the other. It does NOT catch the teleport trap (rule 1 makes that structurally
 *   impossible instead), and it does not reach the browser at all. Do not lean on it for more.
 */

/** The document format this module reads and writes. Bumped only for a breaking shape change. */
export const BOARD_DOC_VERSION = 1;

/** Where the board lives when nothing says otherwise — the same default `tokens` renders. */
export const DEFAULT_BOARD_PATH = 'shared/tactical/tokens';

/*
 * ⭐ THE ESCAPE HATCH, AND IT IS THE ONLY ONE. During a session the deploy poller is stopped
 * (a push restarts the service and destroys the live store), so nothing in the code can be changed
 * while people are playing. A board path held in the STORE can be — one write re-points every
 * viewer at a fresh collection, which is how a board polluted by stale keys gets abandoned mid-play
 * without a deploy and without touching the keys that are wrong.
 */
export const BOARD_PATH_KEY = 'shared/tactical/boardpath';

/**
 * Fields that belong to the HOST's bookkeeping and never to a token.
 * `lock` — a record lock, written by the store's `lock` verb as a child of the record.
 * `force` — the lock-break flag a restore carries INTO `apply`; it is an instruction, not data,
 *           and letting it round-trip would make "somebody once forced this write" a board field.
 */
const NOT_BOARD_FIELDS = { lock: 1, force: 1 };

/** True for a key the board must not carry: host bookkeeping (`_locks`, `_anything`). */
function isHostKey(k) { return typeof k === 'string' && k.charAt(0) === '_'; }

/** A record with the host's fields stripped. The ONE filter, used on the way out AND the way in. */
function boardFields(rec) {
  const out = {};
  for (const k in rec) {
    if (!Object.prototype.hasOwnProperty.call(rec, k)) continue;
    if (isHostKey(k) || NOT_BOARD_FIELDS[k]) continue;
    out[k] = rec[k];
  }
  return out;
}

/**
 * The board path this deployment is currently using: the store key if set, else the default.
 *
 * @param {{get:(p:string)=>any}} store  anything that can read a path — the live store.
 * @param {string} dflt                  what to use when the key is unset or not a usable path.
 */
export function boardPath(store, dflt = DEFAULT_BOARD_PATH) {
  const raw = store && typeof store.get === 'function' ? store.get(BOARD_PATH_KEY) : undefined;
  return normalisePath(raw) || normalisePath(dflt) || DEFAULT_BOARD_PATH;
}

/** Trim a path to the store's own shape, or null if it is not one. */
export function normalisePath(p) {
  if (typeof p !== 'string') return null;
  const s = p.replace(/^\/+/, '').replace(/\/+$/, '').trim();
  if (!s) return null;
  /* ⛔ The store rejects these anyway (app/state.mjs sanitizePath), but a caller that gets a path
     back from here should never be handed one that will be silently refused later. */
  for (const seg of s.split('/')) {
    if (!seg || seg === '.' || seg === '..' || seg === '__proto__' || seg === 'prototype' || seg === 'constructor') return null;
  }
  return s;
}

/**
 * ⭐ CAPTURE — read the LIVE collection and emit one document.
 *
 * @param {{get:(p:string)=>any}} store  the live store. ⛔ Not a roster: see rule 1.
 * @param {{path?:string}} opts          which collection; defaults to the store's own board path.
 * @returns {{v:number, path:string, tokens:object[]}}
 */
export function serialise(store, opts = {}) {
  if (!store || typeof store.get !== 'function') throw new TypeError('serialise expects a store with get(path)');
  const path = normalisePath(opts.path) || boardPath(store);
  const coll = store.get(path);
  const tokens = [];
  if (coll && typeof coll === 'object' && !Array.isArray(coll)) {
    /* ⛔ SORTED. A document is compared, diffed and eyeballed; key-insertion order is an accident
       of who dragged what first, and it would make two identical boards read as different. */
    for (const id of Object.keys(coll).sort()) {
      if (isHostKey(id)) continue;                       // `_locks` is not a piece — rule 2
      const rec = coll[id];
      if (rec == null || typeof rec !== 'object' || Array.isArray(rec)) continue;
      const t = boardFields(rec);
      t.id = id;                                         // the KEY is the id, always — a record's own is advisory
      tokens.push(t);
    }
  }
  return { v: BOARD_DOC_VERSION, path, tokens };
}

/**
 * ⭐ RESTORE / AUTHOR — turn one document back into per-key store ops.
 *
 * ⛔ THE LIST IS AUTHORITATIVE: with `current` supplied, every id in the collection that the
 * document omits gets its own `remove` op. Omission DELETES — that is the whole reason the board
 * is a document, and the reason re-pushing a shorter roster used to change nothing.
 *
 * ⛔ NEVER `clear` (rule 3), even when the document is empty and clearing would be one op.
 *
 * @param {object} document          `{path?, tokens[]}` — `path` may be overridden by opts.
 * @param {object} opts
 * @param {string} [opts.path]       write here instead of the document's own path.
 * @param {object|string[]} [opts.current]  the live collection (or its ids) — enables removals.
 * @param {boolean} [opts.force]     break a stale lock. An INSTRUCTION: stripped back out by
 *                                   `serialise`, so it can never become a board field.
 * @returns {{path:string, verb:string, value:any}[]}  ops, in apply order: writes, then removals.
 */
export function deserialise(document, opts = {}) {
  const doc = document && typeof document === 'object' ? document : {};
  const path = normalisePath(opts.path) || normalisePath(doc.path) || DEFAULT_BOARD_PATH;
  const list = Array.isArray(doc.tokens) ? doc.tokens : [];
  const ops = [];
  const kept = new Set();

  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = raw.id == null ? null : String(raw.id);
    /* ⛔ AN ID-LESS ENTRY IS DROPPED, NOT GUESSED AT. There is no key to write it to, and inventing
       one would put a piece on the board that no later document could ever remove. */
    if (!id || isHostKey(id) || !normalisePath(id) || id.includes('/')) continue;
    if (kept.has(id)) continue;                          // last one wins would be a silent surprise
    kept.add(id);
    const value = boardFields(raw);
    value.id = id;
    if (opts.force === true) value.force = true;
    ops.push(setTokenOp(path, id, value));
  }

  for (const id of currentIds(opts.current)) {
    if (kept.has(id)) continue;
    ops.push(removeTokenOp(path, id));
  }
  return ops;
}

/** The ids currently in a collection — accepts the collection object or a plain id list. */
function currentIds(current) {
  if (!current) return [];
  const ids = Array.isArray(current) ? current.map(String) : Object.keys(current);
  return ids.filter((id) => !isHostKey(id));
}

/**
 * ⭐ THE DELTA WRITE — adding or moving ONE piece is ONE `set` on that piece's own key.
 *
 * ⛔ Not a whole-board rewrite. A rewrite reverts any drag that happened between the read and the
 * write, and on a live board somebody is always mid-drag; a per-key `set` cannot touch a piece it
 * does not name. The whole-board form exists for restore, when nobody is connected.
 */
export function setTokenOp(path, id, token) {
  const p = normalisePath(path) || DEFAULT_BOARD_PATH;
  const key = String(id);
  const value = boardFields(token || {});
  value.id = key;
  if (token && token.force === true) value.force = true;
  return { path: p + '/' + key, verb: 'set', value };
}

/**
 * ⭐ THE DELTA REMOVE — ONE `remove` naming the COLLECTION, with the id as the VALUE.
 *
 * ⛔⛔ AND THAT SHAPE IS NOT A STYLE CHOICE — THE OBVIOUS ONE IS A SILENT NO-OP.
 * `apply({ path: collection + '/' + id, verb:'remove', value:null })` reads exactly like a delete
 * and does NOTHING: the reducer computes `path + '/' + idOf(value)`, a null value yields `id == null`,
 * and it returns early having deleted nothing (app/state.mjs `case 'remove'`). No error, no
 * refusal, a truthy-looking result — the token is still on every board and the caller is satisfied.
 * The id goes in the VALUE and the path names the COLLECTION.
 */
export function removeTokenOp(path, id) {
  const p = normalisePath(path) || DEFAULT_BOARD_PATH;
  return { path: p, verb: 'remove', value: String(id) };
}

/** The op that re-points every viewer's board. One write; see BOARD_PATH_KEY. */
export function setBoardPathOp(path) {
  const p = normalisePath(path);
  if (!p) throw new TypeError('setBoardPathOp needs a usable store path');
  return { path: BOARD_PATH_KEY, verb: 'set', value: p };
}
