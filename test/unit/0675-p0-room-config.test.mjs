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
  resolveRoom, roomConfig, roomStartupLine, identityStartupLine,
  writeConfigSection,
  loadDeploymentConfig, CONFIG_BASENAME,
} from '../../lib/deployment-config.mjs';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync, unlinkSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

/* ── 8 ─────────────────────────────────────────────────────────────────────────────────────────
 * ⛔⛔ THE FALL-THROUGH IS THE FAILURE. A room name that does not resolve must stop the process,
 * not quietly hand it the default room's capabilities. Everything about a mis-selected room looks
 * healthy from outside: it binds, it answers, it logs nothing — it is simply enforcing a policy
 * nobody chose for it. */
test('t0675-08 — an UNKNOWN PRESENTER_ROOM is a named startup error, NEVER a fall-through', () => {
  const cfg = { rooms: TWO_ROOMS, defaultRoom: { plugins: [], record: 'none', voice: false }, configPath: '/test/config.json' };

  const e = threw(() => resolveRoom({ [ROOM_ENV]: 'nosuchroom' }, cfg));
  check('it throws', e !== null);
  check('...and it is NAMED', e instanceof RoomConfigError && e.name === 'RoomConfigError', e && e.name);
  check('...quoting the name that failed', e && e.message.includes('"nosuchroom"'), e && e.message);
  check('...listing the rooms that DO exist, so the fix is in the error',
    e && e.message.includes('voicelink') && e.message.includes('table'), e && e.message);
  check('...and saying out loud that it refused to fall through',
    e && /REFUSING to fall through/.test(e.message), e && e.message);

  const e2 = threw(() => resolveRoom({ [ROOM_ENV]: 'table' }, { configPath: '/test/config.json' }));
  check('naming a room when there is NO rooms block at all also throws — not "close enough to default"',
    e2 instanceof RoomConfigError, e2 && e2.message);
  check('...and says there is no rooms block, rather than listing an empty set',
    e2 && /no "rooms" block/.test(e2.message), e2 && e2.message);

  const e3 = threw(() => resolveRoom({ [ROOM_ENV]: 'Table' }, cfg));
  check('room names are NOT case-folded — a near-miss is still a miss, and silently serving "table" would be the same bug',
    e3 instanceof RoomConfigError, e3 && e3.message);

  const ok = resolveRoom({ [ROOM_ENV]: '  table  ' }, cfg);
  check('surrounding whitespace IS trimmed — a unit file with a stray space is a typo with no policy meaning',
    ok.name === 'table' && ok.room.port === 3001, JSON.stringify(ok.name));
  check('the selected room is the one that was asked for, whole',
    ok.room.plugins.length === 1 && ok.room.record === 'none', JSON.stringify(ok.room));
  check('and the SELECTION source is reported as env', ok.source === 'env');
});

