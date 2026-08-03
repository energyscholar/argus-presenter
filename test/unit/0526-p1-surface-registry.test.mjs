/*
 * Plan 0526 P1 (plan 0534 wave W4) — THE SURFACE REGISTRY.
 *
 * A SURFACE is a named screen a viewer may be shown on request. The one property that makes it
 * worth having a registry at all is that it OUTLIVES THE MODULE: a beat exists only inside the
 * module currently loaded, so a screen sourced from a beat dies on the next `present_module`.
 * That is 0514 §13.1 — where every seat's station screen vanished on a module load — one layer
 * down, and it is the failure these tests are here to make impossible to reintroduce.
 *
 *   t0526-01  no plugin declares surfaces ⇒ empty, inert, and every lookup refuses `no-surfaces`
 *   t0526-02  a declared surface is ADDRESSABLE by id, and resolves to a renderable descriptor
 *   t0526-03  refusals fire BY NAME — `no-such-surface`, and `not-peekable` by DEFAULT-DENY
 *   t0526-04  a malformed registry THROWS AT LOAD (five ways), never at the first viewer
 *   t0526-05  `screenFile` is read once at load; a missing one degrades to the placeholder
 *   t0526-06  ⛓ THE SURVIVAL PROOF — a surface renders BEFORE, and again AFTER, `present_module`
 *
 * ⛔ THE VERB IS NOT IN THIS PHASE. Nothing here summons a surface onto a viewer's screen; the
 * self-service `peek`/`unpeek` is 0526 P4. t0526-06 therefore proves "it renders" through the
 * EXISTING controller push (`api.pushComponent`) — the descriptor the registry hands out is fed
 * to the renderer every beat already uses, and the bytes are asserted at a real websocket client.
 *
 * NAMES: invented and neutral throughout (guard t0531-01). The fixture deployment is two plugins
 * called `alpha` and `beta`; nothing here names anybody's session, setting or seat.
 *
 * Unit tier: no browser. `port: 0` and `tunnel:false`, so nothing binds :3000 or :4300.
 * PRESENTER_PLUGINS_DIR points at a throwaway tree — the installed plugins are never read.
 */
import { test, expect } from '../../harness/test.mjs';
import { buildSurfaceRegistry } from '../../harness/plugins.mjs';
import { createServer } from '../../app/server.mjs';
import { makePluginsDir, withPlugins, connect, last, wait } from './_0514-fixtures.mjs';
import { WebSocket } from 'ws';

const MARK = 'SURFACE-MARK-1';
const BEAT_MARK = 'BEAT-MARK-2';

/** A deployment whose `alpha` plugin declares two surfaces: one offered to viewers, one not. */
function alphaManifest(over = {}) {
  return Object.assign({
    name: 'alpha', requires: [], components: [], presets: {}, fieldSchemas: {},
    surfaces: [
      { surfaceId: 'roster', surfaceLabel: 'The roster', peekable: true, icon: '#', sortOrder: 1,
        screen: { component: 'card', opts: { title: 'The roster', body: MARK } } },
      // NO `peekable` key at all — default-deny is the point of this row.
      { surfaceId: 'private-notes', surfaceLabel: 'Private notes', sortOrder: 2,
        screen: { component: 'card', opts: { title: 'Private notes', body: 'nope' } } },
    ],
  }, over);
}

const ONE_BEAT_MODULE = {
  title: 'A module',
  manifest: { title: 'A module' },
  beats: [{ id: 'first', component: 'card', opts: { title: 'A beat', body: BEAT_MARK } }],
};

/** Build the registry from a bare manifest map — no server, no disk beyond the fixture tree. */
const registryOf = (manifests, log = null) => buildSurfaceRegistry(manifests, { log });

/** Run `fn` against a server booted over a throwaway plugin tree, and always close it. */
async function withServer(dir, fn) {
  return withPlugins(dir, async () => {
    const server = await createServer({ port: 0, tunnel: false });
    try { return await fn(server); } finally { await server.close(); }
  });
}

test('t0526-01 — a deployment that declares no surfaces has an empty registry, and every lookup refuses BY NAME', async () => {
  const empty = registryOf({ alpha: { name: 'alpha' } });
  expect(empty.isEmpty(), 'no `surfaces` key anywhere ⇒ the registry is empty');
  expect(empty.wire().length === 0, 'and its wire form is the empty list');
  expect(empty.get('roster') === null, 'and it resolves nothing');

  const dir = makePluginsDir({ alpha: { 'plugin.json': { name: 'alpha', requires: [] } } });
  await withServer(dir, (server) => {
    expect(server.surfaces().surfaces.length === 0, 'the api reports no surfaces');
    const r = server.surfaceScreen('roster');
    expect(r.ok === false && r.reason === 'no-surfaces',
      'and a lookup refuses by name rather than returning null', JSON.stringify(r));
  });
});

