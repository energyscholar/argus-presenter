/*
 * test/harness/equivalence.mjs — THE PLAN 0530 EQUIVALENCE HARNESS.
 *
 * ⛔ SCAFFOLDING. Plan 0530 P9 DELETES this file, `test/fixtures/0530-baseline.json` and
 *    `test/unit/0530-p1-equivalence.test.mjs`, and P9 FAILS if any of them still exists.
 *    Nothing in `app/`, `lib/`, `mcp/`, `harness/` or `components/` may import it — the only
 *    importer is the scaffolding test beside the fixture. Deleting the three files must leave
 *    a working suite, which is why the comparison lives in its own test file rather than being
 *    threaded into an existing one.
 *
 * ── WHAT IT IS ────────────────────────────────────────────────────────────────────────────────
 * Plan 0530 decomposes `app/server.mjs` (3,770 lines; `createServer()` is 3,473 of them) by
 * lifting collaborators out of one enormous closure. §2 of that plan says NO PHASE MAY CHANGE
 * BEHAVIOUR — not a route, not a log line, not an error string, not the order of a broadcast.
 * A claim like that needs an instrument, so this is one: it drives a server through a fixed
 * script and writes down what it did, in four sections (plan §3):
 *
 *   1. `http`     — a fixed request table: status, headers, and the response body, for an
 *                   UNGATED server and for a GATED one probed with and without the credential.
 *   2. `sockets`  — the welcome frames for seven `hello` variants, then every message type the
 *                   server accepts, each sent on a fresh socket as presenter and as participant,
 *                   with the exact reply frames recorded.
 *   3. `session`  — a scripted session's store OPLOG, verbatim, plus the final snapshot,
 *                   presence, health, telemetry and the durable session-log entries.
 *   4. `logs`     — every log line the server emitted during each of the three sections above, at
 *                   `debug` level, GROUPED BY TAG and in order within each tag. ⚠ The grouping is
 *                   not tidiness — see ASYNC_LOG_TAGS for what it costs and why global emission
 *                   order could not be kept.
 *
 * ── ⛓ WHY IT NORMALISES, AND WHY IT NEVER DROPS ───────────────────────────────────────────────
 * The server binds port 0, mints nonces, stamps `Date.now()`, names its session log with
 * `Math.random()`, and writes absolute temp paths into its own responses. A raw fingerprint
 * containing any of those differs on EVERY run, and the harness would fail for reasons that have
 * nothing to do with a refactor. So every value is passed through `redact()` first.
 *
 * Redaction REPLACES WITH A STABLE TOKEN — `<TS>`, `<PORT>`, `<PATH:tmp>`, `<HEX>`, `<SECRET>` —
 * and never deletes the key. A dropped field hides a change; a tokenised one still proves the
 * field was there, still proves its type, and still goes red if it disappears.
 *
 * ⚠ TWO FIELD FAMILIES ARE EXCLUDED FROM COMPARISON RATHER THAN MERELY TOKENISED. Both were
 * measured making this gate report DIFFERENT ON AN UNCHANGED TREE; nothing else is excluded, and
 * BOTH are fenced by a floor and an exact-equality ceiling in t0530-p1-03 so neither can grow
 * quietly:
 *   1. `sawPing`, outside the hello-reply window — a 5 s heartbeat on a clock the capture does not
 *      control. 2 of 10 sequential runs before plan 0530 P2b. See the `splitPings` block.
 *   2. `bytes`, wherever the number counts SESSION-LOG BYTES — the log's header line carries `pid`,
 *      a variable-width decimal, so the same behaviour writes 177 or 178 bytes depending on the
 *      process table. See the `SESSION_LOG_BYTES` block.
 *
 * ── ⛓ AND THE CLASS BOTH OF THOSE BELONG TO (plan 0530 P2c) ──────────────────────────────────
 * A field whose value depends on WHEN you look rather than on what the code does cannot gate a
 * refactor. The sweep that found the two above also found, and left in place, several that are
 * structurally in the class but have margins measured in seconds — each is named at its site with
 * the margin that protects it, so a future phase that shrinks a margin knows what it is spending.
 * The list, all in this file: `TIME-DEPENDENT, LEFT IN PLACE` comments. Read them before adding a
 * probe, a wait, or a request.
 *
 * ── ⛓ WHY THE ENVIRONMENT IS SYNTHETIC ────────────────────────────────────────────────────────
 * The capture points `PRESENTER_PLUGINS_DIR` and `PRESENTER_MODULES_DIR` at throwaway temp trees
 * it builds itself. Three reasons, all of which would otherwise make the baseline a lie:
 *   - the INSTALLED plugin tree and `modules/` are gitignored and differ per machine, so a
 *     fingerprint taken from them could never be re-matched on another checkout;
 *   - their content is domain content, and this repo is public — a tracked fixture full of it
 *     would violate the campaign-vocabulary guard (t0531-01);
 *   - a baseline that changes when a human edits an unrelated JSON file is not an instrument.
 * ⚠ THE COST, STATED PLAINLY: the plugin CODE path is exercised (a fixture plugin with two
 * stations is loaded and seated) but the installed plugin's own behaviour is NOT fingerprinted.
 *
 * ── USE ───────────────────────────────────────────────────────────────────────────────────────
 *   node test/harness/equivalence.mjs capture     # (re)write test/fixtures/0530-baseline.json
 *   node test/harness/equivalence.mjs verify      # capture + diff against the fixture; exit 1 on drift
 *   node test/harness/equivalence.mjs stability   # capture TWICE and diff the two — proves determinism
 */
import http from 'node:http';
import { WebSocket } from 'ws';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as srvlog from '../../app/log.mjs';
import { createServer } from '../../app/server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');
export const BASELINE_PATH = join(ROOT, 'test', 'fixtures', '0530-baseline.json');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Fixed credentials. Real values, so the gated paths run for real; tokenised on the way out. */
const CONTROL_TOKEN = 'equivalence-control-token';
const ROLE_SEED = 'equivalence-role-seed';
const ROLE_PASSWORD = 'equivalence-role-password';
const CAP_SECRET = 'equivalence-cap-secret';

/* Settle windows. Long enough that a reply has landed, short enough that a capture is ~20 s. */
const SETTLE_WELCOME = 90;
const SETTLE_REPLY = 110;

/* Strings longer than this are stored as `<BIG:len:hash>` — see `makeRedactor`. */
const BIG_STRING = 400;

/*
 * Keys whose value is a MEASURED ELAPSED TIME, not a configured one. These are the only numbers
 * the harness blanks by NAME, and the distinction matters: `settlingMs`, `ttlMs`, `flushMs` and
 * `maxBytes` are CONFIG and must stay comparable, because a refactor that changed one would be a
 * behaviour change. Anything added here must be a stopwatch reading.
 */
