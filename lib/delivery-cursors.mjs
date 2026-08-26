/*
 * Plan 0687 R1 — THE CURSOR BOOK: two records, two meanings, never one number.
 *
 * ⛔ G9 (0674 §5): signals with different meanings never share one number or one map.
 *
 * Before this module there was ONE `situationCursors: Map<key, number>` and it carried TWO
 * semantics at once:
 *
 *   (a) a READ position — `/api/situation` is a digest read; it JUMPS TO THE HEAD, because a
 *       digest is a snapshot of now and "what I have not seen" is not a queue for it; and
 *   (b) a DELIVERY position — the PVS watcher is fed entry by entry and must be able to replay
 *       the gap it did not see.
 *
 * Sharing one number meant one `/api/situation` read by an unrelated caller could zero the PVS
 * backlog for that key. The two are now separate maps, chosen by NAMESPACE.
 *
 * ⛔ G5 — and this is the whole point of the phase: a DELIVERY record is a PAIR.
 *
 *   `sent`  — a TRANSPORT fact. The bytes left this process. Nothing about them was understood.
 *   `acked` — an AGENT fact. Something read the turn and SAID SO.
 *
 * The delivery layer may advance `sent` freely. It may NEVER advance `acked` on the consumer's
 * behalf, for any reason. If it did, a transfer truncated mid-JSON would ack turns nobody read —
 * which is exactly the live defect this phase exists to fix (observed twice, 2026-08-25). Replay
 * is therefore always from `acked`, never from `sent`.
 *
 * ⭐ The two are ALSO different aggregates, deliberately:
 *   - the FLOOR asks "how far behind is what we have handed over?" ⇒ it reads `sent`.
 *   - REDELIVERY asks "what has nobody confirmed?" ⇒ it reads `acked`.
 * Both are namespace-aware; neither borrows the other's number.
 */

/** Delivery-cursor keys live under this namespace; everything else is a read cursor. */
export const DELIVERY_PREFIX = 'pvs:';

/** A key is a DELIVERY key (pair semantics) iff it sits in the delivery namespace. */
export function isDeliveryKey(key) {
  return typeof key === 'string' && key.startsWith(DELIVERY_PREFIX);
}

export class CursorBook {
  /**
   * @param {object} opts
   * @param {(book: CursorBook) => void} [opts.onDurableChange] called after a change that a
   *   durable store must not lose (an ack, a baseline, a drop). Never called for `sent`.
   */
  constructor({ onDurableChange = null } = {}) {
    /** @type {Map<string, number>} read positions — jump-to-head semantics. */
    this.readPositions = new Map();
    /** @type {Map<string, {sent:number, acked:number}>} delivery records — pair semantics. */
    this.deliveryRecords = new Map();
    this._onDurableChange = onDurableChange;
  }

  _durableChanged() { if (this._onDurableChange) this._onDurableChange(this); }

  // ---- READ cursors (namespace: anything not `pvs:`) --------------------------------------

  /** The last seq this read-consumer was SHOWN. 0 when it has never read. */
  readPosition(key) { return this.readPositions.get(key) || 0; }

  /** A digest read jumps to the head. This is a READ act and touches no delivery record. */
  setReadPosition(key, seq) { this.readPositions.set(key, seq); }

  // ---- DELIVERY cursors (namespace: `pvs:`) -----------------------------------------------

  hasDelivery(key) { return this.deliveryRecords.has(key); }

  /** The record, or a zeroed one. Never creates — reading must not have a side effect. */
  delivery(key) {
    const r = this.deliveryRecords.get(key);
    return r ? { sent: r.sent, acked: r.acked } : { sent: 0, acked: 0 };
  }

  /**
   * Create a delivery record at `seq` IF the consumer has none. An existing record is left
   * alone — a re-arm must never re-baseline at live and throw away the gap (0493 R1).
   * @returns {boolean} true when a record was created.
   */
  baselineDelivery(key, seq) {
    if (this.deliveryRecords.has(key)) return false;
    this.deliveryRecords.set(key, { sent: seq, acked: seq });
    this._durableChanged();
    return true;
  }

