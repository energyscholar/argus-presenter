/*
 * plugins.mjs — read plugin manifests (plugins/<name>/plugin.json).
 * Node-style plugin metadata: { name, requires, components, presets, fieldSchemas }.
 * Used by the manifest generator (A5), the dependency-driven assembler (A6), and —
 * since Plan 0514 — app/server.mjs. ONE loader, three consumers: the server must never
 * grow a second manifest reader (0514 §3).
 *
 * Plan 0514 also adds the optional STATION REGISTRY (§3) and the optional server-side
 * module declaration (§4.2). Both are read here and both are DOMAIN-NEUTRAL: core knows
 * only that there is a registry of stations, that it has a default, and that a station may
 * carry a screen descriptor and an occupancy cap. Every row is plugin DATA.
 */
import { readdirSync, existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where plugins live. Resolved PER CALL (not at module load) so a test — or a deployment
 * with its content elsewhere — can point PRESENTER_PLUGINS_DIR at another tree and have
 * every consumer agree. Mirrors PRESENTER_MODULES_DIR.
 */
export function pluginsDir() { return process.env.PRESENTER_PLUGINS_DIR || join(ROOT, 'plugins'); }

/** Absolute path of one plugin's directory. */
export function pluginDir(name) { return join(pluginsDir(), name); }

/** All plugin dir names. */
export function pluginNames() {
  const base = pluginsDir();
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

/** Read one plugin's manifest (or null if it has no plugin.json). */
export function readManifest(name) {
  const p = join(pluginDir(name), 'plugin.json');
  if (!existsSync(p)) return null;
  const m = JSON.parse(readFileSync(p, 'utf8'));
  m.name = m.name || name;
  m.requires = m.requires || [];
  m.components = m.components || [];
  m.presets = m.presets || {};
  m.fieldSchemas = m.fieldSchemas || {};
  return m;
}

/** Map of name -> manifest for every plugin that has a manifest. */
export function loadManifests() {
  const out = {};
  for (const n of pluginNames()) { const m = readManifest(n); if (m) out[n] = m; }
  return out;
}

/**
 * Transitive plugin closure of a `requires` list (Node-style dependency
 * resolution). Follows each manifest's own `requires`. Unknown names are ignored
 * (S9: allowlisted by the existence of a manifest, no path traversal). Returns a
 * de-duplicated, sorted array; [] in → [] out (pure core).
 */
export function resolveClosure(requires = []) {
  const manifests = loadManifests();
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name) || !manifests[name]) return;   // ignore unknown/unmanifested names
    seen.add(name);
    for (const dep of manifests[name].requires) visit(dep);
  };
  for (const r of requires || []) visit(r);
  return [...seen].sort();
}

// ── Plan 0514 §3 — the STATION REGISTRY ─────────────────────────────────────────────────
// A plugin MAY declare `stations` (+ `stationDefaultUid`, `stationSelectorLabel`). Core builds
// an in-memory registry at load. UIDs are AUTHOR-ASSIGNED and stable forever because they are
// written down, not derived from array order (naming canon §3). Validation THROWS AT LOAD —
// a registry that is wrong should stop the server starting, never surprise a live session.

const STATION_CODE_RE = /^[a-z0-9-]+$/;          // authoring only; never on the wire
const PATH_SEG_RE = /^[\w.-]+$/;                  // same guard as readModuleById — no traversal

/** Read a plugin-relative file, refusing anything that could escape the plugin directory. */
function readPluginFile(name, rel) {
  const segs = String(rel).split('/');
  if (!segs.length || segs.some((s) => !PATH_SEG_RE.test(s) || s === '.' || s === '..')) return null;
  const abs = join(pluginDir(name), ...segs);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  return readFileSync(abs, 'utf8');
}

/** The registry every deployment has when no plugin declares stations: empty, and inert. */
function emptyRegistry() {
  return {
    pluginName: null,
    selectorLabel: null,
    defaultUid: null,
    list: [],
    isEmpty: () => true,
    get: () => null,
    wire: () => [],
  };
}

/**
 * Build the station registry from a manifest map. Returns an (empty) registry when no plugin
 * declares stations — teaching deployments are untouched and see no station surface at all.
 * THROWS on: two declaring plugins, a duplicate uid/code/label, a malformed field, or a
 * `stationDefaultUid` that does not resolve.
 *
 * `log` is optional and is used only for non-fatal reports (a `stationScreen.svgFile` that is
 * missing on disk degrades that ONE station to "no screen" — a missing artwork must never take
 * the server down).
 */