/* ── 9 ───────────────────────────────────────────────────────────────────────────────────────── */
test('t0675-09 — PRESENTER_ROOM unset ⇒ defaultRoom, fail-closed', () => {
  const cfg = { rooms: TWO_ROOMS, defaultRoom: { plugins: [], record: 'none', voice: false }, configPath: '/test/config.json' };

  const r = resolveRoom({}, cfg);
  check('no room is named', r.name === null, JSON.stringify(r.name));
  check('the selection source says so', r.source === 'default');
  check('plugins []', r.room.plugins.length === 0, JSON.stringify(r.room.plugins));
  check('record "none"', r.room.record === 'none');
  check('voice false', r.room.voice === false);
  check('⛔ and NOT the first declared room\'s capabilities — voicelink records for 30d and has voice',
    r.room.record !== '30d' && r.room.voice !== true, JSON.stringify(r.room));

  const empty = resolveRoom({}, { rooms: TWO_ROOMS, configPath: '/test/config.json' });
  check('with NO defaultRoom stated at all, the fallback is still the fail-closed room',
    empty.room.plugins.length === 0 && empty.room.record === 'none' && empty.room.voice === false,
    JSON.stringify(empty.room));

  const blank = resolveRoom({ [ROOM_ENV]: '   ' }, cfg);
  check('an EMPTY PRESENTER_ROOM is treated as unset, not as a room named ""',
    blank.name === null && blank.source === 'default');

  // And end-to-end through the real loader, against a throwaway tree.
  const home = scratch(), repo = scratch();
  writeConfig(repo, { presenterPort: 0, rooms: TWO_ROOMS });
  const live = roomConfig({ env: { HOME: home, [ROOM_ENV]: 'voicelink' }, repoDir: repo });
  check('roomConfig() reads the file and resolves through the SAME path',
    live.name === 'voicelink' && live.room.voice === true, JSON.stringify(live.name));
  check('...and reports WHICH file won — the whole-file resolution trap is otherwise invisible',
    live.configPath === join(repo, CONFIG_BASENAME), live.configPath);
  const bad = threw(() => roomConfig({ env: { HOME: home, [ROOM_ENV]: 'ghost' }, repoDir: repo }));
  check('...and a bad name through the real loader throws just the same',
    bad instanceof RoomConfigError, bad && bad.message);
});

/* ── 10 ────────────────────────────────────────────────────────────────────────────────────────
 * ⭐ G12 — THE WHOLE RESOLVED PICTURE MUST BE VISIBLE FROM OUTSIDE, AND CARRY NO SECRET.
 * Both halves are one test on purpose: a line that says everything is useless if it also says the
 * client secret, and a line that is safe because it says nothing is the 0543 failure. */
test('t0675-10 — the startup line names the room, every value AND its source, and leaks nothing', () => {
  const SECRET = 'not-a-real-secret-0675';
  const CLIENT_ID = 'test-client-id-0675.example.invalid';
  const ALLOWED = 'someone@example.invalid';

  const cfg = {
    rooms: { table: { port: 3001, bindHosts: ['127.0.0.1'], plugins: ['ops-console'], record: '30d' } },
    // Everything a leak could come from, present in the SAME config object the resolver is handed.
    oidc: { clientId: CLIENT_ID, clientSecret: SECRET },
    allowlist: { [ALLOWED]: { role: 'presenter', voice: true } },
    configPath: '/test/config.json',
  };
  const line = roomStartupLine(resolveRoom({ [ROOM_ENV]: 'table' }, cfg));

  check('names the room', line.includes('table'), line);
  check('reports the port', /port 3001/.test(line), line);
  check('reports the bind', /127\.0\.0\.1/.test(line), line);
  check('reports the plugin set BY NAME — "2 plugins" would hide which two', /ops-console/.test(line), line);
  check('reports the recording policy', /record 30d/.test(line), line);
  check('reports voice', /voice false/.test(line), line);

  // ⭐ THE SOURCE OF EVERY VALUE. `voice false(default)` and `voice false(config)` are the same
  // value and completely different facts, and 2026-08-25 turned on exactly that difference.
  check('port carries its source', /port 3001\(config\)/.test(line), line);
  check('plugins carries its source', /plugins ops-console\(config\)/.test(line), line);
  check('record carries its source', /record 30d\(config\)/.test(line), line);
  check('an UNSTATED value is marked (default), not silently shown as if chosen',
    /voice false\(default\)/.test(line), line);
  check('the room SELECTION carries its source too', /table \(env\)/.test(line), line);
  check('and WHICH FILE won is named — the whole-file resolution trap is otherwise invisible',
    line.includes('/test/config.json'), line);
  check('the line says it is inert, so nobody reads it as a description of what loaded',
    /PHASE 0: REPORTED ONLY/.test(line), line);

  // ⛔ THE LEAK CHECK.
  check('⛔ NO client secret', !line.includes(SECRET), line);
  check('⛔ NO client id', !line.includes(CLIENT_ID), line);
  check('⛔ NO allowlist entry', !line.includes(ALLOWED) && !line.includes('example.invalid'), line);

  const dflt = roomStartupLine(resolveRoom({}, cfg));
  check('the defaultRoom line is legible too, and says which env var was unset',
    dflt.includes('PRESENTER_ROOM unset'), dflt);
  check('...and marks EVERY value (default)', (dflt.match(/\(default\)/g) || []).length >= 5, dflt);
  check('...and leaks nothing either', !dflt.includes(SECRET) && !dflt.includes(CLIENT_ID), dflt);

  const bare = roomStartupLine({});
  check('called with nothing at all it still renders rather than throwing at startup',
    typeof bare === 'string' && bare.includes('room:'), bare);
});

