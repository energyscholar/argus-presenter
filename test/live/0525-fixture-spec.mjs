/*
 * 0525-fixture-spec.mjs — THE SAME WALK, WITH NOTHING PRIVATE IN IT. Plan 0525 P3.1.
 *
 * `harness/session-rig.mjs` drives one control page and N participant displays through a
 * caller-supplied spec. The other spec in this directory drives a real campaign, and it can only
 * run on the machine that has that campaign: `modules/*.json` and `plugins/<name>/` are BOTH
 * gitignored, so the rig — the repo's only instrument that exercises a whole session in real
 * browsers — skipped in a clean clone, in every scratch worktree used for a revert check, and in
 * CI. Honest, and blind exactly where blindness is cheapest to acquire.
 *
 * This spec removes that. Every byte it depends on is COMMITTED:
 *
 *   the module    `test/live/0525-fixture-module/rig-fixture.json` — tracked, 16 beats, 5 sections
 *   the stations  `stationManifest()` from `test/unit/_0514-fixtures.mjs` — tracked, already
 *                 exported, and already the way this repo builds a throwaway station registry
 *   the resolver  the source string below, materialised into a mkdtemp plugin tree at run time
 *
 * ⛔ It reads and writes NEITHER the repo's `modules/` NOR its `plugins/`. The two optional spec
 * keys `moduleSourceDir` and `pluginsDir` are what make that possible; both are paths, and neither
 * puts a deployment's vocabulary into core (`docs/naming-canon.md`, `README.md`).
 *
 * ⚠⚠ `manifest.defaultBeatId` REACHES EVERY CLIENT AT MODULE LOAD, BEFORE THE PRESENTER SENDS
 * ANYTHING. Loading a module is itself a push — which is why `beats.staged` below is `b-staged`
 * and not `b-title`. Staging the default beat would assert "nothing changed" against a screen that
 * was never going to change, and sending it would assert "the screen changed" against a screen
 * already showing it. It cost the 0524 rig two failing runs to learn this. (Plan 0525 P3.3.)
 *
 * ⚠ THE ON-DEMAND RUN IS DELIBERATE. `b-door-outer` and `b-door-inner` are consecutive and both
 * marked `onDemand`, so plan 0525 P1's marker has a home that survives a clean checkout. The arrow
 * pressed on `b-before-door` lands on the FIRST of the run and ships it — that is the DESIGNED
 * behaviour under R5: the marker informs whoever is presenting, it is not a rule the product
 * enforces. `beats.onDemand` is therefore the SECOND of the run, reached by explicit click, so the
 * "the screen changed" assertion is not made against a screen the arrow already changed.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stationManifest } from '../unit/_0514-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The committed module, and the committed file the station rows come from. */
export const MODULE_DIR = join(HERE, '0525-fixture-module');
export const MODULE_ID = 'rig-fixture';
export const SOURCES = [
  join(MODULE_DIR, `${MODULE_ID}.json`),
  join(HERE, '0525-fixture-spec.mjs'),
  join(HERE, '..', 'unit', '_0514-fixtures.mjs'),
];

/*
 * Six posts. A deployment's own registry is plugin DATA (0514 §3) and core knows only that there
 * is one; these rows are deliberately colourless. Four are sat in, one is left EMPTY on purpose —
 * sending to it must be LOUD — and the last is the default, which is where the control page's own
 * identity lands, exactly as the installed deployment's default does.
 */
const EMPTY_UID = 5;
const DEFAULT_UID = 6;
const STATIONS = [
  { stationUid: 1, stationCode: 'alpha',   stationLabel: 'Alpha',   group: 'Front', icon: 'A', color: '#4488ff', maxOccupants: 1,    sortOrder: 1 },
  { stationUid: 2, stationCode: 'bravo',   stationLabel: 'Bravo',   group: 'Front', icon: 'B', color: '#00ff88', maxOccupants: 1,    sortOrder: 2 },
  { stationUid: 3, stationCode: 'charlie', stationLabel: 'Charlie', group: 'Front', icon: 'C', color: '#ffaa00', maxOccupants: 1,    sortOrder: 3 },
  { stationUid: 4, stationCode: 'delta',   stationLabel: 'Delta',   group: 'Back',  icon: 'D', color: '#cc88ff', maxOccupants: 1,    sortOrder: 4 },
  { stationUid: EMPTY_UID,   stationCode: 'echo',     stationLabel: 'Echo',     group: 'Back', icon: 'E', color: '#ff6644', maxOccupants: 4,    sortOrder: 5 },
  { stationUid: DEFAULT_UID, stationCode: 'foxtrot',  stationLabel: 'Foxtrot',  group: 'Meta', icon: 'F', color: '#888888', maxOccupants: null, sortOrder: 6 },
];
export const STATION_WORD = 'Post';

