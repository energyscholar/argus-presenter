/*
 * voice-link.mjs — the RESUMABLE voice connection for a dedicated voice client (Plan 0904 §4.2/§4.3).
 *
 * One helper, imported by every page that is "a microphone and nothing else" — AP's own /voice page
 * and the in-VTT toggle on another origin (served with CORS to listed origins). The presenter page
 * keeps its own connection (unchanged); this is the protocol the new clients speak.
 *
 * The standard it follows is a gateway RESUME with the SEGMENT as the unit of delivery:
 *   - hello {cap, resume:{lastAckedSeq}, voice:{modes,codecs}}  →  welcome {resumed}
 *   - every segment the capture opens is kept, WHOLE (start meta, PCM chunks, end meta), until the
 *     server's `voice_result` for it arrives. The result IS the ack: a segment is evicted only on its
 *     result, never on send (the sent ≠ acked rule).
 *   - the kept set is bounded: ≤ MAX_SEGS segments and ≤ MAX_BYTES bytes; past that the OLDEST is
 *     evicted and reported as a `voice_gap {cause:'evicted'}` — counted, never silent.
 *   - on close: reconnect with backoff (250 ms → 4 s, jittered); after `welcome`, REPLAY every kept
 *     segment in order. The server deduplicates by (identity, stream, seq), so a replay of a segment
 *     it already recognised returns the cached result and never a second transcript.
 *   - the server's `ping` is answered with `pong` (the server's heartbeat marks a silent client stale).
 *
 * Usage:
 *   const link = createVoiceLink({ wsUrl, cap, onState, onResult, onFault, onMoved, onWelcome });
 *   const ctrl = await startCapture({ sink: link.sink(), workletUrl, badge:false, track? });
 *   link.sendGap({fromTs, toTs, cause:'reload'}); link.close();
 */

export const MAX_SEGS = 10;
export const MAX_BYTES = 3 * 1024 * 1024;

function randomId() {
  try { const a = new Uint8Array(8); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); }
  catch (e) { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
}

/**
 * @param {object} o
 * @param {string}   o.wsUrl        ws(s):// URL of the AP room
 * @param {string}   o.cap          the capability token
 * @param {Function} [o.onState]    (state) — 'connecting' | 'live' | 'reconnecting' | 'closed'
 * @param {Function} [o.onWelcome]  (welcome frame)
 * @param {Function} [o.onResult]   (voice_result frame)
 * @param {Function} [o.onFault]    (frame) — voice_denied / voice_rejected / voice_fault / cap_refused
 * @param {Function} [o.onMoved]    (voice_moved frame) — another device holds the mic now
 * @param {Function} [o.onFrame]    (any other frame)
 * @param {Function} [o.WebSocketImpl]  for tests
 */
