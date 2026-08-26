/*
 * Argus Presenter — the API SURFACE.
 *
 * Plan 0661 phase 3 (seam S-C). The 89 named members of `const api`, lifted out of
 * `createServer()` in app/server.mjs. This is the third and largest of the app's fuse tables; the
 * other two (`wire-actions.mjs` — 21 wire fuseactions, `http-routes.mjs` — 27 routes) moved first.
 *
 * ⭐ WHY THIS IS A TABLE AND NOT A BLOB. `api` reads as 775 lines of tangle, but it is an object
 *   literal of 89 named members — the same shape as `wireActions`. Median member: ONE line. The mass
 *   sits in six of them (health 74, attendance 36, openPoll 33, raf 33, stationSet 23, stageBeat 23).
 *   Seen as a table it migrates like one.
 *
 * ⛔ EVERY DEPENDENCY IS REACHED THROUGH `M`, and `M`'s properties are ALL GETTERS. 99 names are
 *   needed; 15 of them are `let` bindings that createServer reassigns while the server runs
 *   (ACTIVE_PROFILE, asr, commsMode, contentModule, currentBeat, ephTimer, floorState, inboxSeq,
 *   openTurn, pvs, seatResolver, sheddedCount, speaking, voiceSessions, watcher). Destructuring any
 *   of those would snapshot a value at wiring time and every later read would be stale — a SILENT
 *   behaviour change, not a crash. Rather than track which fifteen, every name is a getter: uniform,
 *   always live, and impossible to get wrong by omission. The cost is one property read per access.
 *
 * ⭐ The rewrite from bare name to `M.<name>` was applied to identifier NODES located by the parser,
 *   never by text search — so a property key, a shorthand, a string or a local binding of the same
 *   name is untouched. Bodies are otherwise byte-identical to the members they came from.
 */

import * as log from './log.mjs';
import { annotate as annotateTrust } from './untrusted.mjs';
import { renderMarkdown } from './markdown.mjs';
import { validate, summarize } from './validate.mjs';
import { mintCapability } from '../lib/capability.mjs';
import { assemble } from '../harness/assemble.mjs';

/**
 * Build the public API surface.
 *
 * @param {object} M  createServer()'s state and helpers, exposed as GETTERS — see the note above.
 * @returns {object}  the 89 public members, ready to be composed by createServer.
 */
