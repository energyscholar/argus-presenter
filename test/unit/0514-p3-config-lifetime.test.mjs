/*
 * Plan 0514 PHASE 3 — the config panel, the generic placeholder, and STATION LIFETIME (§13.5).
 *
 * §13 is the reason this plan exists. The defect, reproduced live before it was written:
 *
 *     present_text   → target 'user'   ⇒ roster: user = "prose",   others = "p6-coherent"   ✅
 *     present_module survey-deck       ⇒ roster: user = "p1-sweep", others = "p1-sweep"     ❌
 *
 * Two different LIFETIMES were stored in the same map. A per-seat push is transient and a module
 * load SHOULD replace it; a station is durable and belongs to the system. The fix is not to make
 * displayByUser durable (that makes the opposite error) — it is to move occupancy out of core
 * entirely, so the display layer has no code path to it. Every "untouched" row below is therefore
 * STRUCTURAL, not a promise we maintain.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { ROOT, REAL_PLUGINS, makePluginsDir, makeArtPluginsDir, DRAWN_MARK, withPlugins, wait, connect, last, SHIP_NS } from './_0514-fixtures.mjs';

const PRESENTER_HTML = readFileSync(join(ROOT, 'app', 'presenter.html'), 'utf8');
const CONTROL_HTML = readFileSync(join(ROOT, 'app', 'control.html'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(join(REAL_PLUGINS, 'starship-ops', 'plugin.json'), 'utf8'));

const MODULE = { title: 'T', beats: [{ component: 'card', opts: { title: 'ROOM BEAT', promptId: 'beat-1' } }] };
/** What the roster says a seat is currently showing (displayByUser → displayByRole). */
function displayOf(server, userId) {
  const row = server.attendance({ viewerRole: 'ai' }).roster.find((r) => r.userId === userId);
  return row ? row.display : null;
}

test('t0514-12 — the station selector is ABSENT when no plugin declares stations', async () => {
  // Client: the row ships hidden and is only revealed by a welcome that carries a non-empty
  // registry, so a teaching deployment sees no change whatsoever.
  expect(/id="cfg-station-row"[^>]*style="display:none"/.test(PRESENTER_HTML), 'the selector row ships hidden');
  expect(/if \(!Array\.isArray\(reg\) \|\| !reg\.length[\s\S]{0,120}display = 'none'/.test(PRESENTER_HTML),
    'and stays hidden when the welcome carries no registry');
  // Server: nothing is relayed at all.
  const dir = makePluginsDir({ teaching: { 'plugin.json': { name: 'teaching', requires: [], components: [], presets: {}, fieldSchemas: {} } } });
  await withPlugins(dir, async () => {
    const server = await createServer({ port: 0 });
    const url = server.url().replace('http', 'ws');
    try {
      const c = await connect(WebSocket, url, { userId: 'u', userName: 'U' });
      expect(last(c, 'welcome').stationRegistry === undefined, 'no registry on the wire');
      c.ws.close();
    } finally { await server.close(); }
  });
});

test('t0514-13 — options carry value={stationUid}, grouped by `group`, ordered by `sortOrder`', async () => {
  expect(/o\.value = String\(st\.stationUid\)/.test(PRESENTER_HTML), 'the option VALUE is the uid, never a code (canon §3)');
  expect(/createElement\('optgroup'\)/.test(PRESENTER_HTML), 'grouped with <optgroup>');
  expect(/sort\(function\(a,b\)\{ return \(a\.sortOrder\|\|0\) - \(b\.sortOrder\|\|0\); \}\)/.test(PRESENTER_HTML), 'ordered by sortOrder');

  // The DATA contract the picker is built from — this is the half that can break silently.
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const c = await connect(WebSocket, url, { userId: 'u', userName: 'U' });
    const reg = last(c, 'welcome').stationRegistry;
    expect(reg.length === MANIFEST.stations.length, 'every declared station is relayed', String(reg.length));
    expect(reg.every((r, i) => i === 0 || reg[i - 1].sortOrder <= r.sortOrder), 'relayed in sortOrder', JSON.stringify(reg.map((r) => r.sortOrder)));
    expect(reg.every((r) => Number.isInteger(r.stationUid) && typeof r.stationLabel === 'string' && r.group), 'uid + label + group present');
    expect(last(c, 'welcome').stationSelectorLabel === MANIFEST.stationSelectorLabel,
      'the plugin supplies the UI label — "Role" survives ONLY as a plugin string, never as an identifier',
      last(c, 'welcome').stationSelectorLabel);
    c.ws.close();
  } finally { await server.close(); }
});

