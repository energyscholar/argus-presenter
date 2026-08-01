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
 */

// --- createServer({ ... }) options -----------------------------------------------------
export const CONSTRUCTOR_COVERAGE = {
  port:            { tool: 'presenter_start' },
  voiceEnabled:    { tool: 'presenter_start', as: 'voice' },
  profile:         { tool: 'presenter_start' },
  controlToken:    { tool: 'presenter_start' },
  rolePassword:    { tool: 'presenter_start' },
  roleSeed:        { tool: 'presenter_start' },
  capSecret:       { tool: 'presenter_start' },
  settlingMs:      { tool: 'presenter_start' },
  queueMaxPending: { tool: 'presenter_start' },
  queueTtlMs:      { tool: 'presenter_start' },
  perTurnBudgetMs: { tool: 'presenter_start' },
  perTurnWrapMs:   { tool: 'presenter_start' },
  floorThresholds: { tool: 'presenter_start' },
  // Plan 0522 P16.2 — DELIBERATELY NOT ON THE TOOL SCHEMA, and that is the security decision, not
  // an oversight. presenter_start DOES enable the durable log (it resolves the directory from
  // lib/deployment-config.mjs / $PRESENTER_SESSION_LOG_DIR and passes it in), so the agent-raised
  // session — the one that raised S17, whose op-log died with its process — is now recorded. What
  // the agent may not do is CHOOSE THE DESTINATION: the log carries the session transcript, i.e.
  // participants' own words, so a caller-settable path is a redirect primitive for other people's
  // speech. Where it lands is the deployment's declaration; reading it is role-gated (R6) at
  // GET /api/session-log.
  sessionLogDir:   { declined: 'DEPLOYMENT CONFIG, not a per-call knob (Plan 0522 P16.2 / R3, R6). presenter_start ENABLES the durable session log — it resolves the directory from lib/deployment-config.mjs and passes it to createServer — but the destination is never taken from the caller: the log carries participants\' own words, so an agent-settable path would be a redirect primitive for third parties\' speech. Set it in presenter-config.json or $PRESENTER_SESSION_LOG_DIR.' },
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
  // GAP #4 of the S210 six: the server CAN push raw HTML (server.mjs:1820) and no tool exposes
  // it. Argus told Bruce it was impossible; it wasn't. Recorded as owed, not quietly dropped.
  pushContent:         { declined: 'NOT YET EXPOSED — owed. Raw-HTML push into the sandboxed iframe; needs a decision on the injection surface before it gets a tool.' },

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
  pluginTools:         { tool: 'presenter_plugin_tool' },
  callPluginTool:      { tool: 'presenter_plugin_tool' },
  spotlightHolders:    { declined: 'NOT YET EXPOSED — owed. Who currently holds a share grant is READ-only state; it belongs on presenter_status/attendance alongside the roster rather than in its own tool. Grant/revoke is already reachable via presenter_spotlight.' },

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
  commsMode:           { tool: 'presenter_mode' },
  getPvsSubscriberCount: { declined: 'test-only observability — live ws subscriber count (leak/teardown assertions)' },
  _emitInboxForTest:   { declined: 'test-only ingress seam — injects an inbox item through the real emit path without a socket' },
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
  voiceSessionCount:   { declined: VIA_MCP_STATE },
  isSpeaking:          { declined: VIA_MCP_STATE },
  setSpeaking:         { declined: 'set by the voice pipeline itself; an agent toggling it would desync the floor' },
  emitOwnTurn:         { declined: 'the agent already knows what it said; re-injecting it would double-count turns' },

  // --- capability links (Plan 0472)
  capEnabled:          { declined: 'reported by presenter_start as capLinks' },
  mintCap:             { declined: 'NOT YET EXPOSED — owed. Minting guest seat links is exactly what plan 0486 needs; tracked there, not silently dropped.' },
  revokeCap:           { declined: 'NOT YET EXPOSED — owed alongside mintCap (0486).' },
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
