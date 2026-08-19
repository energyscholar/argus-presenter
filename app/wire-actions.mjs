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
    /* ── HELPERS THAT FOLLOWED THEIR ACTIONS (Plan 0661 phase 1d) ─────────────────────────────
   * 16 declarations nothing outside this seam referenced any more.
   * ⭐ THE DESTRUCTURE IS GONE. Every dependency is now reached as ctx.<name>, uniformly, and the
   *   call site supplies getters. That removes the three-live-reads special case entirely: there is
   *   no longer a set of names you must REMEMBER not to snapshot, because nothing is snapshotted.
   *   The context is DERIVED from this finished module, never predicted — predicting it is what
   *   produced three missing bindings in phase 3b. */
  function bindUser(userId, ws) {
      let set = ctx.byUser.get(userId);
      if (!set) { set = new Set(); ctx.byUser.set(userId, set); }
      if (set.size && !set.has(ws)) {
        ctx.log.warn('conn', 'duplicate-userId', { userId, existingSockets: set.size, action: 'fan-out',
          note: 'targeted content now delivered to ALL sockets for this userId' });
      }
      set.add(ws);
    }

  const everSeen = new Set();

  const everSeenOrder = [];

  const EVER_SEEN_MAX = 5000;

  const lastResultsOrder = [];

  const LAST_RESULTS_MAX = 500;

  function resolveIdentity(m, capGrant, socketId, authCtx = {}) {
      // GUEST (capability link): identity comes from the authentic token, role HARD-FORCED to
      // participant. The client cannot widen either.
      if (capGrant) {
        return {
          userId: 'guest:' + capGrant.nonce,
          userName: capGrant.name || ('guest:' + capGrant.nonce),
          role: 'participant',
          isGuest: true,
          capScope: capGrant.scope,
          capNonce: capGrant.nonce,
        };
      }
      // Plan 0514 §5 / §5.1 — SEAT PROVISIONING, BY UID. When the link carries a station selector,
      // identity is DERIVED from the link and nothing else: userId = <stationCode>-<slug(userName)>,
      // always, one rule, no branch. That is what makes a reload return the SAME seat (0508 D3: an
      // anon seat minted a fresh userId on every reload and orphaned both its station and its
      // spotlight grant).
      //
      // §5.1 (Bruce, S220) — the selector is an INTEGER uid looked up in the registry. Absent,
      // non-numeric or unknown ⇒ the deployment default. There is NO string matching here: a uid
      // cannot be misspelled into a different station, whereas `?station=damage-control` silently
      // seated the DEFAULT station because that station's code was `dc`. The userId is derived from the RESOLVED
      // station, so `?stationUID=999&n=Les` yields <defaultCode>-les and never a bogus seat.
      if (m.stationUID !== undefined && !ctx.stationRegistry.isEmpty()) {
        const askedUid = Number.isInteger(m.stationUID) ? m.stationUID : null;
        const st = ctx.stationRegistry.get(askedUid) || ctx.stationRegistry.get(ctx.stationRegistry.defaultUid);
        const rawName = typeof m.userName === 'string' ? m.userName : '';
        const seatUserId = st.stationCode + '-' + ctx.slugForSeat(rawName);
        const seatUserName = rawName.trim() ? rawName : 'NAME UNKNOWN';
        const askedRole = m.role || 'participant';
        if (!ctx.KNOWN_ROLES.has(askedRole)) {
          ctx.log.warn('auth', 'role-denied', { socketId, userId: seatUserId, requested: String(askedRole), granted: 'participant', reason: 'unknown-role' });
          return { userId: seatUserId, userName: seatUserName, role: 'participant', isGuest: false, stationUid: st.stationUid };
        }
        if (askedRole !== 'participant') {
          const gated = !!(ctx.CONTROL_TOKEN || ctx.ROLE_HASH);
          // Plan 0543 P3 — under enforceOAuth='control' the password is RETIRED for control roles; the
          // Control-page role comes from IDENTITY only. Under 'off' the existing password gate is unchanged.
          const controlOk = (ctx.AUTH_POLICY.enforceOAuth === 'control') ? ctx.identityGrantsControl(authCtx) : (!gated || ctx.credentialOk(m.token));
          const gmOk = (ctx.AUTH_POLICY.enforceOAuth === 'control') ? ctx.identityGrantsControl(authCtx) : (gated && ctx.credentialOk(m.token));
          if (ctx.CONTROL_ROLES.has(askedRole) && controlOk) return { userId: seatUserId, userName: seatUserName, role: askedRole, isGuest: false, stationUid: st.stationUid };
          if (askedRole === 'gm' && gmOk) return { userId: seatUserId, userName: seatUserName, role: 'gm', isGuest: false, stationUid: st.stationUid };
          ctx.log.warn('auth', 'role-denied', { socketId, userId: seatUserId, requested: String(askedRole), granted: 'participant', reason: 'bad-credential' });
        }
        return { userId: seatUserId, userName: seatUserName, role: 'participant', isGuest: false, stationUid: st.stationUid };
      }
      const userId = m.userId || ('anon-' + Math.random().toString(36).slice(2, 8));
      const userName = m.userName || userId;
      const asked = m.role || 'participant';
      const deny = (reason) => {
        ctx.log.warn('auth', 'role-denied', { socketId, userId, requested: String(asked), granted: 'participant', reason });
        return { userId, userName, role: 'participant', isGuest: false };
      };
  
      if (!ctx.KNOWN_ROLES.has(asked)) return deny('unknown-role');       // closed set — no verbatim roles
      if (asked === 'participant') return { userId, userName, role: 'participant', isGuest: false };
  
      if (ctx.CONTROL_ROLES.has(asked)) {
        // Plan 0543 P3 — under enforceOAuth='control' the password is RETIRED for the Control page: the
        // role comes from IDENTITY only (loopback / verified+allowlisted). Under 'off' this is UNCHANGED.
        if (ctx.AUTH_POLICY.enforceOAuth === 'control') {
          return ctx.identityGrantsControl(authCtx) ? { userId, userName, role: asked, isGuest: false } : deny('control-requires-verified-identity');
        }
        const gated = !!(ctx.CONTROL_TOKEN || ctx.ROLE_HASH);
        if (gated && !ctx.credentialOk(m.token)) return deny('bad-credential');
        return { userId, userName, role: asked, isGuest: false };     // ungated ⇒ tokenless grant
      }
      // gm — credential required unconditionally; no credential configured ⇒ nothing to verify ⇒ deny.
      if (ctx.AUTH_POLICY.enforceOAuth === 'control') {                    // Plan 0543 P3 — identity, not password
        return ctx.identityGrantsControl(authCtx) ? { userId, userName, role: 'gm', isGuest: false } : deny('control-requires-verified-identity');
      }
      if (!(ctx.CONTROL_TOKEN || ctx.ROLE_HASH)) return deny('gm-requires-credential-none-configured');
      if (!ctx.credentialOk(m.token)) return deny('bad-credential');
      return { userId, userName, role: 'gm', isGuest: false };
    }

  function pushResult(r) {
      for (const [ws, c] of ctx.conns.entries())
        if (c.role === 'presenter' || c.role === 'ai')
          ctx.send(ws, { t: 'result', promptId: r.promptId, userId: r.userId, userName: r.userName, type: r.type, value: r.value });
    }

  function resyncOrSnapshot(ws, c, lastVersion) {
      const lv = (typeof lastVersion === 'number' && lastVersion >= 0) ? lastVersion : 0;
      const log = ctx.store.oplogSince(0);
      const earliest = log.length ? log[0].version : ctx.store.version() + 1;
      const canReplay = lv > 0 && lv <= ctx.store.version() && lv >= earliest - 1;
      if (canReplay) {
        const missed = ctx.store.oplogSince(lv);
        ctx.send(ws, { t: 'resync', from: lv, to: ctx.store.version(), count: missed.length });
        for (const e of missed) {
          const visible = {};
          for (const p of Object.keys(e.diff)) if (ctx.store.perms.canRead({ role: c.role, userId: c.userId }, p)) visible[p] = e.diff[p];   // Plan 0471 C3: actor-aware read
          if (Object.keys(visible).length) ctx.send(ws, { t: 'host', msg: { source: 'argus-host', type: 'diff', diff: visible, by: e.by, version: e.version } });
        }
      } else {
        ctx.send(ws, { t: 'snapshot', state: ctx.store.snapshot({ role: c.role, userId: c.userId }).state, version: ctx.store.version() });   // Plan 0471 C3: actor-aware snapshot
      }
    }

  function doRoll(c, { spec, target = null, label = null, manualTotal = null, modifiers = null }) {
      const parsed = ctx.parseDice(spec);
      if (!parsed) return { ok: false, reason: 'bad-spec' };
      const tgt = (target === null || target === undefined) ? null : Number(target);
      if (tgt !== null && !Number.isFinite(tgt)) return { ok: false, reason: 'bad-target' };
      let rolls = [], total, mods = [];
      if (manualTotal !== null && manualTotal !== undefined) {
        if (!Number.isFinite(Number(manualTotal))) return { ok: false, reason: 'bad-total' };
        total = Number(manualTotal);
        // ⛔ A HAND-ENTERED TOTAL GETS AN EMPTY BREAKDOWN, deliberately. The human typed the finished
        // number; every adjustment they applied is already inside it. Listing the spec's `+2` beside it
        // would double-count on screen and claim an arithmetic the server never performed.
        mods = [];
      } else {
        for (let i = 0; i < parsed.count; i++) rolls.push(ctx.rollDie(parsed.sides));
        // Spec modifier first (it is part of what was asked for), then any labelled ones.
        mods = (parsed.mod ? [{ label: null, value: parsed.mod }] : []).concat(ctx.normalizeModifiers(modifiers));
        total = rolls.reduce((a, b) => a + b, 0) + mods.reduce((a, m) => a + m.value, 0);
      }
      const rec = {
        id: c.userId + '-' + Date.now() + '-' + ctx.randomInt(1e6),
        who: c.userId, whoName: c.userName || c.userId,
        label: (typeof label === 'string' && label.trim()) ? label.trim().slice(0, 120) : null,
        spec: `${parsed.count}d${parsed.sides}${parsed.mod ? (parsed.mod > 0 ? '+' + parsed.mod : String(parsed.mod)) : ''}`,
        rolls, modifiers: mods, total, target: tgt,
        success: tgt === null ? null : total >= tgt,
        entry: (manualTotal !== null && manualTotal !== undefined) ? 'manual' : 'rolled',
        ts: Date.now(),
      };
      // Written through handleOp with a lifted role so the roll log inherits the X6 rate limit and the
      // op-log attribution, exactly like the `/gm` aside. The sender's userId is preserved.
      ctx.handleOp(c, { path: 'rolls/' + rec.id, verb: 'set', value: rec }, { userId: c.userId, role: 'system' });
      // Representation 2, for humans, DERIVED from the record above.
      for (const sock of ctx.conns.keys()) ctx.send(sock, { t: 'roll', roll: rec, line: ctx.rollLine(rec) });
      ctx.log.info('roll', rec.entry, { who: rec.who, spec: rec.spec, total: rec.total, target: rec.target, success: rec.success });
      return { ok: true, roll: rec };
    }

  function parseRollCommand(rest) {
      const toks = String(rest || '').trim().split(/\s+/).filter(Boolean);
      if (!toks.length) return null;
      const out = { spec: toks.shift(), target: null, manualTotal: null, label: null };
      if (toks.length && /^-?\d+$/.test(toks[0])) out.target = Number(toks.shift());
      if (toks.length && toks[0] === '=') { toks.shift(); if (toks.length && /^-?\d+$/.test(toks[0])) out.manualTotal = Number(toks.shift()); else return null; }
      else if (toks.length && /^=-?\d+$/.test(toks[0])) out.manualTotal = Number(toks.shift().slice(1));
      if (toks.length) out.label = toks.join(' ');
      return out;
    }

  function handleControl(c, m, ws) {
      // ── Plan 0522 P14 — `set_station` IS DISPATCHED BEFORE THE BLANKET ROLE CHECK, DELIBERATELY ──
      // It is this batch's one privilege escalation, and its gate lives in exactly ONE place:
      // `api.stationSet`, which this frame and the MCP tool both funnel through. Checking the role
      // here as well would put the decision in two places — and the surface that was checked here
      // would then be gated by a rule the MCP surface never runs, which is the I1 (surface parity)
      // failure this phase exists to prevent. It also lets the refusal carry a REASON back to the
      // caller (I5): the blanket drop below answers nothing at all, and a refusal that says nothing
      // is indistinguishable from a refusal that never happened.
      if (m.action === 'set_station') {
        const sa = m.args || {};
        const r = ctx.api.stationSet(sa.userId, sa.stationUid, c);
        ctx.send(ws, Object.assign({ t: 'station-set' }, r));
        ctx.log.info('control', 'set_station', { socketId: c.id, role: c.role, ok: r.ok, reason: r.reason || null });
        return;
      }
      if (c.role !== 'presenter' && c.role !== 'ai') { ctx.log.warn('control', 'denied', { socketId: c.id, role: c.role }); return; }
      const a = m.args || {};
      switch (m.action) {
        // PRIM-mirror (MON-2): render the TARGET user's current display in the target's
        // OWN context, then PUSH it back to THIS requesting control client (fire-and-forget,
        // not a reply). Lets the GM thumbnail "what that user sees". OPSEC: role-gated above.
        // Plan 0522 P5 — mirror answers for ANY target the unified selector can hold, not only a
        // userId: `{target:'station:3'}` renders what somebody sitting at that station is really
        // being shown. `{userId:…}` still works and is still echoed back verbatim — MON-2's client
        // and PRIM-mirror both address it that way, and an unknown/absent target still answers
        // html:null rather than inventing a plausible screen.
        case 'mirror': {
          const tgt = a.target != null ? String(a.target) : (a.userId != null ? String(a.userId) : null);
          const tc = ctx.liveConnForTarget(tgt);   // A4: one representative socket — mirror returns ONE html
          const desc = (tc && (ctx.displayByUser.get(tc.userId) || ctx.displayByRole[tc.role])) || null;
          const html = (desc && tc) ? ctx.descToHtml(tc, desc) : null;
          // Plan 0522 P14 — SAY WHICH SOCKET ANSWERED. P3 collapsed the roster to one row per
          // PERSON, so a contested seat (two live sockets, one derived identity) is one row with
          // two clients behind it, and `liveConnForTarget` silently picks the latest. Mirror is the
          // one row action that is inherently SOCKET-scoped (A4: it returns ONE html), so it now
          // reports the socketId it actually rendered rather than leaving the operator to assume.
          ctx.send(ws, { t: 'mirror', target: tgt, userId: a.userId != null ? a.userId : (tc ? tc.userId : null), socketId: tc ? tc.id : null, html });
          break;
        }
        // Plan 0522 P14 — SPOTLIGHT from the roster row. api.spotlight has existed since 0508 with
        // no button on any human surface: the grant was reachable only from MCP, so a GM without an
        // AI in the loop could not let a player share their station at all. IDENTITY-scoped by
        // construction — the grant set is keyed by userId — so it reaches every socket that identity
        // holds, which is the correct behaviour for a capability that belongs to a person.
        case 'spotlight': ctx.send(ws, Object.assign({ t: 'spotlight' }, ctx.api.spotlight(a.userId, a.granted !== false))); break;
        // Plan 0522 P15 — ▣ project a station's screen to the room. CONTROLLER-ONLY by
        // construction: every case in this switch is already past the role gate above, and unlike
        // `set_station` (which is reachable from MCP with an arbitrary userId and therefore needs
        // its own gate inside api.stationSet) this capability exists on exactly one surface.
        // TRANSIENT: it writes no seat — see projectStation's header for why that is load-bearing.
        case 'project_station':
          ctx.send(ws, Object.assign({ t: 'station-project' }, ctx.projectStation(a.stationUid, a.targets)));
          break;
        // Bell as a control: playable from the control page (🔔) and the verify-watching
        // path (👁 = bell + requireAck) via the SAME api.chime method the MCP tools drive.
        case 'bell': ctx.api.chime(a); break;
        case 'push_component': ctx.api.pushComponent(a.target || 'all', a.component, a.opts || {}, a.theme || 'argus', a.requires || []); break;
        case 'open_poll': ctx.api.openPoll(a); break;
        case 'close_poll': ctx.api.closePoll(a.promptId); break;
        case 'reload_clients': ctx.api.reloadClients(a.target || 'all', a.delay || 0); break;
        case 'clear': ctx.dropStaging(c); ctx.api.clear(a.target || 'all'); break;   // route through api.clear so display descriptor is also reset (reconnect → branding)
        // MON-1: drop a user's per-user override so they follow their ROLE/default display
        // again (or branding if the role has none). DISTINCT from clear(): clear BLANKS to
        // branding; reset_user RETARGETS to the role display. Role-gated above.
        case 'reset_user': {
          const uid = a.userId;
          ctx.displayByUser.delete(uid);
          // A4: retarget EVERY socket this person holds — resetting only one leaves the other stale.
          for (const tws of ctx.socketsFor(uid)) {
            const tc = ctx.conns.get(tws);
            if (!tc) continue;
            const desc = ctx.displayByRole[tc.role];
            if (desc) ctx.renderDisplay(tws, tc, desc); else ctx.send(tws, { t: 'clear' });
          }
          ctx.pushPresence();
          break;
        }
        case 'op': ctx.handleOp(c, { path: a.path, verb: a.verb, value: a.value, opId: a.opId }); break;   // drive an op as the presenter
        // ATT (Plan 0466, decision 1): presenter toggles whether attendees may see the roster.
        case 'set_roster_visible': ctx.rosterVisibleToAttendees = !!a.value; ctx.log.info('att', 'roster-visible', { value: ctx.rosterVisibleToAttendees }); break;
        case 'voice_enable': ctx.api.voiceEnable(a.target || 'all'); break;   // Plan 0470: request inbound voice on a target
        case 'set_module': ctx.api.setModule(a.module || { beats: a.beats || [] }); break;   // Group I
        case 'show_beat': ctx.dropStaging(c); ctx.api.showBeat(a.id != null ? a.id : (a.index | 0)); break;   // by id (branch nav) or index — R4: PUBLISHES, unchanged
        // Plan 0522 P4 (R4) — two-stage delivery. STAGE renders a candidate to THIS controller's
        // own surface (per-caller: keyed by socket, so a second controller is untouched — t09) and
        // writes nothing durable (t07). SEND publishes it and ACKS with the recipient count, so
        // "sent to 0 recipients" cannot be silent (I5). Both ack; the UI lands in P5/P6.
        case 'stage_beat': {
          const ref = a.id != null ? a.id : (a.index != null ? (a.index | 0) : null);
          // P5: the SAME `targets` array the send will carry. One control, one target — a candidate
          // is previewed as the audience it is about to reach, never as the presenter (t11).
          ctx.send(ws, Object.assign({ t: 'staged' }, ctx.api.stageBeat(ref, { key: ctx.callerKey(c), ws, conn: c, targets: a.targets })));
          break;
        }
        case 'send_beat':
          ctx.send(ws, Object.assign({ t: 'sent' }, ctx.api.sendBeat({ targets: a.targets, id: a.id, index: a.index }, { key: ctx.callerKey(c) })));
          break;
        // Plan 0522 P6 — a controller that PUBLISHES something else disarms its own staged
        // candidate. Without this the server slot stays armed while the page has moved on, and
        // `stagedBeat()` reports a candidate the operator no longer believes in — the same
        // instrument-lying-about-state failure the indicator exists to remove.
        case 'show_default': ctx.dropStaging(c); ctx.api.showDefault(); break;   // DEF-1: Home → module title page (or branding fallback)
        case 'next_beat': ctx.dropStaging(c); ctx.api.nextBeat(); break;
        case 'prev_beat': ctx.dropStaging(c); ctx.api.prevBeat(); break;
        case 'append_beat': ctx.api.appendBeat(a.beat || { component: a.component, opts: a.opts, requires: a.requires }); break;   // compose (I2) + AI co-author (I3)
        case 'load_module': ctx.api.loadModule(a.module); break;   // I4
        default: ctx.log.warn('control', 'unknown-action', { action: m.action });
      }
      ctx.log.info('control', m.action, { socketId: c.id });
    }

  function peekTo(ws, c, surfaceUid) {
      const r = ctx.resolveSurface(surfaceUid, c);
      if (!r.ok) return r;
      ctx.renderDisplay(ws, c, r.descriptor);
      c.lastActive = Date.now();
      ctx.log.info('surface', 'peeked', { userId: c.userId, surfaceUid: r.surfaceUid });
      return r;
    }

  function unpeekTo(ws, c) {
      const desc = ctx.redisplayFor(ws, c);
      c.lastActive = Date.now();
      ctx.log.info('surface', 'unpeeked', { userId: c.userId, restored: !!desc });
      return { ok: true, unpeeked: true, restored: !!desc };
    }

  function shimAnswer(c, r) {
      if (r.type !== 'answer' || r.promptId == null) return;
      const pid = r.promptId;
      const poll = ctx.polls.get(pid);
      if (poll) {
        if (!poll.open) return;   // closed -> denied
        const res = ctx.serverApply({ path: 'polls/' + pid + '/votes/' + c.userId, verb: 'set', value: r.value }, { userId: c.userId, role: c.role });
        if (res && res.diff) {
          ctx.emit('poll', { type: 'update', promptId: pid, ...ctx.tally(pid) });   // controllers (presenter/ai) get raw vote diffs (override) → live poll-results
          // Plan 0471 D1: raw per-user votes are ALWAYS controller-only (C3 default-deny). The
          // AGGREGATE tally is what resultsMode governs. 'all' (public) → publish counts-only to a
          // readable slice so EVERYONE gets the aggregate (never per-user rows). 'control' (default,
          // private) → skip it; only controllers see the tally.
          if (poll.resultsMode === 'all') { const t = ctx.tally(pid); ctx.serverApply({ path: 'polls/' + pid + '/results', verb: 'set', value: { tally: t.tally, count: t.count } }); }
        }
      } else {
        ctx.serverApply({ path: 'answers/' + pid + '/' + c.userId, verb: 'set', value: r.value }, { userId: c.userId, role: c.role });
      }
    }

  function voiceSegStart(c, ws, m) {
      if (!c) return;
      // Plan 0472 P4: a GUEST may open a voice segment ONLY if its capability scope includes 'speak'
      // (token-signed; not client-widenable). Surface the refusal (never silent). Non-guests unaffected.
      if (c.isGuest && !(c.capScope || []).includes('speak')) { ctx.log.warn('cap', 'speak-out-of-scope', { socketId: c.id }); ctx.send(ws, { t: 'voice_rejected', reason: 'not permitted' }); return; }
      // Plan 0473 P6 — PROACTIVE floor gate: under HOLD (overload) refuse a NEW segment AT THE SOURCE and
      // tell the speaker to hold, instead of accepting audio only to shed it downstream. No-op when the
      // floor is disabled (solo wearable) — so existing single-speaker voice behaviour is unchanged.
      if (ctx.floorGated()) { ctx.log.info('floor', 'gated-seg-start', { socketId: c.id, userId: c.userId }); ctx.send(ws, { t: 'floor', state: 'hold', gated: true }); return; }
      if (!c.voice) c.voice = { active: false, seq: 0, chunks: [], bytes: 0, startedAt: 0, timer: null, tokens: ctx.VOICE_TB_CAPACITY, lastRefill: Date.now() };
      const v = c.voice;
      if (v.active) { if (v.timer) clearTimeout(v.timer); v.active = false; ctx.voiceSessions = Math.max(0, ctx.voiceSessions - 1); v.chunks = []; v.bytes = 0; }   // drop a stray-open prior segment
      if (ctx.voiceSessions >= ctx.VOICE_MAX_SESSIONS) {   // RT-22: reject over cap, with a surfaced reason
        ctx.log.warn('voice', 'sessions-cap', { socketId: c.id, cap: ctx.VOICE_MAX_SESSIONS });
        ctx.send(ws, { t: 'voice_rejected', reason: 'server voice capacity reached' });
        return;
      }
      ctx.ensureAsr();   // RT-25: warm the recognizer now, so the first utterance doesn't eat the model load
      v.active = true; v.seq = (typeof m.seq === 'number' ? m.seq : v.seq + 1); v.chunks = []; v.bytes = 0; v.startedAt = Date.now();
      v.tokens = ctx.VOICE_TB_CAPACITY; v.lastRefill = Date.now();   // F1: full-capacity bucket per segment
      ctx.voiceSessions++;
      ctx.voiceArmTimeout(c, ws);
      ctx.evaluateFloor();   // Plan 0473 P6: a new active speaker changes the load — reassess the floor
      // Plan 0473 P13: BARGE-IN at the SOURCE — a user OPENING a voice segment while the agent's TTS reply
      // is playing is an interruption. Fire the duck/stop cue + clear speaking now (before the utterance is
      // even transcribed); the segment proceeds to capture, so the interrupting speech is still recorded.
      ctx.maybeBargeIn({ userId: c.userId, userName: c.userName, role: c.role, seq: null }, false);
      ctx.log.info('voice', 'seg-start', { socketId: c.id, userId: c.userId, seq: v.seq, sessions: ctx.voiceSessions });
    }
  const wireActions = new Map();

  wireActions.set("pvs_subscribe", ({ m, c, ws, req }) => {
      // Become a SUBSCRIBER: leave the participant set (no roster/floor/backpressure weight, cannot
      // send ops). Share the namespaced delivery cursor (R2); replay the unread backlog from it (R1),
      // then stream live. If no PVS baseline exists yet, baseline at the live seq (don't flood).
      const key = ctx.pvsConsumerKey(m.consumer || 'argusmon');
      const cc = ctx.conns.get(ws); if (cc && cc.userId) ctx.unbindUser(cc.userId, ws);
      ctx.conns.delete(ws); ctx.updateChatListeners(); ctx.emit('presence', ctx.presence()); ctx.evaluateFloor();
      if (!ctx.situationCursors.has(key)) ctx.situationCursors.set(key, ctx.inboxSeq);
      const from = ctx.situationCursors.get(key);
      ctx.pvsSubscribers.set(ws, { consumer: key });
      ctx.send(ws, { t: 'pvs_subscribed', consumer: key, resumeCursor: from, mode: ctx.commsMode });
      for (const it of ctx.inbox.filter((i) => i.seq > from)) ctx.deliverTurnToSub(ws, ctx.pvsSubscribers.get(ws), it);   // replay
      ctx.log.info('pvs', 'subscribe', { consumer: key, resumeFrom: from });
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
        if (ctx.CAP_SECRET) {
          try {
            const v = ctx.verifyCapability(m.cap, ctx.CAP_SECRET, { now: Date.now(), isRevoked: (n) => ctx.revokedNonces.has(n) });
            if (v.ok) capGrant = v.payload;
            else ctx.log.warn('cap', 'invalid-capability', { socketId: c.id });   // GENERIC: no reason, no secret material
          } catch (e) { ctx.log.warn('cap', 'invalid-capability', { socketId: c.id }); }   // never let a bad token crash the conn
        } else {
          ctx.log.warn('cap', 'capability-disabled', { socketId: c.id });   // links disabled: no secret configured
        }
      }
      // Plan 0482 A2: role + userId are decided in EXACTLY ONE function (resolveIdentity,
      // the identity seam). Guest/control/gm/unknown-role policy all live there; this call
      // site only applies the verdict.
      // Plan 0543 P3 — the AUTH CONTEXT (loopback verdict + any verified principal) is read from the
      // upgrade request `req`, then fed to BOTH decisions: resolveIdentity (the control-page ROLE)
      // and deriveConnTrust (command TRUST). This is where 0543 keeps "role" and "authority" separate.
      const authCtx = ctx.computeAuthCtx(req);
      const ident = resolveIdentity(m, capGrant, c.id, authCtx);
      c.userId = ident.userId;
      c.userName = ident.userName;
      c.role = ident.role;
      if (ident.isGuest) { c.isGuest = true; c.capScope = ident.capScope; c.capNonce = ident.capNonce; }
      // The SERVER-AUTHORITATIVE command-trust for this connection. Stamped on every turn this
      // connection emits (chat/voice) so the fence delimits it correctly. NEVER from the password.
      const trustVerdict = ctx.deriveConnTrust(ident, capGrant, authCtx);
      c.trust = trustVerdict.trust;
      // ⭐ Decided ONCE, at hello, from the verified identity — never re-derived from a client claim.
      c.voiceAllowed = ctx.voiceAllowedFor(req);
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
      if (ctx.stationsActive()) {
        try { seat = ctx.seatResolver.select(c.userId, ident.stationUid != null ? ident.stationUid : ctx.stationRegistry.defaultUid); }
        catch (e) { ctx.log.warn('station', 'resolver-select-failed', { userId: c.userId, err: String(e && e.message || e) }); }
      }
      // Plan 0514 §8: the registry, this seat's station and its spotlight grant all ride the
      // welcome, so a client rebuilds its selector AND RESTORES ITS OWN STATE ON RECONNECT —
      // the 0508 D1 class of bug, designed out rather than patched.
      ctx.send(ws, { t: 'welcome', userId: c.userId, userName: c.userName, socketId: c.id, role: c.role, transcriptPersisting: ctx.TRANSCRIPT_PERSIST,
        // Plan 0543 P3 — the client learns its COMMAND-TRUST (distinct from role): whether its words
        // may become an instruction. `authReason` explains a fenced verdict ("signed in, not
        // authorized" — the E/C dead-end fix); `reauth:true` asks a lapsed session to re-authenticate
        // rather than being silently downgraded (the A fix).
        trust: c.trust, ...(c.trustReason ? { authReason: c.trustReason } : {}), ...(c.reauth ? { reauth: true } : {}),
        ...(c.isGuest ? { guest: true, scope: c.capScope } : {}),
        ...(ctx.stationsActive() ? {
          stationRegistry: ctx.stationRegistry.wire(),
          stationSelectorLabel: ctx.stationRegistry.selectorLabel,
          stationUid: seat && seat.uid != null ? seat.uid : ctx.stationRegistry.defaultUid,
          spotlightGranted: ctx.spotlight.has(c.userId),
        } : {}),
        // Plan 0526 P4 — the surfaces this viewer may call up, so a client can OFFER them
        // without asking. Wire form only: uid + label + flags, never a plugin's file layout and
        // never the author's `surfaceId`. Absent entirely when no plugin declared any, so a
        // deployment that has never heard of surfaces sees no change in its welcome at all.
        ...(ctx.surfacesActive() ? { surfaceRegistry: ctx.surfaceRegistry.wire() } : {}) });
      // C4/X1: converge the (re)connecting client. If it reports a lastVersion we
      // can still replay from the op-log, send only the MISSED ops (resync);
      // otherwise a full role-filtered snapshot (Memento).
      resyncOrSnapshot(ws, c, m.lastVersion);
      /* Plan 0539 P2.3 — from HERE on, live broadcasts are purely additive: the client's state is
       * caught up to `store.version()`, so anything arriving next is genuinely new.
       *
       * ⛓ WHERE THIS MAY GO, MEASURED RATHER THAN ASSUMED. The binding constraint is that it sit
       * AFTER THE CONNECT-TIME STORE WRITES — today the station-seat write ~20 lines above
       * (`seatResolver.select` → `occupancy.seat`). Break-tested three ways:
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
      ctx.redisplayFor(ws, c);   // C6: re-push the currently-displayed content module
      if (everSeen.has(c.userId)) ctx.telem.reconnects++; else { everSeen.add(c.userId); everSeenOrder.push(c.userId); if (everSeenOrder.length > EVER_SEEN_MAX) everSeen.delete(everSeenOrder.shift()); }   // Plan 0471 L2: bounded
      ctx.send(ws, { t: 'ping', ts: Date.now() });   // X3 RTT probe
      ctx.log.info('conn', 'hello', { socketId: c.id, userId: c.userId, role: c.role, lastVersion: m.lastVersion || 0 });
      ctx.updateChatListeners();   // P3
      ctx.emit('presence', ctx.presence()); ctx.pushPresence();
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
      ctx.emit('result', r);     // map view/click/pointer are store ops now (E1-E4) — no relay
      // PRIM-results: track last result per prompt and forward to CONTROL roles ONLY (OPSEC:
      // presenter/ai — participants must NEVER receive a peer's answer/continue).
      // Auditor: only meaningful results (answer/continue) — drop lifecycle events (ready/step/change/
      // flow-complete) that carry the SAME promptId and would false-trigger DEL-2 branch nav (S190 gotcha).
      if (r.promptId != null && (r.type === 'answer' || r.type === 'continue')) {
        // Plan 0471 M3: this path bypasses store.validOp, so enforce the 64KB value cap here,
        // and bound lastResults to LAST_RESULTS_MAX distinct promptIds (FIFO evict).
        let vsize = 0; try { vsize = JSON.stringify(r.value === undefined ? null : r.value).length; } catch { vsize = Infinity; }
        if (vsize > ctx.MAX_VALUE_BYTES) {
          ctx.log.warn('result', 'value-too-large', { promptId: r.promptId, userId: r.userId, bytes: vsize });
        } else {
          if (!ctx.lastResults[r.promptId]) {
            ctx.lastResults[r.promptId] = {};
            lastResultsOrder.push(r.promptId);
            while (lastResultsOrder.length > LAST_RESULTS_MAX) { const old = lastResultsOrder.shift(); delete ctx.lastResults[old]; }
          }
          ctx.lastResults[r.promptId][r.userId] = { type: r.type, value: r.value };
          pushResult(r);
        }
      }
  });

  wireActions.set("op", ({ m, c, ws, req }) => {
      ctx.handleOp(c, m);
  });

  wireActions.set("control", ({ m, c, ws, req }) => {
      handleControl(c, m, ws);
  });

  wireActions.set("pong", ({ m, c, ws, req }) => {
      if (typeof m.ts === 'number') { const rtt = Date.now() - m.ts; ctx.telem.rtt.last = rtt; ctx.telem.rtt.sum += rtt; ctx.telem.rtt.count++; }
  });

  wireActions.set("telemetry", ({ m, c, ws, req }) => {
      if (m.kind === 'render-error') ctx.telem.renderErrors++;
      else if (m.kind === 'op-apply-failure') ctx.telem.opApplyFailures++;
      else if (m.kind === 'rtt' && typeof m.value === 'number') { ctx.telem.rtt.last = m.value; ctx.telem.rtt.sum += m.value; ctx.telem.rtt.count++; }
  });

  wireActions.set("request-poll", ({ m, c, ws, req }) => {
      ctx.emit('poll', { type: 'request', from: { userId: c.userId, userName: c.userName }, spec: m.spec });
  });

  wireActions.set("ack", ({ m, c, ws, req }) => {
      // Eyes-on acknowledgement: the viewer clicked CONFIRM on a requireAck chime.
      // Plan 0471 M2: ONLY an OUTSTANDING chime (created by api.chime requireAck) accepts an
      // ack. An unknown/attacker-chosen ackId is dropped — it no longer creates a map entry,
      // so the `acks` map can't be grown by unauth {t:'ack'} frames.
      const ackId = (m && m.ackId) || 'ready';
      const a = ctx.acks.get(ackId);
      if (!a) { ctx.log.debug('ack', 'unknown-ackId', { socketId: c.id, ackId }); return; }
      c.eyesOn = Date.now();                              // this connection is confirmed watching (not AFK)
      c.lastActive = Date.now();                          // ATT: eyes-on CONFIRM click = deliberate interaction
      a.by.set(c.userId, { userName: c.userName, at: c.eyesOn });
      ctx.log.info('ack', 'eyes-on', { ackId, userId: c.userId });
      ctx.pushPresence();                                    // control user-list reflects eyes-on immediately
      // ── ⛓ THE SIX MESSAGES THAT PUT SOMETHING ON A SCREEN (0526 P4's naming seam) ─────────
      // Rule zero says a name means one thing, and this chain now holds six verbs that all end
      // in "somebody sees something". They are NOT synonyms; each answers a different question,
      // and the next person to add a seventh should have to say which of these it is not:
      //
      //   station-select  WRITES the caller's seat (seatResolver.select), then renders it.
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
      if (!ctx.stationsActive()) { ctx.send(ws, { t: 'station', ok: false, reason: 'no-stations' }); }
      else {
        let seat = null;
        try { seat = ctx.seatResolver.select(c.userId, m.stationUid); }
        catch (e) { ctx.log.warn('station', 'resolver-select-failed', { userId: c.userId, err: String(e && e.message || e) }); }
        // Unknown/absent uid ⇒ the plugin answered with the deployment default. Never a throw,
        // never a disconnect — §5's single failure rule, applied on the wire.
        if (!seat) ctx.send(ws, { t: 'station', ok: false, reason: 'no-stations' });
        else {
          ctx.renderStationTo(ws, c, seat);
          c.lastActive = Date.now();
          ctx.send(ws, { t: 'station', ok: true, stationUid: seat.uid });
          ctx.log.info('station', 'selected', { userId: c.userId, stationUid: seat.uid });
          ctx.pushPresence();
        }
      }
  });

  wireActions.set("station-default", ({ m, c, ws, req }) => {
      // Plan 0514 §7 — ⟲ Show default. Idle branding for THIS socket only; displayByUser is
      // untouched, so `▣ My station screen` still works afterwards. Deliberately NOT
      // api.showDefault / default branding — those are controller-scoped and clear the stored
      // descriptor for everyone.
      ctx.send(ws, { t: 'clear' });
      c.lastActive = Date.now();
      ctx.send(ws, { t: 'station', ok: true, defaulted: true });
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
      if (ctx.stationsActive()) {
        const seat = ctx.seatStation(c.userId);
        if (seat) { ctx.renderStationTo(ws, c, seat); c.lastActive = Date.now(); }
        else ctx.send(ws, { t: 'station', ok: false, reason: 'no-station' });
      } else {
        const desc = ctx.displayByUser.get(c.userId);
        if (desc) { ctx.renderDisplay(ws, c, desc); c.lastActive = Date.now(); }
        else ctx.send(ws, { t: 'station', ok: false, reason: 'no-station' });
      }
  });

  wireActions.set("station-share", ({ m, c, ws, req }) => {
      // Plan 0508 — SPOTLIGHT. Promote the caller's OWN station display to everyone. This IS an
      // escalation (a participant changing what the room sees), so it is default-DENY and must be
      // granted per-user by a controller (api.spotlight). Throttled: one share per 3 s per user.
      // Plan 0514 §6.2: the grant model, the throttle and the targets are UNCHANGED — only the
      // SOURCE moved, from displayByUser to the seat's station. Two lines, inside an existing
      // handler; not a new sharing subsystem.
      const seatForShare = ctx.stationsActive() ? ctx.seatStation(c.userId) : null;
      const desc = seatForShare
        ? ((seatForShare.descriptor) || ctx.stationPlaceholder(seatForShare.uid, c))
        : ctx.displayByUser.get(c.userId);
      if (!ctx.spotlight.has(c.userId)) { ctx.send(ws, { t: 'station', ok: false, reason: 'not-granted' }); ctx.log.warn('station', 'share-denied', { userId: c.userId }); }
      else if (!desc) ctx.send(ws, { t: 'station', ok: false, reason: 'no-station' });
      else if (Date.now() - (ctx.spotlightLast.get(c.userId) || 0) < 3000) ctx.send(ws, { t: 'station', ok: false, reason: 'too-fast' });
      else {
        ctx.spotlightLast.set(c.userId, Date.now());
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
        if (desc.kind === 'component') for (const t of ctx.targets(tgt)) { ctx.sendComponentTo(t, ctx.conns.get(t), desc); n++; }
        ctx.log.info('station', 'shared', { userId: c.userId, target: tgt, to: n, component: desc.component });
        ctx.send(ws, { t: 'station', ok: true, shared: n });
        ctx.emit('presence', ctx.presence());
      }
  });

  wireActions.set("peek", ({ m, c, ws, req }) => {
      // Plan 0526 P4 — SELF-SERVICE NAVIGATION. A participant calls up a declared surface on
      // their own screen. Self-scoped and ungated by the same zero-privilege argument as
      // station-show; DEFAULT-DENY on the surface row is what decides whether they may.
      // ⛓ THE WIRE TAKES A UID: {t:'peek', surfaceUid:<int>} (canon §3 — the author's
      // `surfaceId` never reaches this line). A refusal always names its reason.
      const peeked = peekTo(ws, c, m.surfaceUid);
      if (peeked.ok) ctx.send(ws, { t: 'surface', ok: true, surfaceUid: peeked.surfaceUid, surfaceLabel: peeked.surfaceLabel, hasScreen: peeked.hasScreen });
      else ctx.send(ws, { t: 'surface', ok: false, reason: peeked.reason, surfaceUid: peeked.surfaceUid == null ? null : peeked.surfaceUid, ...(peeked.surfaceLabel ? { surfaceLabel: peeked.surfaceLabel } : {}) });
  });

  wireActions.set("unpeek", ({ m, c, ws, req }) => {
      // Plan 0526 P4 — BACK TO THE ROOM. Renders the room's CURRENT display to this socket, so
      // a beat that moved during the peek is the beat the viewer rejoins (see unpeekTo).
      // Stateless: always safe to send, even when the caller was not peeking.
      const back = unpeekTo(ws, c);
      ctx.send(ws, { t: 'surface', ok: true, surfaceUid: null, unpeeked: true, restored: back.restored });
  });

  wireActions.set("attendance-request", ({ m, c, ws, req }) => {
      // ATT (Plan 0466 §2.5): request/reply — NO standing push. Redaction is SERVER-SIDE,
      // keyed on the CONNECTION's authoritative role. Control/ai always get the full roster;
      // a participant gets the redacted roster ONLY when the presenter gate is ON, else self-only.
      const control = (c.role === 'presenter' || c.role === 'ai');
      // Plan 0468: no activity thresholds — connection liveness only. Pass optional staleMs; else default.
      if (control) {
        const att = ctx.api.attendance({ staleMs: m.staleMs, viewerRole: c.role });
        ctx.send(ws, { t: 'attendance', roster: att.roster, summary: att.summary, rosterVisible: ctx.rosterVisibleToAttendees });
      } else if (ctx.rosterVisibleToAttendees) {
        const att = ctx.api.attendance({ staleMs: m.staleMs, viewerRole: 'participant' });
        ctx.send(ws, { t: 'attendance', roster: att.roster, summary: att.summary });
      } else {
        // gate OFF ⇒ deny = self-only (decision 1). Reuse the redacted build, filter to self.
        const att = ctx.api.attendance({ staleMs: m.staleMs, viewerRole: 'participant' });
        const self = att.roster.filter((r) => r.userId === c.userId);
        const summary = {
          connected: self.filter((r) => r.connected).length,
          offline: self.filter((r) => !r.connected).length,
          eyesOn: self.filter((r) => r.eyesOn).length,
          total: self.length,
        };
        ctx.send(ws, { t: 'attendance', roster: self, summary });
      }
  });

  wireActions.set("voice_seg_start", ({ m, c, ws, req }) => {
      // Plan 0470: control frame bracketing an utterance (binary PCM follows on the same conn).
      /* ⛔⛔ THE REAL GATE IS HERE, NOT IN THE PAGE. Stripping the microphone button from the HTML
       *   stops a person clicking it and stops nobody from sending the frame — a client is not a
       *   security boundary and never was. A connection without the capability is refused BY NAME,
       *   so the refusal is visible in the log rather than looking like a microphone that failed. */
      if (!c || c.voiceAllowed !== true) {
        ctx.log.warn('voice', 'seg-start-denied', { socketId: c && c.id, userId: c && c.userId, trust: c && c.trust });
        ctx.send(ws, { t: 'voice_denied', reason: 'voice is granted per user, to signed-in accounts only' });
      } else voiceSegStart(c, ws, m);
  });

  wireActions.set("voice_seg_end", ({ m, c, ws, req }) => {
      ctx.voiceSegFinalize(c, ws, {});   // finalize -> WAV -> WARM ASR -> transcript out
  });

  wireActions.set("voicedbg", ({ m, c, ws, req }) => {
      // Plan 0476 P1: client voice stage-tracer (S1..S10 + level meter). Logs to the voice-debug ring
      // (visible via presenter_debug) — NEVER the inbox/transcript, so the transcript + echo line stay
      // clean. Untrusted client content is confined to a bounded log field.
      if (m && typeof m.tag === 'string') ctx.log.info('voicedbg', m.tag.slice(0, 48), { socketId: c && c.id, ...(m.data && typeof m.data === 'object' ? m.data : {}) });
  });

  wireActions.set("roll", ({ m, c, ws, req }) => {
      // Plan 0537 P3.2 — the wire form: {t:'roll', spec, target?, label?, total?}. `total` is the
      // MANUAL entry (physical dice, typed in) and is the only number a client may contribute —
      // it is recorded as `entry:'manual'` so the log can always tell a roll from a claim.
      if (c && c.isGuest && !(c.capScope || []).includes('type')) { ctx.log.warn('cap', 'roll-out-of-scope', { socketId: c.id }); return; }
      if (c) {
        // Plan 0539 P1.7 — labelled modifiers are CONTROLLER-ONLY on the wire. A participant may
        // still ask for `+2` through the spec (it is part of the request, like the target), but it
        // may not attach a REASON to a number: a skill name appearing in the room's log as though
        // the session had established it is an assertion, and 0537's rule is that the client asks
        // and the server answers. The skill-aware caller this field exists for is a plugin/agent,
        // which holds a control role. A participant's `modifiers` are dropped, not refused —
        // the roll itself is perfectly valid without them.
        const supplied = ctx.CONTROL_ROLES.has(c.role) ? m.modifiers : null;
        const res = doRoll(c, { spec: m.spec, target: m.target, label: m.label, manualTotal: m.total, modifiers: supplied });
        if (!res.ok) ctx.send(ws, { t: 'roll_refused', reason: res.reason, text: 'expected {spec:"<count>d<sides>[+mod]", target?, label?, total?}' });
      }
  });

  wireActions.set("chat", ({ m, c, ws, req }) => {
      // Plan 0472: typed text is FIRST-CLASS input. Land it in the unified inbox attributed to the
      // SERVER-AUTHORITATIVE connection identity (never the client payload). D5 = DUAL-WRITE: also
      // drive the chat STORE slice so the existing read-perm'd chat display (P3) keeps working.
      // Plan 0472 P4: a GUEST may type ONLY if its capability scope includes 'type' (the scope is
      // token-signed, so it cannot be widened by the client). Non-guests are unaffected.
      if (c && c.isGuest && !(c.capScope || []).includes('type')) { ctx.log.warn('cap', 'type-out-of-scope', { socketId: c.id }); return; }
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
          if (!body) { ctx.send(ws, { t: 'chat_private', ok: false, reason: 'empty', text: '' }); return; }
          const asideTs = Date.now();
          ctx.emitInbox({ kind: 'text', userId: c.userId, userName: c.userName, role: c.role, text: body, conf: null, final: true, isGuest: !!c.isGuest, private: true, trust: c.trust });
          ctx.handleOp(c, { path: 'gm/asides/' + id, verb: 'set', value: { id, text: body, name: c.userName, userId: c.userId, ts: asideTs } },
            { userId: c.userId, role: 'system' });   // sender's id, lifted role — see handleOp
          // Plan 0539 P1.3 — the receipt now carries `id` + `ts`. THE SENDER IS THE ONLY PERSON
          // WHO CANNOT READ THEIR OWN ASIDE: it lives in the controller-only `gm` slice, so a
          // participant's reader has no other source for it. Without an id the sender's log
          // cannot dedupe it against the copy a CONTROLLER does receive over `gm/asides`, and a
          // facilitator would see their own aside twice. Without a ts it cannot be ordered
          // against the room's talk, which is the whole point of showing it at all.
          ctx.send(ws, { t: 'chat_private', ok: true, text: body, id, ts: asideTs, name: c.userName });
          return;
        }
        // Plan 0537 P3 — `/roll …` from the chat input. It routes into the SAME doRoll() the
        // `{t:'roll'}` wire message uses, so there is exactly one place a roll is produced. ⛔ It
        // does NOT also land in `chat`: a roll's record is `rolls`, and duplicating it as prose in
        // the room's talk would create a second, parseable representation of the same event.
        const rollCmd = /^\/roll(?:\s+([\s\S]*))?$/.exec(m.text.trim());
        if (rollCmd) {
          const args = parseRollCommand(rollCmd[1]);
          if (!args) { ctx.send(ws, { t: 'roll_refused', reason: 'usage', text: '/roll <count>d<sides>[+mod] [target] [= total] [label]' }); return; }
          const res = doRoll(c, args);
          if (!res.ok) ctx.send(ws, { t: 'roll_refused', reason: res.reason, text: '/roll <count>d<sides>[+mod] [target] [= total] [label]' });
          return;
        }
        ctx.emitInbox({ kind: 'text', userId: c.userId, userName: c.userName, role: c.role, text: m.text, conf: null, final: true, isGuest: !!c.isGuest, trust: c.trust });
        // Plan 0539 P1.1 — `ts` and `userId` are ADDED to the record, and both are load-bearing for
        // the reader. `chat` is a keyed collection, not a list: a client rebuilding the log from a
        // snapshot gets an OBJECT, whose key order is an implementation detail and not a history.
        // Without a server-stamped `ts` there is nothing to sort by, and "newest at the bottom"
        // becomes "whatever order V8 felt like". `userId` is what lets a reader tell YOUR line from
        // a line by someone who typed the same display name.
        ctx.handleOp(c, { path: 'chat', verb: 'add', value: { id, text: m.text, name: c.userName, userId: c.userId, ts: Date.now() } });   // display slice (best-effort; perm-gated)
      }
  });

  return wireActions;
}