/*
 * ⚠ LOG TAGS WHOSE LINES ARE COMPARED AS A SET, NOT IN ORDER.
 *
 * Plan 0530 §3 asks for "every log line emitted, in order", and that is what the `lines` list is.
 * Two emitters cannot honour it, because they are not on the request path at all:
 *
 *   `asr`   — `voice_seg_start` spawns a REAL child process (`python3 voice/asr-whisper.py`) with
 *             a 300 ms watchdog. On an idle box its spawn/ready/exit lines fell in the same slot
 *             every run; under a loaded `npm test` the `exit` line jumped from the end of the
 *             session window to position 1.
 *   `queue` — `enforceQueueBounds` runs off the turn-SETTLING timer, so a `shed` line lands on a
 *             wall-clock boundary. Two consecutive captures on the same code disagreed about
 *             whether it fell before or after a `hello`.
 *
 * Both are scheduling, not behaviour. Their lines are still compared — content, fields and all —
 * as a sorted unique SET, so a change to what these paths log still goes red. Only the position
 * is surrendered, and only for these two tags.
 *
 * ⛓ THIS LIST IS A LOWER BOUND, discovered by running the harness until it lied. Adding a tag is
 * a deliberate loss of evidence: do it only after establishing that the emitter is on a timer,
 * and say so here.
 *
 * ⚠ AND THE SAME PROBLEM ONE LEVEL UP: even with those two removed, the GLOBAL interleaving of the
 * remaining lines is not stable, because the turn engine's `settle` timer emits between whatever
 * two request-driven lines the clock happens to fall between. So the log section is stored GROUPED
 * BY TAG, each group in emission order. What is kept: every line, its fields, its count, and the
 * order WITHIN a subsystem — which is where a refactor's sequencing lives. What is surrendered:
 * the interleaving BETWEEN subsystems. The order of a broadcast is not lost with it — that is
 * measured directly, per socket, in the `sockets` and `session.frames` sections.
 */
const ASYNC_LOG_TAGS = new Set(['asr', 'queue']);

const DURATION_KEYS = new Set([
  'ageMs', 'avgApplyMs', 'maxApplyMs', 'lastSeenAgoSec', 'idleMs', 'uptimeMs',
  'elapsedMs', 'sinceMs', 'openMs', 'durationMs', 'ageSec', 'agoMs', 'lastOpAgoMs',
  // Plan 0530 P2c. `connectedSec` and `eyesOnAgoSec` are `Math.floor((now - <stamp>)/1000)` at
  // app/server.mjs:3226/3229 — stopwatch readings, and the SIBLINGS of `lastSeenAgoSec`, which was
  // already here. They read 0/null today only because a probe socket lives ~240 ms; one slow
  // second and the attendance roster reports 1 with no code change. Blanked by NAME, key kept.
  'connectedSec', 'eyesOnAgoSec',
]);

// ── redaction ─────────────────────────────────────────────────────────────────────────────────

/**
 * A redaction context. `paths` are absolute prefixes to tokenise, `secrets` are exact strings,
 * `ports` are numbers that are really a bound port.
 */
export function makeRedactor({ paths = [], secrets = [], ports = [] } = {}) {
  const pathPairs = paths.filter((p) => p && p.abs).sort((a, b) => b.abs.length - a.abs.length);
  const secretPairs = secrets.filter((s) => s && s.value).sort((a, b) => String(b.value).length - String(a.value).length);
  const portSet = new Set(ports.map(Number).filter((n) => Number.isFinite(n)));

  function text(s) {
    let out = String(s);
    for (const p of pathPairs) out = out.split(p.abs).join(`<PATH:${p.token}>`);
    for (const sec of secretPairs) out = out.split(String(sec.value)).join(`<SECRET:${sec.token}>`);
    // ISO 8601 stamps, epoch-ms, weak etags, anon ids, long hex (nonces/hashes), ws/http origins.
    out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<ISO>');
    out = out.replace(/\b1[6-9]\d{11}\b/g, '<TS>');
    out = out.replace(/W\/"[^"]*"/g, '<ETAG>');
    out = out.replace(/\banon-[a-z0-9]{1,8}\b/g, '<ANON>');
    // ⚠ `{1,8}`, not `{4,8}` (plan 0530 P2c). The suffix is `Math.random().toString(36).slice(2,8)`
    // (lib/session-log.mjs:243) — SIX chars almost always, but base-36 of a double that ends in
    // zeros prints shorter, and a suffix the pattern misses leaks a raw random id straight into the
    // fingerprint. The `session-<8 digits>T?<digits>-` prefix is what anchors this; the suffix
    // length never was.
    out = out.replace(/\bsession-\d{8}T?\d{0,6}-[a-z0-9]{1,8}\b/gi, '<SESSIONLOGID>');
    out = out.replace(/\bsess-[a-z0-9]{5,12}-[a-z0-9]{4,10}\b/gi, '<SESSIONID>');   // api.situation's session id
    out = out.replace(/\bc\d+:[a-z0-9]{4,10}\b/g, '<OPID>');                        // client-minted opId
    out = out.replace(/\b[0-9a-f]{16,}\b/gi, '<HEX>');
    for (const p of portSet) out = out.replace(new RegExp(`(127\\.0\\.0\\.1|localhost):${p}\\b`, 'g'), '$1:<PORT>');
    return out;
  }

  function value(v) {
    if (v === null || v === undefined) return v === undefined ? '<UNDEFINED>' : null;
    if (typeof v === 'number') {
      if (portSet.has(v)) return '<PORT>';
      // ⚠ `isFinite`, not `isInteger` (plan 0530 P2c). `statSync().mtimeMs` is a FRACTIONAL epoch
      // (1785708555692.2302), and it reaches the fingerprint through /api/session-log's `sessions`
      // listing. Under the old integer-only test it was a raw wall clock that would differ on every
      // single run. Nothing in this fingerprint is a configured number in the 2020–2096 ms band.
      if (Number.isFinite(v) && v >= 1_600_000_000_000 && v <= 4_000_000_000_000) return '<TS>';
      return v;
    }
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const s = text(v);
      // A rendered beat's `html` is tens of kilobytes. Storing it whole would make the fixture
      // megabytes; storing a LENGTH + HASH keeps every one-character change detectable and the
      // field itself present. Collapsed, never dropped.
      return s.length > BIG_STRING ? `<BIG:${s.length}:${sha(s)}>` : s;
    }
    if (typeof v === 'function') return '<FUNCTION>';
    if (Array.isArray(v)) return v.map(value);
    if (typeof v === 'object') {
      const out = {};
      // KEYS are redacted too. `chat/<user>-<epoch>` puts a wall-clock stamp in the PATH, so a
      // value-only redactor leaves the fingerprint unstable in a way that looks like a real diff.
      for (const k of Object.keys(v).sort()) {
        const rk = text(k);
        if (DURATION_KEYS.has(k) && typeof v[k] === 'number') out[rk] = '<DURATION>';
        else if (k === 'pid' && typeof v[k] === 'number') out[rk] = '<PID>';   // the session-log header's provenance stamp
        else out[rk] = value(v[k]);
      }
      return out;
    }
    return String(v);
  }

  return { text, value };
}

/*
 * ⛓ SESSION-LOG BYTE COUNTS — THE SECOND DELIBERATE EXCLUSION (plan 0530 P2b/P2c).
 *
 * The durable log's FIRST line is its provenance header, and it carries `pid` (lib/session-log.mjs
 * :394) — a variable-width decimal. The same code writes 177 bytes under a five-digit pid and 178
 * under a six-digit one. That number is the process table talking, not the server, and it is
 * reached from FOUR directions: `health().sessionLog.stats.bytes`, `sessionLog.read().bytes` and
 * its `parts[].bytes`, and — once the log has flushed — every byte total in the /api/session-log
 * response, including the HTTP body's own length.
 *
 * ⚖ WHAT IS SURRENDERED, AND WHY IT IS CHEAP: only the SIZE. The log's ENTRIES are compared
 * verbatim, and /api/session-log is a JSON route whose whole body is compared as parsed `json`, so
 * `response.bytes` there is the one field that adds nothing except the pid's decimal width. A
 * change to WHAT is written still goes red; a change to HOW MANY DIGITS the kernel gave this
 * process does not.
 *
 * ⛔ Do NOT reach for this token anywhere else. `response.bytes` is real evidence on the other 103
 *    routes — it is how a truncated or padded body is caught on the ones served as text. The
 *    `bytesCompared` FLOOR and the exact `bytesExcluded` CEILING in t0530-p1-03 exist to make a
 *    quiet widening impossible.
 */
export const BYTES_EXCLUDED = '<BYTES:SESSION-LOG-PID-WIDTH>';