export function createApiSurface(M) {
  /* ⭐ NAMED, then returned — six members delegate to their siblings (nextBeat → api.showBeat,
   *   loadModule → api.setModule, and four more). Binding the literal to a local 'api' makes those
   *   references resolve to this very object, exactly as they did when the literal lived in
   *   createServer. No rewrite, no self-reference plumbing, no behavioural difference. */
  const api = {
    url: () => `http://127.0.0.1:${M.httpServer.address().port}`,
    port: () => M.httpServer.address().port,
    authPolicy: () => ({ ...M.AUTH_POLICY }),
    profile: () => M.ACTIVE_PROFILE,
    presence: M.presence,
    on: (ev, cb) => { if (M.listeners[ev]) M.listeners[ev].push(cb); },
    /*
     * ⭐⭐ Plan 0691 — WRITE TO THE SHARED STATE MACHINE, AND TELL EVERYONE.
     *
     * The surface had 94 members and not one of them did this. `store.apply` writes silently —
     * no diff is broadcast, so no connected client ever hears, and a value set that way is
     * invisible until the next full snapshot. `serverApply` (apply + broadcastDiff) existed but
     * stayed internal, reachable only as a side effect of openPoll/setModule. So the server
     * could not move a shared value on purpose, only as a by-product of doing something else.
     *
     * Acts as `system` by default, which OVERRIDES the permission table (app/permissions.mjs) —
     * correct for the server's own writes, and the reason `actor` is a parameter: pass a real
     * {userId, role} to have a write CHECKED as that participant.
     *
     * Returns the store's result ({ diff, version, ... }) or { denied:true } if a supplied actor
     * was refused — never throws on a denial, so a caller can drive a permission test.
     */
    apply(op, actor) {
      const res = M.serverApply(op, actor || { userId: 'server', role: 'system' });
      return res || { denied: true };
    },
    /** Convenience for the overwhelmingly common case: set one path, broadcast, done. */
    set(path, value, actor) { return M.serverApply({ path, verb: 'set', value }, actor || { userId: 'server', role: 'system' }); },
    pushContent(target, html, contentId) {
        M.setDisplay(target, { kind: 'content', html, contentId });
        let n = 0;   // deliveries, not address-book entries — see send()
        for (const ws of M.targets(target)) { if (M.send(ws, { t: 'content', contentId: contentId || null, html })) n++; }
        return n;
      },
    /*
     * ⭐⭐ Plan 0689 R5 — AN AUTHORED PAGE THAT HOSTS COMPONENTS. The composition half of the app's
     * stated purpose: a page can carry a dice check beside a navmap beside a live poll, with the
     * author's own markup around them.
     *
     * ⛔ NOT the same as pushContent, and the difference is the whole point. pushContent sends the
     * caller's bytes VERBATIM — no registry, no component code, no bridge — so a raw page cannot
     * host a component: none of the machinery is on it. This assembles the same bundle a component
     * page gets, PER VIEWER, so identity is stamped and `visibility:'gm'` mounts are dropped
     * server-side rather than merely hidden.
     */
    pushPage(target, html, { mounts = [], opts = {}, theme = 'argus', requires = [], contentId = null } = {}) {
        const desc = { kind: 'page', html: String(html == null ? '' : html), mounts: Array.isArray(mounts) ? mounts : [], opts: opts || {}, theme, requires, contentId };
        M.setDisplay(target, desc);                          // C6: remember for (re)connects
        let count = 0;
        for (const ws of M.targets(target)) { if (M.sendPageTo(ws, M.conns.get(ws), desc)) count++; }
        return count;
      },
    pushComponent(target, component, opts = {}, theme = 'argus', requires = [], deliveredOut = null) {
        const desc = { kind: 'component', component, opts, theme, requires };
        M.setDisplay(target, desc);                          // C6: remember for (re)connects
        let count = 0;
        for (const ws of M.targets(target)) {
          if (M.sendComponentTo(ws, M.conns.get(ws), desc)) { count++; if (deliveredOut) deliveredOut.add(ws); }
        }
        return count;
      },
    openPoll({ promptId, prompt, options, target = 'participant', resultsTarget = null, resultsMode = 'control' }) {
        // Plan 0471 D1: resultsMode 'control' (default, private — matches OPSEC) | 'all' (public aggregate).
        const mode = resultsMode === 'all' ? 'all' : 'control';
        log.info('poll', 'open', { promptId, options: (options || []).length, resultsMode: mode });
        M.polls.set(promptId, { spec: { prompt, options }, open: true, resultsMode: mode });
        // Plan 0482 B4 — RUNTIME idempotency. Opening a poll reseeds spec/open, but the votes
        // subtree used to survive, and tally() reads the store. So rehearse → close → open live
        // on one server process and every prompt started PRE-VOTED with the rehearsal's ballots.
        // Opening a poll is a fresh ballot by definition: clear the votes (and any cached
        // aggregate) FIRST, so the seeded results below and every later tally start from zero.
        M.serverApply({ path: 'polls/' + promptId + '/votes', verb: 'clear' });
        // D1: seed the store so the poll is a first-class state slice.
        M.serverApply({ path: 'polls/' + promptId + '/spec', verb: 'set', value: { prompt, options } });
        M.serverApply({ path: 'polls/' + promptId + '/open', verb: 'set', value: true });
        M.serverApply({ path: 'polls/' + promptId + '/resultsMode', verb: 'set', value: mode });   // controllers act on it (participants: denied, harmless)
        if (mode === 'all') M.serverApply({ path: 'polls/' + promptId + '/results', verb: 'set', value: { tally: {}, count: 0 } });   // seed readable aggregate
        // C6: remember the poll display so late joiners see the choice / live results.
        M.setDisplay(target, { kind: 'poll-choice', promptId });
        // Assemble a per-channel `choice` stamped with that channel's identity.
        for (const ws of M.targets(target)) {
          const c = M.conns.get(ws);
          const html = assemble({ component: 'choice', opts: { prompt, options, promptId, userId: c.userId, userName: c.userName, channel: c.userId } });
          M.send(ws, { t: 'content', contentId: promptId, html });
        }
        // Optionally push a live results display to another target (e.g. presenter).
        // It stays live via store vote diffs (D3) — no bespoke relay.
        if (resultsTarget) {
          M.setDisplay(resultsTarget, { kind: 'poll-results', promptId });
          const html = assemble({ component: 'poll-results', opts: { prompt, options, promptId, count: 0 } });
          for (const ws of M.targets(resultsTarget)) M.send(ws, { t: 'content', contentId: promptId + ':results', html });
        }
        return { promptId, ...M.tally(promptId) };
      },
    getPoll: (promptId) => { const votes = M.store.get('polls/' + promptId + '/votes') || {}; return { promptId, ...M.tally(promptId), votes: Object.keys(votes).map((userId) => ({ userId, value: votes[userId] })) }; },
    reloadClients: (target = 'all', delay = 0) => M.targets(target).map((ws) => M.send(ws, { t: 'reload', delay })).length,
    spotlight(userId, granted = true) {
        if (granted) M.spotlight.add(userId); else { M.spotlight.delete(userId); M.spotlightLast.delete(userId); }
        // Plan 0522 P14 (I5) — how many live clients were told. A grant to somebody not yet
        // connected is legitimate (it rides their `welcome` when they arrive), so 0 is not an
        // error here; it is a fact the operator is entitled to see rather than infer.
        let notified = 0;
        for (const ws of M.socketsFor(userId)) { M.send(ws, { t: 'station', ok: true, granted: !!granted }); notified++; }
        log.info('station', granted ? 'spotlight-granted' : 'spotlight-revoked', { userId, notified });
        M.pushPresence();
        return { userId, granted: !!granted, notified, holders: [...M.spotlight] };
      },
    spotlightHolders: () => [...M.spotlight],
    stations() {
        return {
          stationSelectorLabel: M.stationRegistry.selectorLabel,
          stationDefaultUid: M.stationRegistry.defaultUid,
          stations: M.stationRegistry.wire(),
          seats: M.presence().map((p) => ({ userId: p.userId, userName: p.userName, stationUid: p.stationUid })),
        };
      },
    surfaces() { return { surfaces: M.surfaceRegistry.wire() }; },
    surfaceScreen: (surfaceUid) => M.resolveSurface(surfaceUid, null),
    stationSet(userId, stationUid, actor = M.API_ACTOR) {
        if (!M.isControllerActor(actor)) {
          log.warn('station', 'set-denied', { userId, role: (actor && actor.role) || null, socketId: (actor && actor.id) || null });
          return { userId, stationUid: null, ok: false, reason: 'not-controller', delivered: 0 };
        }
        if (!M.stationsActive()) return { userId, stationUid: null, ok: false, reason: 'no-stations', delivered: 0 };
        // I5 — NO SILENT NON-DELIVERY. Before P14 this returned ok:true for a userId nobody
        // occupies: it wrote a resolver record no socket would ever read, and let a caller "prove"
        // a station change that never reached a human. A seat link re-derives identity and re-seats
        // on hello (§5.1), so such a record could not even survive the person actually arriving.
        // Refuse by name, and write nothing.
        const socks = M.socketsFor(userId);
        if (!socks.length) return { userId, stationUid: null, ok: false, reason: 'not-connected', delivered: 0 };
        const seat = M.seatResolver.select(userId, stationUid);
        // IDENTITY-scoped, and necessarily so: the resolver keys a seat by userId and has no socket
        // concept, so a CONTESTED identity (P3: two live sockets, one derived id) has ONE seat and
        // both of its clients move together. `delivered` reports how many were actually re-rendered.
        let delivered = 0;
        for (const ws of socks) { const c = M.conns.get(ws); if (c) { M.renderStationTo(ws, c, seat); M.send(ws, { t: 'station', ok: true, stationUid: seat.uid }); delivered++; } }
        log.info('station', 'set', { userId, stationUid: seat.uid, delivered });
        M.pushPresence();
        return { userId, stationUid: seat.uid, ok: true, delivered };
      },
    stationProject: M.projectStation,
    pluginTools: () => [...M.pluginTools.values()].map((t) => ({ name: t.name, description: t.description || '', input: t.input || null, plugin: t.plugin })),
    async callPluginTool(name, args = {}) {
        const t = M.pluginTools.get(name);
        if (!t) return { ok: false, error: `no such plugin tool: ${name}`, available: [...M.pluginTools.keys()] };
        try { return { ok: true, result: await t.handler(args || {}) }; }
        catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      },
    modulesChanged(id = null) {
        let n = 0;
        for (const [ws, c] of M.conns.entries())
          if (c.role === 'presenter' || c.role === 'ai') { M.send(ws, { t: 'module-changed', id }); n++; }
        log.info('module', 'modules-changed', { id, notified: n });
        return n;
      },
    voiceEnable: (target = 'all') => { M.ensureAsr(); return M.targets(target).map((ws) => M.send(ws, { t: 'voice_enable' })).length; },
    /*
     * ⭐ Plan 0689 R4b — THE COUNTERPART voiceEnable NEVER HAD.
     *
     * An agent could REQUEST a mic and had no way to drop the request, so Bruce's mic stayed
     * requested until he closed it himself. This is the courtesy half — "I have stopped listening"
     * — and it is a RELEASE, never a force.
     *
     * ⛔⛔ IT MUST REMAIN IMPOSSIBLE TO FORCE A MIC ON, AND THIS DOES NOT WEAKEN THAT. The safety
     * property is the browser's own permission prompt (uncoerceable) plus the on-air badge's
     * one-click stop, and both are untouched. Releasing a request THIS AGENT MADE is the opposite
     * direction of travel: it can only ever stop capture, never start it.
     *
     * ⭐ THE CLIENT PATH ALREADY EXISTS AND IS ALREADY TRUSTED. `turn_budget:closed` and
     * `floor:hold` both call APVoice.disable() today — the server has been yielding other people's
     * microphones for two plans. This adds no new client power; it adds a name for the one the
     * agent needed.
     */
    voiceRelease: (target = 'all') => M.targets(target).map((ws) => M.send(ws, { t: 'voice_release' })).length,
    getTranscripts: (since = 0) => ({ transcripts: M.inbox.filter((t) => t.kind === 'voice' && t.seq > (since || 0)).map((t) => annotateTrust(t, t.trust)), cursor: M.inboxSeq }),
    getInbox: (since = 0, waitMs = 0) => {
        const s = since || 0;
        // Plan 0473 P9: DELIMIT-AS-DATA — every served item is annotated with its trust; participant/guest
        // items are fenced (untrusted data, never commands) and guests flagged. Self/controller pass through.
        const serve = (items) => items.map((i) => annotateTrust(i, i.trust));
        const ready = M.inbox.filter((i) => i.seq > s);
        if (ready.length || !waitMs) return { items: serve(ready), cursor: M.inboxSeq };
        return new Promise((resolve) => {
          const w = { settled: false };
          w.wake = () => {
            if (w.settled) return; w.settled = true;
            clearTimeout(w.timer); M.inboxWaiters.delete(w);
            resolve({ items: serve(M.inbox.filter((i) => i.seq > s)), cursor: M.inboxSeq });   // emit-woke: new items; timeout: empty
          };
          w.timer = setTimeout(w.wake, waitMs);
          w.timer.unref?.();
          M.inboxWaiters.add(w);
        });
      },
    getInboxWaiters: () => M.inboxWaiters.size,
    situation: ({ consumerId = 'default', waitMs = 0, recentN = M.RECENT_TURNS_N } = {}) => {
        // Plan 0687 R1 — the wait test asks the TRANSPORT question ("is there anything I have not
        // been handed?"), so it reads the same position buildSituation serves from, per namespace.
        const last = M.cursors.hasDelivery(consumerId) || String(consumerId).startsWith('pvs:')
          ? M.cursors.delivery(consumerId).sent : M.cursors.readPosition(consumerId);
        if (M.inboxSeq > last || !waitMs) return M.buildSituation(consumerId, recentN);
        return new Promise((resolve) => {
          const w = { settled: false };
          w.wake = () => {
            if (w.settled) return; w.settled = true;
            clearTimeout(w.timer); M.inboxWaiters.delete(w);
            resolve(M.buildSituation(consumerId, recentN));   // emit-woke: new items folded in; timeout: current set
          };
          w.timer = setTimeout(w.wake, waitMs);
          w.timer.unref?.();
          M.inboxWaiters.add(w);
        });
      },
    emitOwnTurn: ({ text, userId = 'argus', userName = 'Argus', role = 'ai', speaking: sp = true } = {}) => {
        const entry = M.emitInbox({ kind: 'reply', userId, userName, role, text, conf: null, final: true, own: true });
        if (sp) M.setSpeaking(true);
        return annotateTrust(entry, entry.trust);   // serve-shape (own:true + trust:'self', unfenced)
      },
    setSpeaking: (on) => M.setSpeaking(on),
    isSpeaking: () => M.speaking,
    pvsStart: ({ mode, consumer = 'argusmon', session = null } = {}) => {
        const key = M.pvsConsumerKey(consumer);
        const reopening = !!(M.pvs && M.pvs.open);
        if (mode != null && M.PVS_MODES.has(mode)) M.commsMode = mode;   // an explicit mode wins; else keep the standing mode
        // R1: baseline the delivery cursor ONLY when this consumer has none yet (fresh open). Re-arm keeps it.
        // R1: baseline the delivery record ONLY when this consumer has none yet (fresh open).
        // Re-arm keeps it — and resumes from `acked`, not from `sent`: turns handed to a dead
        // watcher were SENT, never CONFIRMED, and must replay (G5).
        M.cursors.baselineDelivery(key, M.inboxSeq);
        const rec = M.cursors.delivery(key);
        const resumeCursor = rec.acked;
        M.pvs = { open: true, consumer: key, openedAt: (M.pvs && M.pvs.openedAt) || Date.now(), session: session != null ? session : (M.pvs && M.pvs.session) || null };
        log.info('pvs', 'start', { consumer: key, mode: M.commsMode, resumeCursor, sentCursor: rec.sent, liveCursor: M.inboxSeq, reopening });
        return { open: true, mode: M.commsMode, consumer: key, resumeCursor, sentCursor: rec.sent, liveCursor: M.inboxSeq, sessionId: M.SESSION_ID, session: M.pvs.session, reopened: reopening, durable: M.cursorStore.configured };
      },
    pvsStop: () => {
        const wasOpen = !!(M.pvs && M.pvs.open);
        const key = M.pvs && M.pvs.consumer;
        if (key) M.cursors.dropDelivery(key);
        if (wasOpen) log.info('pvs', 'stop', { consumer: key });
        M.pvs = null;
        return { stopped: true, wasOpen };
      },
    pvsState: () => (M.pvs && M.pvs.open)
        ? { open: true, mode: M.commsMode, consumer: M.pvs.consumer, openedAt: M.pvs.openedAt, session: M.pvs.session,
            deliveredCursor: M.cursors.delivery(M.pvs.consumer).sent, ackedCursor: M.cursors.delivery(M.pvs.consumer).acked,
            liveCursor: M.inboxSeq, durable: M.cursorStore.configured }
        : { open: false, mode: M.commsMode },
    /*
     * ⛔ Plan 0687 R2 (G5) — THE ACK. This is the ONLY thing in the whole system that may move an
     * `acked` position, and it exists because a consumer must be able to READ WITHOUT ACKING.
     * `situation()` / `presenter_inbox` / the ws `turn` frame all hand turns over; none of them
     * confirms anything. The agent calls this once it has actually taken the turns in. A response
     * truncated mid-flight therefore leaves `acked` where it was, and the turns come back.
     * `seq` defaults to the live head: "I have everything you have handed me."
     */
    pvsAck: ({ consumer = null, seq = null } = {}) => {
        const key = consumer ? M.pvsConsumerKey(consumer) : (M.pvs && M.pvs.consumer);
        if (!key) return { ok: false, reason: 'no-pvs-consumer' };
        const rec0 = M.cursors.delivery(key);
        const through = (seq == null) ? rec0.sent : Math.min(Number(seq) || 0, M.inboxSeq);
        const rec = M.cursors.ackDelivery(key, through);
        M.compactSpill();   // R4: an entry every consumer has acked is nobody's backlog any more
        log.info('pvs', 'ack', { consumer: key, acked: rec.acked, sent: rec.sent, live: M.inboxSeq });
        return { ok: true, consumer: key, acked: rec.acked, sent: rec.sent, liveCursor: M.inboxSeq, unacked: M.inboxSeq - rec.acked };
      },
    /*
     * ⛔ Plan 0687 R2 — READ WITHOUT ACKING, and without advancing ANY cursor. This is the honest
     * answer to "what have I not confirmed?", served from the ACKED position and reading through
     * the ring's eviction boundary when a durable spill exists (R4). Calling it twice returns the
     * same turns twice; that is the point.
     */
    pvsBacklog: ({ consumer = null, limit = 200 } = {}) => {
        const key = consumer ? M.pvsConsumerKey(consumer) : (M.pvs && M.pvs.consumer);
        if (!key) return { ok: false, reason: 'no-pvs-consumer' };
        const rec = M.cursors.delivery(key);
        const { entries, recovered } = M.entriesAfter(rec.acked);
        const n = Math.max(1, Math.min(1000, Number(limit) || 200));
        const shown = entries.slice(0, n);
        // ⭐ This read IS a handover, so it advances `sent` — to the highest seq it ACTUALLY
        // returned, never past the limit it truncated at. ⛔ It still does not touch `acked`: that
        // is the whole rule. Without this a backlog-only consumer would leave `sent` at zero, and a
        // bare pvsAck() ("everything you handed me") would silently ack NOTHING — a no-op wearing
        // the shape of a confirmation, which is the failure mode this phase is about.
        const oldestRing = M.inbox.length ? M.inbox[0].seq : null;
        // A gap the spill could NOT cover is stated, not hidden: these turns are gone.
        const firstAvailable = shown.length ? shown[0].seq : (oldestRing || rec.acked + 1);
        const missed = Math.max(0, firstAvailable - rec.acked - 1);
        if (shown.length) M.cursors.markSent(key, shown[shown.length - 1].seq);
        const after = M.cursors.delivery(key);
        return {
          ok: true, consumer: key, acked: after.acked, sent: after.sent, liveCursor: M.inboxSeq,
          count: shown.length, truncated: entries.length > shown.length, recoveredFromSpill: recovered,
          missed, missedMarker: missed > 0 ? ('\u26a0 ' + missed + ' turns missed (aged out with nowhere durable to spill)') : null,
          items: shown.map((i) => annotateTrust(i, i.trust)),
        };
      },
    /** ⛔ G6 — the discard ledger. Every eviction is counted; the unrecoverable ones separately. */
    deliveryStats: () => M.deliveryStats(),
    commsMode: (set) => {
        if (set != null) {
          if (!M.PVS_MODES.has(set)) return { ok: false, reason: 'unknown-mode', mode: M.commsMode, modes: [...M.PVS_MODES] };
          M.commsMode = set; log.info('pvs', M.pvs ? 'mode' : 'mode-no-pvs', { mode: set });
        }
        return { ok: true, mode: M.commsMode, pvsOpen: !!(M.pvs && M.pvs.open) };
      },
    presentText: ({ text = '', title = null, target = 'all' } = {}) => {
        const html = renderMarkdown(text);
        const opts = { html };
        if (title != null) opts.title = String(title);
        const n = api.pushComponent(target, 'prose', opts, 'argus', []);
        log.info('present', 'text', { target, chars: String(text).length, html: html.length });
        return { presented: n, target, chars: String(text).length, htmlBytes: html.length };
      },
    getPvsSubscriberCount: () => M.pvsSubscribers.size,
    _emitInboxForTest: (spec = {}) => { const e = M.emitInbox(spec); return annotateTrust(e, e.trust); },
    _oidcAdapterForTest: M.oidcAdapter,
    _authCtxForTest: (req) => M.computeAuthCtx(req),
    _breakGlassForTest: M.bgAdapter,
    _tailscaleWhoisForTest: M.tsWhois,
    _extraBindsForTest: () => M.extraServers.map((e) => { const a = e.address(); return a ? a.address : null; }),
    _displayStateForTest: () => JSON.stringify({
        byRole: Object.fromEntries(M.ROLES.map((r) => [r, M.displayByRole[r] || null])),
        byUser: Object.fromEntries([...M.displayByUser.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
      }),
    workItems: () => M.queueView(),
    turnBudgetFor: ({ role = 'participant', trust } = {}) => M.perTurnBudgetFor(role, trust),
    floorState: () => M.effectiveFloor(),
    autoFloor: () => M.floorState,
    floorGated: () => M.floorGated(),
    setModerationFloor: (state) => M.setModerationFloor(state),
    muteParticipant: (userId) => {
        if (!M.floorKnobs().moderationOverrides) return { ok: false, reason: 'moderation-not-permitted', muted: [...M.mutedParticipants] };
        M.mutedParticipants.add(String(userId));
        log.info('floor', 'mute', { userId: String(userId) });
        return { ok: true, muted: [...M.mutedParticipants] };
      },
    unmuteParticipant: (userId) => {
        if (!M.floorKnobs().moderationOverrides) return { ok: false, reason: 'moderation-not-permitted', muted: [...M.mutedParticipants] };
        M.mutedParticipants.delete(String(userId));
        log.info('floor', 'unmute', { userId: String(userId) });
        return { ok: true, muted: [...M.mutedParticipants] };
      },
    isMuted: (userId) => M.mutedParticipants.has(String(userId)),
    backpressure: () => ({ sheddedCount: M.sheddedCount, floor: M.effectiveFloor() }),
    voiceSessionCount: () => M.voiceSessions,
    workItem: (id) => { M.expireStale(); const it = M.workItemsMap.get(id); return it ? M.itemView(it) : null; },
    debugAllWorkItems: () => { M.expireStale(); return [...M.workItemsMap.values()].map((it) => ({ ...M.itemView(it), deferred: !!it.deferred })); },
    claimWork: (id, { owner = 'agent' } = {}) => {
        M.expireStale();
        const it = M.workItemsMap.get(id);
        if (!it || (it.status !== 'pending' && it.status !== 'claimed')) return null;
        it.status = 'claimed'; it.owner = owner || 'agent'; it.claimedTs = Date.now();
        M.evaluateFloor();   // Plan 0473 P6: queue depth changed — reassess the floor
        log.info('queue', 'claim', { id, owner: it.owner });
        return M.itemView(it);
      },
    resolveWork: (id, { note = null } = {}) => {
        const it = M.workItemsMap.get(id);
        if (!it || it.status === 'resolved') return null;
        it.status = 'resolved'; it.resolvedTs = Date.now(); if (note != null) it.note = String(note).slice(0, M.QUEUE_TEXT_MAX);
        M.pruneTerminal();
        M.evaluateFloor();   // Plan 0473 P6: work resolved lowers the load — reassess the floor (may clear to 'go')
        log.info('queue', 'resolve', { id });
        return M.itemView(it);
      },
    deferWork: (id) => {
        M.expireStale();
        const it = M.workItemsMap.get(id);
        if (!it || (it.status !== 'pending' && it.status !== 'claimed')) return null;
        it.status = 'pending'; it.owner = null; it.priority = M.PRIORITY_DEFERRED; it.createdTs = Date.now(); it.deferred = true;
        M.evaluateFloor();   // Plan 0473 P6: PROACTIVE-FIRST — reassess the floor before any reactive shed
        M.enforceQueueBounds();
        log.info('queue', 'defer', { id });
        return M.itemView(it);
      },
    capEnabled: () => !!M.CAP_SECRET,
    mintCap: (payload = {}) => {
        if (!M.CAP_SECRET) return null;
        const nonce = payload.nonce || ('g-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
        const exp = (typeof payload.exp === 'number') ? payload.exp : (Math.floor(Date.now() / 1000) + 3600);   // default 1h
        const scope = Array.isArray(payload.scope) ? payload.scope.filter((s) => typeof s === 'string') : ['speak', 'type'];
        return mintCapability({ v: 1, sid: payload.sid != null ? payload.sid : M.SESSION_ID, role: 'participant', scope, name: payload.name || null, exp, nonce }, M.CAP_SECRET);
      },
    revokeCap: (nonce) => {
        if (!nonce) return false;
        M.revokedNonces.add(nonce);
        M.persistRevokedNonces();   // Plan 0543 P4 — survive a restart (0489's flagged bug)
        for (const [ws, c] of M.conns.entries()) if (c.isGuest && c.capNonce === nonce) { try { ws.close(); } catch (e) {} }
        log.info('cap', 'revoked', { nonce: String(nonce).slice(0, 8) });   // only a short prefix, for audit; not the token
        return M.revokedNonces.has(nonce);
      },
    isCapRevoked: (nonce) => M.revokedNonces.has(nonce),
    clear: (target = 'all') => { M.setDisplay(target, null); return M.targets(target).map((ws) => M.send(ws, { t: 'clear' })).length; },
    chime: ({ message = 'Ready to start?', target = 'all', requireAck = false, ackId = 'ready', bell = true } = {}) => {
        if (requireAck) {
          const prev = M.acks.get(ackId); M.acks.set(ackId, { message, requestedAt: Date.now(), target, by: (prev && prev.by) || new Map() });
          while (M.acks.size > M.ACKS_MAX) { const oldest = M.acks.keys().next().value; if (oldest === ackId) break; M.acks.delete(oldest); }   // Plan 0471 M2: bound distinct ackIds (FIFO evict)
        }
        return M.targets(target).map((ws) => M.send(ws, { t: 'chime', message, requireAck: !!requireAck, ackId, bell: bell !== false })).length;
      },
    speak: (text, target = 'all') => {
        const clamped = String(text || '').slice(0, 300);
        M.recordSpeak(clamped);   // Plan 0493 E1: remember what we said so its mic loopback can be deduped
        return M.targets(target).map((ws) => M.send(ws, { t: 'speak', text: clamped })).length;
      },
    getAck: (ackId = 'ready') => {
        const a = M.acks.get(ackId);
        const viewerIds = M.targets((a && a.target) || 'all').map((ws) => M.conns.get(ws)).filter(Boolean).map((c) => c.userId);
        const by = a ? [...a.by.entries()].map(([userId, v]) => ({ userId, userName: v.userName, at: v.at })) : [];
        const acked = new Set(by.map((b) => b.userId));
        return { ackId, message: a ? a.message : null, requestedAt: a ? a.requestedAt : null, acked: by.length > 0, count: by.length, by, pending: viewerIds.filter((u) => u && !acked.has(u)) };
      },
    attendance: ({ staleMs = M.STALE_MS, viewerRole = 'participant' } = {}) => {
        const now = Date.now();
        const control = (viewerRole === 'presenter' || viewerRole === 'ai');
        // TODO(opsec): throttle control-view info exposure — see plan 0466 §Deferred
        // Plan 0529 P1: the roster is an AGENT-FACING payload (situation.roster, presenter_attendance)
        // and its two identity columns are typed by the person in the row. They never went through the
        // fence — a hostile display name emitted a live closing marker straight into the agent's context
        // from a row that carries no `text` at all. Neutralized on EVERY row (a control row's name is
        // typed too), so the redacted participant view below inherits it.
        const full = [...M.conns.values()].map((c) => {
          const lastSeenAgoSec = Math.floor((now - (c.lastSeen || now)) / 1000);
          const connected = (now - (c.lastSeen || 0)) <= staleMs;   // green when fresh, red when stale
          return {
            userId: M.safeId(c.userId), userName: M.safeId(c.userName), role: c.role,
            connected,                                             // <-- the dot (liveness only)
            connectedSec: Math.floor((now - (c.connectedAt || now)) / 1000),
            lastSeenAgoSec,                                        // replaces old idle number; bounded, never epoch-sized
            eyesOn: !!c.eyesOn,                                    // explicit attendance (verify_watching CONFIRM)
            eyesOnAgoSec: c.eyesOn ? Math.floor((now - c.eyesOn) / 1000) : null,
            display: M.displayIdFor(c),
            /* Plan 0693 T5 — WHETHER this connection holds command authority. ⛔ A boolean, never
             * an identifier: the verified principal that earned it is not in this payload and must
             * never be. CONTROL-ONLY, like ip/socketId — a participant roster that named the room's
             * admins would be a different disclosure than the one this row is for. */
            self: c.trust === 'self',
            ip: c.ip, socketId: c.id,                             // CONTROL-ONLY (stripped below for participants)
          };
        });
        const summary = {
          connected: full.filter((r) => r.connected).length,
          offline: full.filter((r) => !r.connected).length,
          eyesOn: full.filter((r) => r.eyesOn).length,
          total: full.length,
        };
        // Redaction is SERVER-SIDE (global invariant): participants get names + role + connected + eyesOn
        // ONLY — no ip/socketId/display/last-seen. Control/ai get the full rows (per-row buttons need them).
        const roster = control ? full : full.map((r) => ({
          userId: r.userId, userName: r.userName, role: r.role, connected: r.connected, eyesOn: r.eyesOn,
        }));
        return { roster, summary };
      },
    closePoll: (promptId) => { const p = M.polls.get(promptId); if (p) p.open = false; M.serverApply({ path: 'polls/' + promptId + '/open', verb: 'set', value: false }); const t = M.tally(promptId); if (p && p.resultsMode === 'all') M.serverApply({ path: 'polls/' + promptId + '/results', verb: 'set', value: { tally: t.tally, count: t.count } }); return { promptId, ...t }; },
    debugDump: (role = 'presenter') => ({
        presence: M.presence(),
        connections: [...M.conns.values()].map((c) => ({ socketId: c.id, userId: M.safeId(c.userId), role: c.role })),   // 0529 P1: a self-asserted id is participant-authored
        state: { polls: [...M.polls.entries()].map(([id, p]) => ({ promptId: id, open: p.open, ...M.tally(id) })), store: M.store.snapshot({ role, userId: null }).state },
        version: M.store.version(),
        opLog: log.view(role, { max: 50 }),
        // Telemetry is controller-read-only (S7): only presenter/ai see the operational sink.
        telemetry: (role === 'presenter' || role === 'ai') ? M.telemetryView() : null,
      }),
    telemetry: M.telemetryView,
    setModule(module) {
        M.contentModule = (module && typeof module === 'object')
          ? Object.assign({}, module, { title: module.title || (module.manifest && module.manifest.title) || 'Module', beats: module.beats || [] })
          : { title: 'Module', beats: [] };   // keep sections/manifest server-side (not just title+beats)
        M.currentBeat = -1;
        // Plan 0438 D: validate on load — observability only, NEVER blocks (warn-never-block).
        try { const v = summarize(validate({ title: M.contentModule.title, beats: M.contentModule.beats, manifest: module && module.manifest })); if (v.warn || v.info) log.info('module', 'validate', { warn: v.warn, info: v.info, codes: v.warnings.concat(v.infos).map((x) => x.code) }); } catch (e) { log.warn('module', 'validate-error', { err: String(e).slice(0, 120) }); }
        M.serverApply({ path: 'module/len', verb: 'set', value: M.contentModule.beats.length });
        M.serverApply({ path: 'module/current', verb: 'set', value: -1 });
        // DEF-1: auto-show the module's default/title page on load if declared+resolvable; else
        // leave branding (currentBeat stays -1, push nothing). The panel still drives Start via show_beat index:0.
        const did = M.contentModule.manifest && M.contentModule.manifest.defaultBeatId;
        if (did != null && M.contentModule.beats.findIndex((b) => b.id === did) >= 0) api.showBeat(did);
        return { title: M.contentModule.title, beats: M.contentModule.beats.length };
      },
    showBeat(ref) {
        const r = M.resolveBeatRef(ref);   // by index OR beat id (branch nav)
        if (!r) return null;
        M.publishBeat(r.i, null);          // null ⇒ the beat's own declared routing, as always
        return { index: r.i, component: r.beat.component, target: r.beat.target || 'all' };
      },
    stageBeat(ref, ctx = {}) {
        const key = ctx.key || 'api';
        if (ref == null) return { ok: false, reason: 'no-beat-ref', staged: false };
        const r = M.resolveBeatRef(ref);
        if (!r) return { ok: false, reason: 'no-such-beat', staged: false, ref: String(ref) };
        const desc = M.beatDescriptor(r.beat);
        const list = M.normalizeTargets(ctx.targets);          // ['all'] ⇒ null ⇒ the beat's own routing
        const as = (list && list.length === 1) ? list[0] : null;   // the UI is single-select; the protocol is not
        // Plan 0522 P6 (t16) — a slot holds ONE candidate, so staging a second beat destroys the
        // first. That destruction is invisible from the outside unless the ack says so, and an
        // unsent beat the operator thinks is still armed is I5's silent non-delivery with an extra
        // step. The PREVIOUS occupant is reported whenever it was a DIFFERENT beat; re-staging the
        // same beat loses nothing and reports nothing.
        const prev = M.stagedByCaller.get(key) || null;
        const replaced = (prev && !(prev.index === r.i && prev.beatId === (r.beat.id != null ? r.beat.id : null)))
          ? { beatId: prev.beatId, index: prev.index, targets: prev.targets || ['all'] } : null;
        M.stagedByCaller.set(key, { desc, beatId: r.beat.id != null ? r.beat.id : null, index: r.i, at: Date.now(), targets: list });
        let rendered = false;
        if (ctx.ws && ctx.conn) { M.renderDisplay(ctx.ws, ctx.conn, desc, M.viewerForTarget(as)); rendered = true; }
        log.info('beat', 'stage', { key, index: r.i, beatId: r.beat.id != null ? r.beat.id : null, rendered, targets: list || ['all'], replaced });
        return { ok: true, staged: true, index: r.i, beatId: r.beat.id != null ? r.beat.id : null, component: r.beat.component, rendered,
          targets: list || ['all'], as: as || 'all', replaced };
      },
    sendBeat({ targets: tgt = null, id = null, index = null } = {}, ctx = {}) {
        const key = ctx.key || 'api';
        const staged = M.stagedByCaller.get(key) || null;
        const ref = (id != null) ? id
          : (index != null) ? index
            : staged ? (staged.beatId != null ? staged.beatId : staged.index) : null;
        if (ref == null) return { ok: false, reason: 'nothing-staged', sent: false, recipients: 0, sockets: 0 };
        const r = M.resolveBeatRef(ref);
        if (!r) return { ok: false, reason: 'no-such-beat', sent: false, recipients: 0, sockets: 0, ref: String(ref) };
        // P5: targets SUPPLIED with the send win; otherwise inherit the ones the preview was rendered
        // for. `tgt != null` — not `normalizeTargets(tgt)` — because ['all'] normalises to null and
        // means "do not narrow", which must OVERRIDE a staged station, not silently fall back to it.
        const list = (tgt != null) ? M.normalizeTargets(tgt) : (staged ? staged.targets || null : null);
        const res = M.publishBeat(r.i, list);
        M.stagedByCaller.delete(key);   // it shipped; the slot is no longer armed
        log.info('beat', 'send', { key, index: r.i, targets: res.targets, recipients: res.recipients, sockets: res.sockets });
        return { ok: true, sent: true, index: r.i, beatId: r.beat.id != null ? r.beat.id : null, component: r.beat.component,
          targets: res.targets, recipients: res.recipients, sockets: res.sockets };
      },
    stagedBeat(ctx = {}) {
        const s = M.stagedByCaller.get(ctx.key || 'api');
        return s ? { beatId: s.beatId, index: s.index, at: s.at, targets: s.targets || ['all'] } : null;
      },
    nextBeat() { return api.showBeat(M.currentBeat + 1); },
    prevBeat() { return api.showBeat(Math.max(0, M.currentBeat - 1)); },
    showDefault() {
        const did = M.contentModule && M.contentModule.manifest && M.contentModule.manifest.defaultBeatId;
        if (did != null && M.contentModule.beats.findIndex((b) => b.id === did) >= 0) return api.showBeat(did);
        api.clear('all');
        return null;
      },
    appendBeat(beat) {
        if (!M.contentModule) M.contentModule = { title: 'Module', beats: [] };
        M.contentModule.beats.push(beat);
        M.serverApply({ path: 'module/len', verb: 'set', value: M.contentModule.beats.length });
        return { beats: M.contentModule.beats.length };
      },
    getModule() { return M.contentModule ? JSON.parse(JSON.stringify(M.contentModule)) : null; },
    loadModule(module) { return api.setModule(module); },
    health: ({ staleMs = 10000 } = {}) => {
        const now = Date.now();
        const connections = [...M.conns.values()].map((c) => {
          const ageMs = now - (c.lastSeen || now);
          return { socketId: c.id, userId: c.userId, role: c.role, ageMs, stale: ageMs > staleMs };
        });
        const o = M.telem.ops, total = o.applied + o.denied + o.malformed;
        const errorRate = total ? +((o.denied + o.malformed) / total).toFixed(3) : 0;
        const anyStale = connections.some((x) => x.stale);
        // Plan 0482 B3 — health must react to the signals that mean THE SURFACE IS DEAD, and must
        // NOT react to the signal that means the permission model is doing its job.
        //   FAULTS (degrade): renderErrors + opApplyFailures — the client cannot draw or apply;
        //   throttled — we are dropping the user's input; frameErrors — frames arriving as garbage;
        //   malformed — ops arriving unusable. Every one of these means someone's session is broken.
        //   DENIALS (never degrade): a denied op is default-deny WORKING. Five benign denials used to
        //   drive errorRate to 1.0 and report 'degraded' — crying wolf, while a wholly dead frame
        //   pipeline still read green because none of the fault counters were consulted at all.
        const faults = {
          renderErrors: M.telem.renderErrors,
          opApplyFailures: M.telem.opApplyFailures,
          frameErrors: M.telem.frameErrors,
          throttled: o.throttled,
          malformed: o.malformed,
        };
        const faultCount = faults.renderErrors + faults.opApplyFailures + faults.frameErrors + faults.throttled + faults.malformed;
        const status = (anyStale || faultCount > 0) ? 'degraded' : 'green';
        /*
         * ── Plan 0525 P2 (I1) — IS THIS SESSION BEING RECORDED? ─────────────────────────────────
         * The CLI banner has answered that since P16.2 ("session log: <dir>/<id>.p0.jsonl" or
         * "DISABLED — <reason>"). The AGENT had no way to ask — and presenter_start, which is the
         * path that raises the public ingress, is the path the real sessions come up on. A recorder
         * nobody can confirm is running is the failure P16.2 exists to fix, with extra steps.
         *
         * It lands HERE, beside `opLogSize`, because that is the IN-MEMORY ring this log backstops:
         * the two numbers are the same measurement, one bounded at 1000 and freed with the process,
         * the other durable. The counters below are of a kind with opsApplied / faults / errorRate,
         * and the failure modes that matter are silent DEGRADATIONS mid-session (a directory that
         * stops being writable, three consecutive write failures disabling the log, lines dropped by
         * a wedged disk) — which need the surface an agent polls, not one it reads once at start.
         *
         * ⛔ STATE, NEVER CONTENT. Directory, provenance, id, counters. The log carries participants'
         * own spoken and typed words, and its read surface is deliberately ONE role-gated endpoint
         * (GET /api/session-log, control credential required, fails closed when none is configured —
         * R6). Adding a second read path for third parties' speech is a decision, and it is not this
         * one's to make. Nothing below can carry an entry: the fields are enumerated, never spread.
         *
         * ⚠ DELIBERATELY NOT FOLDED INTO `status`. A disabled log does not degrade the verdict. The
         * library default IS off — a bare createServer() writes nothing, which is what keeps this
         * suite out of a human's ~/.local/state — so degrading on it would paint every test red and
         * teach a reader to ignore the word. Whether stats.dropped / stats.failures should degrade a
         * DEPLOYED session is a real question and a separate one; it is reported, not scored.
         */
        const slog = M.sessionLog.status();
        return {
          status, connections,
          opsApplied: o.applied, errorRate,
          faults, faultCount, denied: o.denied,   // denials REPORTED (visible) but never degrading
          stateVersion: M.store.version(), opLogSize: M.store.oplogSince(0).length,
          sessionLog: {
            enabled: slog.enabled,
            sessionLogId: slog.sessionLogId,
            sessionLogDir: slog.sessionLogDir,
            sessionLogDirSource: slog.sessionLogDirSource,
            // The REASON, under the SAME name the CLI banner and /api/session-log already use. A
            // gauge that reads "off" without saying why is the dead-gauge shape: a reader cannot
            // tell the deliberate library default from a disk that said no. Non-null while ENABLED
            // too — that is the "config unreadable, fell back to the built-in default" warning, and
            // it is worth surfacing rather than swallowing.
            sessionLogDirError: slog.sessionLogDirError,
            stats: { ...slog.stats },
          },
          rtt: M.telem.rtt.last, reconnects: M.telem.reconnects,
        };
      },
    raf: ({ windowMs = 5000 } = {}) => {
        /*
         * ⛔ RAF IS A METRIC OVER HUMAN ACTIVITY, so SYSTEM-actor ops are not in the population.
         * `totalOps` was `oplogSince(0).length` — everything — while every ratio computed from it
         * counted only `participant` / `presenter` / `ai`. A plugin that seeds its own state when it
         * registers (a legitimate thing to do: a component that mounts needs something to read)
         * therefore landed its machine writes in the DENOMINATOR and in nothing else, and
         * peerCatalysisRatio silently fell by a factor of three on any deployment with such a plugin
         * installed. The READING was wrong, not merely the test that noticed. Found 2026-08-11.
         */
        const entries = M.store.oplogSince(0).filter((e) => e.role !== 'system');
        const total = entries.length;
        const CONTROLLERS = new Set(['ai', 'presenter']);
        const peerVisible = entries.filter((e) => e.role === 'participant' && M.store.perms.canRead({ role: 'participant', userId: null }, e.path)).length;   // Plan 0471 C3
        const teacher = entries.filter((e) => CONTROLLERS.has(e.role)).length;
        // Peer->peer response edges: a participant op preceded (within windowMs) by a
        // DIFFERENT participant's op = a peer responding to a peer.
        const partOps = entries.filter((e) => e.role === 'participant');
        let edges = 0;
        for (let i = 0; i < partOps.length; i++) {
          for (let j = i - 1; j >= 0; j--) {
            if (partOps[i].ts - partOps[j].ts > windowMs) break;
            if (partOps[j].by !== partOps[i].by) { edges++; break; }
          }
        }
        return {
          totalOps: total,
          peerCatalysisRatio: total ? +(peerVisible / total).toFixed(3) : 0,
          teacherDependencyRatio: total ? +(teacher / total).toFixed(3) : 0,
          interactionDensity: partOps.length ? +(edges / partOps.length).toFixed(3) : 0,
          peerResponseEdges: edges, participantOps: partOps.length,
        };
      },
    store: M.store,
    sessionLog: M.sessionLog,
    close: () => new Promise((res) => { try { M.saveCursors(); } catch { /* Plan 0687 R3: flush the delivery cursors; a failed write must never block a shutdown */ } try { M.sessionLog.close(); } catch { /* a log must never block a shutdown either */ } clearInterval(M.heartbeat); /* Plan 0468 (INV-7) */ if (M.ephTimer) clearTimeout(M.ephTimer); for (const t of M.hotTimers.values()) clearTimeout(t); M.hotTimers.clear(); for (const w of [...M.inboxWaiters]) w.wake(); /* Plan 0472: drain pending long-poll waiters (resolve, no dangling) */ if (M.openTurn && M.openTurn.timer) { clearTimeout(M.openTurn.timer); M.openTurn.timer = null; } /* Plan 0473 P2: clear a pending turn-settling timer */ for (const [, c] of M.conns) { if (c.voice && c.voice.timer) clearTimeout(c.voice.timer); } if (M.asr) { try { M.asr.close(); } catch (e) {} M.asr = null; } M.watcher && M.watcher.close(); M.wss.clients.forEach((c) => c.close()); for (const e of M.extraServers) { try { e.close(); } catch {} } M.extraServers.length = 0; /* Plan 0650 — the opt-in extra binds go down with the primary */ M.httpServer.close(() => res()); }),
    _http: M.httpServer,
    _acks: M.acks,
    _lastResults: M.lastResults,
  };
  return api;
}