test('t0514-14 / t0514-15 — a station with no screen renders the CORE generic placeholder, built from registry values only', async () => {
  /*
   * 0532 P1 — REWRITTEN, and the rewrite is the point.
   *
   * This test used to open the INSTALLED deployment and take the first station whose `hasScreen`
   * was false, asserting "the fixture deployment has at least one screenless station (the
   * artworks are Phase 4)". At the time all thirteen were screenless, so the search always found
   * one. That assertion was not describing core's behaviour — it was describing an unfinished
   * install, and it went red the moment P1 installed the thirteen artworks. ⇒ A test that passes
   * because production is broken is not a test.
   *
   * The condition it actually needs is "a station whose screen is not on disk". That is now
   * STATED, in a fixture this repo owns (uid 2 names `stations/undrawn.svg`, which is not there),
   * so the deployment is free to be complete and core is still held to the same contract.
   */
  const dir = makeArtPluginsDir();
  await withPlugins(dir, async () => {
    const server = await createServer({ port: 0 });
    const url = server.url().replace('http', 'ws');
    try {
      const withoutScreen = server.stations().stations.find((s) => !s.hasScreen);
      expect(withoutScreen, 'the FIXTURE declares a station whose artwork is not on disk — stated here, not borrowed from the deployment');
      expect(withoutScreen.stationUid === 2, 'and it is the one the fixture meant', String(withoutScreen && withoutScreen.stationUid));
      const c = await connect(WebSocket, url, { userId: 'u', userName: 'Solo' });
      c.clear();
      c.send({ t: 'station-select', stationUid: withoutScreen.stationUid }); await wait(180);
      const html = last(c, 'content').html;
      expect(html.includes('no active screen for this station yet'), 'the placeholder text is rendered');
      expect(html.includes(withoutScreen.stationLabel), 'carrying THIS station\'s label from the registry', withoutScreen.stationLabel);
      expect(html.includes('Solo'), 'and the occupant\'s name');
      c.ws.close();
    } finally { await server.close(); }
  });

  // t0514-15 — and NONE of those labels is hardcoded in core. Core must be able to render a
  // registry it has never seen; a literal here would mean it can only render this one. This half
  // reads the REAL manifest on purpose: it is a claim about core's source, not about a fixture.
  const coreSrc = ['app/server.mjs', 'app/presenter.html', 'app/control.html'].map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
  for (const st of MANIFEST.stations) {
    expect(!coreSrc.includes(st.stationLabel), `core contains no literal "${st.stationLabel}"`, st.stationLabel);
  }
  // …and the fixture's labels too, which core has genuinely never seen.
  for (const label of ['Drawn', 'Undrawn']) {
    expect(!coreSrc.includes(`'${label}'`) && !coreSrc.includes(`"${label}"`), `core contains no literal "${label}"`, label);
  }
});