/**
 * Replace every `key` found anywhere under `node` with `token`, in place.
 * Used for exactly one key — `bytes`, under the session-log surfaces named in the block above.
 */
function blankKey(node, key, token) {
  if (Array.isArray(node)) { for (const v of node) blankKey(v, key, token); return node; }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      if (k === key) node[k] = token;
      else blankKey(node[k], key, token);
    }
  }
  return node;
}

/** Group already-redacted log entries by `tag`, each group in emission order. See ASYNC_LOG_TAGS. */
function groupLogEntries(entries) {
  const byTag = {};
  for (const e of (Array.isArray(entries) ? entries : [])) {
    const tag = (e && e.tag) || '<untagged>';
    if (ASYNC_LOG_TAGS.has(tag)) continue;
    (byTag[tag] = byTag[tag] || []).push(e);
  }
  const out = {};
  for (const k of Object.keys(byTag).sort()) out[k] = byTag[k];
  return out;
}

/** JSON round-trip first, so Maps/Sets/class instances become the shape the wire would carry. */
function plain(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return { '<UNSERIALISABLE>': String((e && e.message) || e) }; } }

// ── a temp deployment ─────────────────────────────────────────────────────────────────────────

/** A domain-NEUTRAL station plugin: the plugin code path, with none of the plugin's content. */
const FIXTURE_PLUGIN = {
  name: 'equivalence-fixture',
  requires: [], components: [], presets: {}, fieldSchemas: {},
  stationSelectorLabel: 'Post',
  stationDefaultUid: 2,
  stations: [
    { stationUid: 1, stationCode: 'alpha', stationLabel: 'Alpha', group: 'One', icon: 'A', color: '#111111', maxOccupants: 1, sortOrder: 1 },
    { stationUid: 2, stationCode: 'beta', stationLabel: 'Beta', group: 'Two', icon: 'B', color: '#222222', maxOccupants: null, sortOrder: 2 },
    { stationUid: 3, stationCode: 'gamma', stationLabel: 'Gamma', group: 'Two', icon: 'C', color: '#333333', maxOccupants: 2, sortOrder: 3 },
  ],
};

const FIXTURE_MODULE = {
  manifest: { title: 'Equivalence fixture', version: '1.0', kind: 'fixture', summary: 'A fixed module the fingerprint drives.', defaultBeatId: 'b-title' },
  sections: [{ id: 's1', title: 'Only section', kind: 'section', summary: 'One of everything.', beatIds: ['b-card', 'b-choice'] }],
  beats: [
    { id: 'b-title', component: 'card', opts: { title: 'Equivalence fixture', body: 'Title page.' } },
    { id: 'b-card', component: 'card', promptId: 'p-card', opts: { title: 'Card beat', body: 'A card.' } },
    { id: 'b-choice', component: 'choice', promptId: 'p-choice', opts: { prompt: 'Pick one', options: [{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }] } },
    { id: 'b-private', component: 'card', promptId: 'p-private', target: 'participant', opts: { title: 'Participants only', body: 'Narrowed.' } },
  ],
};

const FIXTURE_BROKEN_MODULE = { manifest: { title: 'Broken fixture' }, beats: [{ component: 'card' }] };

const FIXTURE_SERIES = { manifest: { title: 'Equivalence series' }, moduleIds: ['fixture-a', 'nope'] };

/**
 * Build the throwaway plugin + modules trees. Returns absolute dirs (caller removes them).
 *
 * ⛓ TWO SESSION-LOG DIRECTORIES, NOT ONE (plan 0530 P2c). The HTTP section PROBES a directory
 * (`GET /api/session-log` lists everything in it); the session section WRITES one. Sharing a
 * directory made what the probe saw depend on which section had run — the exact shape of defect
 * this phase exists to remove, and one that would have come back silently the first time somebody
 * reordered the sections in `capture()`. They are now isolated by construction rather than by the
 * order of a literal array.
 */
function makeDeployment() {
  const base = mkdtempSync(join(tmpdir(), 'ap-0530-'));
  const pluginsDir = join(base, 'plugins');
  const modulesDir = join(base, 'modules');
  const logDir = join(base, 'session-log');
  const logDirHttp = join(base, 'session-log-http');
  mkdirSync(join(pluginsDir, 'equivalence-fixture'), { recursive: true });
  writeFileSync(join(pluginsDir, 'equivalence-fixture', 'plugin.json'), JSON.stringify(FIXTURE_PLUGIN, null, 2));
  mkdirSync(modulesDir, { recursive: true });
  writeFileSync(join(modulesDir, 'fixture-a.json'), JSON.stringify(FIXTURE_MODULE, null, 2));
  writeFileSync(join(modulesDir, 'fixture-broken.json'), JSON.stringify(FIXTURE_BROKEN_MODULE, null, 2));
  writeFileSync(join(modulesDir, 'fixture.series.json'), JSON.stringify(FIXTURE_SERIES, null, 2));
  mkdirSync(logDir, { recursive: true });
  mkdirSync(logDirHttp, { recursive: true });
  return { base, pluginsDir, modulesDir, logDir, logDirHttp };
}

// ── http probes ───────────────────────────────────────────────────────────────────────────────

function request(port, { method = 'GET', path = '/', headers = {}, body = null }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: Buffer.from(''), error: String((e && e.message) || e) }));
    if (body != null) req.write(body);
    req.end();
  });
}

/*
 * The request table. A LOWER BOUND on the routes that exist (brief §4.1) — every arm of the
 * if/else chain at app/server.mjs:540–802 is here, plus the traversal/method/credential edges
 * that the arms themselves branch on.
 *
 * ⛔ TIME-DEPENDENT, LEFT IN PLACE — AND A TRAP FOR WHOEVER ADDS THE NEXT ROW. No request here
 * WRITES a file into MODULES_DIR: `api-module-admin-post` carries no `op` (400 'bad op') and
 * `api-modules-post-badjson` is rejected before the write. That is load-bearing. A row that DID
 * write one would trip `fs.watch(MODULES_DIR)` at app/server.mjs:537, whose 150 ms debounce timer
 * then emits `module changed` into `logs.http` — or does NOT, if the remaining requests finish and
 * `close()` clears the timer first. Whichever side of 150 ms this box lands on becomes a phantom
 * difference. If you need such a row, follow it with an explicit settle longer than the debounce.
 */
const REQUESTS = [
  { name: 'root', path: '/' },
  { name: 'root-query', path: '/?u=probe' },
  { name: 'control', path: '/control' },
  { name: 'manage', path: '/manage' },
  { name: 'creator', path: '/creator' },
  { name: 'branch-mjs', path: '/branch.mjs' },
  { name: 'validate-mjs', path: '/validate.mjs' },
  { name: 'voice-stub', path: '/lib/voice-stub.js' },
  { name: 'voice-capture', path: '/lib/voice-capture.mjs' },
  { name: 'voice-worklet', path: '/lib/voice-worklet.js' },
  { name: 'branding-svg', path: '/branding/argus-presenter.svg' },
  { name: 'api-auth', path: '/api/auth' },
  { name: 'api-modules', path: '/api/modules' },
  { name: 'api-modules-query', path: '/api/modules?x=1' },
  { name: 'api-modules-one', path: '/api/modules/fixture-a' },
  { name: 'api-modules-broken', path: '/api/modules/fixture-broken' },
  { name: 'api-modules-missing', path: '/api/modules/nope' },
  { name: 'api-modules-traversal', path: '/api/modules/..%2F..%2Fetc%2Fpasswd' },
  { name: 'api-modules-post-badjson', method: 'POST', path: '/api/modules/fixture-b', headers: { 'content-type': 'application/json' }, body: 'not json' },
  { name: 'api-module-admin', path: '/api/module-admin' },
  { name: 'api-module-admin-get-one', path: '/api/module-admin/fixture-a' },
  { name: 'api-module-admin-post', method: 'POST', path: '/api/module-admin/fixture-a', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'working' }) },
  { name: 'api-session-log', path: '/api/session-log' },
  { name: 'api-session-log-limit', path: '/api/session-log?limit=5' },
  { name: 'api-series', path: '/api/series' },
  { name: 'api-series-one', path: '/api/series/fixture' },
  { name: 'api-series-missing', path: '/api/series/nope' },
  { name: 'api-series-bad-id', path: '/api/series/..%2Fetc' },
  { name: 'api-situation', path: '/api/situation' },
  { name: 'api-situation-consumer', path: '/api/situation?consumer=probe' },
  { name: 'api-work-get', path: '/api/work' },
  { name: 'api-work-post-badop', method: 'POST', path: '/api/work', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'x', op: 'nonsense' }) },
  { name: 'api-work-post-noid', method: 'POST', path: '/api/work', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'resolve' }) },
  { name: 'not-found', path: '/no/such/route' },
  { name: 'not-found-post', method: 'POST', path: '/no/such/route' },
];

