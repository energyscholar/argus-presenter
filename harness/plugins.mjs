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

// ── Plan 0526 P1 — the SURFACE REGISTRY ─────────────────────────────────────────────────
// A SURFACE is a named screen a viewer may be shown ON REQUEST, declared by the DEPLOYMENT and
// loaded ONCE at startup — deliberately NOT part of a content module. A beat exists only inside
// the module that is currently loaded, so anything sourced from a beat dies on the next
// `present_module`; that is 0514 §13.1's failure, where every seat's screen vanished on a module
// load, in a second place. A surface is registry DATA on the same footing as a station row: core
// holds it, core never rewrites it, and no display or module code path can reach it.
//
// ⚠ HOW THIS DIFFERS FROM THE STATION REGISTRY, deliberately:
//   · MANY plugins may declare surfaces. A seating chart is exclusive — two of them is an
//     incoherent deployment — but a screen somebody can call up is additive, so surfaces MERGE
//     across plugins and only a COLLIDING id or label throws.
//   · `peekable` is DEFAULT-DENY. A surface that has not said it may be summoned may not be
//     summoned; the verb that does the summoning (0526 P4) refuses it BY NAME.
// The registry deliberately holds no per-surface CODE — a row resolves to a plain descriptor at
// load, exactly like `stationScreen`, so "add a surface" stays a data change forever.

const SURFACE_ID_RE = /^[a-z][a-z0-9-]*$/;       // on the wire, so: lowercase, stable, typeable

/** The registry every deployment has when no plugin declares surfaces: empty, and inert. */
function emptySurfaceRegistry() {
  return {
    plugins: [],
    list: [],
    isEmpty: () => true,
    get: () => null,
    wire: () => [],
  };
}

/**
 * Build the surface registry from a manifest map. Returns an (empty) registry when no plugin
 * declares surfaces — a deployment that has never heard of them is untouched.
 * THROWS on: a malformed row, a duplicate surfaceId or surfaceLabel (across ALL plugins), or a
 * non-boolean `peekable`. As with stations, a registry that is wrong stops the server starting
 * rather than surprising a live session.
 *
 * `log` is optional and is used only for non-fatal reports: a `screenFile` that is missing or
 * unparseable degrades that ONE surface to "no screen" (⇒ the caller's placeholder) — art that
 * has not been drawn must never take the server down.
 */