test('t0514-14b — a station WITH an svgFile renders that artwork; a MISSING one degrades to the placeholder', async () => {
  // Both halves against a throwaway plugin (0532 P1 moved the tree into _0514-fixtures so the two
  // tests that need it cannot drift apart). The tolerance half is the one that matters: a station
  // whose artwork has not been drawn yet must degrade to the placeholder and never take the
  // server down — which is what kept thirteen missing files invisible for months.
  const dir = makeArtPluginsDir();
  await withPlugins(dir, async () => {
    const server = await createServer({ port: 0 });
    const url = server.url().replace('http', 'ws');
    try {
      const rows = server.stations().stations;
      expect(rows.find((r) => r.stationUid === 1).hasScreen === true, 'the drawn station has a screen');
      expect(rows.find((r) => r.stationUid === 2).hasScreen === false, 'the undrawn one degrades to no screen, and the server is fine');

      const c = await connect(WebSocket, url, { userId: 'u', userName: 'U' });
      c.clear(); c.send({ t: 'station-select', stationUid: 1 }); await wait(200);
      const html = last(c, 'content').html;
      expect(html.includes('DRAWN-MARK'), 'the SVG file was INLINED into the descriptor at load, once');
      // §6.1: opts.fit === 'cover' is a REAL option on the map component (components/map/map.js
      // zoomToFit uses Math.max instead of Math.min) — verified, not assumed.
      expect(/"fit":"cover"/.test(html), 'and the cover fit rides with it', html.slice(html.indexOf('"fit"') - 60, html.indexOf('"fit"') + 20));

      c.clear(); c.send({ t: 'station-select', stationUid: 2 }); await wait(200);
      expect(last(c, 'content').html.includes('no active screen for this station yet'), 'the undrawn station falls back to the generic placeholder');
      c.ws.close();
    } finally { await server.close(); }
  });
});

test('t0514-16 — a station screen is shareable via the 0508 spotlight, and the sharer\'s STORED descriptor is byte-identical before and after', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await connect(WebSocket, url, { userId: 'sharer', userName: 'Sharer' });
    const b = await connect(WebSocket, url, { userId: 'viewer', userName: 'Viewer' });
    // Stage a transient per-seat push so there IS a stored descriptor whose survival can be checked.
    server.pushComponent('sharer', 'card', { title: 'PUSHED', promptId: 'pushed-1' }); await wait(120);
    const before = displayOf(server, 'sharer');
    expect(before === 'pushed-1', 'the sharer has a stored per-seat descriptor', String(before));

    a.send({ t: 'station-select', stationUid: 4 }); await wait(160);
    server.spotlight('sharer', true); await wait(100);
    b.clear(); a.clear();
    a.send({ t: 'station-share' }); await wait(220);

    expect(last(a, 'station')?.ok === true, 'the share was accepted', JSON.stringify(last(a, 'station')));
    expect(!!last(b, 'content'), 'and the other seat received it');
    // A share is a TRANSIENT PROJECTION: it renders straight to sockets and touches no stored
    // descriptor. If it went through pushComponent, setDisplay('all') would clear displayByUser
    // and wipe every seat's stored push — the bug the 0508 comment already guards against.
    expect(displayOf(server, 'sharer') === before, 'the sharer\'s stored descriptor is unchanged', String(displayOf(server, 'sharer')));
    expect(server.stations().seats.find((s) => s.userId === 'viewer').stationUid === server.stations().stationDefaultUid,
      'and the VIEWER\'s own station is untouched by being shared at');
    a.ws.close(); b.ws.close();
  } finally { await server.close(); }
});

test('t0514-17 — the roster carries a STATION column', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const gm = await connect(WebSocket, url, { userId: 'gm1', userName: 'GM', role: 'presenter' });
    const p = await connect(WebSocket, url, { userId: 'p1', userName: 'P' });
    p.send({ t: 'station-select', stationUid: 2 }); await wait(200);
    const pres = last(gm, 'presence');
    const row = pres.users.find((u) => u.userId === 'p1');
    expect(row && row.stationUid === 2, 'presence carries the uid', JSON.stringify(row));
    expect(row.stationLabel === 'Pilot', 'and a human-readable label for the column', String(row.stationLabel));
    expect(row.stationCode === undefined, 'but never the code');
    expect(/station: '\+esc\(u\.stationLabel/.test(CONTROL_HTML), 'and the control page renders it — this is what makes a mis-seat visible in seconds');
    gm.ws.close(); p.ws.close();
  } finally { await server.close(); }
});

