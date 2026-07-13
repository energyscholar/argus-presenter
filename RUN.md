# Running Argus Presenter (no AI in the loop)

A short runbook for driving the presenter by hand: start the server, become the
presenter, open the control, and deliver a content module beat by beat. No agent
required — you drive every step from the browser.

## 1. Start the server

```bash
npm start                     # runs app/server.mjs on the default port (4300)
# or
node app/server.mjs 4300      # pick a port explicitly (0 = auto-assign)
```

On launch it prints the three entry URLs:

```
Argus Presenter running:
  display : http://127.0.0.1:4300/
  control : http://127.0.0.1:4300/control
  creator : http://127.0.0.1:4300/creator
```

- **display** `/` — the audience view (what everyone sees).
- **control** `/control` — the presenter control panel.
- **creator** `/creator` — the content-authoring panel.

The self-run server is **gated**: becoming the presenter needs a password. The
default is `password` (override with `PRESENTER_ROLE_PASSWORD`).

Content modules are local JSON files read from `modules/` (override with
`PRESENTER_MODULES_DIR`). This repo ships only the neutral `demo-welcome`
module; your own content stays local and gitignored.

## 2. Become the presenter

1. Open the **display** `/` in a browser. You start as a plain **User**.
2. Click the **green dot** (top-left, Settings) to open the Config panel.
3. In the **Role** row, click **Presenter**. A password field appears.
4. Type the password (`password`) and click **Unlock**.
   - Correct password → your role becomes Presenter.
   - Wrong/blank password → you stay **User** and see an error; nothing else changes.

## 3. Open (and later collapse) the control

1. Still in Config, click **▮ Show Presenter Control**.
2. A full-screen overlay expands, hosting the `/control` panel. The display page
   underneath **stays connected** the whole time.
3. To go back, click **✕ Close** on the overlay — it shrinks back to the Config
   panel and tears the control panel down. The display socket is never dropped.

## 4. Deliver content

In the control panel:

1. Select **demo-welcome** in the module list → click **Load**.
   - Its **title page** appears on the display. That is the `defaultBeatId`
     cascade: a module that declares a title beat shows it on Load.
2. Click **Start** / **Next** to walk the beats one at a time. The display
   follows in lockstep.
3. Click **⌂ Home** to jump back to the title page at any time.
4. Click **■ STOP** to end — the display returns to the idle branding.

## 5. Real content (optional, local)

If you keep your own module locally, symlink or drop it into `modules/`
(e.g. `modules/my-content.json` — gitignored), then select it and **Load**.

A module **without** a `defaultBeatId` stays on branding after Load until you
press **Start** — that is expected; the title page is authored per module, so a
module that doesn't declare one simply has no title page to show yet.

## Cascade summary

| Situation | Display shows |
|-----------|---------------|
| No module loaded | idle **branding** |
| Module loaded, has `defaultBeatId` | that module's **title page** |
| Module loaded, no `defaultBeatId` | idle **branding** (until Start) |
| **⌂ Home** | the module's title page |
| **■ STOP** / end of module | idle **branding** |

## Environment variables

- `PRESENTER_MODULES_DIR` — directory content modules are read from (default `./modules`).
- `PRESENTER_ROLE_PASSWORD` — the presenter-role password (CLI self-run defaults to `password`).
- `PRESENTER_CONTROL_TOKEN` — when set, additionally gates control actions + module write-back.
