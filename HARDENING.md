# Hardening — Argus Presenter (HAR)

Defense-in-depth notes for the HTTP/WebSocket boundary. This complements the op-protocol
security model (default-deny paths, prototype-pollution guard, conn-namespaced opIds,
payload caps — see `test/live/X7-hardening.test.mjs`).

## Content-Security-Policy

The three HTML routes (`/`, `/control`, `/creator`) ship one shared CSP:

```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src  'self' 'unsafe-inline';
img-src    'self' data:;
font-src   'self' data:;
connect-src 'self' ws: wss:;
frame-src  'self' blob: data:;
object-src 'none';
base-uri   'self';
form-action 'self';
```

plus `X-Content-Type-Options: nosniff`.

### Why `'unsafe-inline'` is required *today*

- **Inline scripts/styles.** `presenter.html`, `control.html`, and `creator.html` embed
  their logic and styling in inline `<script>`/`<style>` blocks (single-file pages, no
  bundler).
- **Sandboxed component iframes.** Each rendered component is an isolated `srcdoc` iframe
  (see below) whose body runs an inline `<script>`. Those execute under the parent CSP.

So the policy must currently permit inline execution. Everything else is locked to
same-origin: no remote script/style/font/img hosts, `object-src 'none'`, `base-uri 'self'`.

### Why the other allowances exist

- `connect-src ... ws: wss:` — the live WebSocket transport. The client auto-selects
  `wss://` on an `https://` page and `ws://` otherwise; both must be admitted.
- `frame-src 'self' blob: data:` — the sandboxed `srcdoc` component iframes resolve to
  an opaque `blob:`/`data:`-style origin; without this they are blocked.
- `img-src`/`font-src ... data:` — components inline small assets as `data:` URIs
  (self-contained, no external fetch).

### Future path: nonces (drop `'unsafe-inline'`)

The clean upgrade is a per-response nonce: generate a random nonce per HTML request,
stamp `nonce="…"` on every inline `<script>`/`<style>` (including the assembled component
`srcdoc`), and switch the directives to `script-src 'self' 'nonce-…'`. This removes
`'unsafe-inline'` entirely. It requires threading the nonce through `harness/assemble.mjs`
so component inline scripts inherit it — deferred until the page templates are nonce-aware.

## Sandboxed-iframe isolation model

Component HTML is never injected into the presenter DOM directly. The client renders each
component into a **sandboxed `srcdoc` iframe**, so component script runs in a separate
browsing context with no direct access to the host page's DOM, cookies, or socket. The
component talks to the host only through the constrained `postMessage` channel the host
listens on. This is the primary blast-radius control for untrusted/authored content;
the CSP is a second layer on top.

## Static-asset caching (ETag / 304)

`/branch.mjs`, `/validate.mjs`, and `/branding/argus-presenter.svg` are served via a shared
`sendStatic()` helper that computes a **weak ETag** from the file's `size` + `mtimeMs`
(`W/"<size>-<mtimeMs>"`) and sets `Cache-Control: no-cache` (i.e. *always revalidate*, never
serve stale). A conditional request whose `If-None-Match` matches gets a bodyless **304**.
This trims bandwidth for the repeatedly-imported single-source `.mjs` modules and the idle
branding art while still picking up on-disk edits immediately (the ETag changes with mtime).

## TLS / remote access

- **Localhost + LAN:** plain `http://` + `ws://` is fine. No TLS needed for same-machine or
  trusted-LAN sessions; this is the default dev/presentation posture.
- **Open-internet players, or microphone / voice features:** you need `https://` + `wss://`.
  Browsers require a secure context for `getUserMedia` (mic), and — critically — an
  **`https://` page cannot open a `ws://` socket** (mixed content is blocked). The client
  already auto-selects `wss://` when served over `https://`, so the only requirement is
  terminating TLS in front of the node server.
- **How:** put the server behind a TLS-terminating reverse proxy (nginx/Caddy) or a
  **Cloudflare tunnel** (`cloudflared`) that presents `https`/`wss` publicly and forwards to
  the local `http`/`ws` server. The proxy also supplies the `X-Forwarded-For` the server
  already reads for the control-only client IP column.
- **Mixed-content reminder:** serve the page and the socket over the *same* scheme. `https`
  page ⇒ `wss` socket; `http` page ⇒ `ws` socket. Don't mix.