export function buildStationRegistry(manifests = loadManifests(), { log = null } = {}) {
  const declaring = Object.keys(manifests).filter((n) => manifests[n] && manifests[n].stations !== undefined);
  if (declaring.length === 0) return emptyRegistry();
  if (declaring.length > 1) {
    throw new Error(`station registry: ${declaring.length} plugins declare stations (${declaring.join(', ')}) — one deployment, one registry`);
  }
  const pluginName = declaring[0];
  const man = manifests[pluginName];
  const rows = man.stations;
  if (!Array.isArray(rows)) throw new Error(`station registry: ${pluginName}.stations must be an array`);
  if (!rows.length) return emptyRegistry();

  const byUid = new Map();
  const codes = new Set();
  const labels = new Set();
  const list = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new Error('station registry: each station must be an object');
    const { stationUid, stationCode, stationLabel } = row;
    if (!Number.isInteger(stationUid) || stationUid < 1) throw new Error(`station registry: stationUid must be an integer >= 1 (got ${JSON.stringify(stationUid)})`);
    if (byUid.has(stationUid)) throw new Error(`station registry: duplicate stationUid ${stationUid}`);
    if (typeof stationCode !== 'string' || !STATION_CODE_RE.test(stationCode)) throw new Error(`station registry: stationCode must match [a-z0-9-]+ (got ${JSON.stringify(stationCode)})`);
    if (codes.has(stationCode)) throw new Error(`station registry: duplicate stationCode ${stationCode}`);
    if (typeof stationLabel !== 'string' || !stationLabel.trim()) throw new Error(`station registry: stationLabel must be a non-empty string (uid ${stationUid})`);
    if (labels.has(stationLabel)) throw new Error(`station registry: duplicate stationLabel ${stationLabel}`);
    const maxOccupants = row.maxOccupants === undefined ? null : row.maxOccupants;
    if (!(maxOccupants === null || (Number.isInteger(maxOccupants) && maxOccupants >= 1))) {
      throw new Error(`station registry: maxOccupants must be null or an integer >= 1 (uid ${stationUid})`);
    }
    const sortOrder = Number.isInteger(row.sortOrder) ? row.sortOrder : stationUid;
    const station = {
      stationUid, stationCode, stationLabel,
      group: typeof row.group === 'string' ? row.group : null,
      icon: typeof row.icon === 'string' ? row.icon : null,
      color: typeof row.color === 'string' ? row.color : null,
      maxOccupants, sortOrder,
      stationScreen: resolveStationScreen(pluginName, row, log),
    };
    byUid.set(stationUid, station);
    codes.add(stationCode); labels.add(stationLabel);
    list.push(station);
  }
  list.sort((a, b) => a.sortOrder - b.sortOrder || a.stationUid - b.stationUid);

  const defaultUid = man.stationDefaultUid;
  if (!byUid.has(defaultUid)) {
    throw new Error(`station registry: stationDefaultUid ${JSON.stringify(defaultUid)} does not resolve to a declared station`);
  }

  return {
    pluginName,
    selectorLabel: typeof man.stationSelectorLabel === 'string' && man.stationSelectorLabel.trim() ? man.stationSelectorLabel : 'Station',
    defaultUid,
    list,
    isEmpty: () => false,
    /**
     * The ONLY station lookup there is (0514 §5.1, Bruce S220). Provisioning matches an INTEGER
     * uid, never a label or a code: a uid cannot be misspelled into a DIFFERENT station, it either
     * resolves or it does not. The string matcher this replaced silently seated an Observer for
     * `?station=damage-control`, because the code is `dc` — Bruce hit that in his own first seat
     * link. Non-integer / unknown ⇒ null, and every caller falls back to the deployment default.
     */
    get: (uid) => (Number.isInteger(uid) && byUid.has(uid) ? byUid.get(uid) : null),
    /**
     * The WIRE form (naming canon §3 / 0514 t0514-06): a stationCode is AUTHORING ONLY and
     * never leaves the server. Clients address stations by uid and display the label.
     */
    wire: () => list.map((st) => ({
      stationUid: st.stationUid, stationLabel: st.stationLabel, group: st.group,
      icon: st.icon, color: st.color, maxOccupants: st.maxOccupants, sortOrder: st.sortOrder,
      hasScreen: !!st.stationScreen,
    })),
  };
}

/**
 * Turn a manifest `stationScreen` into a ready-to-render component descriptor, ONCE, at load.
 * `svgFile` (not an inlined svg string) keeps plugin.json small; the file is read relative to
 * the plugin directory behind the same path guard as readModuleById. A missing file is LOGGED
 * and degrades that station to "no screen" (⇒ the generic placeholder) rather than throwing —
 * an artwork that has not been drawn yet must never break the server.
 */
function resolveStationScreen(pluginName, row, log) {
  const s = row.stationScreen;
  if (!s || typeof s !== 'object') return null;
  const component = typeof s.component === 'string' && s.component ? s.component : 'map';
  const opts = Object.assign({}, s.opts || {});
  if (s.svgFile) {
    const svg = readPluginFile(pluginName, s.svgFile);
    if (svg == null) {
      log && log.warn && log.warn('station', 'screen-file-missing', { plugin: pluginName, stationUid: row.stationUid, svgFile: String(s.svgFile) });
      return null;                              // no screen yet ⇒ generic placeholder
    }
    opts.svg = svg;
  }
  // Forward-compatible: a `watch` list is accepted and ignored by static art, so promoting a
  // placeholder to a live reactive applet later is a content change, not a protocol change.
  if (Array.isArray(s.watch)) opts.watch = s.watch.slice();
  return { component, opts };
}

/** Does this plugin declare a server-side module (0514 §4.2)? Returns its relative file or null. */
export function pluginServerModule(manifest) {
  const s = manifest && manifest.server;
  if (typeof s !== 'string' || !s || !PATH_SEG_RE.test(s)) return null;   // one path segment; no traversal
  return s;
}
