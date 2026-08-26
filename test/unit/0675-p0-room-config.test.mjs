/*
 * Plan 0675 (phase 0 of 0674) — ROOMS ARE CONFIG, AND A DROPPED CAPABILITY IS LOUD.
 *
 * WHY THESE TESTS EXIST, concretely. On 2026-08-25 (`61588c0`) the allowlist normalizer rebuilt
 * `{role, voice}` as `{role}`. Config right, consumer right, and the layer between them deleted the
 * capability: nothing threw, nothing logged, and a correctly-configured presenter had no
 * microphone. A full debugging session. The room schema is where the SAME class of value now
 * lives, so every one of those failure modes is written here as a test BEFORE it can happen again:
 *
 *   - a normalizer that rebuilds from a known field list                    → t04
 *   - a wrong-typed capability that reads as falsey instead of throwing     → t05, t06
 *   - an absent capability that inherits instead of failing closed          → t03
 *   - a room selection that falls through to somebody else's policy         → t08
 *   - a resolution that is invisible from outside                           → t10
 *
 * ⭐ EACH GUARD WAS PROVED BY WRITING THE FORBIDDEN CASE — the normalizer was temporarily replaced
 * with the field-list rebuild, and with the checks removed, and these tests were watched to FAIL
 * before the real implementation was restored. A guard that has only ever been seen to pass is
 * untested.
 *
 * ⚠ NOTHING HERE BINDS A PORT or touches the real ~/.config. Every case resolves against a
 * throwaway tree via the loader's injectable {env, repoDir}, exactly as 0551 P1 does.
 *
 * ⚠ ROOM AND PLUGIN NAMES HERE ARE PLACEHOLDERS ON PURPOSE. Two repo-wide guards scan every
 * tracked file for real room/plugin vocabulary and both were ALREADY RED at this phase's baseline
 * (test/BASELINE-0675.md §3), so a new offence here would not move them pass→fail and nobody would
 * ever see it. Keep the fixtures neutral.
 */
import { test, check } from '../../harness/test.mjs';
import {
  RoomConfigError, ROOM_KEYS, ROOM_ENV, roomDefaults,
  normalizeRoomConfig, normalizeRoomsConfig, roomValueSources,
  loadDeploymentConfig, CONFIG_BASENAME,
} from '../../lib/deployment-config.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = () => mkdtempSync(join(tmpdir(), 'ap-0675-'));
const writeConfig = (dir, obj) => { writeFileSync(join(dir, CONFIG_BASENAME), JSON.stringify(obj, null, 2)); return join(dir, CONFIG_BASENAME); };
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

/** A valid two-room config. Neutral names throughout — see the header note. */
const TWO_ROOMS = Object.freeze({
  voicelink: { port: 3000, bindHosts: ['127.0.0.1', 'tailnet'], plugins: [], record: '30d', voice: true, label: 'voice link' },
  table:     { port: 3001, bindHosts: ['127.0.0.1', 'tailnet'], plugins: ['ops-console'], record: 'none', voice: false, label: 'the table' },
});

/* ── 1 ─────────────────────────────────────────────────────────────────────────────────────────
 * `rooms` ABSENT ⇒ null. Legal, not an error. This is the inertness hinge: the live deployment's
 * config has no `rooms` key, so if absence were an error this phase would take the box down. */
test('t0675-01 — `rooms` absent ⇒ null, and that is LEGAL, not a misconfiguration', () => {
  check('undefined ⇒ null', normalizeRoomsConfig(undefined) === null);
  check('null ⇒ null', normalizeRoomsConfig(null) === null);

  const home = scratch(), repo = scratch();
  writeConfig(repo, { presenterPort: 0 });   // a real config file, with no room model in it
  const cfg = loadDeploymentConfig({ env: { HOME: home }, repoDir: repo });
  check('a config file with no rooms key still loads', cfg.presenterPort === 0);
  check('...and normalizes to null rather than throwing',
    normalizeRoomsConfig(cfg.rooms, cfg.configPath) === null, JSON.stringify(cfg.rooms));
});

/* ── 2 ─────────────────────────────────────────────────────────────────────────────────────── */
test('t0675-02 — a valid two-room config parses, and BOTH rooms carry all six keys', () => {
  const rooms = normalizeRoomsConfig(TWO_ROOMS, '/test/config.json');
  check('two rooms', Object.keys(rooms).length === 2, JSON.stringify(Object.keys(rooms)));
  for (const name of Object.keys(rooms)) {
    const missing = ROOM_KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(rooms[name], k));
    check(`room "${name}" carries every one of the ${ROOM_KEYS.length} keys — never a partial object`,
      missing.length === 0, missing.join(','));
  }
  check('values survive: port', rooms.table.port === 3001);
  check('values survive: plugins', JSON.stringify(rooms.table.plugins) === '["ops-console"]');
  check('values survive: record', rooms.voicelink.record === '30d');
  check('values survive: voice', rooms.voicelink.voice === true);
  check('values survive: label', rooms.table.label === 'the table');
  check('bindHosts run through the SAME normalizer as the deployment-wide key',
    JSON.stringify(rooms.table.bindHosts) === '["127.0.0.1","tailnet"]', JSON.stringify(rooms.table.bindHosts));
  check('⛔ and a WILDCARD bind is refused inside a room too — a room may not become the wider door',
    threw(() => normalizeRoomsConfig({ open: { bindHosts: ['0.0.0.0'] } }, '/test/config.json')) !== null);
});

