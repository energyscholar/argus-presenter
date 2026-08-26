/*
 * Argus Presenter — the WIRE ACTION TABLE.
 *
 * Plan 0661 phase 1c (seam S-B). The 21 websocket fuseactions, lifted out of `createServer()` in
 * app/server.mjs. ⛔ THIS IS A MOVE, NOT A REWRITE: every body is byte-identical to the branch it
 * came from, save one documented substitution described below.
 *
 * The same seam `http-routes.mjs` cut for HTTP (plan 0530 P2), pointed at the websocket. The
 * handlers used to CLOSE OVER createServer()'s state, so every captured binding is now an explicit
 * dependency, passed in a context object whose keys are spelled exactly as the bodies already spell
 * them — which is why the bodies could be moved without touching a character.
 *
 * ⭐ THE CONTEXT IS COMPUTED, NOT HAND-LISTED. All 64 names were derived from the AST by taking each
 *   handler's free identifiers minus its own bindings minus the JS globals. A hand-copied list is
 *   how you ship a ReferenceError that only fires on the one frame that needs the missing name —
 *   and this table has already cost us exactly that once. See
 *   [[feedback-an-empty-abstraction-step-ships-unexercised]].
 *
 * ⛔ THREE NAMES ARE READ LIVE, NOT DESTRUCTURED: commsMode, inboxSeq, seatResolver.
 *   They are `let` bindings that createServer REASSIGNS after this factory runs (seatResolver at the
 *   tailscale resolve, commsMode from the PVS mode control, inboxSeq as the situation log advances).
 *   Destructuring them here would snapshot the value at wiring time and every handler would then
 *   read a stale one — a silent behaviour change, not a crash. They are therefore reached as
 *   `ctx.<name>` through getters the caller supplies. The handlers only READ them; if one ever needs
 *   to WRITE one, this seam needs a setter and a much harder look.
 *
 * ⚠ WHEN THIS FACTORY MAY BE CALLED: not before every name exists. Most of the context is declared
 *   BELOW the old registration point in createServer, so the call site is at the end of the
 *   function, just before its return. createServer runs to completion synchronously before any
 *   socket callback can fire, so the table is always populated before the first frame arrives.
 */

/**
 * Build the websocket action table.
 *
 * @param {object} ctx  createServer()'s captured state and helpers. commsMode/inboxSeq/seatResolver MUST be
 *                      exposed as getters — see the note above.
 * @returns {Map<string, (frame: {m: object, c: object, ws: object, req: object}) => void>}
 */
