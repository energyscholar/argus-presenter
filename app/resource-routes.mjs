/*
 * app/resource-routes.mjs — THE RESOURCE ROUTER. Plan 0719 T1 (read half).
 *
 * ⛔⛔ CORE LEARNS NO NOUN. Not one word in this file names a domain, a deployment, a game or an
 *   object type. It knows only that a plugin may declare a RESOURCE by some name, and that a
 *   resource answers verbs. `t0514-28` greps `app harness mcp lib components` for domain
 *   vocabulary and `t0531-01` greps EVERY TRACKED FILE; a noun here fails the suite, correctly.
 *   Precedent: `addTool` is core's mechanism and the tool's NAME is the plugin's word. This is the
 *   same seam one layer out.
 *
 * ⭐⭐ THE SPLIT, AND WHY IT IS THE WHOLE POINT (plan 0719 R7). The MECHANISM — verb dispatch,
 *   path parsing, the TRUST GATE, the refusal→status mapping — lives HERE, ONCE. The VOCABULARY
 *   and the handlers live with the plugin that owns the object. A per-plugin router would be N
 *   authorisation implementations on a surface that will eventually commission and delete things,
 *   which is the "second authority path" this estate already forbids elsewhere.
 *
 * ⭐ THE PREFIX IS A FUNCTION OF THE LOADED PLUGIN SET, not a fixed contract. A deployment with no
 *   plugins has no resources at all, and that is CORRECT — not a 404 to apologise for, and not a
 *   reason for core to carry a stub.
 *
 * ── ⛔⛔ READ HALF ONLY (R1a) ─────────────────────────────────────────────────────────────────
 *
 * This router dispatches GET (and HEAD) and NOTHING ELSE. There is no create, no update and no
 * delete path in this file — not stubbed, not commented out, not behind a flag. A non-GET request
 * is REFUSED with a stated reason and a 405, which is a refusal, not a write path.
 *
 * ⛔ Do not "prepare" for the write half by adding a verb table with empty entries. The absence is
 *   the property under test: a surface that can delete must not exist before the gate that guards
 *   it has been proved by making it FIRE.
 */
import * as log from './log.mjs';

/** The three trust levels, ranked. A resource declares the MINIMUM it will answer to. */
const RANK = { guest: 0, participant: 1, self: 2 };

/**
 * ⭐⭐ A RESOURCE DECLARES ITS LAYER, AND THE LAYER SETS ITS FLOOR (R8).
 *
 * ⛔ WHY THIS IS NOT COSMETIC. A file-at-rest guard (a path glob, a .gitignore) governs FILES. It
 * has no view of an HTTP response, so it structurally cannot protect this surface — the moment a
 * router answers, a repository carefully configured never to publish something publishes it.
 *
 * `system` = published/authored material this deployment did not author and may not redistribute.
 * `campaign` = state this deployment's own use produced. The floor below is applied AFTER a
 * resource's declared trust, and can only RAISE it: loosening reads for a wider audience later is
 * a decision about `campaign` resources and must not silently reach a `system` one.
 */
const LAYER_FLOOR = { system: 'self', campaign: 'participant' };
const LAYERS = Object.keys(LAYER_FLOOR);

/** One path segment: no slash, no dot-dot, no empty. Ids arrive from the wire. */
const SEGMENT_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const isSegment = (s) => typeof s === 'string' && SEGMENT_OK.test(s) && !s.includes('..');

/**
 * ⭐ THE REGISTRY. One row per declared resource, keyed by name.
 *
 * ⛔⛔ TWO PLUGINS CLAIMING ONE NAME IS A REFUSAL, LOUDLY, AT LOAD — NEVER LAST-WINS. Two things
 *   filed under one key is the singleton failure this estate has hit repeatedly, and `addTool`'s
 *   `Map.set` (which DOES silently last-win) is the shape not to copy here: a tool that shadows
 *   another is a confusing menu, whereas a resource that shadows another re-points a whole URL
 *   space at a different owner's data.
 *
 * ⚠ THE INCUMBENT KEEPS THE NAME and the challenger is dropped. It is not a throw: a broken or
 *   greedy plugin must degrade the deployment, never take the server down mid-session (t0514-30),
 *   and throwing here would abort the REST of the offending plugin's registration too — losing
 *   its tools and its seat resolver over a name collision. The refusal is recorded so it is
 *   legible from outside rather than only in a log line that scrolled away.
 */
