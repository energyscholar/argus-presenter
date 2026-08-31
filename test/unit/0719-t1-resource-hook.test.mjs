/*
 * Plan 0719 T1 — THE RESOURCE HOOK, THE ONE GATE, AND THE READ-ONLY PROPERTY.
 *
 * ⛔⛔ EVERY FIXTURE NOUN IN THIS FILE IS INVENTED. This repo is PUBLIC, `t0531-01` reads every
 *   tracked file and `t0514-28` reads the five core directories; a fixture that spelled a real
 *   deployment's vocabulary would be the very defect those guards exist for. `widget` / `gadget`
 *   / `alpha` / `beta` are nobody's anything.
 *
 * ⭐⭐ WHAT MAKES THESE TESTS RATHER THAN DECORATION. Every expected value below comes from a
 *   LITERAL THE FIXTURE DECLARED, never from the router's own constants or from calling the code
 *   under test. A test whose only citation is the implementation cannot disagree with it — this
 *   estate has already paid for that once, in a damage formula that restated its own
 *   implementation and was wrong for 21 of 34 published figures.
 *
 * ⭐ THE FIELD MANIFEST (FIELDS, below) is the coverage instrument. The assertions are GENERATED
 *   from it, and it is asserted in BOTH directions: every declared field must be present, and
 *   ⛔ every field PRESENT in a response must have a manifest row. A field added to a payload
 *   with no row FAILS THE SUITE — coverage becomes measurable instead of aspirational.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { makePluginsDir, withPlugins } from './_0514-fixtures.mjs';

/* ── THE PRINCIPAL. Verified (a tailnet peer) AND allowlisted ⇒ TRUST.SELF. ─────────────────────
 * ⛔ The header resolver is a TEST SEAM and is documented as fatal in production (identity.mjs);
 *   it is what every existing trust test in this suite uses to stand up a verified caller. */
const KNOWN = 'tester@fixture';
const STRANGER = 'stranger@fixture';
const SELF_HEADERS = { 'tailscale-user-login': KNOWN };
const SIGNED_IN_HEADERS = { 'tailscale-user-login': STRANGER };

const IDENTITY = {
  allowlist: { [KNOWN]: { role: 'presenter' } },
  tailscale: { enabled: true },
  tailscaleResolve: (req) => req.headers['tailscale-user-login'] || null,
};

/** GET (or any method) a path and return {status, body}. */
async function req(server, path, { method = 'GET', headers = {} } = {}) {
  const r = await fetch(server.url() + path, { method, headers });
  let body = null;
  try { body = JSON.parse(await r.text()); } catch { body = null; }
  return { status: r.status, body, allow: r.headers.get('allow') };
}

/*
 * ⭐ THE FIXTURE'S DECLARED TRUTH. These literals are the SOURCE OF TRUTH for every expectation
 *   in this file. The fixture plugin below serves exactly them, so an assertion that reads one
 *   is comparing the router's output against a value stated OUTSIDE the router.
 */
const WIDGETS = [
  { widgetId: 'alpha', label: 'Alpha', rank: 1 },
  { widgetId: 'beta', label: 'Beta', rank: 2 },
];
const ALPHA_DETAIL = { widgetId: 'alpha', label: 'Alpha', rank: 1, note: 'the detail view carries one more field than the list' };
const ALPHA_PART = { widgetId: 'alpha', part: 'core', wear: 3 };

/*
 * ── ⭐⭐ THE FIELD MANIFEST ────────────────────────────────────────────────────────────────────
 *
 * (route, field, type, source-of-truth, mustBePresent, neverPresent-on-this-route)
 *
 * `expect` is the literal this file declared above — i.e. the value the FIXTURE states, which is
 * independent of the router. `never` names fields that must NOT appear on that route; a leak test
 * that has only ever passed has not been tested, so the manifest asserts absence explicitly.
 */
