/*
 * 0559 — A STATION SCREEN MUST BE VISIBLE, NOT MERELY MOUNTED.
 *
 * ⛔ THE DEFECT THIS LOCKS DOWN (found 2026-08-11, the morning after `requires` was fixed).
 * With `requires` finally correct, the station screen bundled its plugin, registered
 * `station-screen`, mounted it, and put 44 KB of correct DOM on the page — the ship's name, the
 * station's name and its number, all present and all right. The seat was BLANK. The art measured
 * 1004 × **0** px.
 *
 * ⚠ This comment used to quote that DOM text verbatim, which put a DEPLOYMENT'S SHIP NAME into the
 * neutral engine's tracked files — `t0531-01` caught it. Quoting a symptom is how domain vocabulary
 * gets into a domain-free repo: the symptom is made of the domain. Describe it instead.
 *
 * The art is `height:100%` inside `.ap-root`, and assemble.mjs gives `.ap-root` an AUTO height
 * (max-width + padding, no height), so `100%` resolved against an indefinite height and computed
 * to zero. `.ap-root.ap-fullbleed` is the engine's affordance for a component that IS the display;
 * the component now claims it, as map.js does.
 *
 * ⭐ WHY EVERY EXISTING CHECK PASSED OVER IT. t0559-20…25 assert the manifest, the registration,
 * the descriptor and the assembled bytes — all true, all green, all blind to geometry. The
 * ad-hoc browser check that "verified the alert band at two aspects" mounted the component into a
 * container that HAD a definite height, so the one condition that mattered was the one condition
 * never reproduced. ⇒ ASSERT THE PAINTED BOX. A component whose text is right and whose height is
 * zero is indistinguishable from a working one in every non-geometric test.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';
import { buildStationRegistry } from '../../harness/plugins.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '../../plugins/starship-ops');
const MANIFEST = JSON.parse(readFileSync(join(PLUGIN, 'plugin.json'), 'utf8'));

/*
 * ⚠ THE REGISTRY MUST BE THE REAL ONE, not the manifest rows. A manifest declares `svgFile`;
 * `resolveStationScreen` is what READS that file and inlines it as `opts.svg`. A test that maps
 * the manifest rows straight into a Map — as t0559-22 does, correctly, for its own purpose —
 * yields a descriptor with NO ARTWORK, and then measures the geometry of nothing.
 */
const REGISTRY = buildStationRegistry();
const STATION_LIST = REGISTRY.list;
const STATIONS = Object.assign(
  new Map(STATION_LIST.map((st) => [st.stationUid, st])),
  { defaultUid: REGISTRY.defaultUid },
);

/**
 * The descriptor as CORE receives it — captured from the seat resolver the plugin hands over,
 * never hand-built. A hand-built descriptor is what let the duplicate-`requires` bug survive two
 * tests: it exercised the bundler and never the function that was broken.
 */
async function realDescriptor(uid) {
  const mod = await import(pathToFileURL(join(PLUGIN, 'ship-machine.mjs')).href);
  let resolver = null;
  const noop = () => {};
  mod.register({
    store: { apply: () => ({ ok: true }), get: () => undefined, version: () => 0,
             subscribe: () => noop, snapshot: () => ({}) },
    allowRead: noop,
    log: { info: noop, warn: noop, error: noop },
    addTool: noop,
    stations: STATIONS,
    provideSeatResolver: (r) => { resolver = r; },
    on: noop,
  });
  return resolver.select('geometry-probe', uid).descriptor;
}

/** Every station that declares a screen — the whole deployment, not a sample of one. */
const SCREEN_UIDS = STATION_LIST.filter((st) => st.stationScreen).map((st) => st.stationUid);

const GEOMETRY = () => {
  const mount = document.getElementById('ap-mount');
  const wrap = document.querySelector('.ap-stationscreen');
  const svg = document.querySelector('.ap-ss-art svg');
  const band = document.querySelector('.ap-ss-alert');
  const box = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) }; };
  return {
    fullbleed: !!(mount && mount.classList.contains('ap-fullbleed')),
    mount: box(mount), wrap: box(wrap), svg: box(svg), band: box(band),
    text: (mount && mount.innerText || '').trim().slice(0, 120),
  };
};