/* The existing identity line is under the same rule and must STAY under it — 0551 asserts this and
 * this repeats it here so a future edit to either line meets the constraint from both directions. */
test('t0675-10b — the two startup lines are the whole visible picture, and neither carries a secret', () => {
  const line = identityStartupLine({
    oidc: { clientId: 'cid-0675.example.invalid', clientSecret: 'secret-0675' },
    allowlist: { 'a@example.invalid': { role: 'presenter' } },
    configPath: '/test/config.json',
  });
  check('identity line still reports STATE', /OIDC sign-in ACTIVE/.test(line) && /allowlist 1 entry/.test(line), line);
  check('...and still no secret', !line.includes('secret-0675'), line);
  check('...and still no client id', !line.includes('cid-0675'), line);
  check('...and still no allowlist entry', !line.includes('a@example.invalid'), line);
});

/* ══ T4 — THE ONE WRITER ═══════════════════════════════════════════════════════════════════════
 * This file holds the OIDC clientSecret in cleartext. Every test below is really one question:
 * after a write, is the deployment still the deployment it was? */

/** A config file that looks like a real one: a secret, a comment key, an unknown key, mode 0600. */
function writeRealisticConfig(dir) {
  const p = join(dir, CONFIG_BASENAME);
  const text = [
    '{',
    '  "// NOTE": "keep presenterPort and sessionLogDir in the SAME file — resolution is whole-file",',
    '  "presenterPort": 3000,',
    '  "oidc": {',
    '    "clientId": "test-client-id-0675.example.invalid",',
    '    "clientSecret": "not-a-real-secret-0675-KEEP-ME",',
    '    "authEndpoint": "https://idp.example.invalid/authorize"',
    '  },',
    '  "allowlist": { "someone@example.invalid": { "role": "presenter", "voice": true } },',
    '  "somethingThisCodeHasNeverHeardOf": { "deep": [1, 2, 3] },',
    '  "// TRAILING": "a second comment key, last in the file"',
    '}',
    '',
  ].join('\n');
  writeFileSync(p, text, { mode: 0o600 });
  return p;
}