const FIELDS = [
  { route: '/api/v2/widgets', field: 'widgets', type: 'array', from: 'fixture literal WIDGETS', must: true },
  { route: '/api/v2/widgets', field: 'count', type: 'number', from: 'fixture literal WIDGETS.length', must: true },
  { route: '/api/v2/widgets/alpha', field: 'widgetId', type: 'string', from: 'fixture literal ALPHA_DETAIL', must: true },
  { route: '/api/v2/widgets/alpha', field: 'label', type: 'string', from: 'fixture literal ALPHA_DETAIL', must: true },
  { route: '/api/v2/widgets/alpha', field: 'rank', type: 'number', from: 'fixture literal ALPHA_DETAIL', must: true },
  { route: '/api/v2/widgets/alpha', field: 'note', type: 'string', from: 'fixture literal ALPHA_DETAIL', must: true },
  { route: '/api/v2/widgets/alpha/parts', field: 'widgetId', type: 'string', from: 'fixture literal ALPHA_PART', must: true },
  { route: '/api/v2/widgets/alpha/parts', field: 'part', type: 'string', from: 'fixture literal ALPHA_PART', must: true },
  { route: '/api/v2/widgets/alpha/parts', field: 'wear', type: 'number', from: 'fixture literal ALPHA_PART', must: true },
];
/** ⛔ Fields that must appear on NO read route in this run. `secret` is the fixture's stand-in for
 *  material a handler holds and must never serve; `ok` must not decorate a success (a 200 IS the
 *  success, and an `ok:true` beside a refusal-shaped `ok:false` invites branching on the wrong one). */
const NEVER = ['secret', 'ok'];

/** The fixture plugin's server module — the ONLY place a resource noun is spelled. */
const SERVER_MODULE = `
export function register(ctx) {
  const WIDGETS = ${JSON.stringify(WIDGETS)};
  const ALPHA_DETAIL = ${JSON.stringify(ALPHA_DETAIL)};
  const ALPHA_PART = ${JSON.stringify(ALPHA_PART)};
  globalThis.__apFixtureCalls = { list: 0, get: 0, sub: 0, refusal: 0, thrower: 0 };
  ctx.registerResource('widgets', {
    list: () => { globalThis.__apFixtureCalls.list++; return { widgets: WIDGETS, count: WIDGETS.length }; },
    get: (id) => {
      globalThis.__apFixtureCalls.get++;
      if (id === 'alpha') return ALPHA_DETAIL;
      if (id === 'gone') return { ok: false, reason: 'not-found' };
      if (id === 'locked') return { ok: false, reason: 'fixture-refused-on-purpose', detail: 'a stated refusal' };
      if (id === 'boom') { globalThis.__apFixtureCalls.thrower++; throw new Error('fixture handler exploded'); }
      if (id === 'void') return undefined;
      return { ok: false, reason: 'not-found' };
    },
    sub: { parts: (id) => { globalThis.__apFixtureCalls.sub++; return { ...ALPHA_PART, widgetId: id }; } },
  }, { trust: 'self', layer: 'campaign' });

  /* ⭐ Declared LOOSE (participant) but on the published layer — the floor must RAISE it to self. */
  ctx.registerResource('gadgets', {
    list: () => ({ gadgets: [] }),
  }, { trust: 'participant', layer: 'system' });
}
`;

const FIXTURE = {
  fixturely: {
    'plugin.json': { name: 'fixturely', requires: [], components: [], presets: {}, fieldSchemas: {}, server: 'srv.mjs' },
    'srv.mjs': SERVER_MODULE,
  },
};

