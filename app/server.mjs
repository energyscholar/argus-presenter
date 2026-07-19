/*
 * Argus Presenter — greenfield server (lean, ideal API; not SO's broadcast model).
 * Transport: ws (native browser WebSocket). Node built-in http serves the page.
 *
 * User classes: participant | presenter | ai. Each connection authenticates an
 * identity {userId,userName,role} on hello; the server treats THAT as
 * authoritative and stamps it onto results (never trusts client-reported ids).
 *
 * Control surface (used by tests + the MCP server):
 *   pushContent(target, html, contentId)   target: userId | 'all' | role
 *   openPoll({promptId, prompt, options, target})  -> assembles a `choice` per channel
 *   getPoll(promptId) -> { tally, votes, count, spec }
 *   closePoll(promptId)
 *   presence() -> [{userId,userName,role}]
 *   on(event, cb)  events: 'presence','result','poll'
 */
import http from 'http';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, watch } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { WebSocketServer } from 'ws';
import { assemble } from '../harness/assemble.mjs';
import * as log from './log.mjs';
import { createStore, isEphemeral, validOp } from './state.mjs';
import { validate, summarize } from './validate.mjs';

// X6 resilience caps.
const MAX_CONNS = 200;              // connection cap
const MAX_PAYLOAD = 256 * 1024;     // per-frame byte cap (S6)
const DURABLE_OPS_PER_SEC = 50;     // per-conn durable-op rate (ephemeral is coalesced, not capped)

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE = join(__dirname, 'presenter.html');

// AUTH-ROLE (P5.5): standard seeded hash. The plaintext password NEVER travels —
// the browser sends sha256(seed + password); the server compares against ROLE_HASH.
function sha256hex(s) { return createHash('sha256').update(s).digest('hex'); }

// HAR: defense-in-depth HTTP hardening (see HARDENING.md).
// CSP for the HTML pages. 'unsafe-inline' is REQUIRED today — presenter/control/creator
// carry inline <script>/<style> and each srcdoc component runs an inline script; ws:/wss:
// are REQUIRED for the live socket; frame-src blob:/data: admits the sandboxed srcdoc iframes.
// (Future path: nonce the inline scripts and drop 'unsafe-inline' — noted in HARDENING.md.)
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss:; " +
  "frame-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'";
// Shared header set for the three HTML routes (/, /control, /creator).
const htmlHeaders = () => ({
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
});
// Serve a static-ish asset with a weak ETag (size + mtimeMs) + revalidation. On a
// matching if-none-match → 304 (no body). Used for the branding SVG + shipped .mjs modules.
function sendStatic(res, req, absPath, contentType) {
  try {
    const st = statSync(absPath);
    const etag = 'W/"' + st.size + '-' + st.mtimeMs + '"';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'no-cache' }); res.end(); return; }
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache', etag });
    res.end(readFileSync(absPath));
  } catch (e) { res.writeHead(404); res.end('not found'); }
}