test('t0514-20 — station-default restores branding for the CALLER only and leaves displayByUser intact', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await connect(WebSocket, url, { userId: 'a', userName: 'A' });
    const b = await connect(WebSocket, url, { userId: 'b', userName: 'B' });
    server.pushComponent('a', 'card', { title: 'MINE', promptId: 'mine-1' }); await wait(120);
    a.clear(); b.clear();
    a.send({ t: 'station-default' }); await wait(160);
    expect(a.frames.some((f) => f.t === 'clear'), 'the caller is sent back to idle branding');
    expect(!b.frames.some((f) => f.t === 'clear'), 'and NOBODY else is', JSON.stringify(b.frames.map((f) => f.t)));
    // Deliberately NOT presenter_default_branding: that path is controller-scoped and would clear
    // the stored descriptor for everyone, so "▣ My station screen" would stop working afterwards.
    expect(displayOf(server, 'a') === 'mine-1', 'displayByUser is untouched', String(displayOf(server, 'a')));
    a.ws.close(); b.ws.close();
  } finally { await server.close(); }
});

// ── §13.5 — the lifetime table, which IS the specification ────────────────────────────────────

test('t0514-31 — station → present_module → THE STATION STILL RESOLVES (the live failure)', async () => {
  /*
   * 0532 P1 — REWRITTEN. The old form ran against the installed deployment, seated at uid 4, and
   * closed with `html.includes('Sensors') || html.includes('no active screen')`. The first
   * disjunct never fired — that station's artwork was not installed and, once it was, its text is
   * the SVG's own upper-case wordmark, not the registry label — so what actually passed the test
   * was `no active screen`: THE ABSENCE. It went red the moment the artwork arrived, while the
   * behaviour it names (a station surviving a module load) had not changed at all.
   *
   * Now fixture-based, and asserted on the DRAWN station, so "resolves" means the artwork came
   * back — a strictly stronger claim than the placeholder it used to accept.
   */
  const dir = makeArtPluginsDir();
  await withPlugins(dir, async () => {
    const server = await createServer({ port: 0 });
    const url = server.url().replace('http', 'ws');
    try {
      const c = await connect(WebSocket, url, { userId: 'seat-op', userName: 'Op' });
      c.send({ t: 'station-select', stationUid: 1 }); await wait(180);
      expect(server.stations().seats.find((s) => s.userId === 'seat-op').stationUid === 1, 'seated');

      // The exact call that used to erase every seat's station: target 'all' → setDisplay('all') →
      // displayByUser.clear().
      server.setModule(MODULE); server.showBeat(0); await wait(160);

      expect(server.stations().seats.find((s) => s.userId === 'seat-op').stationUid === 1, 'the station SURVIVED the module load');
      expect((server.store.get(`${SHIP_NS}/stations/1/occupants`) || []).includes('seat-op'), 'occupancy is intact in the machine');
      c.clear();
      c.send({ t: 'station-show' }); await wait(180);
      const html = last(c, 'content')?.html || '';
      expect(html.includes(DRAWN_MARK), 'and ▣ My station screen resolves it again — to the ARTWORK, not to a placeholder', html.slice(0, 120));
      c.ws.close();
    } finally { await server.close(); }
  });
});

test('t0514-32 — station + a transient per-seat push → module load → the station resolves, the transient push is GONE', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const c = await connect(WebSocket, url, { userId: 'both', userName: 'Both' });
    c.send({ t: 'station-select', stationUid: 6 }); await wait(160);
    server.presentText({ text: 'a private note', target: 'both' }); await wait(140);
    expect(displayOf(server, 'both') !== null, 'the transient push is stored');

    server.setModule(MODULE); server.showBeat(0); await wait(160);
    // Two lifetimes, two correct outcomes — which is exactly what could not be expressed while
    // both lived in displayByUser.
    expect(displayOf(server, 'both') === 'beat-1', 'the TRANSIENT push is gone (correct)', String(displayOf(server, 'both')));
    expect(server.stations().seats.find((s) => s.userId === 'both').stationUid === 6, 'the DURABLE station remains (correct)');
    c.ws.close();
  } finally { await server.close(); }
});