async function withFixtureServer(fn, over = {}) {
  const dir = makePluginsDir(FIXTURE);
  return withPlugins(dir, async () => {
    const s = await createServer({ port: 0, ...IDENTITY, ...over });
    try { return await fn(s); } finally { await s.close(); }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * t0719-01 — THE HOOK WORKS, AND EVERY FIELD IS ACCOUNTED FOR IN BOTH DIRECTIONS.
 * ═════════════════════════════════════════════════════════════════════════════════════════════ */
test('t0719-01 — a plugin declares a resource and every declared field is served, with NO undeclared field', async () => {
  await withFixtureServer(async (s) => {
    const seen = new Map();
    for (const route of [...new Set(FIELDS.map((f) => f.route))]) {
      const r = await req(s, route, { headers: SELF_HEADERS });
      expect(r.status === 200, `${route} answers 200 for a verified+allowlisted caller`, `${r.status} ${JSON.stringify(r.body)}`);
      seen.set(route, r.body);
    }

    // (a) GENERATED from the manifest: every declared field is present and of its declared type.
    for (const f of FIELDS.filter((x) => x.must)) {
      const body = seen.get(f.route);
      const v = body && body[f.field];
      expect(v !== undefined, `${f.route} → "${f.field}" is present (source: ${f.from})`, JSON.stringify(body));
      const actual = Array.isArray(v) ? 'array' : typeof v;
      expect(actual === f.type, `${f.route} → "${f.field}" is a ${f.type}`, actual);
    }

    // (b) ⛔ THE REVERSE DIRECTION — the half that makes the manifest un-rottable. A field in a
    //     response with no manifest row fails here, so the map cannot silently fall behind.
    for (const [route, body] of seen) {
      const declared = new Set(FIELDS.filter((f) => f.route === route).map((f) => f.field));
      const undeclared = Object.keys(body || {}).filter((k) => !declared.has(k));
      expect(undeclared.length === 0,
        `${route} returns NO field without a manifest row (add a row, or stop returning it)`, undeclared.join(','));
    }

    // (c) ⛔ NEVER-PRESENT: asserted by making it checkable, not by never having seen it.
    for (const [route, body] of seen) {
      const text = JSON.stringify(body);
      for (const banned of NEVER) {
        expect(!Object.prototype.hasOwnProperty.call(body || {}, banned),
          `${route} never carries "${banned}"`, text.slice(0, 200));
      }
    }

    // (d) The VALUES, against the fixture's literals — not against anything the router computed.
    expect(JSON.stringify(seen.get('/api/v2/widgets').widgets) === JSON.stringify(WIDGETS),
      'the list body is byte-identical to what the fixture declared', JSON.stringify(seen.get('/api/v2/widgets').widgets));
    expect(seen.get('/api/v2/widgets').count === WIDGETS.length,
      'count matches the fixture literal length', String(seen.get('/api/v2/widgets').count));
    expect(seen.get('/api/v2/widgets/alpha').note === ALPHA_DETAIL.note,
      'the detail body carries the fixture literal note', seen.get('/api/v2/widgets/alpha').note);
    expect(seen.get('/api/v2/widgets/alpha/parts').wear === ALPHA_PART.wear,
      'the sub-resource body carries the fixture literal wear', String(seen.get('/api/v2/widgets/alpha/parts').wear));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * t0719-02 — ⛔⛔ THE GATE, PROVED BY MAKING IT FIRE. A gate only ever seen to pass is untested.
 * ⚠ THIS TEST FAILS IF THE GATE IS REMOVED: without it the same requests answer 200.
 * ═════════════════════════════════════════════════════════════════════════════════════════════ */
test('t0719-02 — an unverified and a verified-but-unlisted caller are BOTH refused, with a stated reason', async () => {
  await withFixtureServer(async (s) => {
    for (const [who, headers, expectDetail] of [
      ['nobody (no identity at all)', {}, null],
      ['a verified principal who is NOT on the allowlist', SIGNED_IN_HEADERS, 'signed in, not authorized'],
    ]) {
      for (const route of ['/api/v2', '/api/v2/widgets', '/api/v2/widgets/alpha', '/api/v2/widgets/alpha/parts']) {
        const r = await req(s, route, { headers });
        expect(r.status === 403, `${route} REFUSES ${who}`, `${r.status} ${JSON.stringify(r.body)}`);
        expect(r.body && r.body.ok === false, 'the refusal is shaped as a refusal', JSON.stringify(r.body));
        expect(r.body && r.body.reason === 'insufficient-trust', 'and it STATES why', r.body && r.body.reason);
        expect(r.body && r.body.required === 'self', 'naming the trust the route requires', r.body && r.body.required);
        expect(r.body && r.body.trust !== 'self', 'and the trust the caller actually had', r.body && r.body.trust);
        if (expectDetail) {
          expect(r.body && r.body.detail === expectDetail,
            'the fence reason from the SERVER’S EXISTING derivation reaches the body', r.body && r.body.detail);
        }
      }
    }
    // ⛔ AND THE HANDLER WAS NEVER REACHED — a refusal that ran the handler first is not a refusal.
    const calls = globalThis.__apFixtureCalls;
    expect(calls.list === 0 && calls.get === 0 && calls.sub === 0,
      'no handler ran behind a refused request', JSON.stringify(calls));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * t0719-03 — ⛔⛔ READ HALF ONLY. There is no write path, and the absence is asserted.
 * ═════════════════════════════════════════════════════════════════════════════════════════════ */
test('t0719-03 — POST, PATCH, PUT and DELETE are refused with a stated reason, and no handler runs', async () => {
  await withFixtureServer(async (s) => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      for (const route of ['/api/v2/widgets', '/api/v2/widgets/alpha', '/api/v2/widgets/alpha/parts']) {
        const r = await req(s, route, { method, headers: SELF_HEADERS });
        expect(r.status === 405, `${method} ${route} is refused 405`, `${r.status} ${JSON.stringify(r.body)}`);
        expect(r.body && r.body.reason === 'read-only', 'with a stated reason', r.body && r.body.reason);
        expect(r.allow === 'GET, HEAD', 'and an Allow header naming what IS served', r.allow);
      }
    }
    const calls = globalThis.__apFixtureCalls;
    expect(calls.list === 0 && calls.get === 0 && calls.sub === 0,
      'not one handler was reached by a write attempt', JSON.stringify(calls));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * t0719-04 — TWO PLUGINS, ONE NAME ⇒ A LOUD REFUSAL, NEVER LAST-WINS.
 * ═════════════════════════════════════════════════════════════════════════════════════════════ */
test('t0719-04 — a second plugin claiming a declared resource name is REFUSED; the incumbent keeps it', async () => {
  const twoPlugins = {
    first: {
      'plugin.json': { name: 'first', requires: [], components: [], presets: {}, fieldSchemas: {}, server: 'srv.mjs' },
      'srv.mjs': "export function register(ctx){ ctx.registerResource('widgets', { list: () => ({ owner: 'first' }) }, { trust:'self', layer:'campaign' }); }",
    },
    second: {
      'plugin.json': { name: 'second', requires: [], components: [], presets: {}, fieldSchemas: {}, server: 'srv.mjs' },
      'srv.mjs': "export function register(ctx){ globalThis.__apSecondVerdict = ctx.registerResource('widgets', { list: () => ({ owner: 'second' }) }, { trust:'self', layer:'campaign' }); ctx.registerResource('others', { list: () => ({ owner: 'second' }) }, { trust:'self', layer:'campaign' }); }",
    },
  };
  const dir = makePluginsDir(twoPlugins);
  await withPlugins(dir, async () => {
    const s = await createServer({ port: 0, ...IDENTITY });
    try {
      const held = await req(s, '/api/v2/widgets', { headers: SELF_HEADERS });
      expect(held.status === 200, 'the name still answers', String(held.status));
      // ⛔ The plugins load in manifest order; whoever got there first KEEPS it. The assertion is
      //    that ONE of them holds it and the other was told no — not which, because load order is
      //    the deployment's business and a test that pinned it would be testing readdir.
      const index = await req(s, '/api/v2', { headers: SELF_HEADERS });
      const names = index.body.resources.map((r) => r.name).sort();
      expect(JSON.stringify(names) === JSON.stringify(['others', 'widgets']),
        'exactly ONE row holds the contested name, and the loser’s OTHER resource still registered',
        JSON.stringify(names));
      const refused = index.body.refused.filter((r) => r.reason === 'name-already-claimed');
      expect(refused.length === 1, 'the collision is RECORDED, not silent', JSON.stringify(index.body.refused));
      expect(typeof refused[0].heldBy === 'string' && refused[0].heldBy !== refused[0].plugin,
        'and it names who holds the name and who was turned away', JSON.stringify(refused[0]));
      expect(globalThis.__apSecondVerdict && globalThis.__apSecondVerdict.ok === false,
        'the losing plugin was TOLD, in its return value, rather than silently shadowed',
        JSON.stringify(globalThis.__apSecondVerdict));
      expect(held.body.owner === refused[0].heldBy ? true : held.body.owner !== refused[0].plugin,
        'the answer comes from the INCUMBENT, never from the challenger', JSON.stringify(held.body));
    } finally { await s.close(); }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * t0719-05 — THE REFUSAL VOCABULARY MAPS TO STATUS CODES; IT IS NOT REPLACED.
 * ⛔ never a bare 500 for a stated refusal, and never a 200.
 * ═════════════════════════════════════════════════════════════════════════════════════════════ */
test('t0719-05 — a stated refusal is a 4xx WITH the reason; only a thrown handler is a 500', async () => {
  await withFixtureServer(async (s) => {
    const cases = [
      ['/api/v2/widgets/gone', 404, 'not-found', 'the handler’s own not-found reason'],
      ['/api/v2/widgets/locked', 409, 'fixture-refused-on-purpose', 'an arbitrary stated refusal'],
      ['/api/v2/widgets/void', 404, 'not-found', 'a handler that answered with nothing'],
      ['/api/v2/nosuch', 404, 'no-such-resource', 'a resource nothing declared'],
      ['/api/v2/widgets/alpha/nosuchsub', 404, 'no-such-route', 'a sub-resource this resource does not serve'],
    ];
    for (const [route, status, reason, why] of cases) {
      const r = await req(s, route, { headers: SELF_HEADERS });
      expect(r.status === status, `${route} → ${status} (${why})`, `${r.status} ${JSON.stringify(r.body)}`);
      expect(r.body && r.body.reason === reason, `...stating "${reason}"`, r.body && r.body.reason);
      expect(r.status !== 200, 'a refusal is NEVER a 200', String(r.status));
    }
    const boom = await req(s, '/api/v2/widgets/boom', { headers: SELF_HEADERS });
    expect(boom.status === 500, 'a THROWN handler is the one 500 — a different fact from a refusal', String(boom.status));
    expect(boom.body && boom.body.reason === 'handler-failed', 'and it says so', boom.body && boom.body.reason);
    expect(globalThis.__apFixtureCalls.thrower === 1, 'the throwing handler really did run', String(globalThis.__apFixtureCalls.thrower));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * t0719-06 — ⛔ THE LAYER SETS A FLOOR THE PLUGIN CANNOT DIP BELOW (R8's seam).
 * ═════════════════════════════════════════════════════════════════════════════════════════════ */
test('t0719-06 — a resource declared loose on the PUBLISHED layer is still gated at self', async () => {
  await withFixtureServer(async (s) => {
    const index = await req(s, '/api/v2', { headers: SELF_HEADERS });
    const row = index.body.resources.find((r) => r.layer === 'system');
    expect(!!row, 'the published-layer resource registered', JSON.stringify(index.body.resources));
    expect(row.trust === 'self',
      'its trust was RAISED to self by the layer floor, though the plugin asked for participant', row.trust);
    const anon = await req(s, '/api/v2/' + row.name, {});
    expect(anon.status === 403, 'and an anonymous read of it is refused', `${anon.status} ${JSON.stringify(anon.body)}`);
    expect(anon.body && anon.body.layer === 'system', 'the refusal names the layer', anon.body && anon.body.layer);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * t0719-07 — PATH HYGIENE. Ids come off the wire.
 * ═════════════════════════════════════════════════════════════════════════════════════════════ */
test('t0719-07 — traversal and near-miss prefixes are refused, and a plugin-free deployment declares nothing', async () => {
  await withFixtureServer(async (s) => {
    for (const bad of ['/api/v2/widgets/..%2F..%2Fetc', '/api/v2/widgets/a%2Fb', '/api/v2/wid gets']) {
      const r = await req(s, bad, { headers: SELF_HEADERS });
      expect(r.status >= 400, `${bad} is refused`, `${r.status} ${JSON.stringify(r.body)}`);
      expect(r.status !== 500, '...and not by crashing', String(r.status));
    }
    // ⛔ A SHARED TEXT PREFIX IS NOT A PATH PREFIX. /api/v2x must never reach this router.
    const near = await req(s, '/api/v2x/widgets', { headers: SELF_HEADERS });
    expect(near.status === 404, '/api/v2x is NOT this router’s', String(near.status));
  });

  // A deployment with no plugins at all: the index is empty, and that is the correct answer.
  const dir = makePluginsDir({});
  await withPlugins(dir, async () => {
    const s = await createServer({ port: 0, ...IDENTITY });
    try {
      const r = await req(s, '/api/v2', { headers: SELF_HEADERS });
      expect(r.status === 200 && Array.isArray(r.body.resources) && r.body.resources.length === 0,
        'no plugins ⇒ no resources, reported as an empty list rather than a stub', JSON.stringify(r.body));
      const miss = await req(s, '/api/v2/widgets', { headers: SELF_HEADERS });
      expect(miss.status === 404 && miss.body.reason === 'no-such-resource',
        'and asking for one is an honest 404', JSON.stringify(miss.body));
    } finally { await s.close(); }
  });
});
