/*
 * Plan 0488 — MCP SURFACE COVERAGE MANIFEST.
 *
 * THE BUG THIS EXISTS TO PREVENT: six times in one session (S210) the server could do
 * something and the agent-facing MCP surface could not reach it — capSecret, rolePassword,
 * presenter_voice_enable, the raw-HTML push, module-load-by-id, and `profile`. The last one
 * meant an entire live session silently ran the SOLO `wearable` profile (maxPending:1, floor
 * disabled) at what was meant to be a six-person table, and the symptom looked like a
 * backpressure defect that did not exist.
 *
 * That is not six bugs. It is one missing test: nothing asserted that the tool surface covers
 * what createServer()/api can do.
 *
 * HOW THIS WORKS: every createServer() option and every api method must appear below as
 * EITHER
 *     { tool: '<tool name>' }        — reachable by the agent
 *     { declined: '<why not>' }      — deliberately not exposed; the reason is REQUIRED
 * test/unit/0488-surface-coverage.test.mjs diffs this manifest against the real code in both
 * directions, so a new option fails the build and a renamed/removed one fails it too.
 *
 * SAYING NO IS A SUPPORTED ANSWER. The goal is a recorded decision, never forced exposure —
 * `capSecret` and `controlToken` are security-relevant and should be deliberate, which is
 * exactly why codegen was rejected (plan §3).
 *
 * ── Plan 0551 C7 — EVERY constructor entry ALSO carries `deploymentOnly: true|false` ────────────
 * `deploymentOnly:true` means: this option is DEPLOYMENT CONFIG ONLY. It must be routed from the
 * deployment's own file by BOTH launch paths, and it must NEVER appear on presenter_start's input
 * schema. Both halves are asserted by test/unit/0551-p2-identity-routing.test.mjs, which enumerates
 * the options FROM createServer's signature — so a NEWLY ADDED identity key fails the guard until a
 * human classifies it, and fails again unless it is actually routed.
 *
 * That second failure is the one that matters. 0543 added five identity options to createServer and
 * every one of them was unreachable: declined here with a good reason, and never wired to anything
 * that could supply it. "Declined from the agent surface" was silently read as "configured
 * elsewhere", and nowhere was elsewhere.
 */