export function createResourceRegistry({ logger = log } = {}) {
  const rows = new Map();      // name -> { name, plugin, handlers, trust, layer }
  const refusals = [];         // every registration this registry turned down, with its reason

  function refuse(reason, fields) {
    refusals.push({ reason, ...fields });
    logger.error('resource', 'registration-refused', { reason, ...fields });
    return { ok: false, reason };
  }

  return {
    /**
     * Declare a resource. Returns `{ok:true}` or a stated refusal — never throws for a policy
     * reason, only for a caller that got the CALL wrong (a missing handlers object).
     */
    register(plugin, name, handlers, { trust = 'self', layer = 'campaign' } = {}) {
      if (typeof name !== 'string' || !isSegment(name)) {
        return refuse('bad-name', { plugin, name: String(name).slice(0, 64) });
      }
      if (!handlers || typeof handlers !== 'object') {
        return refuse('no-handlers', { plugin, name });
      }
      if (!(trust in RANK)) return refuse('unknown-trust', { plugin, name, trust });
      if (!LAYERS.includes(layer)) return refuse('unknown-layer', { plugin, name, layer });
      const held = rows.get(name);
      if (held) {
        return refuse('name-already-claimed', { plugin, name, heldBy: held.plugin });
      }
      /* The layer's floor can only RAISE the requirement, never lower it. */
      const floor = LAYER_FLOOR[layer];
      const required = RANK[trust] >= RANK[floor] ? trust : floor;
      rows.set(name, { name, plugin, handlers, trust: required, declaredTrust: trust, layer });
      logger.info('resource', 'registered', {
        plugin, name, layer, trust: required,
        ...(required !== trust ? { raisedFrom: trust, by: 'layer-floor' } : {}),
        verbs: ['list', 'get'].filter((v) => typeof handlers[v] === 'function')
          .concat(Object.keys(handlers.sub || {}).map((s) => 'get:' + s)),
      });
      return { ok: true, name, trust: required, layer };
    },
    get(name) { return rows.get(name) || null; },
    /** What this deployment declares, without the handlers. For a health/diagnostic reader. */
    list() {
      return [...rows.values()].map(({ name, plugin, trust, layer }) => ({ name, plugin, trust, layer }));
    },
    refusals() { return refusals.map((r) => ({ ...r })); },
    get size() { return rows.size; },
  };
}

/** JSON out, one shape, cache-never. */
function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * ⭐⭐ THE REFUSAL VOCABULARY ALREADY EXISTS; THIS MAPS IT AND DOES NOT REPLACE IT (R3).
 *
 * A handler answers with a value (⇒ 200) or with `{ok:false, reason}` — the shape the plugins in
 * this estate have returned since long before there was a router. ⛔ A stated refusal is a 4xx
 * WITH THE REASON IN THE BODY: never a bare 500 (which loses the reason) and never a 200 (which
 * makes a refusal look like an answer, and that is exactly how a defect stays hidden for weeks).
 *
 * A handler may name its own `status`; absent one, `not-found` is a 404 and every other stated
 * reason is a 409 — the answer to "I understood you and I will not do that."
 */
function statusForRefusal(out) {
  if (Number.isInteger(out.status) && out.status >= 400 && out.status < 500) return out.status;
  if (out.reason === 'not-found' || out.notFound === true) return 404;
  return 409;
}

/**
 * Build the `/api/v2/` request handler.
 *
 * @param {object}   o
 * @param {object}   o.registry   from createResourceRegistry()
 * @param {function} o.trustFor   (req) => {trust, reason?} — ⛔ THE SERVER'S EXISTING GATE, passed
 *                                in. There is exactly one trust computation on this server and
 *                                this router does not get a second one.
 */