/** Status + headers + BODY (json in full; text/binary as bytes + a redacted head). */
function describeResponse(res, redactor) {
  const ct = String(res.headers['content-type'] || '');
  const out = {
    status: res.status,
    headers: {
      'content-type': ct ? redactor.text(ct) : null,
      'cache-control': res.headers['cache-control'] != null ? redactor.text(String(res.headers['cache-control'])) : null,
      etag: res.headers.etag != null ? redactor.text(String(res.headers.etag)) : null,
    },
    bytes: res.body.length,
  };
  if (res.error) out.error = redactor.text(res.error);
  const raw = res.body.toString('utf8');
  if (ct.includes('json')) {
    try { out.json = redactor.value(JSON.parse(raw)); }
    catch (e) { out.json = { '<UNPARSEABLE>': redactor.text(raw.slice(0, 200)) }; }
  } else {
    // Not JSON ⇒ the exact bytes are the behaviour, but they are large. A redacted head plus the
    // length plus a hash catches any change, including a one-character one, without a 40 KB fixture.
    out.text = { head: redactor.text(raw.slice(0, 240)), tail: redactor.text(raw.slice(-120)), sha256: sha(redactor.text(raw)) };
  }
  return out;
}

function sha(s) {
  // Tiny FNV-1a-64 in BigInt: no crypto import, no salt, stable across runs and machines.
  let h = 0xcbf29ce484222325n;
  const bytes = Buffer.from(String(s), 'utf8');
  for (const b of bytes) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, '0');
}

// ── socket probes ─────────────────────────────────────────────────────────────────────────────

/** Open one socket, say `hello`, settle, and return a frame collector. */
async function openSocket(url, hello) {
  const ws = new WebSocket(url);
  const frames = [];
  ws.on('message', (b) => { try { frames.push(JSON.parse(b.toString())); } catch (e) { frames.push({ '<UNPARSEABLE>': b.toString().slice(0, 120) }); } });
  await new Promise((res) => { ws.on('open', res); ws.on('error', res); });
  if (hello) ws.send(JSON.stringify({ t: 'hello', ...hello }));
  await wait(SETTLE_WELCOME);
  return {
    ws, frames,
    send: (m) => { try { ws.send(JSON.stringify(m)); } catch (e) { frames.push({ '<SENDFAILED>': String((e && e.message) || e) }); } },
    take: () => { const f = frames.slice(); frames.length = 0; return f; },
    close: () => { try { ws.close(); } catch (e) {} },
  };
}

/*
 * ⛓ PINGS — AND WHY `sawPing` IS COMPARED IN ONE WINDOW ONLY (plan 0530 P2b).
 *
 * The server emits `{t:'ping'}` from exactly TWO places (enumerated from `app/server.mjs`, not from
 * a plan — a cited site is a lower bound), and only one of them is on a request path:
 *
 *   1. `app/server.mjs:1014` — the X3 RTT probe, sent SYNCHRONOUSLY inside the `hello` handler
 *      right after the welcome frame. Deterministic, behavioural, and worth a gate: if a refactor
 *      drops it, every `welcome.*.sawPing` goes true -> false and the comparator names the field.
 *   2. `app/server.mjs:763` — the heartbeat, `setInterval(..., PING_MS = 5000)`, started when the
 *      SERVER is constructed. It fires on a wall clock the capture does not control, at whichever
 *      socket happens to be open when the tick lands.
 *
 * ⚠ EMITTER 2 MADE THIS FIELD A FALSE-POSITIVE GENERATOR, AND THAT WAS OBSERVED, NOT REASONED.
 * A message probe lives ~240 ms — a 90 ms welcome settle that `c.take()` DISCARDS, then a 110 ms
 * recorded reply window, then a 40 ms gap with no socket at all — and the message phase runs ~12.5 s,
 * so ~2 heartbeat ticks land in it and only ~46% of a tick's landing zone is inside a recorded
 * window. WHICH probe catches one is pure scheduling. The baseline caught `station-show@participant`;
 * plan 0530 P2 twice saw a different probe catch it ON AN UNCHANGED TREE, and P2b then measured it:
 * 10 sequential `verify` runs on an untouched checkout gave 8 EQUIVALENT and 2 DIFFERENT, both
 * DIFFERENT runs reporting this field and nothing else. On an idle box the fixed waits make the
 * tick land in the same slot; under load the accumulated drift moves it.
 * `sections.session.frames.*` has the SAME defect with a thinner margin — its recorded window is
 * ~1.3 s against a 5 s first tick, so it is deterministic only while the box stays fast.
 *
 * ⛓ THE RULE: `sawPing` is compared ONLY in the window that contains the hello reply, because that
 * is the only window in which a ping is behaviour. Everywhere else the welcome has already been
 * consumed, the heartbeat is the ONLY possible source, and the field therefore carries ZERO
 * information about the server — excluding it there costs no coverage whatsoever. (Nothing else is
 * surrendered: pings are stripped from `frames` in every window either way, so the recorded frame
 * lists are unaffected.) Seven more 0530 phases lean on this gate; a gate that can say DIFFERENT
 * without a code change certifies nothing.
 *
 * The exclusion is LOUD, not quiet: the key stays present and carries a named token, so a field
 * that VANISHES still goes red, and `coverage()` counts both populations separately so the
 * exclusion cannot grow later without a test going red — see t0530-p1-03's `pingsCompared` floor
 * and `pingsExcluded` ceiling.
 *
 * ⛔ Do NOT widen PINGS_EXCLUDED to the welcome window. That deletes the only gate on the X3 RTT
 *    probe, and the `pingsCompared` floor exists precisely to stop it.
 * ⛔ Do NOT "fix" this by making PING_MS configurable. That is an `app/` behaviour change, which
 *    plan 0530 §2 forbids outright.
 */
export const PING_EXCLUDED = '<PING:HEARTBEAT-NONDETERMINISTIC>';
const PINGS_COMPARED = 'pings-compared';   // the hello-reply window: the X3 RTT probe is deterministic
const PINGS_EXCLUDED = 'pings-excluded';   // any post-welcome window: only the 5 s heartbeat can land

/** Split ping frames out of a recorded window. `mode` is MANDATORY — see the block above. */
function splitPings(frames, redactor, mode) {
  if (mode !== PINGS_COMPARED && mode !== PINGS_EXCLUDED) {
    throw new Error(`splitPings: the ping mode must be stated explicitly at the call site, got ${String(mode)}`);
  }
  const kept = [], pings = [];
  for (const f of frames) (f && f.t === 'ping' ? pings : kept).push(f);
  return {
    frames: kept.map((f) => redactor.value(plain(f))),
    sawPing: mode === PINGS_EXCLUDED ? PING_EXCLUDED : pings.length > 0,
  };
}