/* ── 11 ──────────────────────────────────────────────────────────────────────────────────────── */
test('t0675-11 — writeConfigSection round-trips the WHOLE document: secret, mode, unknown keys, order', async () => {
  const dir = scratch();
  const p = writeRealisticConfig(dir);
  const beforeText = readFileSync(p, 'utf8');
  const beforeKeys = Object.keys(JSON.parse(beforeText));

  const logged = [];
  await writeConfigSection('rooms', TWO_ROOMS, { configPath: p, actor: 'test:t0675-11', log: (l) => logged.push(l) });

  const after = JSON.parse(readFileSync(p, 'utf8'));
  check('the section was written', after.rooms && after.rooms.table.port === 3001, JSON.stringify(after.rooms && Object.keys(after.rooms)));

  // ⛔ THE ONE THAT MATTERS.
  check('⛔ the OIDC clientSecret survives BYTE FOR BYTE',
    after.oidc.clientSecret === 'not-a-real-secret-0675-KEEP-ME', JSON.stringify(after.oidc));
  check('⛔ the rest of the oidc block survives too',
    after.oidc.clientId && after.oidc.authEndpoint, JSON.stringify(after.oidc));
  check('⛔ the allowlist survives, entry and voice capability alike',
    after.allowlist['someone@example.invalid'].voice === true, JSON.stringify(after.allowlist));
  check('⛔ an unknown top-level key survives whole',
    JSON.stringify(after.somethingThisCodeHasNeverHeardOf) === '{"deep":[1,2,3]}',
    JSON.stringify(after.somethingThisCodeHasNeverHeardOf));
  check('⛔ a `//`-comment key survives — it is a message from one human to the next',
    after['// NOTE'] && after['// TRAILING'], JSON.stringify(Object.keys(after)));

  const afterKeys = Object.keys(after);
  check('⛔ KEY ORDER survives, with the new section appended rather than the file re-sorted',
    JSON.stringify(afterKeys.slice(0, beforeKeys.length)) === JSON.stringify(beforeKeys),
    JSON.stringify(afterKeys));

  check('⛔ file MODE is still 0600 — a temp file at the ambient umask would have widened the secret',
    (statSync(p).mode & 0o777) === 0o600, (statSync(p).mode & 0o777).toString(8));
  check('the file still ends with a newline, as it did before', readFileSync(p, 'utf8').endsWith('\n'));
  check('and its indentation was not reformatted', /\n  "presenterPort"/.test(readFileSync(p, 'utf8')));

  // ⛔ THE AUDIT LINE.
  check('exactly one audit line', logged.length === 1, JSON.stringify(logged));
  check('...naming the actor', logged[0].includes('test:t0675-11'), logged[0]);
  check('...naming the section', logged[0].includes('"rooms"'), logged[0]);
  check('...and NOT the value — the room names are nowhere in it', !logged[0].includes('voicelink'), logged[0]);
  check('...and no secret in the audit line either', !logged[0].includes('KEEP-ME'), logged[0]);

  // Deleting a section is the same contract.
  await writeConfigSection('rooms', undefined, { configPath: p, actor: 'test:t0675-11', log: () => {} });
  const gone = JSON.parse(readFileSync(p, 'utf8'));
  check('undefined REMOVES the section', gone.rooms === undefined);
  check('...and still does not touch the secret', gone.oidc.clientSecret === 'not-a-real-secret-0675-KEEP-ME');

  // The refusals.
  const noActor = await writeConfigSection('rooms', {}, { configPath: p }).then(() => null, (e) => e);
  check('an unattributed write is REFUSED', noActor instanceof RoomConfigError, noActor && noActor.message);
  const noFile = await writeConfigSection('rooms', {}, { actor: 'x', env: { HOME: scratch() }, repoDir: scratch() }).then(() => null, (e) => e);
  check('with no config file anywhere it REFUSES rather than inventing one somewhere nobody chose',
    noFile instanceof RoomConfigError, noFile && noFile.message);
});

