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
  // Plan 0522 P4 (R4) — two-stage delivery. NOT YET AGENT-FACING, and the reason is structural
  // rather than an oversight: stageBeat renders a candidate to THE CALLER'S OWN SURFACE, and the
  // MCP caller is in-process with no surface to render to — `rendered:false` on every call. The
  // agent-facing form needs a decision about what an AI "staging area" IS (an ai-role socket? a
  // returned HTML string it can inspect?), which the plan puts in P5/P6 with the target selector
  // and the STAGED-vs-LIVE indicator. Recorded as OWED, not dropped: I1 is not satisfied yet.
  // show_beat — the publish path — remains reachable from both surfaces and is unchanged (R4).
  stageBeat:           { declined: 'NOT YET EXPOSED — owed (Plan 0522 P4). Staging renders to the CALLER\'S OWN control surface; the in-process MCP caller has none. Needs the P5/P6 decision on what an agent-side staging surface is before it earns a tool.' },
  sendBeat:            { declined: 'NOT YET EXPOSED — owed (Plan 0522 P4). Publishing a STAGED beat is meaningless for a caller that cannot stage; until stageBeat has an agent surface, the agent publishes with show_beat, whose semantics R4 keeps identical on both surfaces.' },
  stagedBeat:          { declined: 'read-only observability for the P6 STAGED/LIVE indicator and its tests — per-caller staging state, nothing an agent can act on until stageBeat is exposed' },
  // Plan 0508 (spotlight + live module rescan). Both shipped with the station work; the guard
  // caught them missing here, which is exactly its job.
  spotlight:           { tool: 'presenter_spotlight' },
  modulesChanged:      { tool: 'presenter_refresh_modules' },
  // Plan 0514 — stations. The registry is core-owned DATA (declared by a plugin); occupancy is
  // NOT core's and is asked for on demand, so there is nothing here for an agent to corrupt.
  stations:            { tool: 'presenter_stations' },
  stationSet:          { tool: 'presenter_station_set' },
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