// --- createServer({ ... }) options -----------------------------------------------------
export const CONSTRUCTOR_COVERAGE = {
  port:            { tool: 'presenter_start', deploymentOnly: false },   // its DEFAULT is deployment config (presenterPort()); the option itself is a legitimate caller knob
  voiceEnabled:    { tool: 'presenter_start', as: 'voice', deploymentOnly: false },
  profile:         { tool: 'presenter_start', deploymentOnly: false },
  controlToken:    { tool: 'presenter_start', deploymentOnly: false },
  rolePassword:    { tool: 'presenter_start', deploymentOnly: false },
  roleSeed:        { tool: 'presenter_start', deploymentOnly: false },
  capSecret:       { tool: 'presenter_start', deploymentOnly: false },
  settlingMs:      { tool: 'presenter_start', deploymentOnly: false },
  queueMaxPending: { tool: 'presenter_start', deploymentOnly: false },
  queueTtlMs:      { tool: 'presenter_start', deploymentOnly: false },
  perTurnBudgetMs: { tool: 'presenter_start', deploymentOnly: false },
  perTurnWrapMs:   { tool: 'presenter_start', deploymentOnly: false },
  floorThresholds: { tool: 'presenter_start', deploymentOnly: false },
  // Plan 0522 P16.2 — DELIBERATELY NOT ON THE TOOL SCHEMA, and that is the security decision, not
  // an oversight. presenter_start DOES enable the durable log (it resolves the directory from
  // lib/deployment-config.mjs / $PRESENTER_SESSION_LOG_DIR and passes it in), so the agent-raised
  // session — the kind whose op-log used to die with its process — is now recorded. What
  // the agent may not do is CHOOSE THE DESTINATION: the log carries the session transcript, i.e.
  // participants' own words, so a caller-settable path is a redirect primitive for other people's
  // speech. Where it lands is the deployment's declaration; reading it is role-gated (R6) at
  // GET /api/session-log.
  sessionLogDir:   { declined: 'DEPLOYMENT CONFIG, not a per-call knob (Plan 0522 P16.2 / R3, R6). presenter_start ENABLES the durable session log — it resolves the directory from lib/deployment-config.mjs and passes it to createServer — but the destination is never taken from the caller: the log carries participants\' own words, so an agent-settable path would be a redirect primitive for third parties\' speech. Set it in presenter-config.json or $PRESENTER_SESSION_LOG_DIR.', deploymentOnly: true },
  // Plan 0543 P1 — the AUTH POLICY dial. Same shape as sessionLogDir: presenter_start passes it
  // (resolved from lib/deployment-config.mjs authPolicy()), but it is DEPLOYMENT CONFIG, never a
  // caller knob — an agent that could flip enforceOAuth per call could weaken the room's own gate.
  enforceOAuth:              { declined: 'DEPLOYMENT CONFIG, not a per-call knob (Plan 0543 P1). presenter_start reads it from lib/deployment-config.mjs authPolicy() and passes it; who may open the Control page is the deployment\'s declaration, not something the agent flips at runtime. Set it in presenter-config.json.', deploymentOnly: true },
  allowPasswordCommandOnLAN: { declined: 'DEPLOYMENT CONFIG, not a per-call knob (Plan 0543 P1) — an explicitly-unsafe escape hatch. Same deployment-owned resolution as enforceOAuth. Set it in presenter-config.json.', deploymentOnly: true },
  // Plan 0543 P2/P3 — the IDENTITY layer. All deployment config / security-relevant, none of it a
  // per-call agent knob: an agent that could set the allowlist, the OIDC client, or the break-glass
  // credential at runtime could grant itself (or anyone) command authority. Configured on the box.
  allowlist:                 { declined: 'DEPLOYMENT CONFIG / SECURITY (Plan 0543 P2). The fail-closed email/tailnet-user → role map that is the only thing between a verified principal and command authority. A gitignored manifest on the box, never an agent knob.', deploymentOnly: true },
  oidc:                      { declined: 'DEPLOYMENT CONFIG / SECURITY (Plan 0543 P2). The Google OIDC client (client id/secret, endpoints). Set on the box; an agent-settable IdP is a login-redirect primitive.', deploymentOnly: true },
  oidcDeps:                  { declined: 'TEST/INJECTION SEAM (Plan 0543 P2) — the network deps (token exchange, JWKS fetch) are injected so the OIDC flow logic is testable offline; production uses defaultOidcDeps(). Not a session capability.', deploymentOnly: false },
  oidcSessionTtlMs:          { declined: 'TEST SEAM (Plan 0543 P3) — the OIDC session lifetime, driven to 0 by the expiry test. Not a per-call agent knob. ⚠ deploymentOnly:false is the HONEST answer today: nothing reads it from the config file, so production runs the built-in 12h default. If a deployment ever needs to state it, add it to lib/deployment-config.mjs DEPLOYMENT_ROUTED_OPTIONS and flip this flag — the 0551 C7 guard enforces the pairing.', deploymentOnly: false },
  tailscale:                 { declined: 'DEPLOYMENT CONFIG (Plan 0543 P2) — enables the direct-tailnet-peer identity adapter. Set on the box.', deploymentOnly: true },
  // ⚠ Plan 0650 CORRECTED THIS ENTRY. It used to claim the resolver was "wired to the tailscale layer
  // in production". IT WAS NOT — createServer defaulted it to null and only test files ever supplied
  // one, so the tailnet path was inert for months while this line said otherwise. It is now built by
  // createServer itself whenever `tailscale.enabled` is true, so it cannot be enabled-but-inert again.
  tailscaleResolve:          { declined: 'TEST/INJECTION SEAM (Plan 0543 P2, corrected by 0650) — a SYNCHRONOUS override for the tailnet resolver, injected by tests. Production does NOT need it: createServer builds the real two-phase peer resolver (tailscale whois on the SOCKET address) whenever tailscale.enabled is set. ⛔ The header-reading resolver the tests inject must never ship — a header is a client claim.', deploymentOnly: false },
  tailscaleWhois:            { declined: 'TEST/INJECTION SEAM (Plan 0650 §2a) — the two-phase peer resolver { prime, resolve }, injected so a test can stub `tailscale whois` and the peer address and drive the REAL code path offline. Production constructs its own from tailscale.enabled. Not a session capability.', deploymentOnly: false },
  breakGlassDeps:            { declined: 'TEST/INJECTION SEAM (Plan 0650 §2b) — the credential reader and clock for the break-glass adapter, so single-use / TTL / 0600-mode refusal are testable without writing real credentials to disk. Not a session capability.', deploymentOnly: false },
  bindHosts:                 { declined: 'DEPLOYMENT CONFIG / SECURITY (Plan 0650) — EXTRA listen addresses beyond loopback, so a tailnet peer can reach the server at all (and therefore be identified by `tailscale whois`). Absent ⇒ loopback only; ⛔ 0.0.0.0/::/* are refused outright at the config boundary. Which interfaces a server exposes is the deployment\'s declaration, never an agent\'s: an agent that could widen the bind could publish the room.', deploymentOnly: true },
  // ⚠ Plan 0650 CORRECTED THIS ENTRY TOO. Until 0650 the credential's PRESENCE was the entire
  // mechanism: checked at startup, reported in the log line, and consumed by NO ROUTE. It is now
  // redeemed at POST /auth/break-glass — loopback-only, single-use, TTL, 0600 file.
  breakGlass:                { declined: 'DEPLOYMENT CONFIG / SECURITY (Plan 0543 P3, made real by 0650) — the loopback-only recovery credential redeemed at POST /auth/break-glass when the IdP is unreachable. Single-use, TTL-bounded, read from a 0600 file on the box. It grants the CONTROL PAGE and never trust:self. Never an agent knob: an agent that could set it could mint its own way past the OAuth gate.', deploymentOnly: true },
  cursorDir:                 { declined: 'DEPLOYMENT CONFIG (Plan 0687 R3) — the per-room directory holding the delivery cursor file and the eviction spill, so an ack position survives a restart in a room that records NOTHING (RT-6). ⚠ deploymentOnly:false is the HONEST answer today: nothing reads it from presenter-config.json yet, only $PRESENTER_CURSOR_DIR and the direct createServer option, so the 0551 C7 pairing does not apply. When a room section declares it, add it to DEPLOYMENT_ROUTED_OPTIONS and flip this flag. Never an agent knob: an agent that could move the cursor file could make its own dropped turns unprovable.', deploymentOnly: false },
  revokedNonceFile:          { declined: 'DEPLOYMENT CONFIG (Plan 0543 P4) — the durable store path for revoked guest-link nonces (so a revocation survives a restart, 0489\'s flagged bug). Resolved by the CLI / presenter_start from the state dir; not a per-call knob.', deploymentOnly: true },
};

