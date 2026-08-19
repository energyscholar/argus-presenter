/*
 * Argus Presenter — the HTTP route table.
 *
 * Plan 0530 P2 (seam S-A). Lifted VERBATIM out of `createServer()` in app/server.mjs, where it
 * was an inline 262-line if/else chain inside a 3,566-line closure. ⛔ THIS WAS A MOVE, NOT A
 * REWRITE: every branch, header, status code, error string and log line is byte-identical to what
 * it was inline. Behaviour is unchanged by construction, and the plan's equivalence fingerprint
 * says so.
 *
 * Because the handler used to CLOSE OVER createServer()'s state, every one of those captured
 * bindings is now an explicit dependency. They are passed in a context object whose keys are
 * spelled exactly as the body already spelled them, and destructured back into scope at the top of
 * the handler — which is why the body below could be copied without touching a character.
 *
 * ⚠ THERE IS NO IMPORT BACK INTO server.mjs. That is deliberate and load-bearing: a cycle would
 * mean the seam was cut in the wrong place. The four module-level helpers this code needs from
 * server.mjs (renderPresenterPage, htmlHeaders, sendStatic, MODULE_STATUSES) therefore arrive
 * through the context like everything else, rather than by importing their defining module.
 *
 * ⚠ `api` is read PER REQUEST, not once at wiring time. In server.mjs the `const api = {…}` is
 * declared ~2,400 lines BELOW the http.createServer() call, so at the moment this handler is
 * constructed `api` is still in its temporal dead zone. The context exposes it as a getter; the
 * destructure below runs on each request, by which time it exists.
 */
import { readFileSync, writeFileSync, existsSync, lstatSync } from 'fs';
import { join } from 'path';
import * as log from './log.mjs';
import { validate, summarize } from './validate.mjs';

/**
 * Build the node `http` request listener.
 *
 * @param {object} ctx  the server's captured state and helpers — see CTX in the plan's P2 notes.
 *                      `ctx.api` MUST tolerate being read lazily (server.mjs passes a getter).
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => void}
 */
