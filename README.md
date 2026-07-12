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
node app/server.mjs 4300   # run the presenter server, then open http://127.0.0.1:4300
```
The test suite drives real headless-browser flows via Puppeteer (a dev dependency);
the first run downloads a browser. `node harness/test.mjs --only <name>` runs a subset.

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
`plugins/example/` for a reference plugin (a `weather` component + a `city-grid`
map preset).

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