export function createVoiceLink({ wsUrl, cap, onState, onWelcome, onResult, onFault, onMoved, onFrame, WebSocketImpl } = {}) {
  const WS = WebSocketImpl || globalThis.WebSocket;
  const kept = [];                       // [{ seq, start, chunks:[ArrayBuffer], bytes, end|null }]
  let keptBytes = 0;
  let ws = null, closed = false, attempt = 0, timer = null, everWelcomed = false;
  let lastAckedSeq = 0;
  const counts = { evicted: 0, replayed: 0, reconnects: 0, results: 0 };
  const state = (s) => { link.state = s; try { onState && onState(s); } catch (e) {} };
  const live = () => !!(ws && ws.readyState === 1 && link.state === 'live');
  const sendJ = (o) => { try { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; } } catch (e) {} return false; };
  const sendB = (b) => { try { if (ws && ws.readyState === 1) { ws.send(b); return true; } } catch (e) {} return false; };

  function evictOldest() {
    const gone = kept.shift(); if (!gone) return;
    keptBytes -= gone.bytes; counts.evicted++;
    sendJ({ t: 'voice_gap', fromTs: gone.start.startedAt || null, toTs: Date.now(), cause: 'evicted' });
  }
  function keep(seg) {
    kept.push(seg);
    while (kept.length > MAX_SEGS || keptBytes > MAX_BYTES) { if (kept.length <= 1) break; evictOldest(); }
  }
  function replay() {
    for (const seg of kept) {
      counts.replayed++;
      sendJ(Object.assign({ t: 'voice_seg_start' }, seg.start));
      for (const c of seg.chunks) sendB(c);
      if (seg.end) sendJ(Object.assign({ t: 'voice_seg_end' }, seg.end));
    }
  }
  function connect() {
    if (closed) return;
    state(everWelcomed ? 'reconnecting' : 'connecting');
    let sock;
    try { sock = new WS(wsUrl); } catch (e) { schedule(); return; }
    ws = sock;
    try { sock.binaryType = 'arraybuffer'; } catch (e) {}
    sock.onopen = () => {
      const hello = { t: 'hello', cap, voice: { modes: ['pcm'], codecs: ['pcm16'] } };
      if (everWelcomed) hello.resume = { lastAckedSeq };
      sock.send(JSON.stringify(hello));
    };
    sock.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'ping') { sendJ({ t: 'pong', ts: m.ts }); return; }
      if (m.t === 'welcome') {
        attempt = 0; const again = everWelcomed; everWelcomed = true;
        state('live');
        try { onWelcome && onWelcome(m); } catch (e) {}
        if (again) counts.reconnects++;
        replay();
        return;
      }
      if (m.t === 'voice_result') {
        counts.results++;
        const i = kept.findIndex((s) => s.seq === m.seq);
        if (i >= 0) { keptBytes -= kept[i].bytes; kept.splice(i, 1); }
        if (typeof m.seq === 'number' && m.seq > lastAckedSeq) lastAckedSeq = m.seq;
        try { onResult && onResult(m); } catch (e) {}
        return;
      }
      if (m.t === 'voice_moved') { try { onMoved && onMoved(m); } catch (e) {} return; }
      if (m.t === 'voice_denied' || m.t === 'voice_rejected' || m.t === 'voice_fault' || m.t === 'cap_refused') { try { onFault && onFault(m); } catch (e) {} return; }
      try { onFrame && onFrame(m); } catch (e) {}
    };
    sock.onclose = () => { if (ws === sock) ws = null; if (!closed) schedule(); };
    sock.onerror = () => {};
  }
  function schedule() {
    state('reconnecting');
    const base = Math.min(4000, 250 * Math.pow(2, attempt++));
    const delay = Math.round(base / 2 + Math.random() * base / 2);   // jitter
    clearTimeout(timer); timer = setTimeout(connect, delay);
  }

  const link = {
    state: 'connecting', stream: null, counts,
    get kept() { return kept.length; },
    get keptBytes() { return keptBytes; },
    get lastAckedSeq() { return lastAckedSeq; },
    /** A sink for startCapture(): every segment is KEPT until its result, and sent when the link is live. */
    sink() {
      // A FRESH stream id per capture session: the worklet restarts its seq at 1 on every start, and the
      // server's dedup key is (identity, stream, seq) — reusing a stream would replay old results.
      const sStream = randomId();
      link.stream = sStream;
      let cur = null;
      return {
        onOpen(i) { sendJ(Object.assign({ t: 'voice_settings' }, (i && i.settings) || {})); link.settings = i && i.settings; },
        onSegStart(m) {
          const now = Date.now();
          cur = { seq: m.seq, start: { seq: m.seq, stream: sStream, codec: 'pcm16', startedAt: now - (m.durMs || 0) }, chunks: [], bytes: 0, end: null };
          keep(cur);
          if (live()) sendJ(Object.assign({ t: 'voice_seg_start' }, cur.start));
        },
        onPcm(int16) {
          if (!cur) return;
          const buf = int16.buffer.slice(int16.byteOffset, int16.byteOffset + int16.byteLength);
          cur.chunks.push(buf); cur.bytes += buf.byteLength; keptBytes += buf.byteLength;
          while (keptBytes > MAX_BYTES && kept.length > 1) evictOldest();
          if (live()) sendB(buf);
        },
        onSegEnd(m) {
          if (!cur || cur.seq !== m.seq) return;
          cur.end = { seq: m.seq, endedAt: Date.now() };
          if (live()) sendJ(Object.assign({ t: 'voice_seg_end' }, cur.end));
          cur = null;
        },
        onLevel(l) { if (live()) sendJ({ t: 'voice_level', raw: l.raw, nrm: l.nrm, zeroRunMs: l.zeroRunMs || 0, ts: Date.now() }); link.lastLevel = l; },
        onTrackState(t) { if (t && t.state === 'ended') link.sendFault('track-ended', 'the microphone track ended'); },
        onDuckedSeg() {},
      };
    },
    sendGap({ fromTs, toTs, cause }) { return sendJ({ t: 'voice_gap', fromTs, toTs: toTs || Date.now(), cause }); },
    sendFault(code, detail) { return sendJ({ t: 'voice_client_fault', code, detail: detail == null ? null : String(detail) }); },
    close() { closed = true; clearTimeout(timer); try { ws && ws.close(); } catch (e) {} state('closed'); },
    _socket: () => ws,
  };
  connect();
  return link;
}