export function createHttpHandler(ctx) {
  return function httpRequestHandler(req, res) {
    // Destructured PER REQUEST — see the `api` note in the file header. Every name here is a
    // binding the handler used to capture from createServer()'s closure.
    const {
      __dirname, api, ARCHIVE_DIR, BRANDING, catalogueReadAuthed, CONTROL,
      CONTROL_TOKEN, htmlHeaders, httpControlAuthed, LIB, listModules, listModulesAdmin,
      listSeries, MODULE_STATUSES, moduleAdminOp, moduleCache, MODULES_DIR, moduleSummary,
      moduleWriteAuthed, pvsConsumerKey, readModuleFile, readSeriesFile, renderPresenterPage, ROLE_HASH,
      ROLE_SEED, sendStatic, sessionLog, sessionLogReadAuthed, VOICE_ENABLED, oidcAuth, authState,
      breakGlassAuth,
    } = ctx;
    // Plan 0543 P2 — OIDC login flow. Three routes; all a clean 404 when OIDC is not configured
    // (opt-in, never a half-open door). The session cookie is HttpOnly+Secure+SameSite=Lax and holds
    // a server-side session id ONLY. ⚠ It must be readable at the WS upgrade on the tunnel origin —
    // an integration seam verified against the live tunnel, not by the offline suite.
    if (req.url === '/auth/login' || req.url.startsWith('/auth/login?')) {
      const begin = oidcAuth && oidcAuth.active && oidcAuth.beginLogin();
      if (!begin) { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'oidc not configured' })); return; }
      res.writeHead(302, { location: begin.url, 'cache-control': 'no-store' }); res.end(); return;
    }
    if (req.url.startsWith('/auth/callback')) {
      if (!oidcAuth || !oidcAuth.active) { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'oidc not configured' })); return; }
      const query = Object.fromEntries(new URLSearchParams(req.url.split('?')[1] || ''));
      /* ⛔ AN AUTH FAILURE THAT LOGS NOTHING IS UNDIAGNOSABLE. Both branches below used to redirect
       *   to /?auth=failed in silence, so a sign-in that stopped working left the operator with a
       *   query string and no cause — no reason, no error, nothing in the journal. The reason is
       *   NEVER shown to the browser (it can carry provider detail); it goes to the log, where the
       *   person fixing it is looking. */
      oidcAuth.completeLogin(query).then((r) => {
        if (r && r.ok) {
          res.writeHead(302, { location: '/control', 'set-cookie': oidcAuth.sessionCookie(r.sid), 'cache-control': 'no-store' }); res.end();
        } else {
          try { api.log && api.log.warn('auth', 'oidc-login-failed', { reason: (r && (r.reason || r.error)) || 'no reason given', hasCode: !!query.code, hasState: !!query.state }); }
          catch (e) { console.error('oidc login failed:', (r && (r.reason || r.error)) || 'no reason given', 'code:', !!query.code, 'state:', !!query.state); }
          res.writeHead(302, { location: '/?auth=failed', 'cache-control': 'no-store' }); res.end();
        }
      }).catch((e) => {
        try { api.log && api.log.warn('auth', 'oidc-login-threw', { err: String((e && e.message) || e).slice(0, 200) }); }
        catch (_) { console.error('oidc login threw:', String((e && e.message) || e)); }
        console.error('oidc login threw:', String((e && e.message) || e));
        res.writeHead(302, { location: '/?auth=failed', 'cache-control': 'no-store' }); res.end();
      });
      return;
    }
    /*
     * ── Plan 0650 §2b — POST /auth/break-glass: THE LOCK THE STARTUP GATE HAS BEEN DEMANDING ────
     *
     * `enforceOAuth:'control'` has refused to start without a break-glass credential since 0543,
     * naming its shape in the error message — loopback-only, single-use, TTL, 0600 file — and NO
     * ROUTE HAS EVER ACCEPTED ONE. This is that route. It grants a control SESSION (the Control
     * page and the presenter/gm roles) and never `trust:self`; see deriveConnTrust in server.mjs.
     *
     * ⛔ A CLEAN 404 WHEN UNCONFIGURED, exactly like /auth/login: no half-open door, and nothing
     * about the credential's existence leaks from a deployment that has none.
     *
     * ⚠ THE REFUSAL REASON IS RETURNED, AND THAT IS SAFE BY ORDERING. `not-loopback` is decided
     * FIRST in the adapter, so a remote caller can only ever learn that it is remote — never
     * whether the credential was right, already spent, or expired. The operator standing at the
     * box at 2am is the only one who sees the useful reasons, and they need them.
     */
    if (req.url === '/auth/break-glass' || req.url.startsWith('/auth/break-glass?')) {
      const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      if (!breakGlassAuth || !breakGlassAuth.active) { json(404, { error: 'break-glass not configured' }); return; }
      if (req.method !== 'POST') { json(405, { error: 'POST only' }); return; }
      let body = '';
      let overflow = false;
      req.on('data', (d) => { body += d; if (body.length > 4096) { overflow = true; try { req.destroy(); } catch {} } });
      req.on('end', () => {
        if (overflow) return;
        let presented = null;
        try { const q = JSON.parse(body || '{}'); if (q && typeof q.token === 'string') presented = q.token; } catch (e) { presented = null; }
        const r = breakGlassAuth.redeem(req, presented);
        if (!r || !r.ok) { json(403, { ok: false, reason: (r && r.reason) || 'refused' }); return; }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
          'set-cookie': breakGlassAuth.sessionCookie(r.sid),
        });
        res.end(JSON.stringify({ ok: true, note: 'break-glass session granted: Control page only, NOT command authority. Single-use — this credential is now spent.' }));
      });
      return;
    }
    if (req.url === '/auth/logout' || req.url.startsWith('/auth/logout?')) {
      const headers = { location: '/', 'cache-control': 'no-store' };
      if (oidcAuth) { oidcAuth.logout(req); headers['set-cookie'] = oidcAuth.clearCookie(); }
      res.writeHead(302, headers); res.end(); return;
    }
    if (req.url === '/' || req.url.startsWith('/?')) {
      // Plan 0473 P0: strip the voice block(s) unless voice is enabled ⇒ zero voice bytes when off.
      res.writeHead(200, htmlHeaders());
      res.end(renderPresenterPage(VOICE_ENABLED));
    } else if (req.url === '/diag' || req.url.startsWith('/diag?')) {
      /* SELF-CHECK. Serves a page that runs entirely in the browser and TRANSMITS NOTHING — no
         beacon, no logging, no storage, no endpoint behind it. Added 2026-08-12 after sign-in went
         missing on one browser while the server proved healthy from three angles (tunnel, loopback,
         stale cookie). ⭐ A remote-debug channel that ships browser state to a server is a new place
         for identity to leak; this asks the person to read their own screen instead.
         ⛔ UNGATED, for the same reason /auth/login is: the one page that diagnoses "I cannot get
         in" must not itself require getting in. It exposes nothing a caller could not already learn
         from /api/auth-state, which is redacted by design. */
      res.writeHead(200, htmlHeaders());
      res.end(readFileSync(CONTROL.replace(/control\.html$/, 'diag.html'), 'utf8'));
    } else if (req.url === '/control' || req.url.startsWith('/control?')) {
      res.writeHead(200, htmlHeaders());
      res.end(readFileSync(CONTROL, 'utf8'));
    } else if (req.url === '/manage' || req.url.startsWith('/manage?')) {
      // Plan 0522 P12 (R12) — Manage Modules. A SEPARATE page, deliberately not a panel on
      // /control: curating the catalogue is between-sessions work and the picker is in-session
      // work, and the surface that carried ~95% of the clicks in a measured live session should
      // not grow a control whose whole purpose is to make modules disappear. Served exactly like
      // /control and /creator; the credential is entered on the page, never in the served HTML.
      res.writeHead(200, htmlHeaders());
      res.end(readFileSync(join(__dirname, 'manage.html'), 'utf8'));
    } else if (req.url === '/creator' || req.url.startsWith('/creator?')) {
      // AUT-3: the Content Creator authoring panel (beat-list editor + manifest + in-browser
      // validate + live preview). Served exactly like /control.
      res.writeHead(200, htmlHeaders());
      res.end(readFileSync(join(__dirname, 'creator.html'), 'utf8'));
    } else if (req.url === '/branch.mjs') {
      // DEL-2: serve the SINGLE-SOURCE branch resolver to the browser panel so the
      // GM outline imports the SAME resolveNext the server/runner use (no duplication).
      sendStatic(res, req, join(__dirname, 'branch.mjs'), 'text/javascript; charset=utf-8');
    } else if (req.url === '/validate.mjs') {
      // AUT-3: serve the SINGLE-SOURCE validator so the Content Creator imports the SAME
      // validate()/summarize() the server uses (no duplication) for in-browser validation.
      sendStatic(res, req, join(__dirname, 'validate.mjs'), 'text/javascript; charset=utf-8');
    } else if (req.url === '/lib/breakdown.js') {
      // Plan 0539 P1.7 — the SHARED "show the arithmetic" renderer. Served to the host page here and
      // INLINED into every component page by harness/assemble.mjs, so a non-dice caller (the station
      // skill of roadmap 0541) reaches the identical renderer from either side of the iframe.
      // ⛔ NOT under the voice fence: this is not voice, and the fence is deleted when voice is off.
      sendStatic(res, req, join(LIB, 'breakdown.js'), 'text/javascript; charset=utf-8');
    } else if (req.url === '/lib/voice-stub.js') {
      // Plan 0470 Tier 0: the sub-1KB always-on voice stub (dynamic-imports Tier 1 on enable()).
      sendStatic(res, req, join(LIB, 'voice-stub.js'), 'text/javascript; charset=utf-8');
    } else if (req.url === '/lib/voice-capture.mjs') {
      // Plan 0470 Tier 1 controller — served only when a client enable()s voice (T-LAZY).
      sendStatic(res, req, join(LIB, 'voice-capture.mjs'), 'text/javascript; charset=utf-8');
    } else if (req.url === '/lib/voice-worklet.js') {
      // Plan 0470 Tier 1 DSP worklet (pure JS; loaded via audioWorklet.addModule).
      sendStatic(res, req, join(LIB, 'voice-worklet.js'), 'text/javascript; charset=utf-8');
    } else if (req.url === '/branding/argus-presenter.svg') {
      // Default idle branding art (self-contained animated SVG; no external dep).
      sendStatic(res, req, BRANDING, 'image/svg+xml; charset=utf-8');
    } else if (req.url === '/api/auth' || req.url.startsWith('/api/auth?')) {
      // AUTH-ROLE (P5.5): tell the client whether the presenter role is gated + the public
      // SALT it must hash with. NEVER returns ROLE_HASH, ROLE_PW, or CONTROL_TOKEN — only the
      // seed (public by design) and a boolean. The browser computes sha256(seed+password).
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(JSON.stringify({ gated: !!(CONTROL_TOKEN || ROLE_HASH), seed: ROLE_SEED }));
    } else if (req.url === '/api/auth-state' || req.url.startsWith('/api/auth-state?')) {
      /*
       * Plan 0551 P3 — CAN I SIGN IN HERE, AND AM I SIGNED IN? The one question every client page
       * must be able to ask, and the reason 0543's sign-in was invisible: nothing could ask it.
       *
       * ⛔ UNGATED ON PURPOSE, and safe to be. An anonymous phone MUST be able to learn that a
       * sign-in control exists — that is the whole feature — and the answer carries only a boolean
       * about the SERVER plus this caller's own state. Never an email, never `sub`, never a session
       * id, never another participant's anything. See authState() in server.mjs.
       *
       * ⚠ This branch must stay ABOVE nothing in particular but must never be folded into
       * /api/auth: that route answers "is the tissue-thin password gate on", a different question
       * about a different credential, and merging them would put a password readout on a route
       * whose whole point is that anonymous callers may read it.
       */
      const state = (typeof authState === 'function') ? authState(req) : { oidcActive: false, signedIn: false, name: null, trust: 'participant' };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(state));
    } else if (req.url === '/api/modules' || req.url.startsWith('/api/modules?')) {
      // Discover available modules (id, title, counts, validation summary) — for the GM panel's SELECT list.
      // ⚠ The `?...` arm is Plan 0529 P2. This branch was an EXACT match, so `/api/modules?token=…`
      // matched nothing (it does not start with `/api/modules/` either) and fell through to a bare
      // 404 — which reads as "no such route" when the truth is "wrong credential". The header
      // carrier hid it: control.html sends x-control-token, so nothing in the product noticed.
      // /api/session-log and /api/situation already spell their routes this way; these two did not.
      // CONTROL-ONLY, FAILS CLOSED — see catalogueReadAuthed.
      const a = catalogueReadAuthed(req, '/api/modules');
      // Plan 0532 P3 — `reason` travels with the refusal so the picker can say WHY it is empty.
      if (!a.ok) { res.writeHead(a.code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: a.error, reason: a.reason })); return; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(listModules()));
    } else if (req.url === '/api/module-admin' || req.url.startsWith('/api/module-admin?')) {
      // Plan 0522 P12 — the curation LIST. Gated on the same credential as the write, because it
      // is the write surface's own view: an operator who cannot act on it has no use for it, and
      // it reports which files are unreadable (a small map of the box's disk).
      const a = moduleWriteAuthed(req, null);
      if (!a.ok) { res.writeHead(a.code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: a.error })); return; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(JSON.stringify({ dir: MODULES_DIR, archive: ARCHIVE_DIR, statuses: MODULE_STATUSES, modules: listModulesAdmin() }));
    } else if (req.url.startsWith('/api/module-admin/')) {
      // Plan 0522 P12 — the curation WRITE: set `status`, or retire (MOVE to _archive/).
      // ⚠ It is a SEPARATE route from POST /api/modules/:id on purpose. That endpoint replaces a
      // module WHOLESALE (the Content Creator's save); this one edits one manifest field or
      // relocates the file. Folding curation into a whole-body PUT would mean the panel had to
      // round-trip every module's entire content — including the 2 MB one — to change a word.
      const rawPath = req.url.slice('/api/module-admin/'.length);
      const id = decodeURIComponent(rawPath.split('?')[0]);
      if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'method not allowed' })); return; }
      const a = moduleWriteAuthed(req, rawPath);
      if (!a.ok) { res.writeHead(a.code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: a.error })); return; }
      const CAP = 16 * 1024; let body = ''; let aborted = false;
      req.on('data', (chunk) => { if (aborted) return; body += chunk; if (body.length > CAP) { aborted = true; res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'too large' })); req.destroy(); } });
      req.on('end', () => {
        if (aborted) return;
        let msg; try { msg = JSON.parse(body || '{}'); } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'invalid json' })); return; }
        const out = moduleAdminOp(id, msg);
        res.writeHead(out.code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out.body));
      });
    } else if (req.url.startsWith('/api/modules/')) {
      const rawPath = req.url.slice(13);
      const id = decodeURIComponent(rawPath.split('?')[0]);
      if (req.method === 'POST') {
        // AUT-1: module write-back. The Content Creator POSTs a module JSON; it lands in
        // MODULES_DIR so listModules()/the GM <select> discovers it. MUTATION → guarded:
        // AUTH-gated (when a control token is configured), path-safe id, hard size cap.
        // Plan 0471 H1: gate on ANY control credential (was CONTROL_TOKEN-only, so a
        // rolePassword/ROLE_HASH-gated deployment left this write endpoint OPEN). Mirror the
        // WS control gate: require a token matching CONTROL_TOKEN OR ROLE_HASH when either is set.
        // Plan 0522 P12 (R15): and require one UNCONDITIONALLY — see moduleWriteAuthed.
        const auth = moduleWriteAuthed(req, rawPath);
        if (!auth.ok) { res.writeHead(auth.code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: auth.error })); return; }
        // id guard: no path separators / traversal (reuse readModuleFile's rule).
        if (!/^[\w.-]+$/.test(id)) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'bad id' })); return; }
        // Body with a HARD size cap — accumulate, abort past the cap.
        const CAP = 512 * 1024;
        let body = ''; let aborted = false;
        req.on('data', (chunk) => {
          if (aborted) return;
          body += chunk;
          if (body.length > CAP) { aborted = true; res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'too large' })); req.destroy(); }
        });
        req.on('end', () => {
          if (aborted) return;
          let module;
          try { module = JSON.parse(body); } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'invalid json' })); return; }
          try {
            const target = join(MODULES_DIR, id + '.json');
            // Plan 0482 A7 (DATA-LOSS PREVENTION): writeFileSync FOLLOWS SYMLINKS. A module file in
            // MODULES_DIR may be a symlink into a live source tree, so a write-back through it would
            // silently overwrite the real source (and the fs watcher would then hot-reload the
            // wreckage). Refuse LOUDLY rather than destroy the link target. lstat does not follow.
            if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
              log.warn('modules', 'writeback-refused-symlink', { id, target, reason: 'refusing to write through a symlink' });
              res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: 'refusing to write through a symlink', id }));
              return;
            }
            writeFileSync(target, JSON.stringify(module, null, 2));
            moduleCache.delete(id);   // invalidate so the next read reflects the write
          } catch (e) { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: String(e.message || e) })); return; }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, id, validation: summarize(validate(module)) }));
        });
        return;
      }
      // Fetch ONE module (full JSON + validation) so the panel can validate-then-load.
      // Plan 0529 P2 — CONTROL-ONLY, FAILS CLOSED. This is the route that mattered most: the LIST
      // leaks titles, but this one hands over the whole authored file — every unrevealed beat in it.
      const ra = catalogueReadAuthed(req, '/api/modules/:id');
      if (!ra.ok) { res.writeHead(ra.code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: ra.error, reason: ra.reason })); return; }
      let module = null; try { module = readModuleFile(id); } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: String(e.message || e) })); return; }
      if (!module) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ id, module, validation: summarize(validate(module)) }));
    } else if (req.url === '/api/session-log' || req.url.startsWith('/api/session-log?')) {
      /*
       * ── Plan 0522 P16.2 (R6) — READING THE DURABLE LOG IS ROLE-GATED, AND FAILS CLOSED ──────
       *
       * This endpoint serves the session's op-log off disk. That log carries the session
       * TRANSCRIPT: a `t:'chat'` message is applied as an op on `chat` (see handleOp below), so
       * these lines are participants' own words.
       *
       * ⚠ THE RULING, RECORDED BECAUSE IT SHOULD OUTLIVE THE DECISION. Bruce's first call was
       * "no need to protect the log". Shown that an ungated endpoint on a publicly-reachable
       * host makes THIRD PARTIES' speech world-readable to anyone holding the url, he ruled
       * role-gated. The people whose words these are were not in the room for that conversation.
       *
       * FAIL CLOSED, unlike /api/situation. Every other read gate here is "ungated ⇒ open", and
       * that is right for them: an ungated deployment is a LAN/test posture. It is NOT right
       * here, and the reason is P16.1's own finding — presenter_start raises a PUBLIC ingress,
       * and the ungated-and-public combination is a real observed state of this deployment, not
       * a hypothetical. "No credential configured" is not "no gate to apply"; it is "nothing to
       * verify against", and the only safe answer to an unverifiable request for other people's
       * speech is no. Same reasoning as moduleWriteAuthed (P12/R15), different harm.
       *
       * NO SECOND AUTH SCHEME: the credential is the SAME control credential the ws control
       * roles (presenter/ai — CONTROL_ROLES) authenticate with, i.e. CONTROL_TOKEN or the
       * roleSeed+rolePassword hash.
       */
      const a = sessionLogReadAuthed(req);
      if (!a.ok) { res.writeHead(a.code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: a.error })); return; }
      const qs = new URLSearchParams((req.url.split('?')[1] || ''));
      const rawLimit = parseInt(qs.get('limit') || '', 10);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 2000) : 200;
      const wanted = qs.get('session') || sessionLog.sessionLogId;
      const st = sessionLog.status();
      let payload;
      try { payload = st.enabled ? sessionLog.read({ sessionLogId: wanted, limit }) : { sessionLogId: wanted, entries: [], parts: [], bytes: 0, truncated: false, unparsedLines: 0 }; }
      catch (e) { payload = { sessionLogId: wanted, entries: [], parts: [], bytes: 0, truncated: false, unparsedLines: 0, error: String((e && e.message) || e) }; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      // Enumerated, never spread: `parts` means one thing on the status object (this run's part
      // FILENAMES) and another on a read (the requested session's parts with sizes). One name,
      // one meaning — docs/naming-canon.md rule zero.
      res.end(JSON.stringify({
        enabled: st.enabled,
        sessionLogDir: st.sessionLogDir,
        sessionLogDirSource: st.sessionLogDirSource,
        sessionLogDirError: st.sessionLogDirError,
        caps: st.caps,
        stats: st.stats,
        currentSessionLogId: sessionLog.sessionLogId,
        sessions: sessionLog.sessions(),
        limit,
        sessionLogId: payload.sessionLogId,
        entries: payload.entries,
        entryParts: payload.parts,
        bytes: payload.bytes,
        truncated: payload.truncated,
        unparsedLines: payload.unparsedLines,
      }));
    } else if (req.url === '/api/series' || req.url.startsWith('/api/series?')) {
      // Discover available series (id, title, module count) — for the GM panel's series SELECT.
      // The `?...` arm is Plan 0529 P2 — same exact-match gap as /api/modules above.
      // CONTROL-ONLY, FAILS CLOSED — see catalogueReadAuthed.
      const a = catalogueReadAuthed(req, '/api/series');
      if (!a.ok) { res.writeHead(a.code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: a.error, reason: a.reason })); return; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(listSeries()));
    } else if (req.url.startsWith('/api/series/')) {
      // Fetch ONE series: its manifest + moduleIds, plus each module resolved to the SAME
      // summary shape as listModules (missing ids → { id, error:'missing' }).
      // Plan 0529 P2 — CONTROL-ONLY, FAILS CLOSED. A series enumerates the modules a run will walk;
      // ungated it is a table of contents for material nobody has been shown yet.
      const sa = catalogueReadAuthed(req, '/api/series/:id');
      if (!sa.ok) { res.writeHead(sa.code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: sa.error, reason: sa.reason })); return; }
      const id = decodeURIComponent(req.url.slice(12).split('?')[0]);
      if (!/^[\w.-]+$/.test(id)) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'bad id' })); return; }
      let series = null; try { series = readSeriesFile(id); } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: String(e.message || e) })); return; }
      if (!series) { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'not found' })); return; }
      const modules = (series.moduleIds || []).map((mid) => moduleSummary(mid, 'missing'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(JSON.stringify({ id, series, modules }));
    } else if (req.url === '/api/situation' || req.url.startsWith('/api/situation?')) {
      // Plan 0473 P8 — the HUMAN DIGEST FACE reads the SAME bounded WORKING SET the AI consumes via
      // presenter_situation. GET returns api.situation for a per-page consumer id (server-held cursor),
      // so the human face (control.html) and the AI face (MCP) are ONE working set. OPSEC: the roster in
      // the digest carries control-only fields (ip/socketId), so this is GATED behind the control
      // credential when one is configured — parity with the presence feed + module write-back. Ungated
      // server (LAN/tests, no credential) → open, like the rest of the control surface.
      if (!httpControlAuthed(req)) { res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
      // Plan 0493 R2 — a PVS watcher passes ?consumer=<id> for its OWN namespaced cursor (pvs:<id>),
      // distinct from the control.html digest cursor (?c=<id> ⇒ ctl:<id>). Previously ?consumer= was
      // ignored and every caller collapsed onto ctl:default, so the watcher and control.html silently
      // consumed each other's turns. `consumer` (if present) wins; else the control `c` cursor.
      const qp = new URLSearchParams((req.url.split('?')[1] || ''));
      const consumerParam = qp.get('consumer');
      const consumerId = consumerParam ? pvsConsumerKey(consumerParam) : ('ctl:' + (qp.get('c') || 'default'));
      Promise.resolve(api.situation({ consumerId })).then((sit) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(sit));
      }).catch((e) => { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: String((e && e.message) || e) })); });
    } else if (req.url === '/api/work' || req.url.startsWith('/api/work?')) {
      // Plan 0473 P8 — the HUMAN one-click resolve/claim/defer. A digest button POSTs {id, op, note?,
      // owner?}; the op routes through the SAME api.resolveWork / claimWork / deferWork the MCP tools
      // call — so the two faces never disagree (server-tracked status/owner prevent double-handling).
      if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'method not allowed' })); return; }
      if (!httpControlAuthed(req)) { res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
      const CAP = 16 * 1024; let body = ''; let aborted = false;
      req.on('data', (chunk) => { if (aborted) return; body += chunk; if (body.length > CAP) { aborted = true; res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'too large' })); req.destroy(); } });
      req.on('end', () => {
        if (aborted) return;
        let msg; try { msg = JSON.parse(body || '{}'); } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'invalid json' })); return; }
        const id = msg && msg.id, op = msg && msg.op;
        if (typeof id !== 'string' || !id) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'missing id' })); return; }
        let item = null;
        if (op === 'resolve') item = api.resolveWork(id, { note: msg.note != null ? String(msg.note) : null });
        else if (op === 'claim') item = api.claimWork(id, { owner: msg.owner != null ? String(msg.owner) : 'presenter' });
        else if (op === 'defer') item = api.deferWork(id);
        else { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'bad op (resolve|claim|defer)' })); return; }
        if (!item) { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'no such actionable item' })); return; }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, item }));
      });
    } else { res.writeHead(404); res.end('not found'); }
  };
}