test('t0526-02 — a declared surface is addressable by id and resolves to a renderable descriptor', async () => {
  const dir = makePluginsDir({ alpha: { 'plugin.json': alphaManifest() } });
  await withServer(dir, (server) => {
    const listed = server.surfaces().surfaces;
    expect(listed.length === 2, 'both declared rows are listed', JSON.stringify(listed));
    expect(listed[0].surfaceId === 'roster' && listed[0].surfaceLabel === 'The roster',
      'the wire row carries the id and the label', JSON.stringify(listed[0]));
    expect(listed[0].hasScreen === true && listed[0].peekable === true, 'and its two flags');
    // The wire form must be DATA — a JSON round-trip loses nothing, so no closure can hide in it.
    expect(JSON.stringify(JSON.parse(JSON.stringify(listed))) === JSON.stringify(listed),
      'the registry is data-only: its wire form survives a JSON round-trip unchanged');

    const r = server.surfaceScreen('roster');
    expect(r.ok === true && r.surfaceLabel === 'The roster', 'the surface resolves', JSON.stringify(r));
    expect(r.descriptor && r.descriptor.kind === 'component' && r.descriptor.component === 'card',
      'to a component descriptor the existing renderer accepts', JSON.stringify(r.descriptor));
    expect(r.descriptor.opts.body === MARK, 'carrying the declared opts', JSON.stringify(r.descriptor.opts));
    expect(Array.isArray(r.descriptor.requires) && r.descriptor.requires[0] === 'alpha',
      'and the DECLARING PLUGIN as its `requires`, so a plugin component still assembles',
      JSON.stringify(r.descriptor.requires));
  });
});

test('t0526-03 — refusals fire by name: an undeclared id, and a surface that never said it was peekable', async () => {
  const dir = makePluginsDir({ alpha: { 'plugin.json': alphaManifest() } });
  await withServer(dir, (server) => {
    const absent = server.surfaceScreen('no-such-thing');
    expect(absent.ok === false && absent.reason === 'no-such-surface',
      'an undeclared id refuses BY NAME', JSON.stringify(absent));
    const denied = server.surfaceScreen('private-notes');
    expect(denied.ok === false && denied.reason === 'not-peekable',
      'a declared surface with no `peekable` key is DEFAULT-DENY, and says so', JSON.stringify(denied));
    expect(denied.surfaceLabel === 'Private notes',
      'the refusal still names the surface it refused', JSON.stringify(denied));
    // Refusing is not the same as hiding: it is listed, with the flag that explains the refusal.
    const row = server.surfaces().surfaces.find((s) => s.surfaceId === 'private-notes');
    expect(row && row.peekable === false, 'and the list shows why', JSON.stringify(row));
  });
});

test('t0526-04 — a malformed registry throws AT LOAD, never at the first viewer', () => {
  const throws = (manifests, what) => {
    let threw = null;
    try { registryOf(manifests); } catch (e) { threw = String(e && e.message || e); }
    expect(threw !== null, `${what} must throw at load`, JSON.stringify(manifests).slice(0, 160));
    return threw;
  };
  throws({ a: { name: 'a', surfaces: {} } }, '`surfaces` that is not an array');
  throws({ a: { name: 'a', surfaces: [{ surfaceId: 'Not Lowercase', surfaceLabel: 'X' }] } }, 'a malformed surfaceId');
  throws({ a: { name: 'a', surfaces: [{ surfaceId: 'x', surfaceLabel: '  ' }] } }, 'an empty surfaceLabel');
  throws({ a: { name: 'a', surfaces: [{ surfaceId: 'x', surfaceLabel: 'X', peekable: 'yes' }] } }, 'a non-boolean peekable');
  // The collision that matters most: TWO plugins claiming one id. Stations refuse a second
  // DECLARING PLUGIN outright; surfaces merge across plugins, so the guard has to be per-id.
  const dup = throws({
    a: { name: 'a', surfaces: [{ surfaceId: 'x', surfaceLabel: 'A x' }] },
    b: { name: 'b', surfaces: [{ surfaceId: 'x', surfaceLabel: 'B x' }] },
  }, 'the same surfaceId declared by two plugins');
  expect(dup.includes('a') && dup.includes('b'), 'and names both plugins', dup);
  throws({
    a: { name: 'a', surfaces: [{ surfaceId: 'x', surfaceLabel: 'Same' }] },
    b: { name: 'b', surfaces: [{ surfaceId: 'y', surfaceLabel: 'Same' }] },
  }, 'two rows a viewer cannot tell apart');

  // ...and the merge itself works: two plugins, two surfaces, one registry.
  const merged = registryOf({
    a: { name: 'a', surfaces: [{ surfaceId: 'x', surfaceLabel: 'X', peekable: true, sortOrder: 2 }] },
    b: { name: 'b', surfaces: [{ surfaceId: 'y', surfaceLabel: 'Y', peekable: true, sortOrder: 1 }] },
  });
  expect(merged.wire().map((s) => s.surfaceId).join(',') === 'y,x',
    'surfaces from different plugins merge into one registry, ordered by sortOrder',
    JSON.stringify(merged.wire()));
});