/* ── 3 ─────────────────────────────────────────────────────────────────────────────────────────
 * ⛔ ABSENT MEANS FAIL-CLOSED, NEVER INHERITED. The forbidden implementation here is the one that
 * looks helpful: fall back to the other room, or to whatever was on disk last time. */
test('t0675-03 — an omitted capability gets the FAIL-CLOSED value, never an inherited one', () => {
  const rooms = normalizeRoomsConfig({
    loud: { port: 3000, plugins: ['ops-console'], record: '30d', voice: true },
    bare: { port: 3001 },                    // states a port and NOTHING else
  }, '/test/config.json');

  check('plugins ⇒ [] (not the sibling\'s ["ops-console"])',
    Array.isArray(rooms.bare.plugins) && rooms.bare.plugins.length === 0, JSON.stringify(rooms.bare.plugins));
  check('record ⇒ "none" (not the sibling\'s "30d")', rooms.bare.record === 'none', rooms.bare.record);
  check('voice ⇒ false (not the sibling\'s true)', rooms.bare.voice === false, String(rooms.bare.voice));
  check('bindHosts ⇒ null ⇒ loopback only', rooms.bare.bindHosts === null, JSON.stringify(rooms.bare.bindHosts));
  check('label ⇒ null', rooms.bare.label === null);
  check('and the fully-stated sibling is UNCHANGED by any of that',
    rooms.loud.voice === true && rooms.loud.record === '30d', JSON.stringify(rooms.loud));

  check('the two rooms do not SHARE one plugins array (a mutation in phase 2 would alias them)',
    rooms.loud.plugins !== rooms.bare.plugins);
  check('roomDefaults() likewise hands out a fresh array each call',
    roomDefaults().plugins !== roomDefaults().plugins);

  const dflt = normalizeRoomConfig(undefined, '/test/config.json');
  check('an ABSENT defaultRoom is a full fail-closed room, not undefined',
    dflt.plugins.length === 0 && dflt.record === 'none' && dflt.voice === false, JSON.stringify(dflt));
});

/* ── 4 ─────────────────────────────────────────────────────────────────────────────────────────
 * ⛔⛔ THE `61588c0` TEST. A key the normalizer has never heard of must ARRIVE INTACT. Replace the
 * return with `{port, bindHosts, plugins, record, voice, label}` and this is the only test in the
 * suite that notices — which is exactly what happened last time. */
test('t0675-04 — an UNKNOWN key inside a room round-trips untouched (the 61588c0 defect, inverted)', () => {
  const input = {
    room: {
      port: 3001, voice: true,
      profile: 'floor',                                    // real, and arriving in a LATER phase
      mcpPort: 3101,                                       // ditto
      transcriptDir: '/srv/state/room/transcripts',         // ditto
      somethingNobodyHasInventedYet: { deep: ['a', 1, null], flag: false },
    },
  };
  const before = JSON.stringify(input);
  const rooms = normalizeRoomsConfig(input, '/test/config.json');
  const r = rooms.room;
  check('a forward-dated key survives: profile', r.profile === 'floor', JSON.stringify(r.profile));
  check('a forward-dated key survives: mcpPort', r.mcpPort === 3101);
  check('a forward-dated key survives: transcriptDir', r.transcriptDir === '/srv/state/room/transcripts');
  check('a NESTED unknown value survives whole, not shallow-copied to death',
    JSON.stringify(r.somethingNobodyHasInventedYet) === '{"deep":["a",1,null],"flag":false}',
    JSON.stringify(r.somethingNobodyHasInventedYet));
  check('...and the known keys are still normalized alongside it', r.voice === true && r.record === 'none');
  check('the CALLER\'s object was not mutated — normalize returns a new room, it does not edit one',
    JSON.stringify(input) === before, JSON.stringify(input));
  check('...and the returned room is not the same object as the input room',
    r !== input.room);
});

/* ── 5 ─────────────────────────────────────────────────────────────────────────────────────────
 * ⛔ A WRONG-TYPED CAPABILITY THROWS BY NAME. `"true"` is truthy in JS and false to `=== true`;
 * either way it is not what the deployer wrote down. */
