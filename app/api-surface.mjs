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
  /* ── HELPERS THAT FOLLOWED THEIR MEMBERS (Plan 0661 phase 3b) ─────────────────────────────
   * 30 declarations nothing outside this surface referenced any more. M is not predicted for them —
   * it is DERIVED from this finished module: every free identifier left over becomes an M getter,
   * and every one that is assigned also gets a setter. Predicting it produced three missing
   * bindings on the first attempt. */
  function persistRevokedNonces() {
      if (!M.REVOKED_FILE) return;
      try { M.mkdirSync(M.dirname(M.REVOKED_FILE), { recursive: true }); M.writeFileSync(M.REVOKED_FILE, JSON.stringify([...M.revokedNonces])); }
      catch (e) { try { log.warn('cap', 'revoked-persist-failed', { err: String((e && e.message) || e).slice(0, 120) }); } catch {} }
    }

  let contentModule = null;

  let currentBeat = -1;

  const telemetryView = () => ({
      ops: { ...M.telem.ops },
      avgFanout: M.telem.fanout.count ? +(M.telem.fanout.sum / M.telem.fanout.count).toFixed(2) : 0,
      fanoutSamples: M.telem.fanout.count,
      avgApplyMs: M.telem.applyMs.count ? +(M.telem.applyMs.sum / M.telem.applyMs.count).toFixed(3) : 0,
      maxApplyMs: +M.telem.applyMs.max.toFixed(3),
      reconnects: M.telem.reconnects, renderErrors: M.telem.renderErrors, opApplyFailures: M.telem.opApplyFailures, frameErrors: M.telem.frameErrors,
      rtt: { last: M.telem.rtt.last, avg: M.telem.rtt.count ? +(M.telem.rtt.sum / M.telem.rtt.count).toFixed(1) : null, samples: M.telem.rtt.count },
    });

  const ACKS_MAX = 256;

  const ROLES = ['participant', 'presenter', 'ai'];

  function setDisplay(target, desc) {
      // Plan 0522 P5 — a STATION target resolves to THE PEOPLE SEATED THERE, not to a key named
      // after the station. Writing `displayByUser.set('station:3', …)` would have created a durable
      // row that no connection ever reads, would have shown up in the roster's "sees" column and in
      // the I3 snapshot, and would have survived everyone leaving. Resolving to occupants makes a
      // station push exactly a per-user push to each of them (so a reconnect still works), leaves no
      // residue when the station is empty, and never touches SEAT state — 0514 §13.1 / I3.
      const stUid = M.stationTargetUid(target);
      if (target === 'all' || target == null) { for (const r of ROLES) M.displayByRole[r] = desc; M.displayByUser.clear(); }
      else if (ROLES.includes(target)) M.displayByRole[target] = desc;
      else if (stUid != null) { for (const uid of M.usersAtStation(stUid)) M.displayByUser.set(uid, desc); }
      else M.displayByUser.set(target, desc);   // by userId
      M.pushPresence();   // keep the GM user-list "currently sees" column live as displays change
    }

  function resolveBeatRef(ref) {
      if (!contentModule) return null;
      const beats = contentModule.beats || [];
      const i = typeof ref === 'number' ? ref : beats.findIndex((b) => b.id === ref);
      if (!(i >= 0) || i >= beats.length) return null;
      return { i, beat: beats[i] };
    }

  function beatDescriptor(b) {
      const opts = (b.promptId != null) ? Object.assign({}, b.opts || {}, { promptId: b.promptId }) : (b.opts || {});
      return { kind: 'component', component: b.component, opts, theme: b.theme || 'argus', requires: b.requires || [] };
    }

  function publishBeat(i, targetList) {
      const b = contentModule.beats[i];
      const explicit = Array.isArray(targetList) && targetList.length ? targetList : null;
      const bases = explicit || [b.target || 'all'];
      // `reached` is filled by pushComponent with the sockets it genuinely wrote to. It was
      // previously filled by re-running targets() alongside the push, which counted the ADDRESS
      // BOOK rather than the deliveries — see send()/pushComponent.
      const reached = new Set();
      // Route by the beat's target (per-user hooks broadcast to 'all' by default) and ensure promptId
      // reaches opts so interactive beats can actually collect/gate answers.
      const opts = (b.promptId != null) ? Object.assign({}, b.opts || {}, { promptId: b.promptId }) : (b.opts || {});
      for (const t of bases) { api.pushComponent(t, b.component, opts, b.theme || 'argus', b.requires || [], reached); }
      const addressed = new Set(reached);   // the BASE audience, frozen before layers widen `reached`
      // DEL-1: per-user layers. A layer with a `target` OVERRIDES the base opts for that
      // user/role (layer opts win). `when`-only layers are runner-evaluated — out of scope here.
      // Base goes to all; layered targets additionally receive the merged override (last-wins).
      // With an EXPLICIT target list, a layer for someone who is not being addressed is skipped —
      // sending to one station must not push to a third party.
      //
      // ⚠ Plan 0522 P5 — INTERSECT AUDIENCES, DO NOT COMPARE TARGET STRINGS. P4 skipped a layer
      // unless `explicit` literally contained `L.target`, which was right for the one case it had.
      // P5 makes explicit targets the ordinary path, and string equality then DROPS a layer whose
      // target names the same people by another name — a userId layer on a send to that person's
      // STATION, or on a send addressed to a role. A dropped layer is a beat that silently arrives
      // without its personalisation (I4). Sets of sockets say who is really being addressed.
      if (Array.isArray(b.layers)) for (const L of b.layers) {
        if (!L || !L.target) continue;
        if (explicit && !M.targets(L.target).some((lws) => addressed.has(lws))) continue;
        const lopts = Object.assign({}, b.opts || {}, L.opts || {}, (b.promptId != null) ? { promptId: b.promptId } : {});
        api.pushComponent(L.target, b.component, lopts, b.theme || 'argus', b.requires || [], reached);
      }
      currentBeat = i;
      M.serverApply({ path: 'module/current', verb: 'set', value: i });
      const people = new Set();
      for (const ws of reached) { const c = M.conns.get(ws); if (c && c.userId) people.add(c.userId); }
      return { sockets: reached.size, recipients: people.size, targets: bases.slice() };
    }

  function normalizeTargets(t) {
      if (t == null) return null;
      const list = (Array.isArray(t) ? t : [t]).filter((x) => x != null && x !== '').map(String);
      if (!list.length) return null;
      if (list.every((x) => x === 'all')) return null;
      return list;
    }

  function viewerForTarget(target) {
      if (target == null || target === 'all') return null;   // ⇒ render as the caller: the unchanged default
      const live = M.liveConnForTarget(target);
      if (live) return live;
      const stUid = M.stationTargetUid(target);
      if (stUid != null) { const st = M.stationRegistry.get(stUid); return { userId: null, userName: (st && st.stationLabel) || target, role: 'participant' }; }
      if (ROLES.includes(target)) return { userId: null, userName: target, role: target };
      return { userId: target, userName: target, role: 'participant' };
    }

  const API_ACTOR = Object.freeze({ userId: 'api', role: 'ai', principal: 'in-process' });

  function isControllerActor(actor) { return !!actor && M.CONTROL_ROLES.has(actor.role); }

  const PVS_MODES = new Set(['pocket', 'presenter', 'terminal']);

  let pvs = null;

  function recordSpeak(text) {
      const norm = M.normText(text); if (!norm) return;
      M.recentSpeak.push({ norm, ts: Date.now() });
      while (M.recentSpeak.length > 20) M.recentSpeak.shift();
    }

  function setSpeaking(on) { M.speaking = on === true; log.info('barge', 'speaking', { speaking: M.speaking }); return M.speaking; }

  const SITUATION_ROSTER_MAX = 40;

  const MAX_TURN_TEXT = 2000;

  function coalesceTurns(items, n = M.RECENT_TURNS_N) {
      const turns = [];
      let cur = null;
      for (const it of items) {
        if (cur && cur.turnId === it.turnId && it.turnId != null) {
          cur.text = (cur.text + (it.text ? (cur.text ? ' ' : '') + it.text : '')).slice(0, MAX_TURN_TEXT);
          cur.count++; cur.lastSeq = it.seq; cur.ts = it.ts;
          cur.turnComplete = it.turnComplete === true; cur.kind = it.kind;
        } else {
          cur = {
            turnId: it.turnId || null, userId: it.userId, userName: it.userName, role: it.role || null,
            // Plan 0473 P9: a turn's trust is its speaker's — and a turn NEVER merges identities (a
            // speaker-change closes the turn), so every item in a turn shares one trust level.
            trust: it.trust, kind: it.kind, text: (it.text || '').slice(0, MAX_TURN_TEXT), count: 1,
            firstSeq: it.seq, lastSeq: it.seq, ts: it.ts, turnComplete: it.turnComplete === true,
          };
          turns.push(cur);
        }
      }
      return turns.slice(-n);
    }

  function displaySummary() {
      const out = {};
      for (const r of ROLES) {
        const d = M.displayByRole[r];
        out[r] = d ? (d.kind === 'component' ? ((d.opts && d.opts.promptId) || d.component)
          : (d.contentId || d.kind)) : 'idle';
      }
      return out;
    }

  function beatSummary() {
      if (!contentModule) return null;
      const total = (contentModule.beats || []).length;
      const b = (currentBeat >= 0) ? contentModule.beats[currentBeat] : null;
      return b ? { index: currentBeat, total, component: b.component, id: b.id != null ? b.id : null, title: contentModule.title }
        : { index: currentBeat, total, title: contentModule.title };
    }

  function fencedSummary() {
      const v = M.summarizer.view();
      const speakers = (v.speakers || []).map((sp) => M.sanitizeFields(sp, ['userName']));
      return annotateTrust({ ...v, speakers }, M.TRUST.PARTICIPANT);
    }

  function buildSituation(consumerId, recentN = M.RECENT_TURNS_N) {
      const last = M.situationCursors.get(consumerId) || 0;
      const since = M.inbox.filter((i) => i.seq > last);   // bounded: the ring is capped at TRANSCRIPT_RING
      // Plan 0493 R3 — a lost turn must be LOUD. If the oldest undelivered item's seq skips past last+1,
      // the items last+1..firstSeq-1 aged out of the ring before THIS consumer ever saw them (or the
      // consumer was armed past them). Surface a visible "⚠ N turns missed" marker — never a silent gap.
      let missed = 0;
      if (since.length && since[0].seq > last + 1) missed = since[0].seq - last - 1;
      M.situationCursors.set(consumerId, M.inboxSeq);         // advance the cursor to everything now shown
      M.evaluateFloor();   // Plan 0473 P6: this read caught the consumer up (backlog reduced) — reassess the floor
      const att = api.attendance({ viewerRole: 'ai' });
      const openPolls = [...M.polls.entries()].filter(([, p]) => p.open)
        .map(([id, p]) => ({ promptId: id, prompt: p.spec && p.spec.prompt, open: true, ...M.tally(id) }));
      // Plan 0473 P9: DELIMIT-AS-DATA at serve time — participant/guest turns are fenced (untrusted
      // content the agent must treat as data, never as commands); self/controller turns pass through.
      // Plan 0493 E1 — echo loopbacks are never surfaced as turns (poll path); the ws path skips them too.
      const recentTurns = coalesceTurns(M.inbox.filter((i) => i.echo !== true), recentN).map((t) => annotateTrust(t, t.trust));
      // Plan 0473 P4: the WORK QUEUE — judgment items, prioritized + bounded (aged/expired pruned).
      const queue = queueView();
      return {
        sessionId: M.SESSION_ID,
        profile: M.ACTIVE_PROFILE.name,
        bounded: true,
        situation: {
          display: displaySummary(),
          beat: beatSummary(),
          polls: openPolls,
          roster: att.roster.slice(0, SITUATION_ROSTER_MAX),
          rosterSummary: att.summary,
          // Plan 0473 P5/P10: the profile-specific DIGEST section (F-5), assembled by the DIGEST-CONTENT
          // SEAM keyed on the ACTIVE PROFILE's `digestContent` knob VALUE (DATA lookup, never a name
          // fork). wearable ('conversation') ⇒ null (the digest IS the conversation); rpg ('gm') ⇒ a GM
          // view (questions-to-GM + recent actions) + the mcp-gm scene/initiative/dice seam. The seam
          // reads ONLY the already-assembled, already-fenced pieces below — it never blocks/recomputes.
          digest: M.buildDigest(M.ACTIVE_PROFILE.digestContent, { queue, recentTurns }),
        },
        recentTurns,
        // Plan 0493 §6 — the comms MODE is carried on every delivered envelope so each poll tells the
        // agent how to answer (advisory to the agent; the server never enforces it).
        mode: M.commsMode,
        newSinceLastRead: {
          count: since.length,
          // Plan 0493 E1 — an echo loopback advances the cursor (so it never re-delivers) but is NOT
          // surfaced as a Bruce turn: filter it out of the delivered set.
          turns: coalesceTurns(since.filter((i) => i.echo !== true), recentN).map((t) => annotateTrust(t, t.trust)),
          // Plan 0493 R3 — the gap marker travels WITH the delivery. missed>0 ⇒ N turns were lost.
          missed,
          ...(missed > 0 ? { missedMarker: '⚠ ' + missed + ' turns missed' } : {}),
        },
        // Plan 0473 P7: the ROLLING SUMMARY — continuity for context OLDER than the recent-N turns.
        // A PRECOMPUTED, BOUNDED snapshot (this is a pure read of the incrementally-maintained state via
        // the F-10 seam — it NEVER blocks/computes on read), so a long session is not amnesiac past N.
        // Plan 0529 P1: served FENCED, like recentTurns above. A summary is a FLATTENED MIXTURE of many
        // speakers' words with the per-speaker trust boundary already dissolved — untrusted BY
        // CONSTRUCTION — so it carries the label even though stageSettledTurn already neutralized it.
        summary: fencedSummary(),
        // Plan 0473 P4: the WORK QUEUE — the judgment items, prioritized + bounded (aged/expired pruned).
        queue,
        // Plan 0473 P6: one-glance overload awareness. `floor` = the current proactive floor state
        // (go/wrap/hold); `backpressure.sheddedCount` = the reactive fold-to-summary total, SURFACED so a
        // shed is never silent (the LAST resort, secondary to the floor).
        floor: M.effectiveFloor(),
        backpressure: { sheddedCount: M.sheddedCount, floor: M.effectiveFloor() },
        cursor: M.inboxSeq,   // informational only — the consumer does NOT need to pass this back
      };
    }

  const PRIORITY_DEFERRED = 0;

  function expireStale() {
      const { ttlMs } = M.queueKnobs();
      const now = Date.now();
      for (const it of M.workItemsMap.values()) {
        if (it.status === 'pending' && (now - it.createdTs) > ttlMs) { it.status = 'expired'; it.expiredTs = now; }
      }
    }

  function itemView(it) {
      const v = { id: it.id, turnId: it.turnId, userId: it.userId, userName: it.userName, text: it.text,
        priority: it.priority, status: it.status, createdTs: it.createdTs, age: Date.now() - it.createdTs };
      if (it.owner) v.owner = it.owner;
      if (it.note != null) v.note = it.note;
      // Plan 0473 P11 (F-6): a CLUSTERED item carries how many students asked the same thing + the askers,
      // so the queue stays glanceable ("N students asked about X") instead of N rows. Additive; a singleton
      // item omits these (a plain 1-asker question).
      if (it.cluster) {
        v.cluster = true;
        v.count = it.count || 1;
        // Plan 0529 P1: `askers` are participant identities and `variants` are VERBATIM participant
        // utterances — a second copy of exactly the content the fence exists for, on a nested field
        // that annotateTrust below only reaches at the top level. Neutralized here.
        v.askers = (it.askers || []).slice(0, 50).map((a) => M.sanitizeFields(a, ['userId', 'userName']));
        if (it.variants) v.variants = it.variants.slice(0, 50).map((x) => (typeof x === 'string' ? M.sanitizeUntrusted(x) : x));
      }
      // Plan 0473 P9: delimit-as-data — fence the item's text when its speaker is untrusted (participant/
      // guest), flag guests. Additive to the item shape; a self/controller item passes through unfenced.
      return annotateTrust(v, it.trust);
    }

  function queueView() {
      expireStale();
      const live = [...M.workItemsMap.values()].filter((it) => it.status === 'pending' || it.status === 'claimed');
      live.sort((a, b) => (b.priority - a.priority) || (a.createdTs - b.createdTs));
      return live.map(itemView);
    }

  function setModerationFloor(state) {
      if (!M.floorKnobs().moderationOverrides) return { ok: false, reason: 'moderation-not-permitted', floor: M.effectiveFloor(), auto: M.floorState };
      if (state !== null && !M.FLOOR_STATES.includes(state)) return { ok: false, reason: 'bad-state', floor: M.effectiveFloor(), auto: M.floorState };
      M.moderationFloor = state;
      log.info('floor', 'moderation', { moderationFloor: M.moderationFloor, auto: M.floorState });
      M.broadcastFloor(M.effectiveFloor());   // the explicit decision wins over auto; never silent
      return { ok: true, floor: M.effectiveFloor(), auto: M.floorState };
    }

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
    pushContent(target, html, contentId) {
        setDisplay(target, { kind: 'content', html, contentId });
        let n = 0;   // deliveries, not address-book entries — see send()
        for (const ws of M.targets(target)) { if (M.send(ws, { t: 'content', contentId: contentId || null, html })) n++; }
        return n;
      },
    pushComponent(target, component, opts = {}, theme = 'argus', requires = [], deliveredOut = null) {
        const desc = { kind: 'component', component, opts, theme, requires };
        setDisplay(target, desc);                          // C6: remember for (re)connects
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
        setDisplay(target, { kind: 'poll-choice', promptId });
        // Assemble a per-channel `choice` stamped with that channel's identity.
        for (const ws of M.targets(target)) {
          const c = M.conns.get(ws);
          const html = assemble({ component: 'choice', opts: { prompt, options, promptId, userId: c.userId, userName: c.userName, channel: c.userId } });
          M.send(ws, { t: 'content', contentId: promptId, html });
        }
        // Optionally push a live results display to another target (e.g. presenter).
        // It stays live via store vote diffs (D3) — no bespoke relay.
        if (resultsTarget) {
          setDisplay(resultsTarget, { kind: 'poll-results', promptId });
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
    stationSet(userId, stationUid, actor = API_ACTOR) {
        if (!isControllerActor(actor)) {
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
        const last = M.situationCursors.get(consumerId) || 0;
        if (M.inboxSeq > last || !waitMs) return buildSituation(consumerId, recentN);
        return new Promise((resolve) => {
          const w = { settled: false };
          w.wake = () => {
            if (w.settled) return; w.settled = true;
            clearTimeout(w.timer); M.inboxWaiters.delete(w);
            resolve(buildSituation(consumerId, recentN));   // emit-woke: new items folded in; timeout: current set
          };
          w.timer = setTimeout(w.wake, waitMs);
          w.timer.unref?.();
          M.inboxWaiters.add(w);
        });
      },
    emitOwnTurn: ({ text, userId = 'argus', userName = 'Argus', role = 'ai', speaking: sp = true } = {}) => {
        const entry = M.emitInbox({ kind: 'reply', userId, userName, role, text, conf: null, final: true, own: true });
        if (sp) setSpeaking(true);
        return annotateTrust(entry, entry.trust);   // serve-shape (own:true + trust:'self', unfenced)
      },
    setSpeaking: (on) => setSpeaking(on),
    isSpeaking: () => M.speaking,
    pvsStart: ({ mode, consumer = 'argusmon', session = null } = {}) => {
        const key = M.pvsConsumerKey(consumer);
        const reopening = !!(pvs && pvs.open);
        if (mode != null && PVS_MODES.has(mode)) M.commsMode = mode;   // an explicit mode wins; else keep the standing mode
        // R1: baseline the delivery cursor ONLY when this consumer has none yet (fresh open). Re-arm keeps it.
        if (!M.situationCursors.has(key)) M.situationCursors.set(key, M.inboxSeq);
        const resumeCursor = M.situationCursors.get(key);
        pvs = { open: true, consumer: key, openedAt: (pvs && pvs.openedAt) || Date.now(), session: session != null ? session : (pvs && pvs.session) || null };
        log.info('pvs', 'start', { consumer: key, mode: M.commsMode, resumeCursor, liveCursor: M.inboxSeq, reopening });
        return { open: true, mode: M.commsMode, consumer: key, resumeCursor, liveCursor: M.inboxSeq, sessionId: M.SESSION_ID, session: pvs.session, reopened: reopening };
      },
    pvsStop: () => {
        const wasOpen = !!(pvs && pvs.open);
        const key = pvs && pvs.consumer;
        if (key) M.situationCursors.delete(key);
        if (wasOpen) log.info('pvs', 'stop', { consumer: key });
        pvs = null;
        return { stopped: true, wasOpen };
      },
    pvsState: () => (pvs && pvs.open)
        ? { open: true, mode: M.commsMode, consumer: pvs.consumer, openedAt: pvs.openedAt, session: pvs.session,
            deliveredCursor: M.situationCursors.get(pvs.consumer) || 0, liveCursor: M.inboxSeq }
        : { open: false, mode: M.commsMode },
    commsMode: (set) => {
        if (set != null) {
          if (!PVS_MODES.has(set)) return { ok: false, reason: 'unknown-mode', mode: M.commsMode, modes: [...PVS_MODES] };
          M.commsMode = set; log.info('pvs', pvs ? 'mode' : 'mode-no-pvs', { mode: set });
        }
        return { ok: true, mode: M.commsMode, pvsOpen: !!(pvs && pvs.open) };
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
        byRole: Object.fromEntries(ROLES.map((r) => [r, M.displayByRole[r] || null])),
        byUser: Object.fromEntries([...M.displayByUser.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
      }),
    workItems: () => queueView(),
    turnBudgetFor: ({ role = 'participant', trust } = {}) => M.perTurnBudgetFor(role, trust),
    floorState: () => M.effectiveFloor(),
    autoFloor: () => M.floorState,
    floorGated: () => M.floorGated(),
    setModerationFloor: (state) => setModerationFloor(state),
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
    workItem: (id) => { expireStale(); const it = M.workItemsMap.get(id); return it ? itemView(it) : null; },
    debugAllWorkItems: () => { expireStale(); return [...M.workItemsMap.values()].map((it) => ({ ...itemView(it), deferred: !!it.deferred })); },
    claimWork: (id, { owner = 'agent' } = {}) => {
        expireStale();
        const it = M.workItemsMap.get(id);
        if (!it || (it.status !== 'pending' && it.status !== 'claimed')) return null;
        it.status = 'claimed'; it.owner = owner || 'agent'; it.claimedTs = Date.now();
        M.evaluateFloor();   // Plan 0473 P6: queue depth changed — reassess the floor
        log.info('queue', 'claim', { id, owner: it.owner });
        return itemView(it);
      },
    resolveWork: (id, { note = null } = {}) => {
        const it = M.workItemsMap.get(id);
        if (!it || it.status === 'resolved') return null;
        it.status = 'resolved'; it.resolvedTs = Date.now(); if (note != null) it.note = String(note).slice(0, M.QUEUE_TEXT_MAX);
        M.pruneTerminal();
        M.evaluateFloor();   // Plan 0473 P6: work resolved lowers the load — reassess the floor (may clear to 'go')
        log.info('queue', 'resolve', { id });
        return itemView(it);
      },
    deferWork: (id) => {
        expireStale();
        const it = M.workItemsMap.get(id);
        if (!it || (it.status !== 'pending' && it.status !== 'claimed')) return null;
        it.status = 'pending'; it.owner = null; it.priority = PRIORITY_DEFERRED; it.createdTs = Date.now(); it.deferred = true;
        M.evaluateFloor();   // Plan 0473 P6: PROACTIVE-FIRST — reassess the floor before any reactive shed
        M.enforceQueueBounds();
        log.info('queue', 'defer', { id });
        return itemView(it);
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
        persistRevokedNonces();   // Plan 0543 P4 — survive a restart (0489's flagged bug)
        for (const [ws, c] of M.conns.entries()) if (c.isGuest && c.capNonce === nonce) { try { ws.close(); } catch (e) {} }
        log.info('cap', 'revoked', { nonce: String(nonce).slice(0, 8) });   // only a short prefix, for audit; not the token
        return M.revokedNonces.has(nonce);
      },
    isCapRevoked: (nonce) => M.revokedNonces.has(nonce),
    clear: (target = 'all') => { setDisplay(target, null); return M.targets(target).map((ws) => M.send(ws, { t: 'clear' })).length; },
    chime: ({ message = 'Ready to start?', target = 'all', requireAck = false, ackId = 'ready', bell = true } = {}) => {
        if (requireAck) {
          const prev = M.acks.get(ackId); M.acks.set(ackId, { message, requestedAt: Date.now(), target, by: (prev && prev.by) || new Map() });
          while (M.acks.size > ACKS_MAX) { const oldest = M.acks.keys().next().value; if (oldest === ackId) break; M.acks.delete(oldest); }   // Plan 0471 M2: bound distinct ackIds (FIFO evict)
        }
        return M.targets(target).map((ws) => M.send(ws, { t: 'chime', message, requireAck: !!requireAck, ackId, bell: bell !== false })).length;
      },
    speak: (text, target = 'all') => {
        const clamped = String(text || '').slice(0, 300);
        recordSpeak(clamped);   // Plan 0493 E1: remember what we said so its mic loopback can be deduped
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
        telemetry: (role === 'presenter' || role === 'ai') ? telemetryView() : null,
      }),
    telemetry: telemetryView,
    setModule(module) {
        contentModule = (module && typeof module === 'object')
          ? Object.assign({}, module, { title: module.title || (module.manifest && module.manifest.title) || 'Module', beats: module.beats || [] })
          : { title: 'Module', beats: [] };   // keep sections/manifest server-side (not just title+beats)
        currentBeat = -1;
        // Plan 0438 D: validate on load — observability only, NEVER blocks (warn-never-block).
        try { const v = summarize(validate({ title: contentModule.title, beats: contentModule.beats, manifest: module && module.manifest })); if (v.warn || v.info) log.info('module', 'validate', { warn: v.warn, info: v.info, codes: v.warnings.concat(v.infos).map((x) => x.code) }); } catch (e) { log.warn('module', 'validate-error', { err: String(e).slice(0, 120) }); }
        M.serverApply({ path: 'module/len', verb: 'set', value: contentModule.beats.length });
        M.serverApply({ path: 'module/current', verb: 'set', value: -1 });
        // DEF-1: auto-show the module's default/title page on load if declared+resolvable; else
        // leave branding (currentBeat stays -1, push nothing). The panel still drives Start via show_beat index:0.
        const did = contentModule.manifest && contentModule.manifest.defaultBeatId;
        if (did != null && contentModule.beats.findIndex((b) => b.id === did) >= 0) api.showBeat(did);
        return { title: contentModule.title, beats: contentModule.beats.length };
      },
    showBeat(ref) {
        const r = resolveBeatRef(ref);   // by index OR beat id (branch nav)
        if (!r) return null;
        publishBeat(r.i, null);          // null ⇒ the beat's own declared routing, as always
        return { index: r.i, component: r.beat.component, target: r.beat.target || 'all' };
      },
    stageBeat(ref, ctx = {}) {
        const key = ctx.key || 'api';
        if (ref == null) return { ok: false, reason: 'no-beat-ref', staged: false };
        const r = resolveBeatRef(ref);
        if (!r) return { ok: false, reason: 'no-such-beat', staged: false, ref: String(ref) };
        const desc = beatDescriptor(r.beat);
        const list = normalizeTargets(ctx.targets);          // ['all'] ⇒ null ⇒ the beat's own routing
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
        if (ctx.ws && ctx.conn) { M.renderDisplay(ctx.ws, ctx.conn, desc, viewerForTarget(as)); rendered = true; }
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
        const r = resolveBeatRef(ref);
        if (!r) return { ok: false, reason: 'no-such-beat', sent: false, recipients: 0, sockets: 0, ref: String(ref) };
        // P5: targets SUPPLIED with the send win; otherwise inherit the ones the preview was rendered
        // for. `tgt != null` — not `normalizeTargets(tgt)` — because ['all'] normalises to null and
        // means "do not narrow", which must OVERRIDE a staged station, not silently fall back to it.
        const list = (tgt != null) ? normalizeTargets(tgt) : (staged ? staged.targets || null : null);
        const res = publishBeat(r.i, list);
        M.stagedByCaller.delete(key);   // it shipped; the slot is no longer armed
        log.info('beat', 'send', { key, index: r.i, targets: res.targets, recipients: res.recipients, sockets: res.sockets });
        return { ok: true, sent: true, index: r.i, beatId: r.beat.id != null ? r.beat.id : null, component: r.beat.component,
          targets: res.targets, recipients: res.recipients, sockets: res.sockets };
      },
    stagedBeat(ctx = {}) {
        const s = M.stagedByCaller.get(ctx.key || 'api');
        return s ? { beatId: s.beatId, index: s.index, at: s.at, targets: s.targets || ['all'] } : null;
      },
    nextBeat() { return api.showBeat(currentBeat + 1); },
    prevBeat() { return api.showBeat(Math.max(0, currentBeat - 1)); },
    showDefault() {
        const did = contentModule && contentModule.manifest && contentModule.manifest.defaultBeatId;
        if (did != null && contentModule.beats.findIndex((b) => b.id === did) >= 0) return api.showBeat(did);
        api.clear('all');
        return null;
      },
    appendBeat(beat) {
        if (!contentModule) contentModule = { title: 'Module', beats: [] };
        contentModule.beats.push(beat);
        M.serverApply({ path: 'module/len', verb: 'set', value: contentModule.beats.length });
        return { beats: contentModule.beats.length };
      },
    getModule() { return contentModule ? JSON.parse(JSON.stringify(contentModule)) : null; },
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
    close: () => new Promise((res) => { try { M.sessionLog.close(); } catch { /* a log must never block a shutdown either */ } clearInterval(M.heartbeat); /* Plan 0468 (INV-7) */ if (M.ephTimer) clearTimeout(M.ephTimer); for (const t of M.hotTimers.values()) clearTimeout(t); M.hotTimers.clear(); for (const w of [...M.inboxWaiters]) w.wake(); /* Plan 0472: drain pending long-poll waiters (resolve, no dangling) */ if (M.openTurn && M.openTurn.timer) { clearTimeout(M.openTurn.timer); M.openTurn.timer = null; } /* Plan 0473 P2: clear a pending turn-settling timer */ for (const [, c] of M.conns) { if (c.voice && c.voice.timer) clearTimeout(c.voice.timer); } if (M.asr) { try { M.asr.close(); } catch (e) {} M.asr = null; } M.watcher && M.watcher.close(); M.wss.clients.forEach((c) => c.close()); for (const e of M.extraServers) { try { e.close(); } catch {} } M.extraServers.length = 0; /* Plan 0650 — the opt-in extra binds go down with the primary */ M.httpServer.close(() => res()); }),
    _http: M.httpServer,
    _acks: M.acks,
    _lastResults: M.lastResults,
  };
  return api;
}