test('t0526-05 — a screen too big for plugin.json is read from a file at load; a missing file degrades to the placeholder', async () => {
  const dir = makePluginsDir({
    alpha: {
      'plugin.json': {
        name: 'alpha', requires: [],
        surfaces: [
          { surfaceId: 'big', surfaceLabel: 'Big', peekable: true,
            screen: { screenFile: 'surfaces/big.json', opts: { subtitle: 'overridden' } } },
          { surfaceId: 'undrawn', surfaceLabel: 'Undrawn', peekable: true,
            screen: { screenFile: 'surfaces/absent.json' } },
        ],
      },
      'surfaces/big.json': { component: 'card', opts: { title: 'Big', body: MARK, subtitle: 'from the file' } },
      // surfaces/absent.json is DELIBERATELY absent — that absence is the fixture's whole point.
    },
  });
  await withServer(dir, (server) => {
    const big = server.surfaceScreen('big');
    expect(big.ok === true && big.descriptor.opts.body === MARK,
      'the file supplies the screen', JSON.stringify(big.descriptor && big.descriptor.opts));
    expect(big.descriptor.opts.subtitle === 'overridden',
      'and inline opts override the file rather than the other way round');
    const undrawn = server.surfaceScreen('undrawn');
    expect(undrawn.ok === true && undrawn.hasScreen === false,
      'a missing screen file does NOT take the server down — the surface is declared and screenless',
      JSON.stringify(undrawn));
    expect(undrawn.descriptor.component === 'card' && /no screen declared/.test(undrawn.descriptor.opts.body),
      'and it renders the core placeholder, never blank', JSON.stringify(undrawn.descriptor.opts));
  });
});

test('t0526-06 — ⛓ a surface SURVIVES present_module: same id, same bytes, still renders after the module that replaced the screen', async () => {
  const dir = makePluginsDir({ alpha: { 'plugin.json': alphaManifest() } });
  await withServer(dir, async (server) => {
    const viewer = await connect(WebSocket, server.url().replace('http', 'ws'),
      { userId: 'viewer-1', userName: 'Viewer One' });
    try {
      // ── BEFORE. The surface resolves, and its descriptor really does render at a client.
      const before = server.surfaceScreen('roster');
      expect(before.ok === true, 'the surface resolves before any module is loaded');
      const push = (d) => server.pushComponent('all', d.component, d.opts, d.theme, d.requires);
      push(before.descriptor);
      await wait(120);
      const shown = last(viewer, 'content');
      expect(shown && shown.html.includes(MARK),
        'and it RENDERS — the marker reaches a real client', shown && shown.html.slice(0, 120));

      // ── THE THING THAT USED TO DESTROY IT. A module load replaces the room's screen wholesale.
      viewer.clear();
      server.setModule(ONE_BEAT_MODULE);
      server.showBeat(0);
      await wait(120);
      const beat = last(viewer, 'content');
      expect(beat && beat.html.includes(BEAT_MARK),
        'the module took the screen — this is the event a beat-sourced surface would not survive',
        beat && beat.html.slice(0, 120));

      // ── AFTER. Byte-identical, still addressable, still renders.
      const after = server.surfaceScreen('roster');
      expect(after.ok === true, 'the surface is STILL addressable after present_module', JSON.stringify(after));
      expect(JSON.stringify(after.descriptor) === JSON.stringify(before.descriptor),
        'and its descriptor is byte-identical to the one from before the load',
        JSON.stringify({ before: before.descriptor, after: after.descriptor }));
      expect(server.surfaces().surfaces.length === 2, 'the registry still holds both rows');

      viewer.clear();
      push(after.descriptor);
      await wait(120);
      const again = last(viewer, 'content');
      expect(again && again.html.includes(MARK),
        'and it renders again, at the same client, after the module load', again && again.html.slice(0, 120));

      // A SECOND module, to prove it is not "survives the first one".
      server.setModule({ title: 'Another', manifest: { title: 'Another' }, beats: [{ id: 'x', component: 'card', opts: { title: 'x' } }] });
      server.showBeat(0);
      await wait(60);
      const third = server.surfaceScreen('roster');
      expect(JSON.stringify(third.descriptor) === JSON.stringify(before.descriptor),
        'still byte-identical after a second module load', JSON.stringify(third.descriptor));
      // ...and the refusals did not drift either.
      expect(server.surfaceScreen('private-notes').reason === 'not-peekable', 'and the refusals still fire');
    } finally { viewer.ws.close(); }
  });
});