/* ── 12 ──────────────────────────────────────────────────────────────────────────────────────── */
test('t0675-12 — two concurrent writes both complete, and NEITHER loses the other\'s change', async () => {
  const dir = scratch();
  const p = writeRealisticConfig(dir);

  // Both are launched before either can finish: whichever takes the lock second must READ the
  // first one's result, not the copy it saw at call time.
  const results = await Promise.all([
    writeConfigSection('rooms', TWO_ROOMS, { configPath: p, actor: 'writer-a', log: () => {} }),
    writeConfigSection('defaultRoom', { plugins: [], record: 'none', voice: false }, { configPath: p, actor: 'writer-b', log: () => {} }),
  ]);
  check('both calls completed', results.length === 2 && results.every((r) => r && r.configPath === p));

  const after = JSON.parse(readFileSync(p, 'utf8'));
  check('⛔ writer A\'s change is present', after.rooms && Object.keys(after.rooms).length === 2, JSON.stringify(after.rooms && Object.keys(after.rooms)));
  check('⛔ writer B\'s change is present TOO — a lost update is the whole failure mode',
    after.defaultRoom && after.defaultRoom.record === 'none', JSON.stringify(after.defaultRoom));
  check('and the secret survived both', after.oidc.clientSecret === 'not-a-real-secret-0675-KEEP-ME');
  check('the lock file was released', !existsSync(p + '.lock'));
  check('no temp file was left behind',
    readdirSync(dir).filter((f) => f.includes('.tmp.')).length === 0, JSON.stringify(readdirSync(dir)));

  // A STALE lock is stolen rather than waited on: a writer killed mid-write must not wedge the
  // file forever. The refusal to steal a FRESH lock is the other half, and is what makes it safe.
  writeFileSync(p + '.lock', '99999');
  const t = new Date(Date.now() - 120_000);
  utimesSync(p + '.lock', t, t);
  const stole = await writeConfigSection('rooms', TWO_ROOMS, { configPath: p, actor: 'writer-c', log: () => {} }).then(() => true, () => false);
  check('a lock older than the stale window is STOLEN — a dead writer must not wedge the file forever', stole);

  writeFileSync(p + '.lock', '99999');   // fresh: not stale
  const refused = await writeConfigSection('rooms', TWO_ROOMS, { configPath: p, actor: 'writer-d', log: () => {}, lock: { timeoutMs: 60 } })
    .then(() => null, (e) => e);
  check('a FRESH lock is respected and the write times out by name, rather than barging in',
    refused instanceof RoomConfigError, refused && refused.message);
  unlinkSync(p + '.lock');
});

/* ── 13 ──────────────────────────────────────────────────────────────────────────────────────── */
test('t0675-13 — a write interrupted BEFORE the rename leaves the original intact and parseable', async () => {
  const dir = scratch();
  const p = writeRealisticConfig(dir);
  const before = readFileSync(p, 'utf8');

  let sawTemp = null;
  const boom = await writeConfigSection('rooms', TWO_ROOMS, {
    configPath: p, actor: 'writer-crash', log: () => {},
    _hooks: {
      beforeRename: ({ tmpPath }) => {
        // The new content is fully on disk, in the same directory, under a different name...
        sawTemp = { path: tmpPath, exists: existsSync(tmpPath), body: readFileSync(tmpPath, 'utf8') };
        throw new Error('simulated crash before rename');
      },
    },
  }).then(() => null, (e) => e);

  check('the write reported failure rather than claiming success', boom instanceof Error, String(boom));
  check('the new content HAD been written to a temp file first (so the rename is the only mutation)',
    sawTemp && sawTemp.exists && sawTemp.body.includes('"rooms"'), JSON.stringify(sawTemp && sawTemp.path));
  check('...in the SAME directory, because rename is only atomic within one filesystem',
    sawTemp && dirname(sawTemp.path) === dirname(p), sawTemp && sawTemp.path);

  const after = readFileSync(p, 'utf8');
  check('⛔ the ORIGINAL FILE IS BYTE-FOR-BYTE UNCHANGED', after === before);
  check('⛔ ...and still parses', JSON.parse(after).oidc.clientSecret === 'not-a-real-secret-0675-KEEP-ME');
  check('⛔ ...and the half-written temp file was cleaned up, not left to confuse the next reader',
    !existsSync(sawTemp.path), sawTemp.path);
  check('⛔ ...and the lock was released even on the failure path', !existsSync(p + '.lock'));

  // A file that does not parse is never overwritten: a rewrite from a partial parse would destroy
  // the one copy of the secret.
  writeFileSync(p, '{ this is not json', { mode: 0o600 });
  const bad = await writeConfigSection('rooms', {}, { configPath: p, actor: 'writer-e', log: () => {} }).then(() => null, (e) => e);
  check('an unparseable config is REFUSED, not rewritten', bad instanceof RoomConfigError, bad && bad.message);
  check('...and left exactly as it was', readFileSync(p, 'utf8') === '{ this is not json');
});