export function buildSurfaceRegistry(manifests = loadManifests(), { log = null } = {}) {
  const declaring = Object.keys(manifests).filter((n) => manifests[n] && manifests[n].surfaces !== undefined).sort();
  if (declaring.length === 0) return emptySurfaceRegistry();

  const byId = new Map();
  const labelOwner = new Map();
  const list = [];
  for (const pluginName of declaring) {
    const rows = manifests[pluginName].surfaces;
    if (!Array.isArray(rows)) throw new Error(`surface registry: ${pluginName}.surfaces must be an array`);
    for (const row of rows) {
      if (!row || typeof row !== 'object') throw new Error(`surface registry: each surface must be an object (${pluginName})`);
      const { surfaceId, surfaceLabel } = row;
      if (typeof surfaceId !== 'string' || !SURFACE_ID_RE.test(surfaceId)) {
        throw new Error(`surface registry: surfaceId must match [a-z][a-z0-9-]* (got ${JSON.stringify(surfaceId)} in ${pluginName})`);
      }
      if (byId.has(surfaceId)) {
        throw new Error(`surface registry: duplicate surfaceId ${JSON.stringify(surfaceId)} (${byId.get(surfaceId).pluginName} and ${pluginName}) — an id means one screen`);
      }
      if (typeof surfaceLabel !== 'string' || !surfaceLabel.trim()) {
        throw new Error(`surface registry: surfaceLabel must be a non-empty string (surfaceId ${JSON.stringify(surfaceId)})`);
      }
      if (labelOwner.has(surfaceLabel)) {
        throw new Error(`surface registry: duplicate surfaceLabel ${JSON.stringify(surfaceLabel)} (${labelOwner.get(surfaceLabel)} and ${surfaceId}) — two rows a viewer cannot tell apart`);
      }
      if (row.peekable !== undefined && typeof row.peekable !== 'boolean') {
        throw new Error(`surface registry: peekable must be a boolean (surfaceId ${JSON.stringify(surfaceId)})`);
      }
      const sortOrder = Number.isInteger(row.sortOrder) ? row.sortOrder : list.length + 1;
      const surface = {
        surfaceId, surfaceLabel,
        // DEFAULT-DENY (see the note above): silence is "no", never "yes".
        peekable: row.peekable === true,
        group: typeof row.group === 'string' ? row.group : null,
        icon: typeof row.icon === 'string' ? row.icon : null,
        sortOrder,
        pluginName,
        screen: resolveSurfaceScreen(pluginName, row, log),
      };
      byId.set(surfaceId, surface);
      labelOwner.set(surfaceLabel, surfaceId);
      list.push(surface);
    }
  }
  list.sort((a, b) => a.sortOrder - b.sortOrder || (a.surfaceId < b.surfaceId ? -1 : 1));

  // ── naming canon §3 — IDENTITY IS AN INTEGER UID, ASSIGNED HERE, AT LOAD ────────────────────
  // `surfaceId` is the AUTHORING code: a plugin author writes it in plugin.json, it is validated
  // and de-duplicated above, and it stops there. Everything downstream — the wire, `peek`, any
  // push target — addresses a surface by `surfaceUid`, exactly as stations address by
  // `stationUid` and never by `stationCode`. A mistyped code finds nothing and SAYS nothing,
  // which is the failure mode that left thirteen station screens blank for months; an integer
  // either resolves or is refused by name.
  //
  // ⚠ THE UID IS PER-BOOT, DELIBERATELY, and nothing may persist it. It is assigned from the
  // SORTED list, so it is a pure function of the manifests on disk — the same deployment always
  // numbers the same way — but installing another plugin renumbers, and that is fine because a
  // uid is only ever handed to a client that received THIS registry in its `welcome`. A surface
  // is not a database row; there is nothing to be a foreign key to.
  list.forEach((sf, i) => { sf.surfaceUid = i + 1; });
  const byUid = new Map(list.map((sf) => [sf.surfaceUid, sf]));

  return {
    plugins: declaring,
    list,
    isEmpty: () => list.length === 0,
    /**
     * The ONLY surface lookup there is — BY UID (canon §3). A non-integer, or a uid this
     * deployment never assigned, is null, and every caller refuses BY NAME rather than falling
     * back to some other surface. A string is not accepted here at all: an authoring code that
     * reaches a runtime lookup is the bug this signature exists to make impossible.
     */
    get: (surfaceUid) => (Number.isInteger(surfaceUid) && byUid.has(surfaceUid) ? byUid.get(surfaceUid) : null),
    /**
     * The WIRE form: what a client may be told exists. Carries `surfaceUid` and the LABEL — the
     * uid is what a control sends back, the label is what a human reads. `surfaceId` is NOT here:
     * it is authoring vocabulary and never leaves the server (canon §3, the stationCode rule).
     */
    wire: () => list.map((sf) => ({
      surfaceUid: sf.surfaceUid, surfaceLabel: sf.surfaceLabel, peekable: sf.peekable,
      group: sf.group, icon: sf.icon, sortOrder: sf.sortOrder, hasScreen: !!sf.screen,
    })),
  };
}

/**
 * Turn a manifest `screen` into a ready-to-render component descriptor ONCE, at load.
 *
 * Two sources, both DATA: inline `{component, opts}`, and `screenFile` — a plugin-relative JSON
 * file holding the same two keys, read behind the same path guard as `stationScreen.svgFile`,
 * because a screen worth calling up is usually far too big to sit inside plugin.json. Inline opts
 * are merged OVER the file's, so a deployment can override one field without copying the artwork.
 * Missing or unparseable file ⇒ LOGGED, and that one surface has no screen.
 */
function resolveSurfaceScreen(pluginName, row, log) {
  const s = row.screen;
  if (!s || typeof s !== 'object') return null;
  let fileOpts = null;
  let component = typeof s.component === 'string' && s.component ? s.component : null;
  if (s.screenFile) {
    const raw = readPluginFile(pluginName, s.screenFile);
    if (raw == null) {
      log && log.warn && log.warn('surface', 'screen-file-missing', { plugin: pluginName, surfaceId: row.surfaceId, screenFile: String(s.screenFile) });
      return null;
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) {
      log && log.warn && log.warn('surface', 'screen-file-unparseable', { plugin: pluginName, surfaceId: row.surfaceId, screenFile: String(s.screenFile), err: String(e && e.message || e) });
      return null;
    }
    if (!parsed || typeof parsed !== 'object') {
      log && log.warn && log.warn('surface', 'screen-file-not-an-object', { plugin: pluginName, surfaceId: row.surfaceId, screenFile: String(s.screenFile) });
      return null;
    }
    if (!component && typeof parsed.component === 'string' && parsed.component) component = parsed.component;
    fileOpts = (parsed.opts && typeof parsed.opts === 'object') ? parsed.opts : {};
  }
  if (!component) component = 'card';
  return { component, opts: Object.assign({}, fileOpts || {}, s.opts || {}) };
}

/** Does this plugin declare a server-side module (0514 §4.2)? Returns its relative file or null. */
export function pluginServerModule(manifest) {
  const s = manifest && manifest.server;
  if (typeof s !== 'string' || !s || !PATH_SEG_RE.test(s)) return null;   // one path segment; no traversal
  return s;
}