// --- api surface ------------------------------------------------------------------------
// Coverage of createServer options is the MUST; api coverage is the SHOULD (plan §5). Bulk
// internals share one reason each rather than being individually argued.
const INTERNAL = 'internal plumbing — not a session capability an agent should drive';
const VIA_MCP_STATE = 'consumed internally by presenter_situation / presenter_debug rather than as its own tool';

export const API_COVERAGE = {
  // --- lifecycle / identity
  url:                 { tool: 'presenter_start' },
  port:                { tool: 'presenter_start' },
  close:               { tool: 'presenter_stop' },
  profile:             { tool: 'presenter_start' },
  authPolicy:          { tool: 'presenter_status' },   // Plan 0543 P1 — the current auth policy rides on presenter_status.auth

  // --- display / content
  clear:               { tool: 'presenter_situation', },
  reloadClients:       { tool: 'reload_clients' },
  raf:                 { tool: 'presenter_raf' },
  chime:               { tool: 'presenter_bell' },
  speak:               { tool: 'presenter_speak' },   // Plan 0491 §10 minimum working slice
  pushComponent:       { tool: 'push_component' },
  presentText:         { tool: 'present_text' },   // Plan 0493 §8 — standard markdown text-response card
  presence:            { tool: 'presenter_attendance' },
  store:               { declined: VIA_MCP_STATE },
  // Plan 0522 P16.2 — the durable session-log handle (status/read/sessions/append/flush/close).
  // The READ is NOT exposed as a tool, and the reason is the R6 ruling rather than tidiness: the
  // log is the session TRANSCRIPT, and its read surface is deliberately one role-gated HTTP
  // endpoint (GET /api/session-log, control credential required, fails closed when none is
  // configured) so there is exactly one gate to reason about. A `presenter_session_log` tool is a
  // reasonable later ask — the AI is a control role and is the party that most wants to measure a
  // session — but it is a NEW read surface for third parties' speech and earns its own decision,
  // not a bolt-on. Recorded as owed, not quietly dropped.
  //
  // ⚠ Plan 0525 P2 SPLIT THIS ENTRY IN TWO, and the split is the point. status() — enabled, the
  // directory, its provenance, the id, the counters — now rides on api.health() and therefore on
  // presenter_health, because an agent that cannot ask "is anything being recorded?" is back to
  // the failure P16.2 exists to fix. read()/sessions() stay behind the one gate. STATE is not
  // CONTENT, and only the state crossed.
  sessionLog:          { declined: 'PARTLY EXPOSED, DELIBERATELY. STATE — status(): enabled / sessionLogDir / sessionLogDirSource / sessionLogId / stats — is reported by presenter_health (Plan 0525 P2, I1). CONTENT — read()/sessions() — is NOT, and remains role-gated at GET /api/session-log (Plan 0522 P16.2 / R6): the log is the session transcript, so a second read surface for participants\' own words is a decision, not a convenience. append()/flush()/close() are the server\'s own plumbing.' },
  /* ✅ GAP #4 of the S210 six, AND IT WAS THE APP'S PRIMARY PURPOSE. The entry above used to read
   * "NOT YET EXPOSED — owed… needs a decision on the injection surface before it gets a tool", and
   * that decision was never taken, so successive sessions declined the one thing the app is for.
   * ⛔⛔ THE REFUSAL WAS THE DEFECT. Bruce ruled 2026-08-26: *"I totally want you to be able to draw
   * arbitrary HTML in Presenter. It's the primary purpose of the app… It's what the app is FOR."*
   * The security survey (plan 0689 §2d) reached SHIP IT on the containment that was already there:
   * `allow-scripts` with NO `allow-same-origin` ⇒ opaque origin, three source-checked message
   * shapes back, `op` still through the permission layer. The correct mitigation is VISIBILITY,
   * not prohibition — the same reasoning the microphone shipped under. */
  pushContent:         { tool: 'presenter_push_content' },
  /*
   * Plan 0691 — the shared state machine's WRITE half. Deliberately NOT exposed as tools yet.
   *
   * An agent that could set any store path at will could write another user's vote,
   * a seat, a cap, or a plugin's authority slice — every one of which the permission table exists
   * to gate, and all of which `apply` bypasses by acting as `system`. The safe surface is a tool
   * scoped to the `shared/**` slice with a participant actor, which is a design decision, not a
   * rename; until that exists, saying no here is the honest answer.
   *
   * ⚠ Not deploymentOnly: these are live session capabilities, reachable in-process by the
   *   server, plugins and tests. Only the AGENT-facing exposure is declined.
   */
  apply:               { declined: 'STORE WRITE + BROADCAST, acting as `system`, which OVERRIDES the whole permission table (app/permissions.mjs). An agent-settable arbitrary path could write another user\'s vote, a seat, a capability or a plugin\'s authority slice. Expose later as a tool scoped to `shared/**` with a participant actor — that is a new tool, not a wrapper.', deploymentOnly: false },
  set:                 { declined: 'Convenience wrapper over `apply` (one path, verb set). Declined for exactly the same reason and on the same terms.', deploymentOnly: false },
  /* Plan 0689 R5 — the COMPOSITION half, and the reason the decline mattered so much: it stranded
   * sixteen components that exist to be combined with authored HTML rather than to replace it.
   * Assembles the component bundle around the author's markup and stamps it PER VIEWER, so a
   * `visibility:'gm'` mount is dropped server-side rather than merely hidden. */
  pushPage:            { tool: 'presenter_push_content' },

  // --- module / beats (Plan 0488 + S210)
  setModule:           { tool: 'present_module' },
  loadModule:          { tool: 'present_module' },
  getModule:           { tool: 'presenter_beats' },
  showBeat:            { tool: 'show_beat' },
  nextBeat:            { tool: 'next_beat' },
  appendBeat:          { tool: 'append_beat' },
  showDefault:         { tool: 'presenter_home' },        // Plan 0508 — the owed gap, now closed
  prevBeat:            { tool: 'prev_beat' },              // Plan 0508 — next_beat is no longer asymmetric
  // ⛓ Plan 0522 P6 (R18) — TWO-STAGE DELIVERY IS A **DECLARED DIFFERENCE** BETWEEN THE SURFACES,
  // NOT AN OVERSIGHT AND NOT A SILENT GAP. I1 permits exactly this in its own words: *where they
  // must differ, the difference is declared and tested, never discovered live.*
  //
  // The reason is structural. stageBeat renders a candidate to THE CALLER'S OWN CONTROL SURFACE;
  // the in-process MCP caller has none, so the tool would report `rendered:false` on every call —
  // and a tool that renders nowhere is worse than no tool, because the agent would believe it had
  // previewed something. The correct agent-side semantic (staging RETURNS the rendered HTML,
  // because a tool's return value IS an AI's control surface) is a design decision that earns its
  // own plan — 0523 — rather than a bolt-on here.
  //
  // ⚠ DO NOT DELETE THESE ENTRIES TO "TIDY UP". test/unit/0522-p6-declared-surface.test.mjs (t16a)
  // fails if a declaration disappears AND fails if `stage_beat`/`send_beat` appear as tools while
  // still declared declined. That is what keeps this a recorded decision instead of a hole
  // somebody rediscovers mid-session.
  //
  // show_beat — the publish path — keeps FULL PARITY on both surfaces and is unchanged (R4), so
  // nothing an agent can do today regresses: the agent publishes exactly as it always has.
  stageBeat:           { declined: 'DECLARED DIFFERENCE, not a gap (Plan 0522 R18; closure owed to plan 0523). Staging renders to the CALLER\'S OWN control surface and the in-process MCP caller has none, so an exposed tool could only ever report rendered:false. 0523 decides what an agent-side staging surface is — most likely returning the rendered HTML to the caller. Asserted deliberate by t16a.' },
  sendBeat:            { declined: 'DECLARED DIFFERENCE, not a gap (Plan 0522 R18; closure owed to plan 0523). Publishing a STAGED beat is meaningless for a caller that cannot stage; until stageBeat has an agent surface the agent publishes with show_beat, whose semantics R4 keeps identical on both surfaces. Asserted deliberate by t16a.' },
  stagedBeat:          { declined: 'read-only observability for the P6 STAGED/LIVE indicator and its tests — per-caller staging state, nothing an agent can act on until stageBeat is exposed (Plan 0522 R18, closure owed to 0523)' },
  // Plan 0508 (spotlight + live module rescan). Both shipped with the station work; the guard
  // caught them missing here, which is exactly its job.
  spotlight:           { tool: 'presenter_spotlight' },
  modulesChanged:      { tool: 'presenter_refresh_modules' },
  // Plan 0514 — stations. The registry is core-owned DATA (declared by a plugin); occupancy is
  // NOT core's and is asked for on demand, so there is nothing here for an agent to corrupt.
  stations:            { tool: 'presenter_stations' },
  stationSet:          { tool: 'presenter_station_set' },
  // Plan 0522 P15 (R18). Shipped as a control-page-only capability and a CLOSURE, so it was
  // invisible to this very manifest — the shape that hides a capability from the one instrument
  // built to find it. Exposed rather than declined: putting a station's screen on the room is an
  // AI-in-the-loop narration move, and it writes nothing, so there is nothing to protect.
  stationProject:      { tool: 'presenter_station_project' },
  // Plan 0526 P1 — the SURFACE REGISTRY. Deployment DATA, read-only, and (unlike a station) with
  // no occupancy and no seat behind it: there is nothing here an agent could corrupt.
  // ⚠ 0526 P4 HAS NOW LANDED THE VERB, and these two are still declined — the earlier text said
  // the tool would ship WITH the verb, so here is the honest correction rather than a stale note.
  surfaces:            { declined: 'NOT EXPOSED. The reason CHANGED at 0526 P4 (plan 0534 W4b) and this entry is the correction: the verb now exists, but it is `{t:\'peek\'}` on the WEBSOCKET, not on `api`. Peek renders down ONE socket and its whole point is that it disturbs nobody else; an in-process MCP caller has no socket, so an exposed tool could only ever peek on somebody ELSE\'S behalf — which is `presenter_station_project`, a different capability that already exists. The read-only list is declined with it: a catalogue whose only verb is a participant\'s own is deployment configuration, not an agent capability.' },
  surfaceScreen:       { declined: 'NOT EXPOSED — same reason as `surfaces` above, restated at 0526 P4. It answers "does this surface exist, may a viewer be shown it, what does it render as"; the acting-on-that-answer half is self-scoped and lives on the participant\'s own connection. An agent that wants the room to see a screen has push_component and presenter_station_project; peek is deliberately not an agent\'s to press.' },
  pluginTools:         { tool: 'presenter_plugin_tool' },
  callPluginTool:      { tool: 'presenter_plugin_tool' },
  // ✅ Plan 0689 R4c CLOSED THIS. The entry used to say "NOT YET EXPOSED — owed… it belongs on
  // presenter_status/attendance alongside the roster rather than in its own tool". It now does,
  // on BOTH, exactly as written: read-only, no new capability, grant/revoke still presenter_spotlight.
  spotlightHolders:    { tool: 'presenter_status' },

  // --- polls
  openPoll:            { tool: 'open_poll' },
  getPoll:             { tool: 'get_poll' },
  closePoll:           { tool: 'close_poll' },

  // --- work queue (Plan 0473)
  workItems:           { tool: 'presenter_situation' },
  workItem:            { tool: 'presenter_situation' },
  claimWork:           { tool: 'presenter_claim' },
  resolveWork:         { tool: 'presenter_resolve' },
  deferWork:           { tool: 'presenter_defer' },

  // --- PVS lifecycle (Plan 0493)
  pvsStart:            { tool: 'presenter_pvs_start' },
  pvsStop:             { tool: 'presenter_pvs_stop' },
  pvsState:            { tool: 'presenter_status' },
  // Plan 0687 R2 — the ack is an AGENT act (G5), so it needs an agent-reachable surface of its own.
  pvsAck:              { tool: 'presenter_pvs_ack' },
  pvsBacklog:          { tool: 'presenter_pvs_backlog' },
  deliveryStats:       { tool: 'presenter_debug' },
  commsMode:           { tool: 'presenter_mode' },
  getPvsSubscriberCount: { declined: 'test-only observability — live ws subscriber count (leak/teardown assertions)' },
  _emitInboxForTest:   { declined: 'test-only ingress seam — injects an inbox item through the real emit path without a socket' },
  _oidcAdapterForTest: { declined: 'test-only seam (Plan 0543 P3) — the OIDC adapter, so an acceptance test can mint a verified session and exercise the trust path offline. Never a session capability.' },
  _authCtxForTest:     { declined: 'test-only seam (Plan 0543 P3) — computes the loopback/verified auth context for a request so a test can assert the discriminator. Read-only, no capability.' },
  _breakGlassForTest:  { declined: 'test-only seam (Plan 0650 §2b) — the break-glass adapter, so an acceptance test can prove grant-then-spent, the non-loopback refusal and the TTL refusal without a real credential on disk. Read-only, no capability.' },
  _tailscaleWhoisForTest: { declined: 'test-only seam (Plan 0650 §2a) — the two-phase peer resolver actually in use (null when unwired), so a test can prove production is NOT inert. Read-only, no capability.' },
  _extraBindsForTest:  { declined: 'test-only seam (Plan 0650) — the extra host addresses that really bound, so the opt-in tailnet bind is provable and a silent failure to bind cannot pass for success. Read-only, no capability.' },
  _displayStateForTest: { declined: 'test-only observability seam — serialises displayByRole/displayByUser so Plan 0522 t07 can prove a stage wrote nothing durable (I3); read-only, no capability' },

  // --- sensing
  situation:           { tool: 'presenter_situation' },
  getInbox:            { tool: 'presenter_inbox' },
  attendance:          { tool: 'presenter_attendance' },
  health:              { tool: 'presenter_health' },
  telemetry:           { tool: 'presenter_health' },
  debugDump:           { tool: 'presenter_debug' },
  getAck:              { tool: 'presenter_check_ack' },
  getTranscripts:      { tool: 'presenter_inbox' },

  // --- voice
  voiceEnable:         { tool: 'presenter_voice_enable' },
  // Plan 0689 R4b — the counterpart voiceEnable never had. ⛔ It is a RELEASE, not a force: the
  // browser permission prompt is uncoerceable and the on-air badge's one-click stop is untouched,
  // so this can only ever STOP capture. Same yield the server already performs on turn_budget
  // 'closed' and floor 'hold'; what was missing was a name for the one the agent needed. Without
  // it a request Argus made stayed outstanding until Bruce closed it himself.
  voiceRelease:        { tool: 'presenter_voice_release' },
  voiceSessionCount:   { declined: VIA_MCP_STATE },
  isSpeaking:          { declined: VIA_MCP_STATE },
  setSpeaking:         { declined: 'set by the voice pipeline itself; an agent toggling it would desync the floor' },
  emitOwnTurn:         { declined: 'the agent already knows what it said; re-injecting it would double-count turns' },

  // --- capability links (Plan 0472)
  capEnabled:          { declined: 'reported by presenter_start as capLinks' },
  mintCap:             { tool: 'mint_cap' },      // Plan 0543 P4 — guest seat links, sid = seat slug
  revokeCap:           { tool: 'revoke_cap' },    // Plan 0543 P4 — revoke by nonce, persisted across restart
  isCapRevoked:        { declined: INTERNAL },

  // --- moderation / floor
  muteParticipant:     { declined: 'NOT YET EXPOSED — owed; teaching profile needs it.' },
  unmuteParticipant:   { declined: 'NOT YET EXPOSED — owed alongside muteParticipant.' },
  isMuted:             { declined: VIA_MCP_STATE },
  setModerationFloor:  { declined: 'NOT YET EXPOSED — owed; teaching profile needs it.' },
  autoFloor:           { declined: INTERNAL },
  floorState:          { declined: VIA_MCP_STATE },
  floorGated:          { declined: INTERNAL },
  backpressure:        { declined: VIA_MCP_STATE },
  turnBudgetFor:       { declined: INTERNAL },

  // --- internals
  on:                  { declined: INTERNAL },
  _http:               { declined: INTERNAL },
  _acks:               { declined: INTERNAL },
  _lastResults:        { declined: INTERNAL },
  getInboxWaiters:     { declined: INTERNAL },
  debugAllWorkItems:   { declined: 'test-only introspection' },
};

