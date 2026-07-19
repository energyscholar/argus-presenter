# Driving Argus Presenter via MCP — the only supported way

**Rule: ALWAYS and ONLY drive the live Presenter through the MCP server.**
Do **not** `node app/server.mjs` by hand, do **not** open a raw WebSocket to the
presenter, and do **not** drive it by reading internals. The MCP tool surface
(`mcp/tools.mjs`) manages a **single, in-process presenter instance it creates
itself**. A presenter you start by hand is an **orphan** the tools cannot see or
control — you will not be able to `reload_clients`, `push_component`, or
`present_module` to the clients a browser is actually connected to.

Reading source / running Puppeteer / running the unit suite for **diagnosis** is
fine — that is inspecting, not driving. **Driving the live presenter is MCP-only.**

## One-time setup (registering the server)

The presenter MCP server is a stdio server at `mcp/server.mjs`. Register it with
whatever MCP client drives it. For Claude Code, the project that uses Presenter
(`~/software/has-anyone-looked`) carries:

```jsonc
// has-anyone-looked/.mcp.json
{ "mcpServers": { "argus-presenter": {
  "command": "node",
  "args": ["/home/bruce/software/argus-presenter/mcp/server.mjs"]
} } }
```

`MODULES_DIR` resolves via `__dirname` to `argus-presenter/modules`, so no `cwd`
or env is required. Dependencies (`@modelcontextprotocol/sdk`, `zod`, `ws`) resolve
from the repo's `node_modules`. After adding the config, reconnect MCP (`/mcp`);
the `presenter_*` tools then appear in-session.

## The tool surface (14 tools)

| Tool | Purpose |
|------|---------|
| `presenter_start` `{port?}` | Start the (single) presenter server; returns the URL to open. `port:0` = random. |
| `presenter_stop` | Stop it. |
| `presenter_status` | Running? URL + connected users (presence). |
| `present_module` | Load a content module and begin delivering it. |
| `next_beat` | Advance to the next beat. |
| `append_beat` | Add a beat on the fly (compose / co-author). |
| `push_component` `{target,component,opts,...}` | Assemble one component/scene and push it to `all` \| a role \| a userId. |
| `open_poll` / `get_poll` / `close_poll` | Live polling. |
| `reload_clients` `{target?,delay?}` | Hot-reload connected clients (swap code without dropping them). |
| `presenter_debug` / `presenter_health` | Introspection / health. |
| `presenter_raf` | RAF control-plane action. |

## Typical flow: show a module

1. `presenter_start` → open the returned URL (or `reload_clients` if already open).
2. `present_module` with the module → title beat shows.
3. `next_beat` to walk it; `push_component` for ad-hoc content; `reload_clients`
   after any code/module change so open clients pick it up **without** a manual
   browser reload.
4. `presenter_stop` when done.

## Note: content is SVG/text, scripts are blocked

Content-module scripts are blocked and `card`/`scene` render text-only. For math
and rich content, push **SVG** (via the `map` component's `opts.svg`, or the
`image` component) using SVG `<text>`/tspans — see `feedback-presenter-svg-positioning`
(top margin ≥ y=100, x ≥ 60). MathML/KaTeX-via-script will not run.

## Fixed here: control module-list no longer goes stale (2026-07-19)

`control.html` used to fetch the module `<select>` **once at page-init** and never
re-scan on reconnect, so a server restart / instance-swap / unlock-reconnect left
the dropdown frozen (a dropped-in module never appeared). Fix: `ws.onopen` now
calls `refreshModules()` on every (re)connect, and the scan fetch uses
`{cache:'no-store'}`. Verified: wiping the dropdown then dropping the socket
self-heals the list on reconnect. Regression: `AUT2-hotreload`, `P1-control`,
`P5-open-control`, `LED1`, `X1-resync` all pass.