const HELLOS = [
  { name: 'participant', hello: { userId: 'u-part', userName: 'Part' } },
  { name: 'presenter-ungated', hello: { userId: 'u-pres', userName: 'Pres', role: 'presenter' } },
  { name: 'presenter-token', hello: { userId: 'u-pres2', userName: 'Pres2', role: 'presenter', token: CONTROL_TOKEN } },
  { name: 'presenter-bad-token', hello: { userId: 'u-pres3', userName: 'Pres3', role: 'presenter', token: 'wrong' } },
  { name: 'ai', hello: { userId: 'u-ai', userName: 'AI', role: 'ai' } },
  { name: 'unknown-role', hello: { userId: 'u-weird', userName: 'Weird', role: 'sovereign' } },
  { name: 'seated', hello: { userId: 'u-seat', userName: 'Seat', stationUID: 3 } },
  { name: 'anonymous', hello: { userName: 'NoId' } },
  { name: 'bad-cap', hello: { userId: 'u-cap', userName: 'Cap', cap: 'not.a.real.token' } },
  { name: 'resync', hello: { userId: 'u-resync', userName: 'Resync', role: 'presenter', lastVersion: 1 } },
];

/*
 * Every message type the router accepts (app/server.mjs:1176–1430), plus one it does not.
 * A cited site is a lower bound — this list was enumerated from the router, not from the plan.
 */
const MESSAGES = [
  { name: 'result', msg: { t: 'result', promptId: 'p-choice', value: 'one' } },
  { name: 'op', msg: { t: 'op', path: 'notes/probe', verb: 'set', value: 'v', opId: 'op-1' } },
  { name: 'op-denied-path', msg: { t: 'op', path: 'polls/x/open', verb: 'set', value: true, opId: 'op-2' } },
  { name: 'op-invalid', msg: { t: 'op', path: '../escape', verb: 'set', value: 1, opId: 'op-3' } },
  { name: 'control-clear', msg: { t: 'control', action: 'clear', args: {} } },
  { name: 'control-unknown', msg: { t: 'control', action: 'no-such-action', args: {} } },
  { name: 'control-spotlight', msg: { t: 'control', action: 'spotlight', args: { userId: 'u-part', granted: true } } },
  { name: 'pong', msg: { t: 'pong', ts: 1 } },
  { name: 'telemetry', msg: { t: 'telemetry', rtt: 12, reconnects: 1 } },
  { name: 'request-poll', msg: { t: 'request-poll', promptId: 'p-choice' } },
  { name: 'ack', msg: { t: 'ack', ackId: 'ready' } },
  { name: 'ack-unknown', msg: { t: 'ack', ackId: 'no-such-ack' } },
  { name: 'station-select', msg: { t: 'station-select', stationUID: 1 } },
  { name: 'station-select-unknown', msg: { t: 'station-select', stationUID: 99 } },
  { name: 'station-default', msg: { t: 'station-default' } },
  { name: 'station-show', msg: { t: 'station-show', stationUID: 1 } },
  { name: 'station-share', msg: { t: 'station-share', stationUID: 1 } },
  { name: 'attendance-request', msg: { t: 'attendance-request' } },
  { name: 'voice-seg-start', msg: { t: 'voice_seg_start' } },
  { name: 'voice-seg-end', msg: { t: 'voice_seg_end' } },
  { name: 'voicedbg', msg: { t: 'voicedbg', stage: 'probe' } },
  { name: 'chat', msg: { t: 'chat', text: 'a scripted line' } },
  { name: 'pvs-subscribe', msg: { t: 'pvs_subscribe', consumer: 'probe' } },
  { name: 'pvs-unsubscribe', msg: { t: 'pvs_unsubscribe' } },
  { name: 'unknown-type', msg: { t: 'no-such-message-type', payload: 1 } },
  { name: 'no-type', msg: { payload: 1 } },
];

/*
 * ⛓ TIME-DEPENDENT, LEFT IN PLACE — the rest of the plan 0530 P2c sweep, with the margin that
 * protects each one. None of these has ever flaked; every one of them CAN. They are listed because
 * "it has not happened yet" is not a property of the code, and because the cheapest way for a later
 * phase to reintroduce a phantom difference is to shorten a wait without knowing what it was buying.
 *
 *  1. `health().connections[].stale` and `attendance().roster[].connected` — both are
 *     `(now - lastSeen) > STALE_MS`, and STALE_MS is 15 000 ms (app/server.mjs:59). The scripted
 *     session runs ~2.3 s and a probe socket lives ~240 ms. MARGIN ~6×. Compared.
 *  2. `raf()` — `peerResponseEdges` and `interactionDensity` pair participant ops that fall within
 *     a 5 000 ms window (app/server.mjs `raf: ({ windowMs = 5000 })`). The two chat ops it pairs are
 *     ~1 ms apart. MARGIN ~5 000×. Compared.
 *  3. `queueEphemeral` — a 66 ms coalescing timer (app/server.mjs:1428) that would reorder a
 *     broadcast against the next scripted step. It CANNOT fire here: it is reached only for paths
 *     matching `pointer|laser` (app/state.mjs:32) and no probe writes one. MARGIN: total. If you
 *     add a pointer op, the 60 ms waits in captureSession are SHORTER than the coalescer.
 *  4. `voice seg-timeout` — a 3 000 ms open-segment watchdog (app/server.mjs:2272). It never fires
 *     because a socket close clears it (app/server.mjs:1203) and every probe closes at ~240 ms.
 *  5. `srvlog.tail(500)` — the log ring is read 500 lines at a time and the busiest section emits
 *     ~99. A section that ever exceeded 500 would silently lose its OLDEST lines and the loss would
 *     look like a behaviour change. MARGIN ~5×.
 *  6. `socketId` (`c1`…`c62`) is a per-server counter, so ONE extra connection renumbers every line
 *     after it. P2b recorded exactly that shape once in ~24 runs — an unexplained extra `auth`
 *     entry shifting the arrays after it. NOT reproduced in the 10 runs measured for P2c, so it is
 *     recorded and not acted on: excluding a socket id would blind the gate to a real change in
 *     which socket did what.
 */

// ── the three sections ────────────────────────────────────────────────────────────────────────

/*
 * ⛓ THE ROUTE THAT READS A DIRECTORY — plan 0530 P2c's founding defect, and the arithmetic.
 *
 * `GET /api/session-log` does not report server state; it STATS A DIRECTORY and reads the files in
 * it. What is in that directory when the probe fires is decided by `lib/session-log.mjs:292` — an
 * unref'd `setTimeout(flushNow, flushMs = 250)` scheduled when the log's own provenance header is
 * buffered at construction. The gated server is built, ~22 requests later the probe fires, and
 * whether 250 ms have passed by then is a property of the box, not of the code.
 *
 * ⚠ MEASURED, NOT REASONED: 10 sequential captures on an untouched checkout gave 9 EQUIVALENT and
 * 1 DIFFERENT, the DIFFERENT run reporting 20 differences and NOTHING ELSE — `sessions` 0 -> 1,
 * `stats.written` 0 -> 1, `stats.bytes` 0 -> 178, `entries` 0 -> 1, and both response lengths. The
 * Auditor independently hit the same field at 7/8. It is one defect wearing twenty names.
 *
 * ⚖ THE FIX IS DETERMINISM, NOT EXCLUSION, and it BUYS coverage rather than spending it. Flushing
 * immediately before the probe replaces "whatever the timer did" with "everything appended so far
 * is on disk" — the header entry is now COMPARED VERBATIM (kind, profile, gated, voiceEnabled),
 * where the baseline previously froze an empty array. Nothing about the server changes: `flush()`
 * is the same call the session section already makes, and 0530 §2 forbids touching `app/`.
 * The only residue is the byte totals, which follow the pid's decimal width — see BYTES_EXCLUDED.
 */
