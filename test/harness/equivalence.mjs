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
    out = out.replace(/\bsession-\d{8}T?\d{0,6}-[a-z0-9]{4,8}\b/gi, '<SESSIONLOGID>');
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
      if (Number.isInteger(v) && v >= 1_600_000_000_000 && v <= 4_000_000_000_000) return '<TS>';
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

/**
 * Replace every `key` found anywhere under `node` with `token`, in place.
 *
 * ⚠ Used for ONE thing: the durable session log's byte totals. Its header line carries `pid`, a
 * variable-width decimal, so the file is 2974 bytes under a four-digit pid and 2975 under a
 * five-digit one — a difference that is the process table talking, not the server. The log's
 * ENTRIES are still compared verbatim, so a change to what is written is still caught; only the
 * size of the file is surrendered.
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

/** Build the throwaway plugin + modules trees. Returns absolute dirs (caller removes them). */
function makeDeployment() {
  const base = mkdtempSync(join(tmpdir(), 'ap-0530-'));
  const pluginsDir = join(base, 'plugins');
  const modulesDir = join(base, 'modules');
  const logDir = join(base, 'session-log');
  mkdirSync(join(pluginsDir, 'equivalence-fixture'), { recursive: true });
  writeFileSync(join(pluginsDir, 'equivalence-fixture', 'plugin.json'), JSON.stringify(FIXTURE_PLUGIN, null, 2));
  mkdirSync(modulesDir, { recursive: true });
  writeFileSync(join(modulesDir, 'fixture-a.json'), JSON.stringify(FIXTURE_MODULE, null, 2));
  writeFileSync(join(modulesDir, 'fixture-broken.json'), JSON.stringify(FIXTURE_BROKEN_MODULE, null, 2));
  writeFileSync(join(modulesDir, 'fixture.series.json'), JSON.stringify(FIXTURE_SERIES, null, 2));
  mkdirSync(logDir, { recursive: true });
  return { base, pluginsDir, modulesDir, logDir };
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
 * Heartbeat pings arrive every PING_MS on a wall clock the capture does not control, so their
 * COUNT is timing, not behaviour. They are separated out and counted as a presence flag rather
 * than dropped — "a ping happened" stays visible, "how many" does not become flakiness.
 */
function splitPings(frames, redactor) {
  const kept = [], pings = [];
  for (const f of frames) (f && f.t === 'ping' ? pings : kept).push(f);
  return { frames: kept.map((f) => redactor.value(plain(f))), sawPing: pings.length > 0 };
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

// ── the three sections ────────────────────────────────────────────────────────────────────────

async function captureHttp(dep) {
  const out = {};
  for (const flavour of ['bare', 'gated']) {
    const opts = { port: 0 };
    if (flavour === 'gated') Object.assign(opts, { controlToken: CONTROL_TOKEN, roleSeed: ROLE_SEED, rolePassword: ROLE_PASSWORD, capSecret: CAP_SECRET, sessionLogDir: dep.logDir });
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
        const bare = await request(port, r);
        table[r.name] = { request: { method: r.method || 'GET', path: r.path, credentialled: false }, response: describeResponse(bare, redactor) };
        if (flavour === 'gated') {
          const authed = await request(port, { ...r, headers: { ...(r.headers || {}), 'x-control-token': CONTROL_TOKEN } });
          table[r.name + '+token'] = { request: { method: r.method || 'GET', path: r.path, credentialled: true }, response: describeResponse(authed, redactor) };
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
      out.welcome[h.name] = splitPings(c.take(), redactor);
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
        out.messages[`${m.name}@${role}`] = splitPings(c.take(), redactor);
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
    await wait(80);
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

    // ── section 3 proper: the oplog, verbatim, then the state that produced it.
    out.oplog = redactor.value(plain(server.store.oplogSince(0)));
    out.version = server.store.version();
    out.snapshotPresenter = redactor.value(plain(server.store.snapshot({ role: 'presenter', userId: 'gm' }).state));
    out.snapshotParticipant = redactor.value(plain(server.store.snapshot({ role: 'participant', userId: 'p-a' }).state));
    out.presence = redactor.value(plain(server.presence()));
    out.stations = redactor.value(plain(server.stations()));
    out.attendance = redactor.value(plain(server.attendance()));
    out.health = blankKey(redactor.value(plain(server.health())), 'bytes', '<BYTES>');   // see blankKey: the session log's size follows the pid's width
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
    out.frames = {
      gm: splitPings(gm.take(), redactor),
      a: splitPings(a.take(), redactor),
      b: splitPings(b.take(), redactor),
    };
    gm.close(); a.close(); b.close();
    await wait(40);

    await server.sessionLog.flush();
    out.sessionLog = blankKey(redactor.value(plain(server.sessionLog.read({ limit: 2000 }))), 'bytes', '<BYTES>');
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

/** Rough size of the instrument, so "the harness captured nothing" cannot pass as "no difference". */
export function coverage(fp) {
  const s = fp && fp.sections ? fp.sections : {};
  return {
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