test('t0514-33 — seat A shares via the spotlight → seat B\'s station is unchanged', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await connect(WebSocket, url, { userId: 'a', userName: 'A' });
    const b = await connect(WebSocket, url, { userId: 'b', userName: 'B' });
    a.send({ t: 'station-select', stationUid: 5 }); await wait(140);
    b.send({ t: 'station-select', stationUid: 9 }); await wait(140);
    server.spotlight('a', true); await wait(100);
    a.send({ t: 'station-share' }); await wait(220);
    expect(server.stations().seats.find((s) => s.userId === 'b').stationUid === 9, 'B is still at its own station');
    expect(server.stations().seats.find((s) => s.userId === 'a').stationUid === 5, 'and so is the sharer');
    a.ws.close(); b.ws.close();
  } finally { await server.close(); }
});

test('t0514-34 — disconnect + reconnect on the same seat link → same userId, same station', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const link = { stationUID: 7, userName: 'Nix' };   // §5.1 — the uid is the selector
    const first = await connect(WebSocket, url, link);
    const id = last(first, 'welcome').userId;
    const uid = last(first, 'welcome').stationUid;
    first.ws.close(); await wait(220);
    // release() ran, so the seat left occupants — and the link re-establishes it identically.
    const again = await connect(WebSocket, url, link);
    expect(last(again, 'welcome').userId === id, 'same userId', last(again, 'welcome').userId);
    expect(last(again, 'welcome').stationUid === uid, 'same station', String(last(again, 'welcome').stationUid));
    expect((server.store.get(SHIP_NS + '/stations/' + uid + '/occupants') || []).includes(id), 'and it is re-recorded exactly once',
      JSON.stringify(server.store.get(SHIP_NS + '/stations/' + uid + '/occupants')));
    again.ws.close();
  } finally { await server.close(); }
});

test('t0514-35 — reloading the system plugin returns every seat to the default station, and it is LOGGED', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const c = await connect(WebSocket, url, { userId: 'holder', userName: 'Holder' });
    c.send({ t: 'station-select', stationUid: 10 }); await wait(160);
    expect(server.stations().seats.find((s) => s.userId === 'holder').stationUid === 10, 'seated before the reload');

    // A "reload" is a FRESH machine: the interpreter and the occupancy it held are process memory
    // belonging to the plugin. Registering again is exactly what a reload does.
    const mod = await import(pathToFileURL(join(REAL_PLUGINS, 'starship-ops', 'ship-machine.mjs')).href);
    let reloaded = null;
    const logLines = [];
    mod.register({
      store: { get: (p) => server.store.get(p), apply: (op, actor) => server.store.apply(op, actor || { role: 'system', userId: 'x' }), perms: server.store.perms },
      allowRead: () => {}, on: () => {}, emit: () => {}, addTool: () => {},
      log: { info: (tag, msg, f) => logLines.push(msg), warn: () => {} },
      stations: { list: server.stations().stations, defaultUid: server.stations().stationDefaultUid,
        get: (uid) => server.stations().stations.find((s) => s.stationUid === uid) || null },
      provideSeatResolver: (r) => { reloaded = r; },
    });
    // Bruce: "Reloading SYSTEM plugin should break people out of their station, but that won't
    // happen during play." Correct, not a regression: a stationUid that outlived its registry is
    // exactly the kind of stale reference that produces a screen nobody can explain.
    expect(reloaded.get('holder').uid === server.stations().stationDefaultUid,
      'after a reload the seat resolves to the DEFAULT station', String(reloaded.get('holder').uid));
    expect(logLines.includes('stations-cleared-on-load'), 'and the clear is logged at info so it is visible', JSON.stringify(logLines));
    c.ws.close();
  } finally { await server.close(); }
});

test('t0514-36 — displayByUser CLEARING behaviour is unchanged (a guard against "fixing" it)', async () => {
  // 0508 §4.2 D2 suggested making setDisplay('all') stop clearing displayByUser. Under 0514 that
  // is the OPPOSITE error: it would make transient per-seat pushes durable. This test fails if
  // anyone tries it.
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const c = await connect(WebSocket, url, { userId: 'seat', userName: 'Seat' });
    server.pushComponent('seat', 'card', { title: 'PER-SEAT', promptId: 'per-seat-1' }); await wait(140);
    expect(displayOf(server, 'seat') === 'per-seat-1', 'the per-seat push is stored', String(displayOf(server, 'seat')));
    server.setModule(MODULE); server.showBeat(0); await wait(160);
    expect(displayOf(server, 'seat') === 'beat-1', 'a room display change STILL clears the per-seat override', String(displayOf(server, 'seat')));
    c.ws.close();
  } finally { await server.close(); }
});

