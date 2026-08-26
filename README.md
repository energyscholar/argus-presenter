# Argus Presenter

An interactive presentation engine and a **library of vanilla, zero-dependency
interactive components** that can be pushed to a live display in real time — for
teaching, polling, decision-making, and multi-user sessions. Built to be driven by
an AI (via MCP), a human presenter, and participants at once.

> **License:** MIT · **Status:** early, active development.

## Why
Interactive content should be **pushable on the fly** — no build step — into a
shared or per-user display, and should **report results back** cleanly so the
server (or an AI) can react. Components are plain HTML/CSS/SVG/JS so an agent can
generate, tweak, and push them live.

## Quickstart
```bash
npm ci            # install (ws is the only runtime dependency)
npm test          # run the full suite (unit + component + live/headless)
node app/server.mjs        # run the presenter server on the configured port (default 3000)
```
The test suite drives real headless-browser flows via Puppeteer (a dev dependency);
the first run downloads a browser. `node harness/test.mjs --only <name>` runs a subset.

## Run
```bash
npm start                  # runs app/server.mjs on the CONFIGURED port (default 3000)
node app/server.mjs 4300   # or pick a port explicitly (0 = auto-assign)
```
The default port is deployment configuration, not source: copy
`presenter-config.example.json` to `presenter-config.json` (gitignored) or to
`~/.config/argus-presenter/presenter-config.json` and set `presenterPort`. With no config
file anywhere it is **3000**. Set it to whatever your public ingress forwards to — a
mismatch is invisible locally and fatal remotely.
No AI required — it runs standalone. On launch it prints all three entry URLs:
- **display** `/` — the shared/per-user audience view
- **control** `/control` — the presenter control panel
- **creator** `/creator` — the content-authoring panel

Environment variables (all optional):
- `PRESENTER_MODULES_DIR` — where content modules are read from (default `./modules`).
- `PRESENTER_CONTROL_TOKEN` — when set, gates control actions + module write-back.
- `PRESENTER_ASR_CMD` — the persistent speech-recognition worker command for inbound voice
  (default `python3 voice/asr-whisper.py`, a warm faster-whisper worker). See below.
- `PRESENTER_TRANSCRIPT_PERSIST` — opt-in (default OFF). When ON, recognized transcript text is
  appended as JSONL under `PRESENTER_TRANSCRIPT_DIR` (default `.transcripts/`, gitignored).
  ⛔ **That default resolves INSIDE the release tree.** A deployment that keeps N releases and
  prunes the rest will record there successfully — visibly, at every moment you might check — and
  then lose everything to a later prune. Always set `PRESENTER_TRANSCRIPT_DIR` to an absolute path
  outside the tree. A ROOM that declares `record` other than `"none"` and names no `transcriptDir`
  (and has no `PRESENTER_TRANSCRIPT_DIR`) is refused at startup — see `presenter-config.example.json`
  under `//rooms-transcriptDir`.

## Inbound voice (optional, off by default)
A participant can speak into their browser mic; the client CPU pre-processes the audio and streams
16 kHz PCM to the server, which runs speech recognition and hands the recognized **text** to the
presenter/AI. **Audio never returns to a human, and audio is never stored** — only text, and only if
you explicitly opt in.

- **Lightweight by default.** The display page loads only a **sub-1KB stub**. The capture engine and
  DSP worklet load on demand (dynamic `import()`) the first time voice is enabled — never before, and
  **no WebAssembly** is loaded in this path. Byte budgets are CI-gated (see `test/unit/V0470-budget`).
- **Enable it** from the green-dot **Settings** overlay → **Voice → 🎙 Mic** row (default OFF), or ask
  the AI to request it with `presenter_voice_enable`. Either way the browser's **mic-permission prompt**
  is the uncoerceable gate; while the mic is hot a persistent **on-air badge** with a one-click **Stop**
  is shown. The AI can never silently hot a mic.
- **Secure context required.** `getUserMedia` needs `localhost`/`127.0.0.1` or HTTPS — plain
  `http://<lan-ip>` is blocked by the browser; use the Cloudflare tunnel (WSS) for multi-device use.