test('t0559-26 — ⛔ a station screen PAINTS: the art has real width AND real height', async () => {
  const uid = SCREEN_UIDS[0];
  const desc = await realDescriptor(uid);
  const r = await drive({
    component: desc.component, opts: desc.opts, theme: desc.theme || 'argus',
    requires: desc.requires, viewport: { width: 1280, height: 800 }, probe: GEOMETRY,
  });
  const g = r.probe;
  expect('the component mounted at all', g && g.wrap, JSON.stringify(g));
  expect('the mount claimed ap-fullbleed (else .ap-root has no definite height)', g.fullbleed, JSON.stringify(g.mount));
  expect('⛔ the art has NON-ZERO HEIGHT — 1004×0 is the bug this test exists for',
    g.svg && g.svg.h > 100, JSON.stringify(g.svg));
  expect('the art fills the viewport width', g.svg && g.svg.w >= 1200, JSON.stringify(g.svg));
});

test('t0559-27 — EVERY station that declares a screen paints, not just the first', async () => {
  for (const uid of SCREEN_UIDS) {
    const desc = await realDescriptor(uid);
    const r = await drive({
      component: desc.component, opts: desc.opts, theme: desc.theme || 'argus',
      requires: desc.requires, viewport: { width: 1280, height: 800 }, probe: GEOMETRY,
    });
    const g = r.probe;
    expect(`station ${uid} paints (h>100)`, g && g.svg && g.svg.h > 100,
      `station ${uid}: ` + JSON.stringify(g && g.svg));
  }
});

test('t0559-28 — the alert band lands ON the art, inside the frame, at 16:10 and 4:3', async () => {
  /* The band is positioned in PERCENT of a container that had zero height, so it was pinned to the
     top edge regardless of the artwork. Checking two aspects is the point: `preserveAspectRatio:
     slice` moves the art under the band, and a percentage that is right at one aspect can be wrong
     at another. ⚠ This asserts CONTAINMENT, not a pixel — a tighter assertion would break every
     time the art is redrawn, which is how a geometry test becomes something people delete. */
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1024, height: 768 }]) {
    const desc = await realDescriptor(SCREEN_UIDS[0]);
    const r = await drive({ component: desc.component, opts: desc.opts, requires: desc.requires, viewport, probe: GEOMETRY });
    const g = r.probe;
    const tag = `${viewport.width}x${viewport.height}`;
    expect(`${tag}: the band rendered`, g.band && g.band.w > 0 && g.band.h > 0, JSON.stringify(g.band));
    expect(`${tag}: the band is INSIDE the art box`,
      g.band && g.svg && g.band.x >= g.svg.x && g.band.y >= g.svg.y
        && g.band.x + g.band.w <= g.svg.x + g.svg.w && g.band.y + g.band.h <= g.svg.y + g.svg.h,
      `band ${JSON.stringify(g.band)} vs art ${JSON.stringify(g.svg)}`);
  }
});

test('t0559-29 — the full-bleed affordance survives WITHOUT the map component on the page', async () => {
  /* ⭐ THE HIDDEN COUPLING. `.ap-root.ap-fullbleed` used to be declared in components/map/map.css,
     so station-screen worked only while the map component happened to be bundled alongside it.
     It now lives in lib/theme.css, which ships with the theme on every assembled page. This test
     asserts the RULE IS IN EFFECT rather than that a file contains a string — a stylesheet can be
     present and overridden, and only the computed value settles it. */
  const desc = await realDescriptor(SCREEN_UIDS[0]);
  const r = await drive({
    component: desc.component, opts: desc.opts, requires: desc.requires,
    viewport: { width: 1280, height: 800 },
    probe: () => {
      const mount = document.getElementById('ap-mount');
      const cs = getComputedStyle(mount);
      return { height: cs.height, maxWidth: cs.maxWidth, padding: cs.padding,
               mapPresent: !!(window.ApComponents && window.ApComponents.has && window.ApComponents.has('map')) };
    },
  });
  expect('the mount has a DEFINITE height, not auto', r.probe.height === '800px', JSON.stringify(r.probe));
  expect('the readable-column cap is lifted', r.probe.maxWidth === 'none', JSON.stringify(r.probe));
  expect('and the padding is gone', /^0/.test(r.probe.padding), JSON.stringify(r.probe));
});