test('t0514-37 — no station LABEL or CODE appears anywhere under the ship namespace (occupancy is UID-only)', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await connect(WebSocket, url, { stationUID: 5, userName: 'Tamsin' });
    const b = await connect(WebSocket, url, { userId: 'plain-seat', userName: 'Plain' });
    b.send({ t: 'station-select', stationUid: 3 }); await wait(200);

    const labels = MANIFEST.stations.map((s) => s.stationLabel);
    const codes = MANIFEST.stations.map((s) => s.stationCode);
    const bad = [];
    (function walk(node, path) {
      if (node == null) return;
      if (typeof node === 'string') {
        // VALUES are unconditional: occupancy records 4, never "sensors" and never "Sensors".
        if (labels.includes(node) || codes.includes(node)) bad.push('value@' + path + ' = ' + node);
        return;
      }
      if (typeof node !== 'object') return;
      for (const k of Object.keys(node)) {
        // §13.2a, the ONE deliberate exception: a seat's userId is DERIVED from a station code so
        // that a reload returns the same seat (§5). It is an IDENTITY string, not a station
        // reference — the machine never parses it to learn a station, it reads stationUid. The
        // exception is scoped to exactly that one path segment and nowhere else.
        const isSeatIdentity = path === `${SHIP_NS}/seats`;
        /*
         * ⚠⚠ AND A SECOND ONE — plan 0572, STATED RATHER THAN SILENT. A starship HAS a sensors
         * system, and the damage region names it; `stationCode: 'sensors'` and the damage key
         * `sensors` are two different things spelled the same. A text scan sees only the spelling.
         *
         * ⛔ THE INVARIANT IS UNCHANGED — OCCUPANCY IS UID-ONLY, which is what this test's own
         *   title claims and what its positive controls below check. The damage region is not
         *   occupancy and holds no station reference; every other subtree is still walked.
         * ⭐ AND THE EXEMPTION IS PAID FOR, IN TWO PLACES A READER CAN GO AND CHECK:
         *     - `t0514-06` (0514-p1-registry.test.mjs), which takes the same exemption on the wire
         *       and then asserts the damage keys are EXACTLY `deriveSystems(hullClass)`;
         *     - `t0572-02 (state)` (0572-damage-station.test.mjs), which asserts the same thing
         *       against the store, and its negative half — a hull with no drives has no drive rows.
         *   That is STRONGER than the word ban it replaces: a word ban only stops thirteen strings,
         *   whereas "the keys are exactly the derived list" stops every string that is not one.
         * ⛔ DO NOT DELETE THIS EXEMPTION AS TIDYING. Removing it does not restore a protection; it
         *   breaks a passing suite for a collision that is two English words, not a defect.
         * ⚠ The alternative was renaming the ship's sensors system to dodge a string match — a
         *   second name for one rulebook concept, which is the drift this repo exists to prevent.
         */
        const isDamageRegion = path === SHIP_NS && k === 'damage';
        if (isDamageRegion) continue;
        if (!isSeatIdentity && (labels.includes(k) || codes.includes(k))) bad.push('key@' + path + '/' + k);
        walk(node[k], path + '/' + k);
      }
    })(server.store.get(SHIP_NS), SHIP_NS);
    expect(bad.length === 0, `${SHIP_NS}/ is UID-keyed throughout`, JSON.stringify(bad));

    // Positive control: the occupancy that IS there is keyed by integer uid.
    expect(Array.isArray(server.store.get(`${SHIP_NS}/stations/5/occupants`)), 'occupancy lives at an integer-uid path');
    expect(server.store.get(`${SHIP_NS}/seats/plain-seat/stationUid`) === 3, 'and the reverse index stores an integer');
    a.ws.close(); b.ws.close();
  } finally { await server.close(); }
});