const READS_THE_LOG_DIRECTORY = (name) => name.startsWith('api-session-log');

async function captureHttp(dep) {
  const out = {};
  for (const flavour of ['bare', 'gated']) {
    const opts = { port: 0 };
    // ⛓ ITS OWN log directory, not the session section's — see makeDeployment.
    if (flavour === 'gated') Object.assign(opts, { controlToken: CONTROL_TOKEN, roleSeed: ROLE_SEED, rolePassword: ROLE_PASSWORD, capSecret: CAP_SECRET, sessionLogDir: dep.logDirHttp });
    const server = await createServer(opts);
    const port = server.port();
    const redactor = makeRedactor({
      paths: [{ abs: dep.base, token: 'tmp' }, { abs: ROOT, token: 'repo' }, { abs: tmpdir(), token: 'tmpdir' }],
      secrets: [{ value: CONTROL_TOKEN, token: 'control' }, { value: ROLE_SEED, token: 'seed' }, { value: CAP_SECRET, token: 'cap' }],
      ports: [port],
    });
    try {
      const table = {};
      for (const r of REQUESTS) {
        // Settle the log's own writes BEFORE any probe that lists the directory. A no-op for the
        // bare flavour, where the log is disabled and `flush()` returns its status untouched.
        if (READS_THE_LOG_DIRECTORY(r.name)) await server.sessionLog.flush();
        const bare = await request(port, r);
        table[r.name] = { request: { method: r.method || 'GET', path: r.path, credentialled: false }, response: describeResponse(bare, redactor) };
        if (flavour === 'gated') {
          if (READS_THE_LOG_DIRECTORY(r.name)) await server.sessionLog.flush();
          const authed = await request(port, { ...r, headers: { ...(r.headers || {}), 'x-control-token': CONTROL_TOKEN } });
          table[r.name + '+token'] = { request: { method: r.method || 'GET', path: r.path, credentialled: true }, response: describeResponse(authed, redactor) };
        }
        /*
         * Byte totals only, and only on the responses that actually CARRY them — the credentialled
         * 200s, identified by the `stats` block the log payload always has. The ungated 403s on the
         * same route are `{"error":"forbidden"}` and stay fully compared, byte length included:
         * their size has nothing to do with a pid, and an exclusion that swallowed them would be
         * wider than its own justification.
         */
        for (const key of [r.name, r.name + '+token']) {
          const resp = table[key] && table[key].response;
          if (resp && resp.json && resp.json.stats) blankKey(resp, 'bytes', BYTES_EXCLUDED);
        }
      }
      out[flavour] = table;
    } finally { await server.close(); }
  }
  return out;
}

async function captureSockets(dep) {
  const server = await createServer({ port: 0, controlToken: CONTROL_TOKEN, roleSeed: ROLE_SEED, rolePassword: ROLE_PASSWORD, capSecret: CAP_SECRET });
  const port = server.port();
  const url = server.url().replace('http', 'ws');
  const redactor = makeRedactor({
    paths: [{ abs: dep.base, token: 'tmp' }, { abs: ROOT, token: 'repo' }, { abs: tmpdir(), token: 'tmpdir' }],
    secrets: [{ value: CONTROL_TOKEN, token: 'control' }, { value: ROLE_SEED, token: 'seed' }, { value: CAP_SECRET, token: 'cap' }],
    ports: [port],
  });
  const out = { welcome: {}, messages: {} };
  try {
    for (const h of HELLOS) {
      const c = await openSocket(url, h.hello);
      // The ONLY window whose ping is behaviour: this take() still holds the hello reply, and the
      // X3 RTT probe rides in it. Compared.
      out.welcome[h.name] = splitPings(c.take(), redactor, PINGS_COMPARED);
      c.close();
      await wait(20);
    }
    // Each probe gets a FRESH socket so one message cannot contaminate the next, and is run once
    // as a participant and once as an authenticated presenter — the router's two authority levels.
    for (const role of ['participant', 'presenter']) {
      for (const m of MESSAGES) {
        // ⚠ A UNIQUE userId per probe, and this is not cosmetic. Reusing one id across 26 fresh
        // sockets races the unbind: if the previous socket has not left `byUser` when the next
        // hello lands, the server logs `conn/duplicate-userId` — a warn that appeared in roughly
        // one capture in six and looked exactly like a behaviour change. The race is the
        // harness's, not the server's, so the harness stops running it.
        const uid = `probe-${role}-${m.name}`;
        const hello = role === 'presenter'
          ? { userId: uid, userName: 'ProbePres', role: 'presenter', token: CONTROL_TOKEN }
          : { userId: uid, userName: 'ProbePart' };
        const c = await openSocket(url, hello);
        c.take();                       // discard the welcome; it is fingerprinted above
        c.send(m.msg);
        await wait(SETTLE_REPLY);
        // The welcome (and its RTT probe) was discarded four lines up, so a ping here can ONLY be
        // the 5 s heartbeat. Excluded — it is the clock talking, not the server.
        out.messages[`${m.name}@${role}`] = splitPings(c.take(), redactor, PINGS_EXCLUDED);
        c.close();
        await wait(40);
      }
    }
  } finally { await server.close(); }
  return out;
}