export function createServer({ port = 0, controlToken = null, rolePassword = null, roleSeed = null } = {}) {
  // AUTH-1: a shared secret gates the control roles (presenter/ai). When null,
  // behaviour is unchanged / LAN-open — any browser may claim a control role.
  const CONTROL_TOKEN = controlToken || process.env.PRESENTER_CONTROL_TOKEN || null;
  // AUTH-ROLE (P5.5): a shared PASSWORD gate via a seeded hash ("keep honest people
  // honest"). The seed is a public salt; the password is secret. ROLE_HASH =
  // sha256(seed + password). The browser computes the same hash and sends it as the
  // hello token — plaintext never leaves the client. NULL password ⇒ this gate is
  // inactive (so createServer() with no credential stays UNGATED for existing tests).
  const ROLE_SEED = roleSeed || process.env.PRESENTER_ROLE_SEED || 'argus-presenter';
  const ROLE_PW = rolePassword || process.env.PRESENTER_ROLE_PASSWORD || null;
  const ROLE_HASH = ROLE_PW ? sha256hex(ROLE_SEED + ROLE_PW) : null;
  const conns = new Map();     // ws -> {id,userId,userName,role}
  const byUser = new Map();    // userId -> ws
  let connSeq = 0;             // per-server connection counter -> stable socketId (S5-ready)
  const store = createStore(); // core session state machine (Plan 0435 group B)
  // Current DISPLAY per role / per user (C6): what a (re)connecting client should
  // be shown. A descriptor is re-rendered per connection on hello.
  const displayByRole = {};    // role -> descriptor
  const displayByUser = new Map(); // userId -> descriptor (per-user override)
  const everSeen = new Set();  // userIds seen (to count reconnects)
  let contentModule = null;    // Group I: the current content module { title?, beats:[{component,opts,requires?}] }
  let currentBeat = -1;        // index of the displayed beat
  // X3 telemetry sink (controller-read-only). Feedback from stress points.
  const telem = {
    ops: { applied: 0, denied: 0, malformed: 0, throttled: 0, duplicate: 0 },
    fanout: { sum: 0, count: 0 },
    applyMs: { sum: 0, count: 0, max: 0 },
    reconnects: 0, renderErrors: 0, opApplyFailures: 0,
    rtt: { last: null, sum: 0, count: 0 },
  };
  const telemetryView = () => ({
    ops: { ...telem.ops },
    avgFanout: telem.fanout.count ? +(telem.fanout.sum / telem.fanout.count).toFixed(2) : 0,
    fanoutSamples: telem.fanout.count,
    avgApplyMs: telem.applyMs.count ? +(telem.applyMs.sum / telem.applyMs.count).toFixed(3) : 0,
    maxApplyMs: +telem.applyMs.max.toFixed(3),
    reconnects: telem.reconnects, renderErrors: telem.renderErrors, opApplyFailures: telem.opApplyFailures,
    rtt: { last: telem.rtt.last, avg: telem.rtt.count ? +(telem.rtt.sum / telem.rtt.count).toFixed(1) : null, samples: telem.rtt.count },
  });
  const polls = new Map();     // promptId -> {spec, votes:Map(userId->{value,userName,ts}), open}
  const lastResults = {};      // PRIM-results: promptId -> { userId -> {type,value} } (last beat result per user)
  const listeners = { presence: [], result: [], poll: [] };
  const emit = (ev, data) => listeners[ev].forEach((cb) => { try { cb(data); } catch (e) {} });

  const CONTROL = join(__dirname, 'control.html');
  const BRANDING = join(__dirname, 'branding', 'argus-presenter.svg');
  // --- Content-module registry. Modules are LOCAL JSON files (NOT the web) in MODULES_DIR
  // (default ./modules; set PRESENTER_MODULES_DIR to point at your content, e.g. a campaign's
  // adventures/). Read + validated on demand, cached by file mtime so repeat loads are snappy.
  const MODULES_DIR = process.env.PRESENTER_MODULES_DIR || join(__dirname, '..', 'modules');
  const moduleCache = new Map();   // id -> { mtimeMs, module }
  function readModuleFile(id) {
    if (!/^[\w.-]+$/.test(id)) return null;          // no path traversal
    const file = join(MODULES_DIR, id + '.json');
    if (!existsSync(file)) return null;
    const mtimeMs = statSync(file).mtimeMs;
    const hit = moduleCache.get(id);
    if (hit && hit.mtimeMs === mtimeMs) return hit.module;   // cache hit
    const module = JSON.parse(readFileSync(file, 'utf8'));
    moduleCache.set(id, { mtimeMs, module });
    return module;
  }
  // Summarize ONE module id into the shape the GM <select> uses. Shared by listModules
  // and series resolution (/api/series/:id) so a series' modules describe identically to
  // the flat list. `missing` = the error string when the id resolves to no file.
  function moduleSummary(id, missing = 'unreadable') {
    let module; try { module = readModuleFile(id); } catch (e) { return { id, error: String(e.message || e).slice(0, 80) }; }
    if (!module) return { id, error: missing };
    const man = module.manifest || {};
    const v = summarize(validate(module));
    return { id, title: man.title || module.title || id, version: man.version || null,
      beats: (module.beats || []).length, sections: (module.sections || []).length, warn: v.warn, info: v.info };
  }
  function listModules() {
    if (!existsSync(MODULES_DIR)) return [];
    // SKIP *.series.json — those are SERIES manifests (an ordered list of module ids), not modules.
    return readdirSync(MODULES_DIR)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.series.json'))
      .map((f) => moduleSummary(f.slice(0, -5)))
      // Keep ONLY real content modules: drop unreadable/non-module files (error), and drop
      // JSON that parses but is not a content module (no beats AND no sections — e.g. a stray
      // *-responses.json log). Prevents bogus 0-beat entries in the GM <select>.
      .filter((m) => !m.error && !(m.beats === 0 && m.sections === 0));
  }
  // --- Series registry. A SERIES is the level above Module: a file `<id>.series.json` =
  // { manifest:{title,summary?}, moduleIds:[...] } listing modules to walk in order.
  function readSeriesFile(id) {
    if (!/^[\w.-]+$/.test(id)) return null;               // reuse the module path-guard
    const file = join(MODULES_DIR, id + '.series.json');
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  function listSeries() {
    if (!existsSync(MODULES_DIR)) return [];
    return readdirSync(MODULES_DIR)
      .filter((f) => f.endsWith('.series.json'))
      .map((f) => {
        const id = f.slice(0, -('.series.json'.length));
        let s; try { s = readSeriesFile(id); } catch (e) { return null; }   // skip unreadable
        if (!s) return null;
        const man = s.manifest || {};
        return { id, title: man.title || id, count: (s.moduleIds || []).length };
      })
      .filter(Boolean);
  }
  // AUT-2: hot-reload. Watch MODULES_DIR; when a *.json module file changes on disk,
  // invalidate its cache and notify the control roles (presenter/ai) so a just-
  // edited/just-saved module is discoverable without a server restart. Debounced —
  // fs.watch fires duplicate/rapid events; coalesce with a short trailing timer per id.
  let watcher = null;
  const hotTimers = new Map();   // id -> trailing debounce timer
  function notifyModuleChanged(id) {
    moduleCache.delete(id);
    for (const [ws, c] of conns.entries())
      if (c.role === 'presenter' || c.role === 'ai') send(ws, { t: 'module-changed', id });
    log.info('module', 'changed', { id });
  }
  try {
    if (existsSync(MODULES_DIR)) {
      watcher = watch(MODULES_DIR, (evt, filename) => {
        if (!filename || !filename.endsWith('.json')) return;
        const id = filename.replace(/\.json$/, '');
        if (hotTimers.has(id)) clearTimeout(hotTimers.get(id));
        hotTimers.set(id, setTimeout(() => { hotTimers.delete(id); notifyModuleChanged(id); }, 150));
      });
    }
  } catch (e) { log.warn('module', 'watch-failed', { err: String((e && e.message) || e).slice(0, 80) }); }
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/?')) {
      res.writeHead(200, htmlHeaders());
      res.end(readFileSync(PAGE, 'utf8'));
    } else if (req.url === '/control' || req.url.startsWith('/control?')) {
      res.writeHead(200, htmlHeaders());
      res.end(readFileSync(CONTROL, 'utf8'));
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
    } else if (req.url === '/branding/argus-presenter.svg') {
      // Default idle branding art (self-contained animated SVG; no external dep).
      sendStatic(res, req, BRANDING, 'image/svg+xml; charset=utf-8');
    } else if (req.url === '/api/auth' || req.url.startsWith('/api/auth?')) {
      // AUTH-ROLE (P5.5): tell the client whether the presenter role is gated + the public
      // SALT it must hash with. NEVER returns ROLE_HASH, ROLE_PW, or CONTROL_TOKEN — only the
      // seed (public by design) and a boolean. The browser computes sha256(seed+password).
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(JSON.stringify({ gated: !!(CONTROL_TOKEN || ROLE_HASH), seed: ROLE_SEED }));
    } else if (req.url === '/api/modules') {
      // Discover available modules (id, title, counts, validation summary) — for the GM panel's SELECT list.
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(listModules()));
    } else if (req.url.startsWith('/api/modules/')) {
      const rawPath = req.url.slice(13);
      const id = decodeURIComponent(rawPath.split('?')[0]);
      if (req.method === 'POST') {
        // AUT-1: module write-back. The Content Creator POSTs a module JSON; it lands in
        // MODULES_DIR so listModules()/the GM <select> discovers it. MUTATION → guarded:
        // AUTH-gated (when a control token is configured), path-safe id, hard size cap.
        // AUTH: if a control token is set, require it (header or ?token=); else 403.
        if (CONTROL_TOKEN) {
          const q = rawPath.split('?')[1] || '';
          const qtoken = new URLSearchParams(q).get('token');
          const token = req.headers['x-control-token'] || qtoken;
          if (token !== CONTROL_TOKEN) { res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
        }
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
            writeFileSync(join(MODULES_DIR, id + '.json'), JSON.stringify(module, null, 2));
            moduleCache.delete(id);   // invalidate so the next read reflects the write
          } catch (e) { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: String(e.message || e) })); return; }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, id, validation: summarize(validate(module)) }));
        });
        return;
      }
      // Fetch ONE module (full JSON + validation) so the panel can validate-then-load.
      let module = null; try { module = readModuleFile(id); } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: String(e.message || e) })); return; }
      if (!module) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ id, module, validation: summarize(validate(module)) }));
    } else if (req.url === '/api/series') {
      // Discover available series (id, title, module count) — for the GM panel's series SELECT.
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(listSeries()));
    } else if (req.url.startsWith('/api/series/')) {
      // Fetch ONE series: its manifest + moduleIds, plus each module resolved to the SAME
      // summary shape as listModules (missing ids → { id, error:'missing' }).
      const id = decodeURIComponent(req.url.slice(12).split('?')[0]);
      if (!/^[\w.-]+$/.test(id)) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'bad id' })); return; }
      let series = null; try { series = readSeriesFile(id); } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: String(e.message || e) })); return; }
      if (!series) { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'not found' })); return; }
      const modules = (series.moduleIds || []).map((mid) => moduleSummary(mid, 'missing'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(JSON.stringify({ id, series, modules }));
    } else { res.writeHead(404); res.end('not found'); }
  });
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD });

  function send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch (e) {} }
  function presence() { return [...conns.values()].map((c) => ({ userId: c.userId, userName: c.userName, role: c.role })); }
  // Full presence (incl. IP + socketId + current display id) pushed to CONTROL roles only, for the GM user list.
  function pushPresence() {
    // No-op unless a control client (presenter/ai) is actually listening — avoids building/sending
    // the presence feed on every display change when nobody's watching.
    const ctl = [...conns.values()].filter((c) => c.role === 'presenter' || c.role === 'ai');
    if (!ctl.length) return;
    const users = [...conns.values()].map((c) => ({ userId: c.userId, userName: c.userName, role: c.role, ip: c.ip, socketId: c.id, lastSeen: c.lastSeen, display: displayIdFor(c) }));
    for (const [ws, c] of conns.entries()) if (c.role === 'presenter' || c.role === 'ai') send(ws, { t: 'presence', users });
  }
  // PRIM-results: forward a beat result (answer/continue) to CONTROL roles ONLY (presenter/ai),
  // mirroring pushPresence's OPSEC filter — participants must never receive a `t:'result'` frame.
  function pushResult(r) {
    for (const [ws, c] of conns.entries())
      if (c.role === 'presenter' || c.role === 'ai')
        send(ws, { t: 'result', promptId: r.promptId, userId: r.userId, userName: r.userName, type: r.type, value: r.value });
  }
  // A short label for what a given connection is currently showing (for the user list / tiny preview).
  function displayIdFor(c) {
    const d = displayByUser.get(c.userId) || displayByRole[c.role];
    if (!d) return 'idle';
    if (d.kind === 'content') return d.contentId || 'content';
    if (d.kind === 'component') return (d.opts && d.opts.promptId) || d.component || 'component';
    return d.kind || 'display';
  }
  function targets(target) {
    if (target === 'all' || target == null) return [...conns.keys()];
    if (['participant', 'presenter', 'ai'].includes(target))
      return [...conns.entries()].filter(([, c]) => c.role === target).map(([ws]) => ws);
    const ws = byUser.get(target); return ws ? [ws] : [];   // by userId
  }

  wss.on('connection', (ws, req) => {
    if (conns.size >= MAX_CONNS) { log.warn('conn', 'cap-reached', { conns: conns.size }); try { ws.close(1013, 'server busy'); } catch {} return; }
    // Capture client IP (x-forwarded-for through a proxy, else the socket peer). Shown ONLY to
    // presenter/ai in the user list — never broadcast to participants.
    const ip = ((req && (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress))) || '').toString().split(',')[0].trim() || null;
    conns.set(ws, { id: 'c' + (++connSeq), userId: null, userName: null, role: 'participant', lastSeen: Date.now(), ip });
    ws.on('message', (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
      const c = conns.get(ws);
      if (c) c.lastSeen = Date.now();   // liveness (X4)
      if (m.t === 'hello') {
        c.userId = m.userId || ('anon-' + Math.random().toString(36).slice(2, 8));
        c.userName = m.userName || c.userId;
        // AUTH-1 / AUTH-ROLE: control roles require a credential when one is configured.
        // GRANTED iff: ungated (no token AND no password hash) OR the hello token matches
        // CONTROL_TOKEN (when set) OR it matches ROLE_HASH (the seeded password hash, when
        // set). Otherwise downgrade to participant. CONTROL_TOKEN-only behaves exactly as
        // before; neither configured ⇒ ungated (LAN-open back-compat).
        let reqRole = m.role || 'participant';
        if (reqRole === 'presenter' || reqRole === 'ai') {
          const gated = !!(CONTROL_TOKEN || ROLE_HASH);
          const ok = !gated
            || (CONTROL_TOKEN && m.token === CONTROL_TOKEN)
            || (ROLE_HASH && m.token === ROLE_HASH);
          if (!ok) {
            log.warn('auth', 'control-denied', { userId: c.userId, role: reqRole });
            reqRole = 'participant';
          }
        }
        c.role = reqRole;
        byUser.set(c.userId, ws);
        // welcome.role = the EFFECTIVE granted role, so the client learns if it was
        // silently downgraded (wrong/absent password) and can surface feedback.
        send(ws, { t: 'welcome', userId: c.userId, socketId: c.id, role: c.role });
        // C4/X1: converge the (re)connecting client. If it reports a lastVersion we
        // can still replay from the op-log, send only the MISSED ops (resync);
        // otherwise a full role-filtered snapshot (Memento).
        resyncOrSnapshot(ws, c, m.lastVersion);
        redisplayFor(ws, c);   // C6: re-push the currently-displayed content module
        if (everSeen.has(c.userId)) telem.reconnects++; else everSeen.add(c.userId);
        send(ws, { t: 'ping', ts: Date.now() });   // X3 RTT probe
        log.info('conn', 'hello', { socketId: c.id, userId: c.userId, role: c.role, lastVersion: m.lastVersion || 0 });
        updateChatListeners();   // P3
        emit('presence', presence()); pushPresence();
      } else if (m.t === 'result') {
        // Authoritative identity from the connection, NOT the client payload.
        const r = Object.assign({}, m.msg, { userId: c.userId, userName: c.userName, channel: c.userId });
        shimAnswer(c, r);      // D2: poll vote (and generic answer) -> store op
        emit('result', r);     // map view/click/pointer are store ops now (E1-E4) — no relay
        // PRIM-results: track last result per prompt and forward to CONTROL roles ONLY (OPSEC:
        // presenter/ai — participants must NEVER receive a peer's answer/continue).
        // Auditor: only meaningful results (answer/continue) — drop lifecycle events (ready/step/change/
        // flow-complete) that carry the SAME promptId and would false-trigger DEL-2 branch nav (S190 gotcha).
        if (r.promptId != null && (r.type === 'answer' || r.type === 'continue')) {
          lastResults[r.promptId] = lastResults[r.promptId] || {};
          lastResults[r.promptId][r.userId] = { type: r.type, value: r.value };
          pushResult(r);
        }
      } else if (m.t === 'op') {
        handleOp(c, m);
      } else if (m.t === 'control') {
        handleControl(c, m, ws);
      } else if (m.t === 'pong') {
        if (typeof m.ts === 'number') { const rtt = Date.now() - m.ts; telem.rtt.last = rtt; telem.rtt.sum += rtt; telem.rtt.count++; }
      } else if (m.t === 'telemetry') {
        if (m.kind === 'render-error') telem.renderErrors++;
        else if (m.kind === 'op-apply-failure') telem.opApplyFailures++;
        else if (m.kind === 'rtt' && typeof m.value === 'number') { telem.rtt.last = m.value; telem.rtt.sum += m.value; telem.rtt.count++; }
      } else if (m.t === 'request-poll') {
        emit('poll', { type: 'request', from: { userId: c.userId, userName: c.userName }, spec: m.spec });
      }
    });
    ws.on('close', () => { const c = conns.get(ws); if (c && c.userId) byUser.delete(c.userId); conns.delete(ws); updateChatListeners(); emit('presence', presence()); });
  });

  // ---- Op protocol (Plan 0435 C3): {t:'op'} -> store.apply -> broadcast diff ----
  // Identity is the CONNECTION record (S1); opId is namespaced by conn id (S5) so a
  // client cannot forge/suppress another's dedup. Diffs are read-perm filtered per
  // recipient (S7). Broadcast-all v1 (§7 Q1).
  function handleOp(c, m) {
    // X6 per-conn rate limit on DURABLE ops (ephemeral is coalesced/uncapped).
    if (!isEphemeral(m && m.path)) {
      const now = Date.now();
      if (!c.rl || now - c.rl.winStart >= 1000) c.rl = { winStart: now, count: 0, warned: false };
      c.rl.count++;
      if (c.rl.count > DURABLE_OPS_PER_SEC) {
        telem.ops.throttled++;
        if (!c.rl.warned) { log.warn('rl', 'throttled', { socketId: c.id, path: m && m.path }); c.rl.warned = true; }
        return;   // drop excess
      }
    }
    const opId = c.id + ':' + (m.opId != null ? String(m.opId) : ('a' + Math.random().toString(36).slice(2, 8)));
    const op = { path: m.path, verb: m.verb, value: m.value, opId };
    if (!validOp(op)) { telem.ops.malformed++; log.debug('op', 'malformed', { socketId: c.id, path: m && m.path }); return; }
    const t0 = Date.now();
    const res = store.apply(op, { userId: c.userId, role: c.role });
    telem.applyMs.sum += (Date.now() - t0); telem.applyMs.count++; telem.applyMs.max = Math.max(telem.applyMs.max, Date.now() - t0);
    if (res && res.diff) {
      telem.ops.applied++;
      if (res.ephemeral) queueEphemeral(res.diff, res);   // X2 — coalesce, not logged
      else broadcastDiff(res.diff, res);
      log.trace('op', 'applied', { socketId: c.id, path: m.path, verb: m.verb, by: res.by, version: res.version, ephemeral: !!res.ephemeral }, { roles: ['presenter', 'ai'] });
    } else if (res && res.duplicate) {
      telem.ops.duplicate++;
      log.trace('op', 'duplicate', { socketId: c.id, opId });
    } else {
      telem.ops.denied++;
      log.debug('op', 'denied', { socketId: c.id, path: m.path, verb: m.verb, by: c.userId });
    }
  }

  // X1: converge a (re)connecting client. Replay missed ops if the requested
  // lastVersion is still covered by the retained op-log; else a full snapshot.
  function resyncOrSnapshot(ws, c, lastVersion) {
    const lv = (typeof lastVersion === 'number' && lastVersion >= 0) ? lastVersion : 0;
    const log = store.oplogSince(0);
    const earliest = log.length ? log[0].version : store.version() + 1;
    const canReplay = lv > 0 && lv <= store.version() && lv >= earliest - 1;
    if (canReplay) {
      const missed = store.oplogSince(lv);
      send(ws, { t: 'resync', from: lv, to: store.version(), count: missed.length });
      for (const e of missed) {
        const visible = {};
        for (const p of Object.keys(e.diff)) if (store.perms.canRead(c.role, p)) visible[p] = e.diff[p];
        if (Object.keys(visible).length) send(ws, { t: 'host', msg: { source: 'argus-host', type: 'diff', diff: visible, by: e.by, version: e.version } });
      }
    } else {
      send(ws, { t: 'snapshot', state: store.snapshot(c.role).state, version: store.version() });
    }
  }

  // Apply an op on the server's behalf (system controller by default) and broadcast
  // the resulting durable diff. Used to seed/close polls and to shim answers to ops.
  // P3: publish the count of attached LISTENERS (presenter/ai) so participant chat
  // inputs enable only when someone is listening. Sent as a transient control
  // message (NOT a store op) — presence-derived, must not grow the durable state.
  function currentListeners() { return [...conns.values()].filter((c) => c.role === 'presenter' || c.role === 'ai').length; }
  function updateChatListeners() {
    const count = currentListeners();
    for (const ws of conns.keys()) send(ws, { t: 'chat_listeners', n: count });
  }

  function serverApply(op, actor) {
    const res = store.apply(op, actor || { userId: 'server', role: 'system' });
    if (res && res.diff && !res.ephemeral) broadcastDiff(res.diff, res);
    return res;
  }

  // P1: presenter control-message handler — the SAME server API the AI/MCP drives.
  // Presenter/ai only (server-authoritative role, S1/S2); others are ignored.
  function handleControl(c, m, ws) {
    if (c.role !== 'presenter' && c.role !== 'ai') { log.warn('control', 'denied', { socketId: c.id, role: c.role }); return; }
    const a = m.args || {};
    switch (m.action) {
      // PRIM-mirror (MON-2): render the TARGET user's current display in the target's
      // OWN context, then PUSH it back to THIS requesting control client (fire-and-forget,
      // not a reply). Lets the GM thumbnail "what that user sees". OPSEC: role-gated above.
      case 'mirror': {
        const uid = a.userId;
        const tws = byUser.get(uid);
        const tc = tws ? conns.get(tws) : null;
        const desc = displayByUser.get(uid) || (tc && displayByRole[tc.role]) || null;
        const html = (desc && tc) ? descToHtml(tc, desc) : null;
        send(ws, { t: 'mirror', userId: uid, html });
        break;
      }
      case 'push_component': api.pushComponent(a.target || 'all', a.component, a.opts || {}, a.theme || 'argus', a.requires || []); break;
      case 'open_poll': api.openPoll(a); break;
      case 'close_poll': api.closePoll(a.promptId); break;
      case 'reload_clients': api.reloadClients(a.target || 'all', a.delay || 0); break;
      case 'clear': api.clear(a.target || 'all'); break;   // route through api.clear so display descriptor is also reset (reconnect → branding)
      // MON-1: drop a user's per-user override so they follow their ROLE/default display
      // again (or branding if the role has none). DISTINCT from clear(): clear BLANKS to
      // branding; reset_user RETARGETS to the role display. Role-gated above.
      case 'reset_user': {
        const uid = a.userId;
        displayByUser.delete(uid);
        const tws = byUser.get(uid);
        const tc = tws ? conns.get(tws) : null;
        const desc = tc ? displayByRole[tc.role] : null;
        if (tws && tc) { if (desc) renderDisplay(tws, tc, desc); else send(tws, { t: 'clear' }); }
        pushPresence();
        break;
      }
      case 'op': handleOp(c, { path: a.path, verb: a.verb, value: a.value, opId: a.opId }); break;   // drive an op as the presenter
      case 'set_module': api.setModule(a.module || { beats: a.beats || [] }); break;   // Group I
      case 'show_beat': api.showBeat(a.id != null ? a.id : (a.index | 0)); break;   // by id (branch nav) or index
      case 'show_default': api.showDefault(); break;   // DEF-1: Home → module title page (or branding fallback)
      case 'next_beat': api.nextBeat(); break;
      case 'prev_beat': api.prevBeat(); break;
      case 'append_beat': api.appendBeat(a.beat || { component: a.component, opts: a.opts, requires: a.requires }); break;   // compose (I2) + AI co-author (I3)
      case 'load_module': api.loadModule(a.module); break;   // I4
      default: log.warn('control', 'unknown-action', { action: m.action });
    }
    log.info('control', m.action, { socketId: c.id });
  }

  function broadcastDiff(diff, meta) {
    let recipients = 0;
    for (const [ws, c] of conns.entries()) {
      const visible = {};
      for (const p of Object.keys(diff)) if (store.perms.canRead(c.role, p)) visible[p] = diff[p];
      if (Object.keys(visible).length) {
        send(ws, { t: 'host', msg: { source: 'argus-host', type: 'diff', diff: visible, by: meta.by, version: meta.version } });
        recipients++;
      }
    }
    telem.fanout.sum += recipients; telem.fanout.count++;   // X3 fan-out measurement
  }

  // X2: ephemeral (pointer/laser) coalescing. Merge latest-per-path and flush at
  // ~15 Hz so a 100 ops/s stream produces a bounded broadcast count. Not logged.
  let ephPending = null, ephTimer = null, ephBy = null;
  function queueEphemeral(diff, meta) {
    if (!ephPending) ephPending = {};
    for (const p of Object.keys(diff)) ephPending[p] = diff[p];   // latest-wins coalesce
    ephBy = meta.by;
    if (!ephTimer) ephTimer = setTimeout(flushEphemeral, 66);
  }
  function flushEphemeral() {
    ephTimer = null;
    const diff = ephPending; ephPending = null;
    if (diff) broadcastDiff(diff, { by: ephBy, version: null });
  }

  // ---- Current-display tracking + per-connection render (C6) ----
  const ROLES = ['participant', 'presenter', 'ai'];
  function setDisplay(target, desc) {
    if (target === 'all' || target == null) { for (const r of ROLES) displayByRole[r] = desc; displayByUser.clear(); }
    else if (ROLES.includes(target)) displayByRole[target] = desc;
    else displayByUser.set(target, desc);   // by userId
    pushPresence();   // keep the GM user-list "currently sees" column live as displays change
  }
  // Stamp identity + apply the OPSEC scene strip via the PERMISSION MODEL (G2):
  // an item is included only if this role may READ its visibility. The scene
  // component keeps a thin client-side filter as defense-in-depth.
  function stampFor(c, component, opts) {
    const o = Object.assign({}, opts, { userId: c.userId, userName: c.userName, channel: c.userId, viewerRole: c.role });
    if (component === 'scene' && Array.isArray(o.items)) o.items = o.items.filter((it) => store.perms.canSeeVisibility(c.role, it.visibility));
    return o;
  }
  function sendComponentTo(ws, c, desc) {
    const o = stampFor(c, desc.component, desc.opts || {});
    send(ws, { t: 'content', contentId: o.promptId || null, html: assemble({ component: desc.component, opts: o, theme: desc.theme || 'argus', requires: desc.requires || [] }) });
  }
  // Produce the HTML STRING for `desc` rendered in viewer `c`'s context — the html-
  // producing half of renderDisplay, factored out for PRIM-mirror (server push of a
  // target's current display back to a control client). Mirrors renderDisplay's branches.
  function descToHtml(c, desc) {
    if (!desc) return '';
    if (desc.kind === 'content') return desc.html || '';
    if (desc.kind === 'component') return assemble({ component: desc.component, opts: stampFor(c, desc.component, desc.opts || {}), theme: desc.theme || 'argus', requires: desc.requires || [] });
    if (desc.kind === 'poll-choice') {
      const poll = polls.get(desc.promptId); if (!poll) return '';
      return assemble({ component: 'choice', opts: { ...poll.spec, promptId: desc.promptId, userId: c.userId, userName: c.userName, channel: c.userId } });
    }
    if (desc.kind === 'poll-results') {
      const poll = polls.get(desc.promptId); if (!poll) return ''; const t = tally(desc.promptId);
      return assemble({ component: 'poll-results', opts: { ...poll.spec, promptId: desc.promptId, tally: t.tally, count: t.count } });
    }
    return '';
  }
  function renderDisplay(ws, c, desc) {
    if (!desc) return;
    if (desc.kind === 'content') send(ws, { t: 'content', contentId: desc.contentId || null, html: desc.html });
    else if (desc.kind === 'component') sendComponentTo(ws, c, desc);
    else if (desc.kind === 'poll-choice') {
      const poll = polls.get(desc.promptId); if (!poll) return;
      send(ws, { t: 'content', contentId: desc.promptId, html: assemble({ component: 'choice', opts: { ...poll.spec, promptId: desc.promptId, userId: c.userId, userName: c.userName, channel: c.userId } }) });
    } else if (desc.kind === 'poll-results') {
      const poll = polls.get(desc.promptId); if (!poll) return; const t = tally(desc.promptId);
      send(ws, { t: 'content', contentId: desc.promptId + ':results', html: assemble({ component: 'poll-results', opts: { ...poll.spec, promptId: desc.promptId, tally: t.tally, count: t.count } }) });
    }
  }
  // On (re)connect: re-push the current content module (GAP fix, C6).
  function redisplayFor(ws, c) {
    const desc = displayByUser.get(c.userId) || displayByRole[c.role];
    if (desc) renderDisplay(ws, c, desc);
  }

  // D2: shim a component 'answer' into a store op. Poll answers -> a per-user vote
  // slice (perm: self); other answers -> answers/{pid}/{self}. Close guard (D4):
  // votes into a closed poll are dropped.
  function shimAnswer(c, r) {
    if (r.type !== 'answer' || r.promptId == null) return;
    const pid = r.promptId;
    const poll = polls.get(pid);
    if (poll) {
      if (!poll.open) return;   // closed -> denied
      const res = serverApply({ path: 'polls/' + pid + '/votes/' + c.userId, verb: 'set', value: r.value }, { userId: c.userId, role: c.role });
      if (res && res.diff) emit('poll', { type: 'update', promptId: pid, ...tally(pid) });   // diff broadcast (serverApply) drives poll-results
    } else {
      serverApply({ path: 'answers/' + pid + '/' + c.userId, verb: 'set', value: r.value }, { userId: c.userId, role: c.role });
    }
  }

  function tally(promptId) {
    const poll = polls.get(promptId); if (!poll) return { tally: {}, count: 0 };
    const counts = {};
    (poll.spec.options || []).forEach((o) => { counts[o.value] = 0; });
    const votes = store.get('polls/' + promptId + '/votes') || {};   // store is authoritative (D2)
    let count = 0;
    for (const uid of Object.keys(votes)) { const v = votes[uid]; counts[v] = (counts[v] || 0) + 1; count++; }
    return { tally: counts, count, spec: poll.spec };
  }

  const api = {
    url: () => `http://127.0.0.1:${httpServer.address().port}`,
    port: () => httpServer.address().port,
    presence,
    on: (ev, cb) => { if (listeners[ev]) listeners[ev].push(cb); },
    pushContent(target, html, contentId) {
      setDisplay(target, { kind: 'content', html, contentId });
      const n = targets(target).map((ws) => send(ws, { t: 'content', contentId: contentId || null, html }));
      return n.length;
    },
    // Role-aware push: assemble PER channel, stamping identity + viewerRole, and
    // STRIP gm-only scene items for non-GM viewers (real OPSEC — secret content
    // never leaves the server for a player). This is the per-role-render path.
    // requires = the content module's declared plugin deps (Node-style). The
    // assembler bundles core + exactly that transitive closure; [] ⇒ pure core.
    pushComponent(target, component, opts = {}, theme = 'argus', requires = []) {
      const desc = { kind: 'component', component, opts, theme, requires };
      setDisplay(target, desc);                          // C6: remember for (re)connects
      let count = 0;
      for (const ws of targets(target)) { sendComponentTo(ws, conns.get(ws), desc); count++; }
      return count;
    },
    openPoll({ promptId, prompt, options, target = 'participant', resultsTarget = null }) {
      log.info('poll', 'open', { promptId, options: (options || []).length });
      polls.set(promptId, { spec: { prompt, options }, open: true });
      // D1: seed the store so the poll is a first-class state slice.
      serverApply({ path: 'polls/' + promptId + '/spec', verb: 'set', value: { prompt, options } });
      serverApply({ path: 'polls/' + promptId + '/open', verb: 'set', value: true });
      // C6: remember the poll display so late joiners see the choice / live results.
      setDisplay(target, { kind: 'poll-choice', promptId });
      // Assemble a per-channel `choice` stamped with that channel's identity.
      for (const ws of targets(target)) {
        const c = conns.get(ws);
        const html = assemble({ component: 'choice', opts: { prompt, options, promptId, userId: c.userId, userName: c.userName, channel: c.userId } });
        send(ws, { t: 'content', contentId: promptId, html });
      }
      // Optionally push a live results display to another target (e.g. presenter).
      // It stays live via store vote diffs (D3) — no bespoke relay.
      if (resultsTarget) {
        setDisplay(resultsTarget, { kind: 'poll-results', promptId });
        const html = assemble({ component: 'poll-results', opts: { prompt, options, promptId, count: 0 } });
        for (const ws of targets(resultsTarget)) send(ws, { t: 'content', contentId: promptId + ':results', html });
      }
      return { promptId, ...tally(promptId) };
    },
    getPoll: (promptId) => { const votes = store.get('polls/' + promptId + '/votes') || {}; return { promptId, ...tally(promptId), votes: Object.keys(votes).map((userId) => ({ userId, value: votes[userId] })) }; },
    // Hot-reload clients in place (swap client/server code without dropping them).
    reloadClients: (target = 'all', delay = 0) => targets(target).map((ws) => send(ws, { t: 'reload', delay })).length,
    // Clear the display back to idle/branding. Sends {t:'clear'} to live clients AND drops the stored
    // display descriptor so a RECONNECTING client converges to idle branding, not the stale last content
    // (fixes "stuck on the end card, never reverts to branding"). Use as the standard session-end primitive.
    clear: (target = 'all') => { setDisplay(target, null); return targets(target).map((ws) => send(ws, { t: 'clear' })).length; },
    // READY chime: a transient signal (NOT a display descriptor — no setDisplay, so it
    // never re-fires on reconnect). Rings a gentle chime + shows a "Ready to start?"
    // banner on live clients, so a human keeping the tab backgrounded knows to come look.
    chime: ({ message = 'Ready to start?', target = 'all' } = {}) => targets(target).map((ws) => send(ws, { t: 'chime', message })).length,
    closePoll: (promptId) => { const p = polls.get(promptId); if (p) p.open = false; serverApply({ path: 'polls/' + promptId + '/open', verb: 'set', value: false }); return { promptId, ...tally(promptId) }; },
    // Debug snapshot for the ?debug overlay + the presenter_debug MCP tool.
    // state = current authoritative view (proto: polls; the core store extends this
    // in group C); opLog = the structured-log tail (role-redacted for the viewer).
    debugDump: (role = 'presenter') => ({
      presence: presence(),
      connections: [...conns.values()].map((c) => ({ socketId: c.id, userId: c.userId, role: c.role })),
      state: { polls: [...polls.entries()].map(([id, p]) => ({ promptId: id, open: p.open, ...tally(id) })), store: store.snapshot(role).state },
      version: store.version(),
      opLog: log.view(role, { max: 50 }),
      // Telemetry is controller-read-only (S7): only presenter/ai see the operational sink.
      telemetry: (role === 'presenter' || role === 'ai') ? telemetryView() : null,
    }),
    telemetry: telemetryView,
    // ---- Group I: content-module display + authoring (humans AND the AI) ----
    // A content module is a portable deck of beats; showing a beat pushes it to all
    // (viewers follow in lockstep). module/current + module/len are store slices.
    setModule(module) {
      contentModule = (module && typeof module === 'object')
        ? Object.assign({}, module, { title: module.title || (module.manifest && module.manifest.title) || 'Module', beats: module.beats || [] })
        : { title: 'Module', beats: [] };   // keep sections/manifest server-side (not just title+beats)
      currentBeat = -1;
      // Plan 0438 D: validate on load — observability only, NEVER blocks (warn-never-block).
      try { const v = summarize(validate({ title: contentModule.title, beats: contentModule.beats, manifest: module && module.manifest })); if (v.warn || v.info) log.info('module', 'validate', { warn: v.warn, info: v.info, codes: v.warnings.concat(v.infos).map((x) => x.code) }); } catch (e) { log.warn('module', 'validate-error', { err: String(e).slice(0, 120) }); }
      serverApply({ path: 'module/len', verb: 'set', value: contentModule.beats.length });
      serverApply({ path: 'module/current', verb: 'set', value: -1 });
      // DEF-1: auto-show the module's default/title page on load if declared+resolvable; else
      // leave branding (currentBeat stays -1, push nothing). The panel still drives Start via show_beat index:0.
      const did = contentModule.manifest && contentModule.manifest.defaultBeatId;
      if (did != null && contentModule.beats.findIndex((b) => b.id === did) >= 0) api.showBeat(did);
      return { title: contentModule.title, beats: contentModule.beats.length };
    },
    showBeat(ref) {
      if (!contentModule) return null;
      const i = typeof ref === 'number' ? ref : contentModule.beats.findIndex((b) => b.id === ref);   // by index OR beat id (branch nav)
      if (i < 0 || i >= contentModule.beats.length) return null;
      const b = contentModule.beats[i];
      // Route by the beat's target (per-user hooks broadcast to 'all' by default) and ensure promptId
      // reaches opts so interactive beats can actually collect/gate answers.
      const opts = (b.promptId != null) ? Object.assign({}, b.opts || {}, { promptId: b.promptId }) : (b.opts || {});
      api.pushComponent(b.target || 'all', b.component, opts, b.theme || 'argus', b.requires || []);
      // DEL-1: per-user layers. A layer with a `target` OVERRIDES the base opts for that
      // user/role (layer opts win). `when`-only layers are runner-evaluated — out of scope here.
      // Base goes to all; layered targets additionally receive the merged override (last-wins).
      if (Array.isArray(b.layers)) for (const L of b.layers) {
        if (!L || !L.target) continue;
        const lopts = Object.assign({}, b.opts || {}, L.opts || {}, (b.promptId != null) ? { promptId: b.promptId } : {});
        api.pushComponent(L.target, b.component, lopts, b.theme || 'argus', b.requires || []);
      }
      currentBeat = i;
      serverApply({ path: 'module/current', verb: 'set', value: i });
      return { index: i, component: b.component, target: b.target || 'all' };
    },
    nextBeat() { return api.showBeat(currentBeat + 1); },
    prevBeat() { return api.showBeat(Math.max(0, currentBeat - 1)); },
    // DEF-1: cascading default. A module WITH a resolvable manifest.defaultBeatId shows that
    // title/default beat; a module without one (or no module at all) falls back to branding
    // (clear). This is the mechanism behind Home + the STOP/end→branding cascade.
    showDefault() {
      const did = contentModule && contentModule.manifest && contentModule.manifest.defaultBeatId;
      if (did != null && contentModule.beats.findIndex((b) => b.id === did) >= 0) return api.showBeat(did);
      api.clear('all');
      return null;
    },
    appendBeat(beat) {
      if (!contentModule) contentModule = { title: 'Module', beats: [] };
      contentModule.beats.push(beat);
      serverApply({ path: 'module/len', verb: 'set', value: contentModule.beats.length });
      return { beats: contentModule.beats.length };
    },
    getModule() { return contentModule ? JSON.parse(JSON.stringify(contentModule)) : null; },   // portable snapshot (I4)
    loadModule(module) { return api.setModule(module); },
    // X4 health: liveness (last-seen/RTT), throughput, error rate, sizes, stuck detection.
    health: ({ staleMs = 10000 } = {}) => {
      const now = Date.now();
      const connections = [...conns.values()].map((c) => {
        const ageMs = now - (c.lastSeen || now);
        return { socketId: c.id, userId: c.userId, role: c.role, ageMs, stale: ageMs > staleMs };
      });
      const o = telem.ops, total = o.applied + o.denied + o.malformed;
      const errorRate = total ? +((o.denied + o.malformed) / total).toFixed(3) : 0;
      const anyStale = connections.some((x) => x.stale);
      const status = (anyStale || errorRate > 0.5) ? 'degraded' : 'green';
      return {
        status, connections,
        opsApplied: o.applied, errorRate,
        stateVersion: store.version(), opLogSize: store.oplogSince(0).length,
        rtt: telem.rtt.last, reconnects: telem.reconnects,
      };
    },
    // X5 RAF metrics from the attributed/timestamped op-log.
    raf: ({ windowMs = 5000 } = {}) => {
      const entries = store.oplogSince(0);
      const total = entries.length;
      const CONTROLLERS = new Set(['ai', 'presenter']);
      const peerVisible = entries.filter((e) => e.role === 'participant' && store.perms.canRead('participant', e.path)).length;
      const teacher = entries.filter((e) => CONTROLLERS.has(e.role)).length;
      // Peer->peer response edges: a participant op preceded (within windowMs) by a
      // DIFFERENT participant's op = a peer responding to a peer.
      const partOps = entries.filter((e) => e.role === 'participant');
      let edges = 0;
      for (let i = 0; i < partOps.length; i++) {
        for (let j = i - 1; j >= 0; j--) {
          if (partOps[i].ts - partOps[j].ts > windowMs) break;
          if (partOps[j].by !== partOps[i].by) { edges++; break; }
        }
      }
      return {
        totalOps: total,
        peerCatalysisRatio: total ? +(peerVisible / total).toFixed(3) : 0,
        teacherDependencyRatio: total ? +(teacher / total).toFixed(3) : 0,
        interactionDensity: partOps.length ? +(edges / partOps.length).toFixed(3) : 0,
        peerResponseEdges: edges, participantOps: partOps.length,
      };
    },
    store,
    close: () => new Promise((res) => { if (ephTimer) clearTimeout(ephTimer); for (const t of hotTimers.values()) clearTimeout(t); hotTimers.clear(); watcher && watcher.close(); wss.clients.forEach((c) => c.close()); httpServer.close(() => res()); }),
    _http: httpServer,
  };

  return new Promise((resolve) => { httpServer.listen(port, '127.0.0.1', () => resolve(api)); });
}

// Runnable standalone: `node app/server.mjs [port]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const p = parseInt(process.argv[2] || '4300', 10);
  // Real deployments are GATED out of the box: default the presenter password to
  // `password` (override via PRESENTER_ROLE_PASSWORD). This applies ONLY to the CLI
  // self-run — createServer() from tests stays ungated unless a credential is passed.
  createServer({
    port: p,
    controlToken: process.env.PRESENTER_CONTROL_TOKEN || null,
    rolePassword: process.env.PRESENTER_ROLE_PASSWORD || 'password',
  }).then((s) => {
    const u = s.url();   // base like http://127.0.0.1:PORT (no trailing slash)
    console.log('Argus Presenter running:');
    console.log('  display :', u + '/');
    console.log('  control :', u + '/control');
    console.log('  creator :', u + '/creator');
  });
}
