/*
 * _0514-fixtures.mjs — shared scaffolding for the Plan 0514 station tests.
 *
 * Registers NO tests (the leading underscore + this note; cf. _bridge-harness.mjs). It builds
 * THROWAWAY plugin trees in a temp dir and points PRESENTER_PLUGINS_DIR at them, so a test can
 * assert what a DIFFERENT deployment does — a teaching deployment with no stations at all, two
 * plugins fighting over the registry, a plugin whose server module throws — without touching the
 * installed plugin or inventing a createServer option for it.
 *
 * The env var (rather than an option) is deliberate: it mirrors PRESENTER_MODULES_DIR, and it
 * keeps the 0488 surface-coverage contract honest — a new createServer option would have to be
 * reachable from an MCP tool, and "where the plugins live" is deployment wiring, not a session
 * capability an agent should drive.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The REAL, installed plugin tree — what a live deployment actually runs. */
export const REAL_PLUGINS = join(ROOT, 'plugins');

/**
 * Build a temp plugins dir. `plugins` = { <pluginName>: { <relFile>: string|object } }.
 * Returns the absolute directory.
 */
export function makePluginsDir(plugins) {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0514-'));
  for (const [name, files] of Object.entries(plugins)) {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, name, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    }
  }
  return dir;
}

/** Run `fn` with PRESENTER_PLUGINS_DIR pointed at `dir`, restoring it afterwards no matter what. */
export async function withPlugins(dir, fn) {
  const prev = process.env.PRESENTER_PLUGINS_DIR;
  process.env.PRESENTER_PLUGINS_DIR = dir;
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.PRESENTER_PLUGINS_DIR; else process.env.PRESENTER_PLUGINS_DIR = prev; }
}

/** A minimal well-formed station manifest, so a test can vary ONE thing at a time. */
export function stationManifest(over = {}) {
  return Object.assign({
    name: 'fixture',
    requires: [], components: [], presets: {}, fieldSchemas: {},
    stationSelectorLabel: 'Post',
    stationDefaultUid: 2,
    stations: [
      { stationUid: 1, stationCode: 'alpha', stationLabel: 'Alpha', group: 'One', icon: 'A', color: '#111', maxOccupants: 1, sortOrder: 1 },
      { stationUid: 2, stationCode: 'beta', stationLabel: 'Beta', group: 'Two', icon: 'B', color: '#222', maxOccupants: null, sortOrder: 2 },
    ],
  }, over);
}

/*
 * ── The DRAWN / UNDRAWN fixture (0532 P1) ────────────────────────────────────────────────────
 *
 * A two-station plugin: uid 1 has an artwork on disk, uid 2 names one that does not exist. Every
 * test that needs "a station with a screen" or "a station WITHOUT one" builds it here.
 *
 * ⚠ WHY THIS EXISTS AT ALL. Until 0532 P1 the installed deployment had thirteen stations and
 * ZERO artworks, so three tests took their screenless station from the real registry — they
 * passed because production was broken, and they went red the moment the artworks were
 * installed. A test may not depend on the deployment's state. The fixture is under this repo's
 * control and states the condition it needs; the deployment is free to be complete.
 *
 * The seat resolver is the real installed machine, re-exported: a station is only live when some
 * plugin answers "who is sitting where", and re-implementing that here would test a stub.
 */
export const DRAWN_MARK = 'DRAWN-MARK';
export const DRAWN_SVG =
  `<svg viewBox="-400 -400 800 800" preserveAspectRatio="xMidYMid slice"><text x="0" y="0">${DRAWN_MARK}</text></svg>`;

export function artManifest(over = {}) {
  return Object.assign({
    name: 'art', requires: [], components: [], presets: {}, fieldSchemas: {},
    stationSelectorLabel: 'Post', stationDefaultUid: 2,
    stations: [
      { stationUid: 1, stationCode: 'drawn', stationLabel: 'Drawn', group: 'G', icon: '#', sortOrder: 1,
        stationScreen: { component: 'map', svgFile: 'stations/drawn.svg', opts: { fit: 'cover' } } },
      { stationUid: 2, stationCode: 'undrawn', stationLabel: 'Undrawn', group: 'G', icon: '@', sortOrder: 2,
        stationScreen: { component: 'map', svgFile: 'stations/undrawn.svg', opts: { fit: 'cover' } } },
    ],
    server: 'noop.mjs',
  }, over);
}

/** Build the drawn/undrawn plugin tree and return its directory. */
export function makeArtPluginsDir(over = {}) {
  return makePluginsDir({ art: {
    'plugin.json': artManifest(over),
    'stations/drawn.svg': DRAWN_SVG,
    // stations/undrawn.svg is DELIBERATELY absent — that absence is the fixture's whole point.
    'noop.mjs': `import { register as real } from ${JSON.stringify(pathToFileURL(join(REAL_PLUGINS, 'starship-ops', 'ship-machine.mjs')).href)};\nexport const register = real;\n`,
  } });
}

// ── the ship's store namespace ────────────────────────────────────────────────────────────────
/*
 * ⭐⭐ 0575 P1a — SHIP STATE IS KEYED: `ships/<shipId>/alert`, not the singleton `ship/alert`.
 *
 * ⛔ THE ID IS ASKED FOR, NEVER WRITTEN DOWN. Two independent reasons: this repo is PUBLIC and
 * t0531 fails any test that spells a campaign value; and a literal here would be a SECOND source
 * of truth for a key the plugin already owns — which is the drift the rename exists to stop.
 *
 * The fallback is the plugin's OWN uncommissioned default, and it applies only when the plugin is
 * not installed — a case every test using this already guards with `haveMachine`/a station check.
 */
async function readShipKey() {
  try {
    const mod = await import(pathToFileURL(join(REAL_PLUGINS, 'starship-ops', 'ship-machine.mjs')).href);
    const id = mod.loadShipInstance().shipId || mod.UNCOMMISSIONED_SHIP_ID;
    return { id, ns: mod.shipNs(id) };
  } catch (e) { return { id: 'unknown', ns: 'ships/unknown' }; }
}
const SHIP_KEY = await readShipKey();
/** The commissioned ship's id, or `unknown` when nothing is commissioned. */
export const SHIP_ID = SHIP_KEY.id;
/** Its store namespace — the prefix every ship write hangs off. */
export const SHIP_NS = SHIP_KEY.ns;

// ── live websocket helpers ────────────────────────────────────────────────────────────────────
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Connect, hello with `hello`, and collect every frame. Resolves once the welcome has landed. */
export function connect(WebSocket, url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const frames = [];
    ws.on('message', (b) => { try { frames.push(JSON.parse(b.toString())); } catch (e) {} });
    ws.on('open', () => {
      ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello)));
      setTimeout(() => resolve({ ws, frames, send: (m) => ws.send(JSON.stringify(m)), clear: () => { frames.length = 0; } }), 140);
    });
  });
}

/** Last frame of type `t`. */
export function last(conn, t) { return [...conn.frames].reverse().find((f) => f.t === t); }