async function captureSession(dep) {
  const server = await createServer({
    port: 0, controlToken: CONTROL_TOKEN, roleSeed: ROLE_SEED, rolePassword: ROLE_PASSWORD,
    capSecret: CAP_SECRET, sessionLogDir: dep.logDir,
  });
  const port = server.port();
  const url = server.url().replace('http', 'ws');
  const redactor = makeRedactor({
    paths: [{ abs: dep.base, token: 'tmp' }, { abs: ROOT, token: 'repo' }, { abs: tmpdir(), token: 'tmpdir' }],
    secrets: [{ value: CONTROL_TOKEN, token: 'control' }, { value: ROLE_SEED, token: 'seed' }, { value: CAP_SECRET, token: 'cap' }],
    ports: [port],
  });
  const out = {};
  try {
    const gm = await openSocket(url, { userId: 'gm', userName: 'Presenter', role: 'presenter', token: CONTROL_TOKEN });
    const a = await openSocket(url, { userId: 'p-a', userName: 'A', stationUID: 1 });
    const b = await openSocket(url, { userId: 'p-b', userName: 'B', stationUID: 3 });
    gm.take(); a.take(); b.take();

    server.setModule(JSON.parse(JSON.stringify(FIXTURE_MODULE)));
    await wait(60);
    server.showBeat('b-card');
    await wait(60);
    server.stageBeat('b-choice', { userId: 'gm', role: 'presenter' });
    await wait(60);
    server.sendBeat({ id: 'b-choice', targets: ['all'] }, { userId: 'gm', role: 'presenter' });
    await wait(60);
    server.sendBeat({ id: 'b-private', targets: ['p-a'] }, { userId: 'gm', role: 'presenter' });
    await wait(60);
    server.openPoll({ promptId: 'poll-1', prompt: 'Which?', options: [{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }] });
    await wait(60);
    a.send({ t: 'result', promptId: 'poll-1', value: 'one' });
    b.send({ t: 'result', promptId: 'poll-1', value: 'two' });
    await wait(80);
    server.closePoll('poll-1');
    await wait(60);
    a.send({ t: 'chat', text: 'first line' });
    b.send({ t: 'chat', text: 'second line' });
    /*
     * ⛓ 520 ms, NOT 80 (plan 0530 P2c). A chat op enters the turn engine, and the LAST open turn is
     * closed by `openTurn.timer = setTimeout(closeTurn('settle'), settlingMs)` — 400 ms on the
     * `wearable` profile (app/profiles.mjs:45). That timer emits `voice turn-complete`
     * (app/server.mjs:2119), which is the ONE line in the ordered `voice` group that is not
     * request-driven. At 80 ms the line landed ~460 ms before `close()` cleared the timer; a box
     * that stalled for half a second anywhere in the remaining script would have DELETED a log line
     * from the fingerprint. Waiting the settling window out here makes its emission a fact of the
     * script rather than a race against shutdown, and costs 440 ms of a ~17 s capture.
     * ⚠ Note the asymmetry with `queue shed`, which rides the SAME timer and is excluded by tag in
     * ASYNC_LOG_TAGS. `voice` could not be excluded the same way — `seg-start` and `inbox` in that
     * group ARE behaviour — so this one is bought with a wait instead.
     */
    await wait(520);
    server.spotlight('p-a', true);
    server.stationSet('p-b', 1);
    await wait(60);
    gm.send({ t: 'control', action: 'op', args: { path: 'notes/gm', verb: 'set', value: 'noted', opId: 'op-gm-1' } });
    await wait(60);
    server.pushComponent('all', 'card', { title: 'Pushed', body: 'Directly.' });
    await wait(60);
    server.presentText({ text: 'A line of text.', title: 'Text' });
    await wait(60);
    server.chime({ message: 'Ready?', requireAck: true, ackId: 'ready' });
    await wait(60);
    a.send({ t: 'ack', ackId: 'ready' });
    await wait(80);
    server.clear('all');
    await wait(80);

    /*
     * ⛓ FLUSH BEFORE MEASURING (plan 0530 P2c). `health().sessionLog.stats.written` counts lines
     * the flush timer has actually put on disk, so without this it reports "appended minus whatever
     * was still buffered when the 250 ms timer last fired" — a stopwatch reading wearing a
     * counter's name. It reads 15 of 15 on this box and would read 13 or 14 on a slower one, with
     * no code change anywhere. After the flush, `written === appended` is a property of the script.
     */
    await server.sessionLog.flush();

    // ── section 3 proper: the oplog, verbatim, then the state that produced it.
    out.oplog = redactor.value(plain(server.store.oplogSince(0)));
    out.version = server.store.version();
    out.snapshotPresenter = redactor.value(plain(server.store.snapshot({ role: 'presenter', userId: 'gm' }).state));
    out.snapshotParticipant = redactor.value(plain(server.store.snapshot({ role: 'participant', userId: 'p-a' }).state));
    out.presence = redactor.value(plain(server.presence()));
    out.stations = redactor.value(plain(server.stations()));
    out.attendance = redactor.value(plain(server.attendance()));
    out.health = blankKey(redactor.value(plain(server.health())), 'bytes', BYTES_EXCLUDED);   // the session log's size follows the pid's width — see the BYTES_EXCLUDED block
    out.raf = redactor.value(plain(server.raf()));
    out.telemetry = redactor.value(plain(server.telemetry()));
    // `debugDump.opLog` is `log.view()` — the SAME process-global ring the logs section reads, in
    // raw emission order, so it carries the same cross-subsystem interleaving problem. Grouped by
    // tag for the same reason and with the same trade (see ASYNC_LOG_TAGS).
    const dump = redactor.value(plain(server.debugDump('presenter')));
    dump.opLog = groupLogEntries(dump.opLog);
    out.debugDump = dump;
    out.getAck = redactor.value(plain(server.getAck('ready')));
    out.getPoll = redactor.value(plain(server.getPoll('poll-1')));
    out.displayState = redactor.value(plain(server.getModule() ? JSON.parse(server._displayStateForTest()) : null));
    // Same story as the message probes: these three take()s are post-welcome, so only the heartbeat
    // can reach them. It has never landed here (the scripted session is ~1.3 s against a 5 s first
    // tick) — which is exactly the point: this window is one slow box away from flaking too.
    out.frames = {
      gm: splitPings(gm.take(), redactor, PINGS_EXCLUDED),
      a: splitPings(a.take(), redactor, PINGS_EXCLUDED),
      b: splitPings(b.take(), redactor, PINGS_EXCLUDED),
    };
    gm.close(); a.close(); b.close();
    await wait(40);

    await server.sessionLog.flush();
    out.sessionLog = blankKey(redactor.value(plain(server.sessionLog.read({ limit: 2000 }))), 'bytes', BYTES_EXCLUDED);
  } finally { await server.close(); }
  return out;
}

// ── the capture ───────────────────────────────────────────────────────────────────────────────

/**
 * Drive a server through all four sections and return the normalised fingerprint.
 * Restores every environment variable and the log level it touched, whatever happens.
 */