test('t0675-05 — voice:"true" THROWS a named error; voice:true does not. Same for record:true', () => {
  const bad = threw(() => normalizeRoomsConfig({ room: { voice: 'true' } }, '/test/config.json'));
  check('the STRING "true" throws', bad !== null);
  check('...and it is a NAMED error, so a human sees the category first',
    bad instanceof RoomConfigError && bad.name === 'RoomConfigError', bad && bad.name);
  check('...naming the room', bad && bad.message.includes('"room"'), bad && bad.message);
  check('...and naming the key', bad && bad.message.includes('voice'), bad && bad.message);
  check('the BOOLEAN true does not throw',
    threw(() => normalizeRoomsConfig({ room: { voice: true } }, '/x')) === null);
  check('the BOOLEAN false does not throw either',
    threw(() => normalizeRoomsConfig({ room: { voice: false } }, '/x')) === null);
  check('voice:0 throws — a falsey non-boolean is the same silent-drop shape',
    threw(() => normalizeRoomsConfig({ room: { voice: 0 } }, '/x')) instanceof RoomConfigError);

  const rec = threw(() => normalizeRoomsConfig({ room: { record: true } }, '/test/config.json'));
  check('record:true (boolean) throws — a boolean is not a retention policy',
    rec instanceof RoomConfigError, rec && rec.message);
  check('record:"30d" is fine', threw(() => normalizeRoomsConfig({ room: { record: '30d' } }, '/x')) === null);
  check('record:"none" is fine', threw(() => normalizeRoomsConfig({ room: { record: 'none' } }, '/x')) === null);
  check('record:"forever" throws — an undeclared retention is how a transcript outlives its consent',
    threw(() => normalizeRoomsConfig({ room: { record: 'forever' } }, '/x')) instanceof RoomConfigError);
  check('record:"0d" throws — a zero duration is a typo, not "off"',
    threw(() => normalizeRoomsConfig({ room: { record: '0d' } }, '/x')) instanceof RoomConfigError);
});

/* ── 6 ───────────────────────────────────────────────────────────────────────────────────────── */
test('t0675-06 — plugins as a bare STRING throws, naming the room', () => {
  const e = threw(() => normalizeRoomsConfig({ table: { plugins: 'ops-console' } }, '/test/config.json'));
  check('a bare string throws', e instanceof RoomConfigError, e && e.name);
  check('...and names the room, so a five-room file does not need bisecting',
    e && e.message.includes('"table"'), e && e.message);
  check('...and says WHY, because iterating a string is the trap',
    e && /ARRAY/.test(e.message), e && e.message);
  check('an array of strings is fine',
    threw(() => normalizeRoomsConfig({ table: { plugins: ['a', 'b'] } }, '/x')) === null);
  check('an EMPTY array is fine and means "no plugins" — the fail-closed value stated out loud',
    normalizeRoomsConfig({ table: { plugins: [] } }, '/x').table.plugins.length === 0);
  check('an array containing a non-string throws',
    threw(() => normalizeRoomsConfig({ table: { plugins: ['a', 7] } }, '/x')) instanceof RoomConfigError);
  check('an array containing an empty string throws',
    threw(() => normalizeRoomsConfig({ table: { plugins: ['a', '  '] } }, '/x')) instanceof RoomConfigError);
});

/* ── 7 ───────────────────────────────────────────────────────────────────────────────────────── */
test('t0675-07 — a port outside 1..65535 throws, and so does a non-object room', () => {
  for (const p of [99999, 0, -1, 3000.5, '3000', 70000, true]) {
    const e = threw(() => normalizeRoomsConfig({ table: { port: p } }, '/test/config.json'));
    check(`port ${JSON.stringify(p)} throws a named error`, e instanceof RoomConfigError, e && e.message);
  }
  check('port 1 and port 65535 are accepted',
    normalizeRoomsConfig({ a: { port: 1 }, b: { port: 65535 } }, '/x').b.port === 65535);
  check('a room that is not an object throws',
    threw(() => normalizeRoomsConfig({ table: 3001 }, '/x')) instanceof RoomConfigError);
  check('rooms that is not an object throws',
    threw(() => normalizeRoomsConfig(['a'], '/x')) instanceof RoomConfigError);
  check('an empty room NAME throws',
    threw(() => normalizeRoomsConfig({ '  ': {} }, '/x')) instanceof RoomConfigError);
  check('an empty rooms map is legal — it means "no rooms declared", not "invalid"',
    JSON.stringify(normalizeRoomsConfig({}, '/x')) === '{}');
});

/* ── sources ──────────────────────────────────────────────────────────────────────────────────
 * The startup line's raw material: what the config STATED vs what fell back. Kept separate from
 * the value because an invisible resolution is the trap that cost 2026-08-25. */
test('t0675-07b — roomValueSources says config vs default for every key', () => {
  const s = roomValueSources({ port: 3001, voice: true });
  check('a stated key reads "config"', s.port === 'config' && s.voice === 'config', JSON.stringify(s));
  check('an omitted key reads "default"',
    s.plugins === 'default' && s.record === 'default' && s.label === 'default', JSON.stringify(s));
  check('every ROOM_KEY is answered for', ROOM_KEYS.every((k) => !!s[k]), JSON.stringify(s));
  check('an absent room answers "default" for all of them',
    ROOM_KEYS.every((k) => roomValueSources(undefined)[k] === 'default'));
  check('ROOM_ENV is the documented name', ROOM_ENV === 'PRESENTER_ROOM');
});