/* --- the THIRD direction: every TOOL is accounted for ------------------------------------------
 *
 * ⭐⭐ Plan 0689. The two maps above are keyed by what the SERVER can do, and they answer
 * "is this capability reachable?". Neither of them can answer the opposite question — "what is
 * this tool, and who decided it should exist?" — because a tool that wraps no `api` method and no
 * constructor option appears in neither map. Seven of them did, silently, and one of the seven was
 * the ops surface added by this very plan.
 *
 * That is the same hole in a different orientation: a capability nothing explains. So every tool
 * name must appear EITHER as the `tool:` of an entry above (⇒ it is that capability's surface) OR
 * here, WITH a reason. test/unit/0488-surface-coverage.test.mjs diffs it in both directions, so a
 * new unexplained tool fails the build and a stale entry fails it too.
 *
 * ⛔ A tool listed here as well as above is an error, not a belt-and-braces: two places to change
 * is how one of them goes stale.
 */
export const TOOL_COVERAGE = {
  presenter_tunnel:           'PUBLIC INGRESS control (S220). Wraps mcp/tunnel.mjs, not `api` — the ingress is a separate process on the box, so there is no server method for it to cover. Exposed because a local 200 proves nothing about reachability and the tunnel has died mid-session.',
  presenter_default_branding: '⏹ THE PANIC BUTTON (2026-07-27). Drives api.clear (covered above as `clear`) but is listed here too because its NAME is the capability: 33 tools could put things on screen and none read as "take it off". Findable on reboot without reading source.',
  presenter_modules:          'Reads the deployment\'s modules DIRECTORY from disk (mcp/tools.mjs readModuleById\'s sibling), not any server method. The server never enumerates the catalogue; the agent needs to know what it may load.',
  presenter_verify_watching:  'A COMPOSITE of api.chime + the ack path (both covered above) with one meaning: "is a human actually looking?". The eyesOn signal is only ever set by a CONFIRM through this tool — never by polling, voting or receiving content — so the composite is the capability.',
  presenter_transcript:       'The VOICE-ONLY VIEW of api.getTranscripts (covered above, mapped to presenter_inbox, which is its text+voice superset). Kept as its own tool because it is voice-CONDITIONAL: it disappears from the surface when the deployment has no mic.',
  /* ── Plan 0689 R1/R2 — the ops surface. Neither wraps `api`: they answer questions about the BOX
   * and the DEPLOYMENT, and the moment you need them is the moment the presenter is down. ⛔ Both
   * READ-ONLY; presenter_deploy / presenter_rollback are R3 and need Bruce's recorded decision. */
  presenter_release_status:   'Plan 0689 R1. READ-ONLY deployment inspection — the current release, its sha/builtAt, each unit\'s MainPID AND ExecMainStartTimestamp, and the enumerable releases with every rejection\'s reason. Not an `api` method: it reads the filesystem and systemd, deliberately WITHOUT a running presenter, because ssh-and-a-pipe lost an exit code twice on 2026-08-25/26 and text through a pipe is not a measurement.',
  presenter_health_deep:      'Plan 0689 R2. READ-ONLY per-room reachability — loopback AND tailnet, each answering a REAL PAGE (id="stage" + id="ap-config") rather than merely 200. Distinct from presenter_health, which reports the IN-PROCESS server this MCP owns: this one probes the DEPLOYMENT, including rooms in other processes, which is where the 26-hour phantom hid.',
};
