# Examples — composed pages

Worked examples of **composition**: an authored HTML page that hosts components and shares state
with every viewer. Each is self-contained and runs against a throwaway local server, so nothing
here can touch a live deployment.

```sh
node examples/tictactoe/run.mjs      # 2 players + observers, over the shared store
node examples/showcase/run.mjs       # every component mounted into one authored page
```

Both open real headless browsers, drive them, assert on the **server store** as well as the DOM,
and leave screenshots in `test/screenshots/examples/`.

## What they demonstrate

| | |
|---|---|
| `pushPage(target, html, {mounts})` | authored markup + mounted components, assembled per viewer |
| `data-ap-bind="path"` | any HTML form control becomes shared — no component needed |
| `Argus.state / op / subscribeState` | read, write, observe: the whole shared-state model |
| per-user keys + derivation | seating without a race (see the note in `tictactoe/page.html`) |

## Two things worth knowing before you write your own

**Assert on the server, not just the screen.** A control that moves locally but never reaches
`server.store.get(path)` is not shared — it is decorative, and it looks identical.

**Run a multi-client test more than once.** A race that resolves favourably is not a pass. The
seating logic in `tictactoe` passed its first run and then handed one player both seats; the fix
was to write only your own key and derive the shared answer.

See the `presenter-interactive-composition` skill for the debugging hazards — several ordinary
instincts return confident false negatives inside the sandboxed content frame.