export function createResourceRouter({ registry, trustFor, prefix = '/api/v2', logger = log } = {}) {
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return function resourceRequest(req, res) {
    const qi = req.url.indexOf('?');
    const path = qi === -1 ? req.url : req.url.slice(0, qi);
    /* ⛔ THE PREFIX ENDS AT A SEGMENT BOUNDARY. A bare `startsWith` would hand this router
       `/api/v2x/anything` — a route it was never mounted for, matched by a shared prefix that is
       not a path prefix at all. */
    if (path !== base && !path.startsWith(base + '/')) {
      return json(res, 404, { ok: false, reason: 'no-such-route' });
    }
    const rest = path.slice(base.length);
    let segs;
    try { segs = rest.split('/').filter(Boolean).map(decodeURIComponent); }
    catch { return json(res, 400, { ok: false, reason: 'bad-encoding' }); }

    /* The collection index. ⭐ It says what THIS deployment declares — which is the honest answer
       to "why is there no /api/v2/<x> here", and it is the same answer for a deployment that
       loaded no plugins at all: an empty list, not a stub. */
    if (segs.length === 0) {
      const gate = trustFor(req);
      if (RANK[gate.trust] < RANK.self) {
        return json(res, 403, { ok: false, reason: 'insufficient-trust', required: 'self', trust: gate.trust, ...(gate.reason ? { detail: gate.reason } : {}) });
      }
      return json(res, 200, { resources: registry.list(), refused: registry.refusals() });
    }

    const [name, id, sub, ...extra] = segs;
    if (!isSegment(name)) return json(res, 400, { ok: false, reason: 'bad-resource-name' });

    const row = registry.get(name);
    /* ⛔ 404 IS THE RIGHT ANSWER **ONLY** FOR A RESOURCE NOTHING DECLARED. A resource that exists
       and is switched off is a different statement, and when a hot-swap lands it must be a named
       refusal here rather than "no such thing" — see plan 0719 R7. There is no disable mechanism
       on this server today, so there is nothing to filter yet; `row.plugin` is what a later
       filter keys on, which is why it is recorded. */
    if (!row) {
      return json(res, 404, { ok: false, reason: 'no-such-resource', resource: name, declared: registry.list().map((r) => r.name) });
    }

    /* ⛔⛔ READ HALF ONLY. Everything that is not a read is refused HERE, before the gate and
       before any handler is consulted, and the refusal states why rather than pretending the
       route does not exist. */
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return json(res, 405, {
        ok: false, reason: 'read-only',
        detail: 'this surface serves reads only; no create, update or delete path exists here',
        resource: name, method,
      });
    }

    /* ── THE GATE (R4/R9). ONE function, read from the server's existing derivation. ────────── */
    const gate = trustFor(req);
    if (RANK[gate.trust] < RANK[row.trust]) {
      logger.info('resource', 'refused', { resource: name, required: row.trust, trust: gate.trust, layer: row.layer });
      return json(res, 403, {
        ok: false, reason: 'insufficient-trust',
        required: row.trust, trust: gate.trust, resource: name, layer: row.layer,
        ...(gate.reason ? { detail: gate.reason } : {}),
      });
    }

    if (extra.length) return json(res, 404, { ok: false, reason: 'no-such-route', resource: name });
    if (id !== undefined && !isSegment(id)) return json(res, 400, { ok: false, reason: 'bad-id', resource: name });
    if (sub !== undefined && !isSegment(sub)) return json(res, 400, { ok: false, reason: 'bad-sub', resource: name });

    /* ── VERB DISPATCH. Three shapes, and a resource declares only the ones it has. ─────────── */
    let fn = null; let args = [];
    if (id === undefined) { fn = row.handlers.list; args = []; }
    else if (sub === undefined) { fn = row.handlers.get; args = [id]; }
    else { fn = (row.handlers.sub || {})[sub]; args = [id]; }

    if (typeof fn !== 'function') {
      return json(res, 404, {
        ok: false, reason: 'no-such-route', resource: name,
        ...(sub !== undefined ? { sub } : {}),
      });
    }

    const query = Object.fromEntries(new URLSearchParams(qi === -1 ? '' : req.url.slice(qi + 1)));
    Promise.resolve()
      .then(() => fn(...args, { query, trust: gate.trust }))
      .then((out) => {
        if (out === undefined || out === null) {
          return json(res, 404, { ok: false, reason: 'not-found', resource: name, ...(id !== undefined ? { id } : {}) });
        }
        if (out && typeof out === 'object' && out.ok === false) {
          return json(res, statusForRefusal(out), { ...out, resource: name });
        }
        return json(res, 200, out);
      })
      .catch((e) => {
        /* ⛔ A THROW IS THE ONE 500, AND IT SAYS SO. Every ANSWERABLE refusal came back as a 4xx
           above; reaching here means the handler itself broke, which is a different fact and
           must not be dressed up as a refusal. */
        logger.warn('resource', 'handler-threw', { resource: name, err: String((e && e.message) || e).slice(0, 200) });
        json(res, 500, { ok: false, reason: 'handler-failed', resource: name, detail: String((e && e.message) || e).slice(0, 200) });
      });
  };
}
