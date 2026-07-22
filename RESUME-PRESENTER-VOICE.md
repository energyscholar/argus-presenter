# RESUME — Presenter voice/ergonomics (post-restart pickup)

## STATE (2026-07-20 ~02:xx)
**BUILD DONE + MERGED + TAGGED.** The full voice + ergonomic-core stack (Plan 0470 pipeline+F1, 0472 inbox +
guest capability link, 0473 P0–P13: bounded working-set, 4 session profiles, injection defense, barge-in) is
built, Auditor-verified phase-by-phase (V0473 47/47), and MERGED into `master`:
- Merge commit **`58f56f4`**, annotated tag **`v0.2.0-voice-ergonomic-core`**. Every AP0471 security test
  (C1/C2/C4-XSS/C3/D1/H1/M2-M4/L1) AND every V0473 gate green on the merged tree. **NOT pushed** (origin exists:
  github.com/energyscholar/argus-presenter — push is Bruce's call). Merge worktree left at
  `…/scratchpad/merge-wt`.
- Board (Artifact): https://claude.ai/code/artifact/8287d19b-2e8b-4fcd-a0f4-325ee878a573

## THE ONE OPEN THING: live voice test, driven via MCP, Bruce observing
Fix is IN CODE + CONFIG and VERIFIED (throwaway-server wiring check passed: voice serves, tools register,
port=4300, ASR env present). It just needed a TRUE MCP restart. After restart:
1. `presenter_start` (no args) → **http://127.0.0.1:4300** with voice + whisper ON (pinned in code).
2. Open Bruce's browser to it (he observes).
3. Ring **2 bells** (`presenter_bell`) — Bruce asked to prove it; bell = "speak now" signal.
4. `presenter_voice_enable` → Bruce grants mic + speaks → watch `presenter_situation`/`presenter_transcript` +
   `presenter_debug` for the transcript. That's the live functional test.

## WHAT WAS FIXED (this is why the restart was needed)
- `mcp/tools.mjs`: `presenter_start` now defaults `port = AP_STANDARD_PORT (4300)` + `voice = true` → passes
  `voiceEnabled` to `createServer`. (Was `port=0` random → the `46021`/`41719` bug.)
- `~/.claude.json` `argus-presenter` env: added `PRESENTER_ASR_CMD` (voice-env python + voice/asr-whisper.py) +
  `PRESENTER_WHISPER_MODEL=base.en`.
- **ONLY the argus-presenter MCP server needs restarting** (nothing else was touched).

## HARD LESSON (do not repeat): drive Presenter via MCP; reconnect ≠ restart
- ALWAYS drive Presenter via the argus-presenter MCP (presenter_start/bell/debug/status/push_component/
  reload_clients/situation/voice_enable). Do NOT hand-run `node app/server.mjs`. Hand-code ONLY to MEASURE/FIX
  the MCP. If a capability is missing, ADD it to the MCP surface — don't route around it.
- A `/mcp` **reconnect re-attaches to the running process** — it does NOT re-import edited code or new env. A
  TRUE process restart (fully restart Claude Code) is required to load `mcp/tools.mjs` edits or `~/.claude.json`
  env changes. Telltale of stale MCP: `/api/situation` 200 (current code loaded earlier) but the process env
  lacks your additions and `presenter_start` still returns a random port.
See [[reference-presenter-mcp-debug-interface]] [[feedback-drive-presenter-via-mcp]].