/*
 * A registry alone seats nobody: `stationsActive()` needs a plugin-provided seat resolver
 * (app/server.mjs §4.2a). This is the smallest one that answers all three calls core makes —
 * select on join and on {t:'station-select'}, get whenever welcome/presence is built, release on
 * disconnect — and it falls back to the deployment default for an unknown uid rather than erroring,
 * which is what §5 requires. No screen descriptor: core then draws its own generic placeholder,
 * which is the honest render for a post nobody has pushed anything to.
 */
const RESOLVER = `
export function register(ctx) {
  const seats = new Map();
  const known = new Set((ctx.stations && ctx.stations.list || []).map(function (s) { return s.stationUid; }));
  const dflt = ctx.stations && ctx.stations.defaultUid;
  ctx.provideSeatResolver({
    select: function (userId, uid) {
      const u = known.has(uid) ? uid : dflt;
      seats.set(userId, { uid: u, descriptor: null });
      return { uid: u, descriptor: null };
    },
    get: function (userId) { return seats.get(userId) || null; },
    release: function (userId) { seats.delete(userId); },
  });
}
`;

/**
 * The throwaway plugin tree, built ONCE and only if somebody actually asks for it — the getter
 * below fires when `runSession` destructures the spec, never at import. Import must stay free of
 * side effects: the whole suite is ONE process, and a spec that touched the environment on import
 * would change the deployment every later test file sees.
 */
let _pluginsDir = null;
export function fixturePluginsDir() {
  if (_pluginsDir) return _pluginsDir;
  const dir = mkdtempSync(join(tmpdir(), 'ap-0525-plugins-'));
  mkdirSync(join(dir, 'rigfixture'), { recursive: true });
  writeFileSync(join(dir, 'rigfixture', 'plugin.json'), JSON.stringify(stationManifest({
    name: 'rigfixture',
    server: 'seats.mjs',
    stationSelectorLabel: STATION_WORD,
    stationDefaultUid: DEFAULT_UID,
    stations: STATIONS,
  }), null, 2));
  writeFileSync(join(dir, 'rigfixture', 'seats.mjs'), RESOLVER);
  _pluginsDir = dir;
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch (e) {} });
  return dir;
}

export default {
  name: 'Rig fixture — a whole walk, committed',
  moduleId: MODULE_ID,

  // ⛔ The two keys that make this spec runnable where the private content is not.
  moduleSourceDir: MODULE_DIR,
  get pluginsDir() { return fixturePluginsDir(); },

  seats: [
    { userId: 'a-one',   userName: 'One',   stationUid: 1, station: 'Alpha' },
    { userId: 'b-two',   userName: 'Two',   stationUid: 2, station: 'Bravo' },
    { userId: 'c-three', userName: 'Three', stationUid: 3, station: 'Charlie' },
    { userId: 'd-four',  userName: 'Four',  stationUid: 4, station: 'Delta' },
  ],
  emptyStationUid: EMPTY_UID,

  beats: {
    staged: 'b-staged',                                                     // staged, then GO
    survey: ['b-survey-1', 'b-survey-2', 'b-survey-3', 'b-survey-4'],
    perSeat: ['b-seat-1', 'b-seat-2'],                                      // to the first seat alone
    broadcast: ['b-room-1', 'b-room-2'],                                    // and to the room
    mid: ['b-mid-1', 'b-mid-2'],
    beforeArrow: 'b-before-door',
    onDemand: 'b-door-inner',                                               // the SECOND of the run
    finale: 'b-finale',
  },

  notes: {
    'boot': 'the control page alone, before anyone joins',
    'seated': 'One, Two, Three and Four take their posts — Echo is left empty on purpose',
    'module-loaded': 'the committed fixture deck: 16 beats, 5 sections, nothing gitignored',
    'arrival': 'the title page is on every display already — manifest.defaultBeatId put it there at load. Nobody sent it.',
    'staged-not-sent': 'a row is clicked — and the room does NOT change',
    'go': 'GO ships it, and only then',
    'survey': 'four ordinary beats walked to the room, each timed',
    'site-alpha-fails': 'two beats addressed to Alpha alone',
    'site-beta-passes': 'and two addressed to everybody',
    'empty-station': 'sent to Echo — where nobody is sitting',
    'plant-online': 'two mid-deck beats, deep enough into the session for accumulated state to matter',
    'the-pulse': 'the arrow walks onto the FIRST on-demand beat and ships it (R5: correct); the second is opened by an explicit click',
    'station-tier-and-close': 'a post is projected to the room, a display reloads, and the deck closes',
  },
};