- **Read recognized speech** with the cursored `presenter_transcript` tool.
- **Recognizer.** The default ASR is a **persistent, warm** worker (model loaded once, reused across
  utterances — never cold-spawned per segment). It is pluggable via `PRESENTER_ASR_CMD`; the default
  `voice/asr-whisper.py` needs a `faster-whisper` venv (documented in that file). Optional enhancers
  (RNNoise, Silero VAD, Opus) are scaffolded but off; the MVP DSP is pure JS.
- **Transcripts are ephemeral by default** (a bounded in-memory ring). Disk persistence is opt-in
  (`PRESENTER_TRANSCRIPT_PERSIST`) and, when on, is surfaced to clients (`welcome.transcriptPersisting`).

Local content modules go in `modules/` and are **gitignored** (this public repo ships
only the neutral `demo-welcome` module — your own content is never committed here).

## Layout
```
lib/         foundation: bridge (result protocol), theme (tokens), a11y helpers
components/  the core component library (choice, poll-results, map, form, dice, …)
app/         the presenter server (per-user channels, push, state store) + pages
mcp/         MCP server — how an AI drives the presenter (push / ask / poll / results)
harness/     assemble (package a component) + drive (headless test rig) + manifest
plugins/     optional domain bundles (extra components / scenes / map presets)
test/        unit · component · live tiers
docs/        component-manifest.json (generated field-schema catalog)
```

## Core idea: the result bridge
Every interactive component reports out through one tiny bridge (`lib/bridge.js`):
identity-stamped (`userId`, `userName`, `channel`), correlated by `promptId`, and
working whether the component is embedded in the presenter or run standalone. A
path-addressed store (`app/state.mjs`) is the authoritative reducer; the server
broadcasts permission-filtered diffs, and components subscribe to the slices they
render.

## Multi-user by default
Three user classes — **AI**, **human presenter**, **participant** — each with a
UID + name. Aggregation patterns (e.g. **poll/vote across N users**) are
first-class, and content can be pushed to `all`, a role, or a single user.

## Plugins
Core ships **domain-neutral**. Optional bundles live in `plugins/<name>/` with a
`plugin.json` manifest declaring components, map presets, and field schemas. The
assembler bundles core **plus exactly** the transitive closure of a content
module's declared `requires` — no `requires` means zero plugin bytes. See
`test/fixtures/plugins/example/` for a reference plugin (a `weather` component +
a `city-grid` map preset).

⛔ **This repo ships no plugins.** `plugins/` is an install target only — real
plugins live in `repertory` (private), because plugin content is not necessarily
publishable and this repo is public. The reference plugin above is a **test
fixture**: it exists so the engine can prove the plugin *mechanism* without
knowing any real plugin's name.

**Installing a plugin is a copy plus a proof.** `plugins/` is gitignored, so a
partial install leaves no trace in `git status` and looks exactly like a complete
one — this deployment ran for months with 8 of one plugin's 24 files present, its
thirteen declared station artworks silently absent and degrading to placeholders.
Install from the repo that versions the bundle, using that repo's installer
(`tools/install-system-plugins.sh` in the content repo), which copies and then
verifies file sets, md5s, and every file the manifest declares. `t0532-02` holds
the same line from this side: an installed plugin missing a file its own
`plugin.json` names is a **red test**, not a warning in a log nobody reads.

## Security posture
- **No telemetry egress.** The server makes no outbound network calls. The only
  sockets are the local HTTP page server and its WebSocket. Telemetry is an
  in-process, controller-read-only sink — nothing is sent to any third party.
- **Sandboxed content.** Pushed component HTML renders in an `iframe` with
  `sandbox="allow-scripts"` (opaque origin): it can `postMessage` results out but
  cannot reach the host page, cookies, or same-origin storage.
- **Default-deny permissions.** The state store denies participant writes on
  ungated paths/verbs; only explicitly gated slices (e.g. a user's own vote) are
  writable, and presenter/AI roles override. Identity is taken from the
  authenticated connection, never from the client payload.
- **No prototype pollution.** Store paths are sanitized (`__proto__` / `prototype`
  / `constructor` / traversal segments rejected) over a null-prototype tree.
- **Resource caps.** Per-connection durable-op rate limiting, a max-connection
  cap, and a per-frame payload cap bound abuse.

## License
MIT — see [LICENSE](./LICENSE).