export async function capture() {
  const dep = makeDeployment();
  const prevPlugins = process.env.PRESENTER_PLUGINS_DIR;
  const prevModules = process.env.PRESENTER_MODULES_DIR;
  const prevLogDir = process.env.PRESENTER_SESSION_LOG_DIR;
  const prevLevel = srvlog.getLevel();
  process.env.PRESENTER_PLUGINS_DIR = dep.pluginsDir;
  process.env.PRESENTER_MODULES_DIR = dep.modulesDir;
  delete process.env.PRESENTER_SESSION_LOG_DIR;   // the log dir is passed as an OPTION, per section
  srvlog.setLevel('debug');

  const logRedactor = makeRedactor({
    paths: [{ abs: dep.base, token: 'tmp' }, { abs: ROOT, token: 'repo' }, { abs: tmpdir(), token: 'tmpdir' }],
    secrets: [{ value: CONTROL_TOKEN, token: 'control' }, { value: ROLE_SEED, token: 'seed' }, { value: CAP_SECRET, token: 'cap' }],
    ports: [],
  });
  /* A log line's `ts` is wall clock and its port is this run's; both are tokenised. The ORDER and
   * the (level, tag, msg, fields) tuple are the behaviour, and those are kept in full. */
  const takeLogs = () => {
    const all = srvlog.tail(500);
    srvlog.clear();
    const shape = (e) => logRedactor.value(plain({ level: e.level, tag: e.tag, msg: e.msg, fields: e.fields, roles: e.roles || null }));
    const byTag = {};
    for (const e of all) {
      if (ASYNC_LOG_TAGS.has(e.tag)) continue;
      (byTag[e.tag] = byTag[e.tag] || []).push(shape(e));
    }
    const ordered = {};
    for (const k of Object.keys(byTag).sort()) ordered[k] = byTag[k];
    const unordered = [...new Set(all.filter((e) => ASYNC_LOG_TAGS.has(e.tag)).map((e) => JSON.stringify(shape(e))))].sort().map((x) => JSON.parse(x));
    return { byTag: ordered, tags: Object.keys(ordered), lines: Object.values(ordered).reduce((n, v) => n + v.length, 0), unordered };
  };

  const fingerprint = { version: 1, sections: {}, logs: {} };
  try {
    for (const [name, fn] of [['http', captureHttp], ['sockets', captureSockets], ['session', captureSession]]) {
      srvlog.clear();
      try { fingerprint.sections[name] = await fn(dep); }
      catch (e) { fingerprint.sections[name] = { '<CAPTURE-FAILED>': String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ') }; }
      fingerprint.logs[name] = takeLogs();
    }
  } finally {
    srvlog.setLevel(prevLevel);
    if (prevPlugins === undefined) delete process.env.PRESENTER_PLUGINS_DIR; else process.env.PRESENTER_PLUGINS_DIR = prevPlugins;
    if (prevModules === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prevModules;
    if (prevLogDir !== undefined) process.env.PRESENTER_SESSION_LOG_DIR = prevLogDir;
    try { rmSync(dep.base, { recursive: true, force: true }); } catch (e) {}
  }
  return fingerprint;
}

/*
 * ⛓ CAPTURE IN A CHILD PROCESS — and this is not tidiness, it is correctness.
 *
 * `app/log.mjs` keeps ONE module-level ring for the whole process. Every server that is alive
 * shares it. Run `capture()` inside the full suite and section 4 picks up log lines emitted by
 * OTHER tests' servers — a socket closing three tests ago lands in the middle of this one's
 * session log. Measured: the in-process capture matched the baseline perfectly on its own and
 * produced 40 phantom differences under `npm test`, all of them in `logs.*`.
 *
 * A child process is the isolation the log ring does not provide. It is also how the baseline was
 * taken, so the comparison is like-for-like, and it means the harness cannot perturb the suite it
 * runs inside (no env-var juggling, no clearing a ring somebody else is reading).
 */
export function captureInChildProcess({ timeoutMs = 180000 } = {}) {
  const out = join(mkdtempSync(join(tmpdir(), 'ap-0530-fp-')), 'fingerprint.json');
  // A SANITISED env: the suite (and any test before this one) sets PRESENTER_* / AP_LOG* vars, and
  // an inherited one would silently reconfigure the server being fingerprinted.
  const env = {};
  for (const k of Object.keys(process.env)) if (!/^(PRESENTER_|AP_LOG)/.test(k)) env[k] = process.env[k];
  try {
    execFileSync(process.execPath, [join(__dirname, 'equivalence.mjs'), 'capture', '--out', out],
      { cwd: ROOT, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], env });
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally { try { rmSync(dirname(out), { recursive: true, force: true }); } catch (e) {} }
}

// ── comparison ────────────────────────────────────────────────────────────────────────────────

const MISSING = Symbol('missing');

/**
 * Structural diff, deepest-first, reported as a list of `{ path, baseline, current }`.
 * `limit` caps the report so one systemic change does not produce a 10,000-line failure.
 */
export function diff(baseline, current, { limit = 40 } = {}) {
  const found = [];
  const brief = (v) => {
    if (v === MISSING) return '<ABSENT>';
    const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
    return s === undefined ? String(v) : (s.length > 160 ? s.slice(0, 157) + '...' : s);
  };
  const walk = (a, b, path) => {
    if (found.length >= limit) return;
    if (a === MISSING || b === MISSING) { found.push({ path, baseline: brief(a), current: brief(b) }); return; }
    const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
    const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
    if (ta !== tb) { found.push({ path, baseline: brief(a), current: brief(b) }); return; }
    if (ta === 'array') {
      if (a.length !== b.length) found.push({ path: path + '.length', baseline: a.length, current: b.length });
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i++) walk(i < a.length ? a[i] : MISSING, i < b.length ? b[i] : MISSING, `${path}[${i}]`);
      return;
    }
    if (ta === 'object') {
      for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        walk(k in a ? a[k] : MISSING, k in b ? b[k] : MISSING, path ? `${path}.${k}` : k);
      }
      return;
    }
    if (a !== b) found.push({ path, baseline: brief(a), current: brief(b) });
  };
  walk(baseline, current, '');
  return found;
}

export function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

export function writeBaseline(fp) {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify(fp, null, 2) + '\n');
  return BASELINE_PATH;
}

/**
 * Every `sawPing` in the fingerprint, split into the population that is COMPARED (a real boolean,
 * the hello-reply windows) and the one that is EXCLUDED (the heartbeat token). Counting both is the
 * whole guard against a deliberate loss of evidence quietly spreading: see the splitPings block.
 */
function countPings(node, acc = { compared: 0, excluded: 0 }) {
  if (Array.isArray(node)) { for (const v of node) countPings(v, acc); return acc; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k !== 'sawPing') { countPings(v, acc); continue; }
      if (v === PING_EXCLUDED) acc.excluded++;
      else if (typeof v === 'boolean') acc.compared++;
    }
  }
  return acc;
}

/**
 * Every `bytes` in the fingerprint, split the same way `countPings` splits pings: the population
 * still COMPARED (a real number — 100+ HTTP body lengths) and the one EXCLUDED because it counts
 * session-log bytes and therefore the pid's decimal width. Both are asserted in t0530-p1-03: a
 * floor on the first, an exact equality on the second. See the BYTES_EXCLUDED block.
 */
function countBytes(node, acc = { compared: 0, excluded: 0 }) {
  if (Array.isArray(node)) { for (const v of node) countBytes(v, acc); return acc; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k !== 'bytes') { countBytes(v, acc); continue; }
      if (v === BYTES_EXCLUDED) acc.excluded++;
      else if (typeof v === 'number') acc.compared++;
    }
  }
  return acc;
}

/** Rough size of the instrument, so "the harness captured nothing" cannot pass as "no difference". */
export function coverage(fp) {
  const s = fp && fp.sections ? fp.sections : {};
  const pings = countPings(s);
  const bytes = countBytes(s);
  return {
    pingsCompared: pings.compared,
    pingsExcluded: pings.excluded,
    bytesCompared: bytes.compared,
    bytesExcluded: bytes.excluded,
    httpBare: Object.keys((s.http && s.http.bare) || {}).length,
    httpGated: Object.keys((s.http && s.http.gated) || {}).length,
    welcomes: Object.keys((s.sockets && s.sockets.welcome) || {}).length,
    messageProbes: Object.keys((s.sockets && s.sockets.messages) || {}).length,
    oplogEntries: ((s.session && s.session.oplog) || []).length,
    logLines: Object.values(fp && fp.logs ? fp.logs : {}).reduce((n, v) => n + ((v && typeof v.lines === 'number') ? v.lines : 0), 0),
    logTags: [...new Set(Object.values(fp && fp.logs ? fp.logs : {}).flatMap((v) => (v && v.tags) || []))].length,
    bytes: JSON.stringify(fp || {}).length,
  };
}

// ── cli ───────────────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith('equivalence.mjs')) {
  const cmd = process.argv[2] || 'verify';
  const t0 = Date.now();
  if (cmd === 'capture') {
    const oi = process.argv.indexOf('--out');
    const dest = oi > 0 ? process.argv[oi + 1] : BASELINE_PATH;
    const fp = await capture();
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, JSON.stringify(fp, null, 2) + '\n');
    console.log('captured', JSON.stringify(coverage(fp)), `in ${Date.now() - t0} ms ->`, dest);
    process.exit(0);
  } else if (cmd === 'stability') {
    const a = await capture();
    const b = await capture();
    const d = diff(a, b);
    console.log('coverage', JSON.stringify(coverage(a)));
    console.log(d.length ? `UNSTABLE — ${d.length} difference(s) between two captures:` : 'STABLE — two consecutive captures are identical');
    for (const x of d.slice(0, 40)) console.log('  ', x.path, '\n     first :', x.baseline, '\n     second:', x.current);
    process.exit(d.length ? 1 : 0);
  } else {
    const base = readBaseline();
    if (!base) { console.log('no baseline at', BASELINE_PATH, '- run `capture` first'); process.exit(1); }
    const fp = await capture();
    const d = diff(base, fp);
    console.log('coverage', JSON.stringify(coverage(fp)), `in ${Date.now() - t0} ms`);
    if (!d.length) { console.log('EQUIVALENT — the fingerprint is byte-identical to the baseline'); process.exit(0); }
    console.log(`DIFFERENT — ${d.length} difference(s) (showing up to 40):`);
    for (const x of d.slice(0, 40)) console.log('  ', x.path, '\n     baseline:', x.baseline, '\n     current :', x.current);
    process.exit(1);
  }
}