  /**
   * TRANSPORT fact: entries up to `seq` have left this process for `key`. Monotonic.
   * ⛔ This MUST NOT touch `acked`. Writing acked here is the forbidden implementation the
   * at-most-once test exists to catch.
   */
  markSent(key, seq) {
    const r = this.deliveryRecords.get(key);
    if (!r) { this.deliveryRecords.set(key, { sent: seq, acked: 0 }); this._durableChanged(); return; }
    if (seq > r.sent) r.sent = seq;
  }

  /**
   * AGENT fact: the consumer says it has READ everything through `seq`. This is the ONLY way
   * `acked` ever moves, and only a consumer-originated call may reach it. Monotonic — an ack
   * can never walk backwards, so a late duplicate ack is harmless.
   * @returns {{sent:number, acked:number}} the record after the ack.
   */
  ackDelivery(key, seq) {
    let r = this.deliveryRecords.get(key);
    if (!r) { r = { sent: 0, acked: 0 }; this.deliveryRecords.set(key, r); }
    if (seq > r.acked) r.acked = seq;
    if (r.acked > r.sent) r.sent = r.acked;   // an ack implies it was sent; the pair stays ordered
    this._durableChanged();
    return { sent: r.sent, acked: r.acked };
  }

  dropDelivery(key) {
    const had = this.deliveryRecords.delete(key);
    if (had) this._durableChanged();
    return had;
  }

  /** Every live delivery key. */
  deliveryKeys() { return [...this.deliveryRecords.keys()]; }

  /**
   * The lowest `acked` across all delivery consumers — everything at or below it has been
   * confirmed by everyone, so it is safe to forget. `null` when there is no delivery consumer
   * at all (⚠ that is NOT the same as 0: with nobody watching, nothing needs retaining).
   */
  minAcked() {
    if (!this.deliveryRecords.size) return null;
    let m = Infinity;
    for (const r of this.deliveryRecords.values()) if (r.acked < m) m = r.acked;
    return m;
  }

  // ---- AGGREGATES — namespace-aware, one meaning each (G9) --------------------------------

  /**
   * FLOOR signal: the largest "not yet handed over" distance across ALL consumers, of either
   * kind. Read consumers count from their read position; delivery consumers from `sent`.
   * ⛔ Deliberately NOT `acked`: an agent that never acks is a durability problem, not a
   * reason to throttle the room's speakers.
   */
  maxTransportBacklog(liveSeq) {
    let max = 0;
    for (const last of this.readPositions.values()) { const b = liveSeq - last; if (b > max) max = b; }
    for (const r of this.deliveryRecords.values()) { const b = liveSeq - r.sent; if (b > max) max = b; }
    return max;
  }

  /** REDELIVERY signal: the largest unconfirmed distance across delivery consumers only. */
  maxUnackedBacklog(liveSeq) {
    let max = 0;
    for (const r of this.deliveryRecords.values()) { const b = liveSeq - r.acked; if (b > max) max = b; }
    return max;
  }

  // ---- Durability shape (R3) --------------------------------------------------------------

  /** The whole book as plain data. Delivery records round-trip WHOLE (G2), never field-picked. */
  toJSON() {
    return {
      read: Object.fromEntries(this.readPositions),
      delivery: Object.fromEntries([...this.deliveryRecords].map(([k, r]) => [k, { ...r }])),
    };
  }

  /** Restore from `toJSON()` output. Unknown/garbage shapes are ignored, never guessed at. */
  static fromJSON(data, opts) {
    const book = new CursorBook(opts);
    if (!data || typeof data !== 'object') return book;
    for (const [k, v] of Object.entries(data.read || {})) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) book.readPositions.set(k, v);
    }
    for (const [k, v] of Object.entries(data.delivery || {})) {
      if (!v || typeof v !== 'object') continue;
      const sent = Number(v.sent), acked = Number(v.acked);
      if (!Number.isFinite(sent) || !Number.isFinite(acked) || sent < 0 || acked < 0) continue;
      book.deliveryRecords.set(k, { sent: Math.max(sent, acked), acked });
    }
    return book;
  }
}