export function createWireActions(ctx) {
  const {
    CAP_SECRET, CONTROL_ROLES, EVER_SEEN_MAX, LAST_RESULTS_MAX, MAX_VALUE_BYTES,
    TRANSCRIPT_PERSIST, acks, api, bindUser, computeAuthCtx,
    conns, deliverTurnToSub, deriveConnTrust, displayByUser, doRoll,
    emit, emitInbox, evaluateFloor, everSeen, everSeenOrder,
    handleControl, handleOp, inbox, lastResults, lastResultsOrder,
    log, parseRollCommand, peekTo, presence, pushPresence,
    pushResult, pvsConsumerKey, pvsSubscribers, redisplayFor, renderDisplay,
    renderStationTo, resolveIdentity, resyncOrSnapshot, revokedNonces, rosterVisibleToAttendees,
    seatStation, send, sendComponentTo, shimAnswer, cursors,
    spotlight, spotlightLast, stationPlaceholder, stationRegistry, stationsActive,
    surfaceRegistry, surfacesActive, targets, telem, unbindUser,
    unpeekTo, updateChatListeners, verifyCapability, voiceAllowedFor, voiceSegFinalize,
    voiceSegStart,
  } = ctx;
  const wireActions = new Map();

  wireActions.set("pvs_subscribe", ({ m, c, ws, req }) => {
      // Become a SUBSCRIBER: leave the participant set (no roster/floor/backpressure weight, cannot
      // send ops). Share the namespaced delivery cursor (R2); replay the unread backlog from it (R1),
      // then stream live. If no PVS baseline exists yet, baseline at the live seq (don't flood).
      const key = pvsConsumerKey(m.consumer || 'argusmon');
      const cc = conns.get(ws); if (cc && cc.userId) unbindUser(cc.userId, ws);
      conns.delete(ws); updateChatListeners(); emit('presence', presence()); evaluateFloor();
      // ⛔ Plan 0687 R2 (G5) — REPLAY IS FROM `acked`, NOT FROM `sent`. A previous attach may have
      // been handed turns whose response was truncated mid-flight; those advanced `sent` and nothing
      // else, so on re-attach they are REDELIVERED. Only an explicit ack retires a turn.
      if (!cursors.hasDelivery(key)) cursors.baselineDelivery(key, ctx.inboxSeq);
      const rec = cursors.delivery(key);
      pvsSubscribers.set(ws, { consumer: key });
      send(ws, { t: 'pvs_subscribed', consumer: key, resumeCursor: rec.acked, sentCursor: rec.sent, mode: ctx.commsMode });
      // R4: read through the ring's eviction boundary when a durable spill exists.
      for (const it of ctx.entriesAfter(rec.acked).entries) deliverTurnToSub(ws, pvsSubscribers.get(ws), it, { replay: true });
      log.info('pvs', 'subscribe', { consumer: key, resumeFrom: rec.acked, sent: rec.sent });
      return;
  });

  wireActions.set("pvs_ack", ({ m, c, ws, req }) => {
      // ⛔ Plan 0687 R2 (G5) — THE ACK, over the same socket that carried the turns. This is the
      // ONLY wire frame that may move an `acked` position, and it moves ONLY the sender's own
      // delivery record: the key comes from the subscriber table, never from the frame, so one
      // watcher can never ack another's turns. A socket that is not a subscriber is refused by
      // name — silently ignoring it would look exactly like a successful ack.
      const sub = pvsSubscribers.get(ws);
      if (!sub) { send(ws, { t: 'pvs_acked', ok: false, reason: 'not-a-subscriber' }); return; }
      const live = ctx.inboxSeq;
      const asked = (typeof m.seq === 'number' && Number.isFinite(m.seq)) ? m.seq : cursors.delivery(sub.consumer).sent;
      const rec = cursors.ackDelivery(sub.consumer, Math.max(0, Math.min(asked, live)));
      ctx.compactSpill();
      send(ws, { t: 'pvs_acked', ok: true, consumer: sub.consumer, acked: rec.acked, sent: rec.sent, liveCursor: live });
      log.info('pvs', 'ack-ws', { consumer: sub.consumer, acked: rec.acked, sent: rec.sent });
      return;
  });

  wireActions.set("hello", ({ m, c, ws, req }) => {
      // Plan 0472 P4 (SECURITY): a signed, scoped, revocable GUEST capability link (?cap=<token>).
      // The HMAC is verified over the RAW payload bytes BEFORE any field is trusted; exp + revocation
      // are enforced; the rejection reason stays INTERNAL (a generic warn only — never the reason or
      // any secret/nonce is surfaced). A presented cap makes this connection a GUEST: role is
      // HARD-FORCED to participant (never presenter/ai, whatever the payload/hello claims), identity +
      // scope come from the (authentic) token, and the client CANNOT widen either. Disabled entirely
      // when no secret is configured. A cap NEVER bypasses the control gate below — it is a separate,
      // guest-only path.
      let capGrant = null;
      if (m.cap) {
        if (CAP_SECRET) {
          try {
            const v = verifyCapability(m.cap, CAP_SECRET, { now: Date.now(), isRevoked: (n) => revokedNonces.has(n) });
            if (v.ok) capGrant = v.payload;
            else log.warn('cap', 'invalid-capability', { socketId: c.id });   // GENERIC: no reason, no secret material
          } catch (e) { log.warn('cap', 'invalid-capability', { socketId: c.id }); }   // never let a bad token crash the conn
        } else {
          log.warn('cap', 'capability-disabled', { socketId: c.id });   // links disabled: no secret configured
        }
      }
      // Plan 0482 A2: role + userId are decided in EXACTLY ONE function (resolveIdentity,
      // the identity seam). Guest/control/gm/unknown-role policy all live there; this call
      // site only applies the verdict.
      // Plan 0543 P3 — the AUTH CONTEXT (loopback verdict + any verified principal) is read from the
      // upgrade request `req`, then fed to BOTH decisions: resolveIdentity (the control-page ROLE)
      // and deriveConnTrust (command TRUST). This is where 0543 keeps "role" and "authority" separate.
      const authCtx = computeAuthCtx(req);
      const ident = resolveIdentity(m, capGrant, c.id, authCtx);
      c.userId = ident.userId;
      c.userName = ident.userName;
      c.role = ident.role;
      if (ident.isGuest) { c.isGuest = true; c.capScope = ident.capScope; c.capNonce = ident.capNonce; }
      /* ⛔ Plan 0692 F3 — REMEMBER THAT THIS IDENTITY WAS DERIVED FROM A SEAT LINK. resolveIdentity
         returns a stationUid on exactly one branch: the one where userId = <stationCode>-<slug(userName)>.
         On that branch the name IS the key, so a rename would silently make this connection a
         different user and strand its seat. The `rename` action below refuses it, server-side,
         rather than trusting the client to have hidden the control. */
      c.seatDerived = ident.stationUid != null;
      // The SERVER-AUTHORITATIVE command-trust for this connection. Stamped on every turn this
      // connection emits (chat/voice) so the fence delimits it correctly. NEVER from the password.
      const trustVerdict = deriveConnTrust(ident, capGrant, authCtx);
      c.trust = trustVerdict.trust;
      // ⭐ Decided ONCE, at hello, from the verified identity — never re-derived from a client claim.
      c.voiceAllowed = voiceAllowedFor(req);
      c.trustReason = trustVerdict.reason || null;
      c.reauth = !!trustVerdict.reauth;
      bindUser(c.userId, ws);
      // welcome.role = the EFFECTIVE granted role, so the client learns if it was
      // silently downgraded (wrong/absent password) and can surface feedback.
      // RT-26 consent surface: tell every client whether recognized speech is being written to
      // disk. Default false (ephemeral-only) — saving people's words silently is a consent violation.
      // For a GUEST (capability link), surface guest:true + the granted scope so the client knows
      // exactly what it may do (talk/type) — the same consent/transparency surface as any participant.
      // Plan 0514 §4.2a / §8 — seat this connection at a station. select() is where "every
      // failure path lands on the default station" is implemented: an unresolvable uid comes back as the
      // default, never as an error, and never as a disconnect. Core records nothing.
      let seat = null;
      if (stationsActive()) {
        try { seat = ctx.seatResolver.select(c.userId, ident.stationUid != null ? ident.stationUid : stationRegistry.defaultUid); }
        catch (e) { log.warn('station', 'resolver-select-failed', { userId: c.userId, err: String(e && e.message || e) }); }
      }
      // Plan 0514 §8: the registry, this seat's station and its spotlight grant all ride the
      // welcome, so a client rebuilds its selector AND RESTORES ITS OWN STATE ON RECONNECT —
      // the 0508 D1 class of bug, designed out rather than patched.
      send(ws, { t: 'welcome', userId: c.userId, userName: c.userName, socketId: c.id, role: c.role, transcriptPersisting: TRANSCRIPT_PERSIST,
        // Plan 0543 P3 — the client learns its COMMAND-TRUST (distinct from role): whether its words
        // may become an instruction. `authReason` explains a fenced verdict ("signed in, not
        // authorized" — the E/C dead-end fix); `reauth:true` asks a lapsed session to re-authenticate
        // rather than being silently downgraded (the A fix).
        trust: c.trust, ...(c.trustReason ? { authReason: c.trustReason } : {}), ...(c.reauth ? { reauth: true } : {}),
        ...(c.isGuest ? { guest: true, scope: c.capScope } : {}),
        ...(stationsActive() ? {
          stationRegistry: stationRegistry.wire(),
          stationSelectorLabel: stationRegistry.selectorLabel,
          stationUid: seat && seat.uid != null ? seat.uid : stationRegistry.defaultUid,
          spotlightGranted: spotlight.has(c.userId),
        } : {}),
        // Plan 0526 P4 — the surfaces this viewer may call up, so a client can OFFER them
        // without asking. Wire form only: uid + label + flags, never a plugin's file layout and
        // never the author's `surfaceId`. Absent entirely when no plugin declared any, so a
        // deployment that has never heard of surfaces sees no change in its welcome at all.
        ...(surfacesActive() ? { surfaceRegistry: surfaceRegistry.wire() } : {}) });
      // C4/X1: converge the (re)connecting client. If it reports a lastVersion we
      // can still replay from the op-log, send only the MISSED ops (resync);
      // otherwise a full role-filtered snapshot (Memento).
      resyncOrSnapshot(ws, c, m.lastVersion);
      /* Plan 0539 P2.3 — from HERE on, live broadcasts are purely additive: the client's state is
       * caught up to `store.version()`, so anything arriving next is genuinely new.
       *
       * ⛓ WHERE THIS MAY GO, MEASURED RATHER THAN ASSUMED. The binding constraint is that it sit
       * AFTER THE CONNECT-TIME STORE WRITES — today the station-seat write ~20 lines above
       * (`ctx.seatResolver.select` → `occupancy.seat`). Break-tested three ways:
       *   · guard removed entirely            → X1 red, `got=[18,19,16,17,18,19]` (the original defect)
       *   · `converged = true` before the SEAT WRITE → X1 red, same signature
       *   · `converged = true` before the RESYNC     → X1 GREEN
       * That third result is the interesting one: it means the resync is NOT the boundary, the seat
       * write is. Nothing writes to the store between `resyncOrSnapshot` and this line, so the two
       * placements are observationally identical today. It is kept here anyway because that empty
       * window is an accident of the current handler, not a guarantee — the moment anything
       * store-writing is added to the handshake, only this position stays correct. ⛔ An earlier
       * "must be after the resync or the fix is undone" claim was written here first and was
       * simply WRONG; the break-test is what says otherwise. */
      c.converged = true;
      redisplayFor(ws, c);   // C6: re-push the currently-displayed content module
      if (everSeen.has(c.userId)) telem.reconnects++; else { everSeen.add(c.userId); everSeenOrder.push(c.userId); if (everSeenOrder.length > EVER_SEEN_MAX) everSeen.delete(everSeenOrder.shift()); }   // Plan 0471 L2: bounded
      send(ws, { t: 'ping', ts: Date.now() });   // X3 RTT probe
      log.info('conn', 'hello', { socketId: c.id, userId: c.userId, role: c.role, lastVersion: m.lastVersion || 0 });
      updateChatListeners();   // P3
      emit('presence', presence()); pushPresence();
  });

  wireActions.set("result", ({ m, c, ws, req }) => {
      if (c) c.lastActive = Date.now();   // ATT: beat answer/continue + poll vote = deliberate human interaction
      // Authoritative identity from the connection, NOT the client payload.
      // Plan 0572 §3.3: the ROLE is stamped here for the same reason and from the same source as
      // the userId beside it. A plugin guard that must answer "is this actor the operator?" had
      // no way to ask — the neutral plugin context offers store/allowRead/on/addTool/stations and
      // nothing that carries a role — so it would have had to read a presence snapshot, which is
      // a SECOND, CACHEABLE source for a fact this connection already knows. It stays off the
      // wire: pushResult below names its forwarded fields explicitly and does not include it.
      const r = Object.assign({}, m.msg, { userId: c.userId, userName: c.userName, role: c.role, channel: c.userId });
      shimAnswer(c, r);      // D2: poll vote (and generic answer) -> store op
      emit('result', r);     // map view/click/pointer are store ops now (E1-E4) — no relay
      // PRIM-results: track last result per prompt and forward to CONTROL roles ONLY (OPSEC:
      // presenter/ai — participants must NEVER receive a peer's answer/continue).
      // Auditor: only meaningful results (answer/continue) — drop lifecycle events (ready/step/change/
      // flow-complete) that carry the SAME promptId and would false-trigger DEL-2 branch nav (S190 gotcha).
      if (r.promptId != null && (r.type === 'answer' || r.type === 'continue')) {
        // Plan 0471 M3: this path bypasses store.validOp, so enforce the 64KB value cap here,
        // and bound lastResults to LAST_RESULTS_MAX distinct promptIds (FIFO evict).
        let vsize = 0; try { vsize = JSON.stringify(r.value === undefined ? null : r.value).length; } catch { vsize = Infinity; }
        if (vsize > MAX_VALUE_BYTES) {
          log.warn('result', 'value-too-large', { promptId: r.promptId, userId: r.userId, bytes: vsize });
        } else {
          if (!lastResults[r.promptId]) {
            lastResults[r.promptId] = {};
            lastResultsOrder.push(r.promptId);
            while (lastResultsOrder.length > LAST_RESULTS_MAX) { const old = lastResultsOrder.shift(); delete lastResults[old]; }
          }
          lastResults[r.promptId][r.userId] = { type: r.type, value: r.value };
          pushResult(r);
        }
      }
  });

  /* ── Plan 0692 T2 — RENAME: THE LABEL CHANGES, THE KEY DOES NOT ────────────────────────────
   *
   * ⭐ Bruce, 2026-08-26: "IDENTITY is one thing, current NAME is another matter. On one login I
   *   might name myself 'Bob' and on another 'Conan' and that's fine. My IDENTITY to the server
   *   should remain consistent where possible."
   *
   * ⛔ THIS HANDLER MUST NEVER TOUCH c.userId. Seats, locks, private slices, presence rows, the
   *   op-log's `by`, the display binding and `bindUser` are ALL keyed on it. Changing it here
   *   would evict the renamer from their station and leave a lock nobody can release — the exact
   *   harm plan 0692 exists to prevent. There is no reconnect and no re-resolve: one field moves.
   *
   * ⛔ F3 — REFUSED ON A SEAT-DERIVED IDENTITY. There, userId = <stationCode>-<slug(userName)>
   *   (t79), so the name IS the key and renaming would be exactly the identity change forbidden
   *   above. The client hides the control; this refuses it anyway, because a rule enforced only in
   *   the page is a rule a raw socket does not have.
   *
   * ⛔ REFUSED FOR A GUEST. A capability link's name comes from the signed token; letting the
   *   holder overwrite it would let a client widen what the token said (0472 P4).
   *
   * ⛔ F2 — THIS IS NOT AN `op`. It is how an unnamed visitor becomes named, so it can never sit
   *   behind the write-gate that unnamed visitors are subject to. */
  wireActions.set("rename", ({ m, c, ws, req }) => {
      if (!c || !c.userId) return;                                   // never said hello
      if (c.seatDerived || c.isGuest) { send(ws, { t: 'renamed', userId: c.userId, userName: c.userName, refused: c.seatDerived ? 'seat-link' : 'guest' }); return; }
      if (typeof m.userName !== 'string') return;
      const nm = m.userName.replace(/\s+/g, ' ').trim().slice(0, 64);
      if (!nm) return;                                               // a blank is not a name; the old one stands
      /* ⛔ T6 — A DUPLICATE NAME IS ACCEPTED. Two people called Bruce both keep it; they are told
         apart by the uid, which is the key. Refusing a name, or mutating it into 'Bruce (2)', would
         be the server deciding what a person is called. Any disambiguation is for DISPLAY only. */
      const before = c.userId;
      c.userName = nm;
      if (c.userId !== before) throw new Error('0692: a rename changed the userId');   // unreachable by construction; here so it can never become reachable silently
      send(ws, { t: 'renamed', userId: c.userId, userName: c.userName });
      log.info('conn', 'rename', { socketId: c.id, userId: c.userId });   // ⛔ the NAME is not logged: it is a person's chosen label, and the id is what a log needs
      emit('presence', presence()); pushPresence();
  });

  wireActions.set("op", ({ m, c, ws, req }) => {
      handleOp(c, m);
  });

  wireActions.set("control", ({ m, c, ws, req }) => {
      handleControl(c, m, ws);
  });

  wireActions.set("pong", ({ m, c, ws, req }) => {
      if (typeof m.ts === 'number') { const rtt = Date.now() - m.ts; telem.rtt.last = rtt; telem.rtt.sum += rtt; telem.rtt.count++; }
  });

  wireActions.set("telemetry", ({ m, c, ws, req }) => {
      if (m.kind === 'render-error') telem.renderErrors++;
      else if (m.kind === 'op-apply-failure') telem.opApplyFailures++;
      else if (m.kind === 'rtt' && typeof m.value === 'number') { telem.rtt.last = m.value; telem.rtt.sum += m.value; telem.rtt.count++; }
  });

  wireActions.set("request-poll", ({ m, c, ws, req }) => {
      emit('poll', { type: 'request', from: { userId: c.userId, userName: c.userName }, spec: m.spec });
  });

  wireActions.set("ack", ({ m, c, ws, req }) => {
      // Eyes-on acknowledgement: the viewer clicked CONFIRM on a requireAck chime.
      // Plan 0471 M2: ONLY an OUTSTANDING chime (created by api.chime requireAck) accepts an
      // ack. An unknown/attacker-chosen ackId is dropped — it no longer creates a map entry,
      // so the `acks` map can't be grown by unauth {t:'ack'} frames.
      const ackId = (m && m.ackId) || 'ready';
      const a = acks.get(ackId);
      if (!a) { log.debug('ack', 'unknown-ackId', { socketId: c.id, ackId }); return; }
      c.eyesOn = Date.now();                              // this connection is confirmed watching (not AFK)
      c.lastActive = Date.now();                          // ATT: eyes-on CONFIRM click = deliberate interaction
      a.by.set(c.userId, { userName: c.userName, at: c.eyesOn });
      log.info('ack', 'eyes-on', { ackId, userId: c.userId });
      pushPresence();                                    // control user-list reflects eyes-on immediately
      // ── ⛓ THE SIX MESSAGES THAT PUT SOMETHING ON A SCREEN (0526 P4's naming seam) ─────────
      // Rule zero says a name means one thing, and this chain now holds six verbs that all end
      // in "somebody sees something". They are NOT synonyms; each answers a different question,
      // and the next person to add a seventh should have to say which of these it is not:
      //
      //   station-select  WRITES the caller's seat (ctx.seatResolver.select), then renders it.
      //                   The only one of the six that changes durable state.
      //   station-show    renders the caller's OWN SEAT's station. Source: the seat. No write.
      //   station-default renders the idle branding to the caller. Source: nothing. No write.
      //   station-share   renders the caller's own station TO EVERYONE. Escalation ⇒ granted,
      //                   throttled. The only one of the six that reaches other people.
      //   peek            renders a DECLARED SURFACE to the caller. Source: the registry, which
      //                   no module can touch. No seat, no write, nobody else affected.
      //   unpeek          renders whatever the ROOM is currently showing the caller. Source: the
      //                   live display maps. No write.
      //
      // ⚠ `station-show` IS "peek my own station" and the overlap is real — it is not folded in
      // because the two read DIFFERENT SOURCES (a seat the plugin owns vs a registry core owns)
      // and folding them would put the seat resolver behind the surface verb. Two sources, two
      // verbs, one sentence each: that is the seam, stated rather than left to be rediscovered.
  });

  wireActions.set("station-select", ({ m, c, ws, req }) => {
      // Plan 0514 §8 — SELF-SCOPED and UNGATED, by the same zero-privilege argument as
      // station-show: it changes only what the caller sees. Core hands the request to the
      // plugin, which validates and RECORDS it, and renders whatever comes back.
      if (!stationsActive()) { send(ws, { t: 'station', ok: false, reason: 'no-stations' }); }
      else {
        let seat = null;
        try { seat = ctx.seatResolver.select(c.userId, m.stationUid); }
        catch (e) { log.warn('station', 'resolver-select-failed', { userId: c.userId, err: String(e && e.message || e) }); }
        // Unknown/absent uid ⇒ the plugin answered with the deployment default. Never a throw,
        // never a disconnect — §5's single failure rule, applied on the wire.
        if (!seat) send(ws, { t: 'station', ok: false, reason: 'no-stations' });
        else {
          renderStationTo(ws, c, seat);
          c.lastActive = Date.now();
          send(ws, { t: 'station', ok: true, stationUid: seat.uid });
          log.info('station', 'selected', { userId: c.userId, stationUid: seat.uid });
          pushPresence();
        }
      }
  });

  wireActions.set("station-default", ({ m, c, ws, req }) => {
      // Plan 0514 §7 — ⟲ Show default. Idle branding for THIS socket only; displayByUser is
      // untouched, so `▣ My station screen` still works afterwards. Deliberately NOT
      // api.showDefault / default branding — those are controller-scoped and clear the stored
      // descriptor for everyone.
      send(ws, { t: 'clear' });
      c.lastActive = Date.now();
      send(ws, { t: 'station', ok: true, defaulted: true });
  });

  wireActions.set("station-show", ({ m, c, ws, req }) => {
      // Plan 0508 — STATION SCREEN (self-scoped, ungated). Zero privilege: it shows you only
      // what is already yours, so a participant may always call it. Lets a player park on a
      // shared beat, then flick back to their own station without asking the GM.
      // Plan 0514 §13.2 — the SOURCE is now the seat's STATION (machine → registry →
      // descriptor), never displayByUser. That map is the transient per-seat push layer and a
      // module load clears it, which is exactly why every seat's station used to vanish on
      // `present_module` (§13.1). §13.4 records the accepted consequence: this button now means
      // "show my station", which is what it says. With no stations declared it keeps its 0508
      // meaning, so a teaching deployment is untouched.
      if (stationsActive()) {
        const seat = seatStation(c.userId);
        if (seat) { renderStationTo(ws, c, seat); c.lastActive = Date.now(); }
        else send(ws, { t: 'station', ok: false, reason: 'no-station' });
      } else {
        const desc = displayByUser.get(c.userId);
        if (desc) { renderDisplay(ws, c, desc); c.lastActive = Date.now(); }
        else send(ws, { t: 'station', ok: false, reason: 'no-station' });
      }
  });

  wireActions.set("station-share", ({ m, c, ws, req }) => {
      // Plan 0508 — SPOTLIGHT. Promote the caller's OWN station display to everyone. This IS an
      // escalation (a participant changing what the room sees), so it is default-DENY and must be
      // granted per-user by a controller (api.spotlight). Throttled: one share per 3 s per user.
      // Plan 0514 §6.2: the grant model, the throttle and the targets are UNCHANGED — only the
      // SOURCE moved, from displayByUser to the seat's station. Two lines, inside an existing
      // handler; not a new sharing subsystem.
      const seatForShare = stationsActive() ? seatStation(c.userId) : null;
      const desc = seatForShare
        ? ((seatForShare.descriptor) || stationPlaceholder(seatForShare.uid, c))
        : displayByUser.get(c.userId);
      if (!spotlight.has(c.userId)) { send(ws, { t: 'station', ok: false, reason: 'not-granted' }); log.warn('station', 'share-denied', { userId: c.userId }); }
      else if (!desc) send(ws, { t: 'station', ok: false, reason: 'no-station' });
      else if (Date.now() - (spotlightLast.get(c.userId) || 0) < 3000) send(ws, { t: 'station', ok: false, reason: 'too-fast' });
      else {
        spotlightLast.set(c.userId, Date.now());
        c.lastActive = Date.now();
        // Target: 'all', a ROLE, or a single userId — one-by-one is deliberate, so a player can
        // walk one crewmate through a readout without taking over every screen.
        const tgt = (typeof m.target === 'string' && m.target) ? m.target : 'all';
        // SHARE IS TRANSIENT PROJECTION — it deliberately does NOT go through pushComponent.
        // pushComponent calls setDisplay, and setDisplay('all') does displayByUser.clear(): a
        // single share would wipe EVERY seat's station, the sharer's included, and "▣ My station
        // screen" would answer "nothing has been sent to your seat" for the rest of the session.
        // (Caught by t0508 T7.) So we render straight to the sockets and touch no descriptor:
        // stations stay durable, the projection lasts until the next push. Each viewer is still
        // rendered in THEIR own context, so identity stamping and the OPSEC strip still apply —
        // never a verbatim copy of the sharer's HTML.
        let n = 0;
        if (desc.kind === 'component') for (const t of targets(tgt)) { sendComponentTo(t, conns.get(t), desc); n++; }
        log.info('station', 'shared', { userId: c.userId, target: tgt, to: n, component: desc.component });
        send(ws, { t: 'station', ok: true, shared: n });
        emit('presence', presence());
      }
  });

  wireActions.set("peek", ({ m, c, ws, req }) => {
      // Plan 0526 P4 — SELF-SERVICE NAVIGATION. A participant calls up a declared surface on
      // their own screen. Self-scoped and ungated by the same zero-privilege argument as
      // station-show; DEFAULT-DENY on the surface row is what decides whether they may.
      // ⛓ THE WIRE TAKES A UID: {t:'peek', surfaceUid:<int>} (canon §3 — the author's
      // `surfaceId` never reaches this line). A refusal always names its reason.
      const peeked = peekTo(ws, c, m.surfaceUid);
      if (peeked.ok) send(ws, { t: 'surface', ok: true, surfaceUid: peeked.surfaceUid, surfaceLabel: peeked.surfaceLabel, hasScreen: peeked.hasScreen });
      else send(ws, { t: 'surface', ok: false, reason: peeked.reason, surfaceUid: peeked.surfaceUid == null ? null : peeked.surfaceUid, ...(peeked.surfaceLabel ? { surfaceLabel: peeked.surfaceLabel } : {}) });
  });

  wireActions.set("unpeek", ({ m, c, ws, req }) => {
      // Plan 0526 P4 — BACK TO THE ROOM. Renders the room's CURRENT display to this socket, so
      // a beat that moved during the peek is the beat the viewer rejoins (see unpeekTo).
      // Stateless: always safe to send, even when the caller was not peeking.
      const back = unpeekTo(ws, c);
      send(ws, { t: 'surface', ok: true, surfaceUid: null, unpeeked: true, restored: back.restored });
  });

  wireActions.set("attendance-request", ({ m, c, ws, req }) => {
      // ATT (Plan 0466 §2.5): request/reply — NO standing push. Redaction is SERVER-SIDE,
      // keyed on the CONNECTION's authoritative role. Control/ai always get the full roster;
      // a participant gets the redacted roster ONLY when the presenter gate is ON, else self-only.
      const control = (c.role === 'presenter' || c.role === 'ai');
      // Plan 0468: no activity thresholds — connection liveness only. Pass optional staleMs; else default.
      if (control) {
        const att = api.attendance({ staleMs: m.staleMs, viewerRole: c.role });
        send(ws, { t: 'attendance', roster: att.roster, summary: att.summary, rosterVisible: rosterVisibleToAttendees });
      } else if (rosterVisibleToAttendees) {
        const att = api.attendance({ staleMs: m.staleMs, viewerRole: 'participant' });
        send(ws, { t: 'attendance', roster: att.roster, summary: att.summary });
      } else {
        // gate OFF ⇒ deny = self-only (decision 1). Reuse the redacted build, filter to self.
        const att = api.attendance({ staleMs: m.staleMs, viewerRole: 'participant' });
        const self = att.roster.filter((r) => r.userId === c.userId);
        const summary = {
          connected: self.filter((r) => r.connected).length,
          offline: self.filter((r) => !r.connected).length,
          eyesOn: self.filter((r) => r.eyesOn).length,
          total: self.length,
        };
        send(ws, { t: 'attendance', roster: self, summary });
      }
  });

  wireActions.set("voice_seg_start", ({ m, c, ws, req }) => {
      // Plan 0470: control frame bracketing an utterance (binary PCM follows on the same conn).
      /* ⛔⛔ THE REAL GATE IS HERE, NOT IN THE PAGE. Stripping the microphone button from the HTML
       *   stops a person clicking it and stops nobody from sending the frame — a client is not a
       *   security boundary and never was. A connection without the capability is refused BY NAME,
       *   so the refusal is visible in the log rather than looking like a microphone that failed. */
      if (!c || c.voiceAllowed !== true) {
        log.warn('voice', 'seg-start-denied', { socketId: c && c.id, userId: c && c.userId, trust: c && c.trust });
        send(ws, { t: 'voice_denied', reason: 'voice is granted per user, to signed-in accounts only' });
      } else voiceSegStart(c, ws, m);
  });

  wireActions.set("voice_seg_end", ({ m, c, ws, req }) => {
      voiceSegFinalize(c, ws, {});   // finalize -> WAV -> WARM ASR -> transcript out
  });

  wireActions.set("voicedbg", ({ m, c, ws, req }) => {
      // Plan 0476 P1: client voice stage-tracer (S1..S10 + level meter). Logs to the voice-debug ring
      // (visible via presenter_debug) — NEVER the inbox/transcript, so the transcript + echo line stay
      // clean. Untrusted client content is confined to a bounded log field.
      if (m && typeof m.tag === 'string') log.info('voicedbg', m.tag.slice(0, 48), { socketId: c && c.id, ...(m.data && typeof m.data === 'object' ? m.data : {}) });
  });

  wireActions.set("roll", ({ m, c, ws, req }) => {
      // Plan 0537 P3.2 — the wire form: {t:'roll', spec, target?, label?, total?}. `total` is the
      // MANUAL entry (physical dice, typed in) and is the only number a client may contribute —
      // it is recorded as `entry:'manual'` so the log can always tell a roll from a claim.
      if (c && c.isGuest && !(c.capScope || []).includes('type')) { log.warn('cap', 'roll-out-of-scope', { socketId: c.id }); return; }
      if (c) {
        // Plan 0539 P1.7 — labelled modifiers are CONTROLLER-ONLY on the wire. A participant may
        // still ask for `+2` through the spec (it is part of the request, like the target), but it
        // may not attach a REASON to a number: a skill name appearing in the room's log as though
        // the session had established it is an assertion, and 0537's rule is that the client asks
        // and the server answers. The skill-aware caller this field exists for is a plugin/agent,
        // which holds a control role. A participant's `modifiers` are dropped, not refused —
        // the roll itself is perfectly valid without them.
        const supplied = CONTROL_ROLES.has(c.role) ? m.modifiers : null;
        const res = doRoll(c, { spec: m.spec, target: m.target, label: m.label, manualTotal: m.total, modifiers: supplied });
        if (!res.ok) send(ws, { t: 'roll_refused', reason: res.reason, text: 'expected {spec:"<count>d<sides>[+mod]", target?, label?, total?}' });
      }
  });

  wireActions.set("chat", ({ m, c, ws, req }) => {
      // Plan 0472: typed text is FIRST-CLASS input. Land it in the unified inbox attributed to the
      // SERVER-AUTHORITATIVE connection identity (never the client payload). D5 = DUAL-WRITE: also
      // drive the chat STORE slice so the existing read-perm'd chat display (P3) keeps working.
      // Plan 0472 P4: a GUEST may type ONLY if its capability scope includes 'type' (the scope is
      // token-signed, so it cannot be widened by the client). Non-guests are unaffected.
      if (c && c.isGuest && !(c.capScope || []).includes('type')) { log.warn('cap', 'type-out-of-scope', { socketId: c.id }); return; }
      if (c && typeof m.text === 'string' && m.text.length) {
        c.lastActive = Date.now();   // ATT: typing = deliberate human interaction
        const id = (typeof m.id === 'string' && m.id) ? m.id : (c.userId + '-' + Date.now());
        // Plan 0537 P2.3 — `/gm <text>` is a PRIVATE ASIDE TO THE GM. Parsed HERE, on the server,
        // not in the client: the client cannot be the authority on which of its own messages stay
        // private, and a second client (or a bot on a raw socket) would otherwise miss the rule
        // entirely. The aside is written to the `gm` slice, which is already controller-read-only
        // by default-deny — no second secrecy mechanism, and no way for it to reach `chat`.
        const aside = /^\/gm(?:\s+([\s\S]*))?$/.exec(m.text.trim());
        if (aside) {
          const body = (aside[1] || '').trim();
          // ⛓ The client MUST be told what happened. A message that simply vanishes from the room
          // is the invisible-GO defect wearing a new coat: the sender assumes it landed, and the
          // only evidence either way is its absence. Both branches below answer.
          if (!body) { send(ws, { t: 'chat_private', ok: false, reason: 'empty', text: '' }); return; }
          const asideTs = Date.now();
          emitInbox({ kind: 'text', userId: c.userId, userName: c.userName, role: c.role, text: body, conf: null, final: true, isGuest: !!c.isGuest, private: true, trust: c.trust });
          handleOp(c, { path: 'gm/asides/' + id, verb: 'set', value: { id, text: body, name: c.userName, userId: c.userId, ts: asideTs } },
            { userId: c.userId, role: 'system' });   // sender's id, lifted role — see handleOp
          // Plan 0539 P1.3 — the receipt now carries `id` + `ts`. THE SENDER IS THE ONLY PERSON
          // WHO CANNOT READ THEIR OWN ASIDE: it lives in the controller-only `gm` slice, so a
          // participant's reader has no other source for it. Without an id the sender's log
          // cannot dedupe it against the copy a CONTROLLER does receive over `gm/asides`, and a
          // facilitator would see their own aside twice. Without a ts it cannot be ordered
          // against the room's talk, which is the whole point of showing it at all.
          send(ws, { t: 'chat_private', ok: true, text: body, id, ts: asideTs, name: c.userName });
          return;
        }
        // Plan 0537 P3 — `/roll …` from the chat input. It routes into the SAME doRoll() the
        // `{t:'roll'}` wire message uses, so there is exactly one place a roll is produced. ⛔ It
        // does NOT also land in `chat`: a roll's record is `rolls`, and duplicating it as prose in
        // the room's talk would create a second, parseable representation of the same event.
        const rollCmd = /^\/roll(?:\s+([\s\S]*))?$/.exec(m.text.trim());
        if (rollCmd) {
          const args = parseRollCommand(rollCmd[1]);
          if (!args) { send(ws, { t: 'roll_refused', reason: 'usage', text: '/roll <count>d<sides>[+mod] [target] [= total] [label]' }); return; }
          const res = doRoll(c, args);
          if (!res.ok) send(ws, { t: 'roll_refused', reason: res.reason, text: '/roll <count>d<sides>[+mod] [target] [= total] [label]' });
          return;
        }
        emitInbox({ kind: 'text', userId: c.userId, userName: c.userName, role: c.role, text: m.text, conf: null, final: true, isGuest: !!c.isGuest, trust: c.trust });
        // Plan 0539 P1.1 — `ts` and `userId` are ADDED to the record, and both are load-bearing for
        // the reader. `chat` is a keyed collection, not a list: a client rebuilding the log from a
        // snapshot gets an OBJECT, whose key order is an implementation detail and not a history.
        // Without a server-stamped `ts` there is nothing to sort by, and "newest at the bottom"
        // becomes "whatever order V8 felt like". `userId` is what lets a reader tell YOUR line from
        // a line by someone who typed the same display name.
        handleOp(c, { path: 'chat', verb: 'add', value: { id, text: m.text, name: c.userName, userId: c.userId, ts: Date.now() } });   // display slice (best-effort; perm-gated)
      }
  });

  return wireActions;
}
