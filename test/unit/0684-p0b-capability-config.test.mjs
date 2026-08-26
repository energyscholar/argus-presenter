/*
 * Plan 0684 (phase 0b of 0674) — CAPABILITY KEYS COME FROM THE CONFIG FILE, AND THE UNSTATED
 * CASES ARE LOUD.
 *
 * WHAT THIS PHASE ACTUALLY DOES, so a reader is not misled by the word "config": it moves WHERE
 * VALUES COME FROM and it VALIDATES them. It does not change which plugins load, what is recorded,
 * or which port is bound — the existing readers in app/, mcp/ and harness/ are untouched. The
 * inertness proof at the bottom is what holds that claim up, and it is deliberately as strong as
 * `t0675-15`: it runs the real CLI twice and diffs the whole startup banner.
 *
 * THE THREE DEFECTS EACH RUN CLOSES:
 *
 *   R1  Capability keys lived in a systemd unit's `Environment=` lines — one process's capability
 *       set, in a place a second room cannot have its own copy of, invisible to anything reading
 *       the deployment's config file (G13). ⛔ And the existing env readers COERCE: the live
 *       `envVoiceEnabled()` is `/^(1|true|on|yes)$/i.test(...)`, so `=ture`, `=enabled`, or a
 *       stray space reads as FALSE with no error — `61588c0` through a different door.
 *
 *   R2  `PRESENTER_TRANSCRIPT_DIR` defaulted INSIDE the release tree. The pipeline keeps ten
 *       releases and prunes the rest, so turning recording on without setting it WORKS — visibly,
 *       at every moment you might check — and then the prune deletes everything recorded.
 *
 *   R5  `PRESENTER_MCP_HTTP` is process-global. Two room processes both bind it; the second dies
 *       or the tools address whichever won. A collision is a named startup error, never a race.
 *
 * ⭐ EACH GUARD WAS PROVED BY WRITING THE FORBIDDEN CASE — the strict env parser was temporarily
 * replaced with the regex the repo already uses, the record/transcript assertion was removed, and
 * the duplicate-port loop was deleted; the tests below were watched to FAIL before the real
 * implementations were restored. A guard that has only ever been seen to pass is untested.
 *
 * ⚠ ROOM, PLUGIN AND PROFILE NAMES HERE ARE PLACEHOLDERS ON PURPOSE. Two repo-wide guards scan
 * every tracked file for real room/plugin/campaign vocabulary and BOTH WERE ALREADY RED at this
 * programme's baseline (test/BASELINE-0675.md §3), so a new offence here would not move them
 * pass→fail and nobody would ever see it. Keep the fixtures neutral.
 *
 * ⚠ NOTHING HERE BINDS A PORT or touches the real ~/.config. Every case resolves against a
 * throwaway tree via the loader's injectable {env, repoDir}.
 */
import { test, check } from '../../harness/test.mjs';
import {
  RoomConfigError, ROOM_KEYS, ROOM_ENV, roomDefaults,
  normalizeRoomConfig, normalizeRoomsConfig, roomValueSources,
  resolveRoom, roomConfig, roomStartupLine,
  resolveRoomCapabilities, parseCapabilityEnv, CAPABILITY_ENV, CAPABILITY_KEYS,
  ENV_TRUE_TOKENS, ENV_FALSE_TOKENS,
  identityConfig, identityServerOptions, presenterPort, bindHostsConfig, authPolicy,
  DEPLOYMENT_ROUTED_OPTIONS, REPO_ROOT, CONFIG_BASENAME,
} from '../../lib/deployment-config.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSessionLogDir } from '../../lib/session-log.mjs';
import { spawn } from 'node:child_process';

const scratch = () => mkdtempSync(join(tmpdir(), 'ap-0684-'));
const writeConfig = (dir, obj) => { writeFileSync(join(dir, CONFIG_BASENAME), JSON.stringify(obj, null, 2), { mode: 0o600 }); return join(dir, CONFIG_BASENAME); };
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

/* ══ R1 — THE CAPABILITY KEYS ══════════════════════════════════════════════════════════════════ */

/* ── 1 ─────────────────────────────────────────────────────────────────────────────────────────
 * The two keys R1 adds are now VALIDATED SCHEMA, not unknown keys riding through. `profile` and
 * `pluginsDir` were forward-dated in 0675 (t0675-04 names them); this is the phase that lands them. */
test('t0684-01 — profile and pluginsDir are validated room keys, fail-closed when absent', () => {
  check('both are declared in ROOM_KEYS, so later phases enumerate from there, not from a copy',
    ROOM_KEYS.includes('profile') && ROOM_KEYS.includes('pluginsDir'), ROOM_KEYS.join(','));

  const d = roomDefaults();
  check('absent profile ⇒ null — "this room states none", NEVER "inherit the default profile"',
    d.profile === null, JSON.stringify(d.profile));
  check('absent pluginsDir ⇒ null ⇒ the documented in-code fallback, not a sibling room\'s tree',
    d.pluginsDir === null, JSON.stringify(d.pluginsDir));

  const r = normalizeRoomConfig({ profile: '  profile-a  ', pluginsDir: '/srv/deploy/plugins' }, '/test/config.json', 'a');
  check('a stated profile survives, trimmed', r.profile === 'profile-a', JSON.stringify(r.profile));
  check('a stated pluginsDir survives', r.pluginsDir === '/srv/deploy/plugins', JSON.stringify(r.pluginsDir));

  const rooms = normalizeRoomsConfig({
    loud: { profile: 'profile-a', pluginsDir: '/srv/deploy/plugins' },
    bare: { port: 3001 },
  }, '/test/config.json');
  check('⛔ an omitted profile does NOT inherit the sibling\'s (G1)', rooms.bare.profile === null, JSON.stringify(rooms.bare.profile));
  check('⛔ nor does an omitted pluginsDir', rooms.bare.pluginsDir === null, JSON.stringify(rooms.bare.pluginsDir));
});

/* ── 2 ─────────────────────────────────────────────────────────────────────────────────────────
 * ⛔ G3 — A WRONG-TYPED CAPABILITY THROWS BY NAME. The value that must never be accepted quietly
 * is one that reads as "off": `profile:false` and `pluginsDir:false` are the shape of the bug. */
test('t0684-02 — a wrong-typed profile / pluginsDir throws a NAMED error, never a silent falsey', () => {
  for (const [key, bad] of [['profile', false], ['profile', 12], ['profile', '   '], ['pluginsDir', true], ['pluginsDir', 7], ['pluginsDir', '']]) {
    const e = threw(() => normalizeRoomConfig({ [key]: bad }, '/test/config.json', 'a'));
    check(`${key}: ${JSON.stringify(bad)} throws RoomConfigError`, e instanceof RoomConfigError, String(e));
    check(`...and the message names the room AND the key, so nobody bisects a five-room file`,
      e && e.message.includes('"a"') && e.message.includes(key), e && e.message);
  }
  check('...while a legitimate value does NOT throw',
    threw(() => normalizeRoomConfig({ profile: 'profile-a', pluginsDir: '/p' }, '/x', 'a')) === null);
});

/* ── 3 ─────────────────────────────────────────────────────────────────────────────────────────
 * ⭐ THE PRECEDENCE, AND THE SOURCE OF EVERY VALUE. config > env > fail-closed default. */
test('t0684-03 — config beats env beats the fail-closed default, and each value reports its SOURCE', () => {
  const env = { PRESENTER_PROFILE: 'profile-from-env', PRESENTER_VOICE_ENABLED: 'true', PRESENTER_PLUGINS_DIR: '/env/plugins' };

  const stated = { profile: 'profile-from-config', voice: false, record: '30d', pluginsDir: '/config/plugins' };
  const a = resolveRoomCapabilities(normalizeRoomConfig(stated, '/x', 'a'), roomValueSources(stated), env);
  check('config wins over env: profile', a.values.profile === 'profile-from-config', JSON.stringify(a.values.profile));
  check('config wins over env: voice — and note the config says FALSE while the env says true, so a',
    a.values.voice === false, JSON.stringify(a.values.voice));
  check('...precedence bug here would look like the capability working', a.sources.voice === 'config', a.sources.voice);
  check('config wins over env: pluginsDir', a.values.pluginsDir === '/config/plugins');
  for (const k of ['profile', 'voice', 'record', 'pluginsDir']) {
    check(`source of ${k} is reported as config`, a.sources[k] === 'config', a.sources[k]);
  }

  const b = resolveRoomCapabilities(normalizeRoomConfig({}, '/x', 'b'), roomValueSources({}), env);
  check('with nothing in config, ENV supplies profile', b.values.profile === 'profile-from-env', JSON.stringify(b.values.profile));
  check('...and voice', b.values.voice === true, JSON.stringify(b.values.voice));
  check('...and pluginsDir', b.values.pluginsDir === '/env/plugins');
  check('⭐ and each says (env) — "voice true(env)" and "voice true(config)" are the same value and different facts',
    b.sources.profile === 'env' && b.sources.voice === 'env' && b.sources.pluginsDir === 'env', JSON.stringify(b.sources));

  const c = resolveRoomCapabilities(normalizeRoomConfig({}, '/x', 'c'), roomValueSources({}), {});
  check('with neither, every capability is the FAIL-CLOSED value (G1)',
    c.values.profile === null && c.values.voice === false && c.values.record === 'none' && c.values.pluginsDir === null,
    JSON.stringify(c.values));
  check('...and every one of them says so', CAPABILITY_KEYS.every((k) => c.sources[k] === 'default'), JSON.stringify(c.sources));
});

/* ── 4 ─────────────────────────────────────────────────────────────────────────────────────────
 * ⛔⛔ THE ONE THAT MATTERS. An unrecognised boolean token is a NAMED STARTUP ERROR — it does NOT
 * read as "off". The repo's own `envVoiceEnabled()` is `/^(1|true|on|yes)$/i.test(...)`, and this
 * test exists because that regex answers FALSE to `ture`, to `enabled`, and to `"true "` with the
 * trailing space a unit file so easily carries. A capability that silently reads as false, with a
 * correct-looking config, is `61588c0`: one full debugging session, no error anywhere. */
test('t0684-04 — an UNRECOGNISED PRESENTER_VOICE_ENABLED token THROWS; it is never read as "off"', () => {
  for (const bad of ['ture', 'enabled-please', 'maybe', '2', 'TRUE!', 'sí']) {
    const e = threw(() => parseCapabilityEnv('voice', bad));
    check(`${JSON.stringify(bad)} throws rather than reading as false`, e instanceof RoomConfigError, String(e));
    check('...and the error names the variable, so the unit file is findable',
      e && e.message.includes('PRESENTER_VOICE_ENABLED'), e && e.message);
  }
  for (const t of ENV_TRUE_TOKENS) check(`${JSON.stringify(t)} ⇒ true`, parseCapabilityEnv('voice', t) === true, t);
  for (const t of ENV_FALSE_TOKENS) check(`${JSON.stringify(t)} ⇒ false`, parseCapabilityEnv('voice', t) === false, t);
  check('case and surrounding whitespace do not decide a capability', parseCapabilityEnv('voice', '  TRUE  ') === true);
  check('unset ⇒ undefined ⇒ fall through to the default, which is NOT the same as false-from-env',
    parseCapabilityEnv('voice', undefined) === undefined && parseCapabilityEnv('voice', '   ') === undefined);

  /* ⭐ AND THE CONTRAST, spelled out so the difference is testable rather than asserted in prose:
   * the coercing regex the repo already ships would call every one of those tokens "off". */
  const coercing = (v) => /^(1|true|on|yes)$/i.test(String(v || '').trim());
  check('the pre-existing coercing reader would have said "off" to every one of them, silently',
    ['ture', 'enabled-please', 'maybe', '2', 'TRUE!'].every((v) => coercing(v) === false));
});

/* ── 5 ─────────────────────────────────────────────────────────────────────────────────────────
 * ⛔ `record` HAS NO ENV FALLBACK, ON PURPOSE. It is a RETENTION POLICY, not a switch. The nearest
 * existing variable is a boolean, and mapping a boolean onto a duration invents a retention nobody
 * wrote down — which is how a transcript outlives the consent that permitted it. */
test('t0684-05 — recording cannot be turned on by an environment variable: record is config-only', () => {
  check('record is a capability this layer answers for', CAPABILITY_KEYS.includes('record'));
  check('⛔ …and it has NO entry in the env-fallback map', !('record' in CAPABILITY_ENV), JSON.stringify(Object.keys(CAPABILITY_ENV)));

  const noisy = {
    PRESENTER_RECORD: '30d', PRESENTER_TRANSCRIPT_PERSIST: '1', PRESENTER_TRANSCRIPT_DIR: '/srv/state/t',
    PRESENTER_VOICE_ENABLED: '1',
  };
  const c = resolveRoomCapabilities(normalizeRoomConfig({}, '/x', 'a'), roomValueSources({}), noisy);
  check('with every plausible env var set, recording is still "none"', c.values.record === 'none', c.values.record);
  check('...and it says (default), not (env)', c.sources.record === 'default', c.sources.record);
  check('...while voice, which DOES have a fallback, moved — so the null result above is not vacuous',
    c.values.voice === true && c.sources.voice === 'env', JSON.stringify([c.values.voice, c.sources.voice]));

  const e = threw(() => parseCapabilityEnv('record', '30d'));
  check('asking the parser for it directly is refused by name, not answered with a guess',
    e instanceof RoomConfigError, String(e));
});

/* ── 6 ─────────────────────────────────────────────────────────────────────────────────────────
 * ⛔⛔ G2 AGAIN, one layer up. A room carrying keys this file has never heard of must arrive intact
 * THROUGH THE CAPABILITY RESOLVER too — the resolver reads a declared key table, it does not
 * reconstruct a room. */
test('t0684-06 — the capability layer never rebuilds the room: unknown keys survive resolution', () => {
  const raw = {
    port: 3001, profile: 'profile-a', voice: true, pluginsDir: '/p',
    somethingNobodyHasInventedYet: { deep: ['a', 1, null], flag: false },
    aFutureCapability: 'kept',
  };
  const cfg = { rooms: { a: raw }, configPath: '/test/config.json' };
  const r = resolveRoom({ [ROOM_ENV]: 'a' }, cfg);
  check('a nested unknown value survives whole',
    JSON.stringify(r.room.somethingNobodyHasInventedYet) === '{"deep":["a",1,null],"flag":false}',
    JSON.stringify(r.room.somethingNobodyHasInventedYet));
  check('...and a flat one', r.room.aFutureCapability === 'kept');
  check('...and the resolved capabilities are alongside it, not instead of it',
    r.capabilities.profile === 'profile-a' && r.capabilities.voice === true, JSON.stringify(r.capabilities));
  check('the capability view answers for EVERY declared capability key — never a partial object',
    CAPABILITY_KEYS.every((k) => Object.prototype.hasOwnProperty.call(r.capabilities, k)
      && Object.prototype.hasOwnProperty.call(r.capabilitySources, k)), JSON.stringify(r.capabilities));
});

/* ── 7 ─────────────────────────────────────────────────────────────────────────────────────────
 * ⭐ G12 — THE STARTUP LINE REPORTS THE NEW VALUES, WITH THEIR SOURCE, AND STILL LEAKS NOTHING. */
test('t0684-07 — the startup line reports profile and pluginsDir with their source, and leaks nothing', () => {
  const SECRET = 'not-a-real-secret-0684';
  const CLIENT_ID = 'test-client-id-0684.example.invalid';
  const ALLOWED = 'someone@example.invalid';
  const cfg = {
    rooms: { a: { port: 3001, profile: 'profile-a' } },
    oidc: { clientId: CLIENT_ID, clientSecret: SECRET },
    allowlist: { [ALLOWED]: { role: 'presenter', voice: true } },
    configPath: '/test/config.json',
  };
  const line = roomStartupLine(resolveRoom({ [ROOM_ENV]: 'a', PRESENTER_PLUGINS_DIR: '/env/plugins', PRESENTER_VOICE_ENABLED: 'yes' }, cfg));

  check('reports the profile BY NAME, with its source', /profile profile-a\(config\)/.test(line), line);
  check('reports the pluginsDir, and says it came from the ENVIRONMENT — the third answer this run adds',
    /pluginsDir \/env\/plugins\(env\)/.test(line), line);
  check('⭐ an env-supplied capability is marked (env), never (config) and never (default)',
    /voice true\(env\)/.test(line), line);
  check('an unstated one is still marked (default)', /record none\(default\)/.test(line), line);

  check('⛔ NO client secret', !line.includes(SECRET), line);
  check('⛔ NO client id', !line.includes(CLIENT_ID), line);
  check('⛔ NO allowlist entry', !line.includes(ALLOWED) && !line.includes('example.invalid'), line);

  const bare = roomStartupLine({});
  check('called with nothing at all it still renders rather than throwing at startup',
    typeof bare === 'string' && bare.includes('profile unset(default)'), bare);
});

/* ══ R2 — RECORDING MUST SAY WHERE, AND IT MAY NOT BE THE RELEASE TREE ═════════════════════════ */

/* ── 8 ─────────────────────────────────────────────────────────────────────────────────────────
 * ⛔⛔ THE DATA-LOSS DEFECT. `PRESENTER_TRANSCRIPT_DIR` defaults inside the release tree; the
 * pipeline keeps ten releases and prunes the rest. A deployment that records without naming a
 * destination therefore WORKS — visibly, at every moment a human might check — and is then deleted
 * by a later prune. There is no point at which it looks broken, which is why a warning is not
 * enough and this is a refusal. */
test('t0684-08 — a room that RECORDS and names no transcriptDir is a NAMED STARTUP ERROR', () => {
  const cfg = { rooms: { a: { port: 3001, record: '30d' } }, configPath: '/test/config.json' };

  const e = threw(() => resolveRoom({ [ROOM_ENV]: 'a' }, cfg));
  check('it throws', e instanceof RoomConfigError, String(e));
  check('...naming the room', e && e.message.includes('"a"'), e && e.message);
  check('...naming the retention it was asked for', e && e.message.includes('30d'), e && e.message);
  check('...and saying WHY, in the terms that matter — the release tree and the prune',
    e && /release tree/.test(e.message) && /prune/.test(e.message), e && e.message);

  const dflt = threw(() => resolveRoom({}, { defaultRoom: { record: '7d' }, configPath: '/test/config.json' }));
  check('⛔ and the defaultRoom is under the same rule — it is where an unset PRESENTER_ROOM lands',
    dflt instanceof RoomConfigError, String(dflt));

  // …and end-to-end through the real loader, so this is a STARTUP error and not a library nicety.
  const home = scratch(), repo = scratch();
  writeConfig(repo, { presenterPort: 0, rooms: { a: { port: 3001, record: '30d' } } });
  const live = threw(() => roomConfig({ env: { HOME: home, [ROOM_ENV]: 'a' }, repoDir: repo }));
  check('the real loader refuses it too', live instanceof RoomConfigError, String(live));
});

/* ── 9 ─────────────────────────────────────────────────────────────────────────────────────────
 * The requirement is satisfiable from EITHER source — the config file, or R1's documented env
 * fallback. It is a requirement that the destination be KNOWN, not that it be written in one place. */
test('t0684-09 — the requirement is met by the config OR by $PRESENTER_TRANSCRIPT_DIR, and says which', () => {
  const cfg = { rooms: { a: { port: 3001, record: '30d', transcriptDir: '/srv/state/a/transcripts' } }, configPath: '/test/config.json' };
  const a = resolveRoom({ [ROOM_ENV]: 'a' }, cfg);
  check('a config-stated destination satisfies it', a.capabilities.transcriptDir === '/srv/state/a/transcripts');
  check('...and reports (config)', a.capabilitySources.transcriptDir === 'config', a.capabilitySources.transcriptDir);

  const envCfg = { rooms: { a: { port: 3001, record: '30d' } }, configPath: '/test/config.json' };
  const b = resolveRoom({ [ROOM_ENV]: 'a', PRESENTER_TRANSCRIPT_DIR: '/srv/state/from-env' }, envCfg);
  check('the environment fallback satisfies it too', b.capabilities.transcriptDir === '/srv/state/from-env');
  check('...and is reported as (env), so nobody reads it as a choice the config file made',
    b.capabilitySources.transcriptDir === 'env', b.capabilitySources.transcriptDir);
  check('the startup line carries it', /transcriptDir \/srv\/state\/from-env\(env\)/.test(roomStartupLine(b)), roomStartupLine(b));

  const none = resolveRoom({ [ROOM_ENV]: 'a' }, { rooms: { a: { port: 3001 } }, configPath: '/test/config.json' });
  check('⛔ and a room that does NOT record is not asked for one — the check is conditional, not blanket',
    none.capabilities.record === 'none' && none.capabilities.transcriptDir === null, JSON.stringify(none.capabilities));
});

/* ── 10 ────────────────────────────────────────────────────────────────────────────────────────
 * ⛔ A DESTINATION INSIDE THE RELEASE TREE IS REFUSED, and so is a relative path — which resolves
 * against the process's working directory, i.e. the release tree again. Satisfying the requirement
 * by naming the very place the defect lives would be a rule that reads as enforced and is not. */
test('t0684-10 — a transcriptDir inside the release tree, or a relative one, is REFUSED', () => {
  for (const bad of [join(REPO_ROOT, '.transcripts'), join(REPO_ROOT, 'a', 'b'), REPO_ROOT]) {
    const e = threw(() => normalizeRoomConfig({ record: '30d', transcriptDir: bad }, '/test/config.json', 'a'));
    check(`${bad} is refused`, e instanceof RoomConfigError, String(e));
    check('...and the message says it is the release tree, not just "invalid"',
      e && /release tree/.test(e.message), e && e.message);
  }
  for (const rel of ['.transcripts', 'var/transcripts', './t']) {
    const e = threw(() => normalizeRoomConfig({ transcriptDir: rel }, '/test/config.json', 'a'));
    check(`relative ${JSON.stringify(rel)} is refused`, e instanceof RoomConfigError, String(e));
    check('...naming the working-directory trap', e && /ABSOLUTE/.test(e.message), e && e.message);
  }
  check('an absolute path outside the tree is accepted, so the rule is not simply "refuse everything"',
    normalizeRoomConfig({ transcriptDir: '/srv/state/x' }, '/x', 'a').transcriptDir === '/srv/state/x');

  /* ⛔ AND THE ENV FALLBACK IS HELD TO THE SAME RULE. A rule the config file obeys and the
   * environment variable does not is a rule with a documented way around it. */
  const e = threw(() => parseCapabilityEnv('transcriptDir', join(REPO_ROOT, '.transcripts')));
  check('$PRESENTER_TRANSCRIPT_DIR pointing into the release tree is refused too',
    e instanceof RoomConfigError, String(e));
  check('...and names the variable', e && e.message.includes('PRESENTER_TRANSCRIPT_DIR'), e && e.message);

  /* ⚠ …and pluginsDir is DELIBERATELY NOT under this rule: plugins are CODE, they ship inside the
   * release, and `/srv/argus/current/plugins` is the correct value on the live box. The
   * prohibition is about durable DATA, which a prune destroys; code a prune merely replaces. */
  check('pluginsDir inside the tree is ACCEPTED — the asymmetry is deliberate, not an oversight',
    normalizeRoomConfig({ pluginsDir: join(REPO_ROOT, 'plugins') }, '/x', 'a').pluginsDir === join(REPO_ROOT, 'plugins'));
});

/* ══ R5 — THE MCP CONTROL PORT IS A PROPERTY OF THE ROOM ══════════════════════════════════════ */

/* ── 11 ────────────────────────────────────────────────────────────────────────────────────────
 * ⛔⛔ TWO ROOMS ON ONE MCP PORT IS A NAMED STARTUP ERROR, NEVER LAST-WRITER-WINS. A racing bind
 * does not produce a wrong VALUE a human can read back — it produces a nondeterministic outcome:
 * one unit dead in a way that looks like a crash, or an operator's tools quietly attached to the
 * other room. Only a config-time check can see it, because at bind time the answer depends on
 * which process happened to start first. */
test('t0684-11 — two rooms claiming ONE mcpPort is a named startup error, not last-writer-wins', () => {
  const e = threw(() => normalizeRoomsConfig({
    a: { port: 3000, mcpPort: 3100 },
    b: { port: 3001, mcpPort: 3100 },
  }, '/test/config.json'));
  check('it throws', e instanceof RoomConfigError, String(e));
  check('...and names BOTH claimants, so the fix does not need a bisect',
    e && e.message.includes('"a"') && e.message.includes('"b"'), e && e.message);
  check('...and the port', e && e.message.includes('3100'), e && e.message);
  check('...and refuses in those words, so nobody reads it as a merge rule',
    e && /last one written win/i.test(e.message), e && e.message);

  check('distinct MCP ports are fine',
    threw(() => normalizeRoomsConfig({ a: { port: 3000, mcpPort: 3100 }, b: { port: 3001, mcpPort: 3101 } }, '/x')) === null);
  check('...and rooms that declare NO mcpPort do not collide with each other on "null"',
    threw(() => normalizeRoomsConfig({ a: { port: 3000 }, b: { port: 3001 }, c: {} }, '/x')) === null);

  /* ⛔ One process cannot bind one port twice either. */
  const self = threw(() => normalizeRoomConfig({ port: 3001, mcpPort: 3001 }, '/test/config.json', 'a'));
  check('a room whose mcpPort IS its own http port is refused', self instanceof RoomConfigError, String(self));
  check('...naming the room and the number', self && self.message.includes('"a"') && self.message.includes('3001'), self && self.message);

  // …and through the real loader, so this is a STARTUP error.
  const home = scratch(), repo = scratch();
  writeConfig(repo, { presenterPort: 0, rooms: { a: { port: 3000, mcpPort: 3100 }, b: { port: 3001, mcpPort: 3100 } } });
  const live = threw(() => roomConfig({ env: { HOME: home, [ROOM_ENV]: 'a' }, repoDir: repo }));
  check('the real loader refuses to start', live instanceof RoomConfigError, String(live));
});

/* ── 12 ────────────────────────────────────────────────────────────────────────────────────────
 * The env fallback keeps `PRESENTER_MCP_HTTP`'s EXISTING meaning (0/unset ⇒ no HTTP MCP) rather
 * than inventing a second interpretation of a variable already set on the live box — but it stops
 * coercing. Today `Number('31OO')` is NaN, `NaN > 0` is false, and the control port simply never
 * opens with nothing anywhere saying why. */
test('t0684-12 — mcpPort resolves config > env > unset, and a typo THROWS instead of silently not binding', () => {
  check('a real port from the environment', parseCapabilityEnv('mcpPort', '3100') === 3100);
  check('0 keeps its existing meaning — "no HTTP MCP" — and is NOT an error',
    parseCapabilityEnv('mcpPort', '0') === undefined);
  check('unset likewise', parseCapabilityEnv('mcpPort', undefined) === undefined);
  for (const bad of ['31OO', 'yes', '70000', '-1', '3100.5']) {
    const e = threw(() => parseCapabilityEnv('mcpPort', bad));
    check(`${JSON.stringify(bad)} throws rather than quietly not binding`, e instanceof RoomConfigError, String(e));
    check('...and names the variable', e && e.message.includes('PRESENTER_MCP_HTTP'), e && e.message);
  }
  const coercing = (v) => Number(v || 0);
  check('the pre-existing coercing reader answers NaN to the typo, and NaN > 0 is false — the port just never opens',
    Number.isNaN(coercing('31OO')) && !(coercing('31OO') > 0));

  const cfg = { rooms: { a: { port: 3001, mcpPort: 3101 } }, configPath: '/test/config.json' };
  const a = resolveRoom({ [ROOM_ENV]: 'a', PRESENTER_MCP_HTTP: '3100' }, cfg);
  check('⛔ the ROOM wins over the process-global variable — that is the whole point of R5',
    a.capabilities.mcpPort === 3101, JSON.stringify(a.capabilities.mcpPort));
  check('...and says (config)', a.capabilitySources.mcpPort === 'config', a.capabilitySources.mcpPort);

  const b = resolveRoom({ [ROOM_ENV]: 'a', PRESENTER_MCP_HTTP: '3100' }, { rooms: { a: { port: 3001 } }, configPath: '/x' });
  check('a room that states none falls back to the variable, reported as (env)',
    b.capabilities.mcpPort === 3100 && b.capabilitySources.mcpPort === 'env', JSON.stringify(b.capabilitySources));
  check('the startup line carries it', /mcpPort 3100\(env\)/.test(roomStartupLine(b)), roomStartupLine(b));
});

/* ══ THE INERTNESS PROOF ═══════════════════════════════════════════════════════════════════════
 * ⛔⛔ AS STRONG AS `t0675-15`, AND FOR THE SAME REASON. This phase's whole claim is that it moves
 * where values come from without changing what happens, and the ordinary green check cannot see
 * the difference. So: run the REAL CLI twice — once against a config declaring a room that states
 * every capability this run adds, once against a config with no room model at all — and require
 * the entire startup banner to be identical apart from the room line itself.
 *
 * ⚠ THE PROBE ROOM MUST STATE EVERY CAPABILITY THIS TEST CLAIMS TO CHECK. 0675 recorded catching
 * exactly this: its first probe room's `record` was already "none", so the recording half of the
 * assertion could not have failed. This one states a profile, a plugins dir, a transcript dir, an
 * MCP port, a plugin, a retention and voice — all different from the defaults.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */
test('t0684-13 — INERTNESS: a room stating EVERY new capability changes no port, no plugin set, no recording', async () => {
  const home = scratch();
  const withRooms = scratch(), without = scratch();
  const logDir = scratch(), stateDir = scratch();
  const base = { presenterPort: 0, sessionLogDir: join(logDir, 'logs') };
  const PROBE = {
    probe: {
      port: 3001, bindHosts: ['127.0.0.1'], plugins: ['ops-console'], record: '30d', voice: true, label: 'probe',
      profile: 'profile-a', pluginsDir: '/srv/deploy/other-plugins',
      transcriptDir: join(stateDir, 'transcripts'), mcpPort: 3101,
    },
  };
  writeConfig(withRooms, { ...base, rooms: PROBE, defaultRoom: { plugins: [], record: 'none', voice: false } });
  writeConfig(without, base);

  const envA = { HOME: home, [ROOM_ENV]: 'probe' };
  const envB = { HOME: home };

  /* ── (a) every option the launch paths actually route into createServer ────────────────────── */
  const optsA = identityServerOptions(identityConfig({ env: envA, repoDir: withRooms }));
  const optsB = identityServerOptions(identityConfig({ env: envB, repoDir: without }));
  check('the routed identity options are identical', JSON.stringify(optsA) === JSON.stringify(optsB), JSON.stringify([optsA, optsB]));
  check('⛔ and not one capability this run adds rode in with them',
    !('profile' in optsA) && !('pluginsDir' in optsA) && !('transcriptDir' in optsA) && !('mcpPort' in optsA)
      && !('rooms' in optsA) && !('plugins' in optsA) && !('record' in optsA) && !('voice' in optsA),
    JSON.stringify(Object.keys(optsA)));
  check('⛔ nor did any of them become a deployment-routed option',
    ['profile', 'pluginsDir', 'transcriptDir', 'mcpPort', 'rooms', 'defaultRoom'].every((k) => !DEPLOYMENT_ROUTED_OPTIONS.includes(k)),
    JSON.stringify(DEPLOYMENT_ROUTED_OPTIONS));
  check('the resolved PORT is identical',
    presenterPort({ env: envA, repoDir: withRooms }) === presenterPort({ env: envB, repoDir: without }));
  check('the resolved BIND HOSTS are identical',
    JSON.stringify(bindHostsConfig({ env: envA, repoDir: withRooms })) === JSON.stringify(bindHostsConfig({ env: envB, repoDir: without })));
  check('the resolved AUTH POLICY is identical',
    JSON.stringify(authPolicy({ env: envA, repoDir: withRooms })) === JSON.stringify(authPolicy({ env: envB, repoDir: without })));
  check('the resolved SESSION LOG target is identical',
    resolveSessionLogDir({ env: envA, repoDir: withRooms }).sessionLogDir === resolveSessionLogDir({ env: envB, repoDir: without }).sessionLogDir);

  /* ⚠ …and this is only meaningful because the room WAS read. A schema nobody parses is trivially
   * inert and proves nothing. */
  const resolved = roomConfig({ env: envA, repoDir: withRooms });
  check('the room really resolved, and it states EVERY capability this test claims to check',
    resolved.name === 'probe' && resolved.capabilities.profile === 'profile-a'
      && resolved.capabilities.pluginsDir === '/srv/deploy/other-plugins'
      && resolved.capabilities.mcpPort === 3101 && resolved.capabilities.record === '30d'
      && resolved.capabilities.voice === true && !!resolved.capabilities.transcriptDir,
    JSON.stringify(resolved.capabilities));

  /* ── (b) the CLI self-run's own observable startup, end to end ─────────────────────────────── */
  const runCli = (env) => new Promise((res) => {
    const child = spawn(process.execPath, ['app/server.mjs'], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH, HOME: env.HOME, ...(env[ROOM_ENV] ? { [ROOM_ENV]: env[ROOM_ENV] } : {}),
             PRESENTER_CONFIG_FILE: join(env._dir, CONFIG_BASENAME) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const done = (why) => { try { child.kill('SIGKILL'); } catch {} res({ out, why }); };
    const timer = setTimeout(() => done('timeout'), 20_000);
    child.stdout.on('data', (d) => { out += d; if (/^ +session log:/m.test(out)) { clearTimeout(timer); done('up'); } });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); done('spawn-error'); });
  });

  const a = await runCli({ ...envA, _dir: withRooms });
  const b = await runCli({ ...envB, _dir: without });
  check('both CLI runs came up', a.why === 'up' && b.why === 'up', JSON.stringify([a.why, b.why, a.out.slice(-400)]));

  const portOf = (o) => (o.match(/display : http:\/\/127\.0\.0\.1:(\d+)\//) || [])[1];
  check('⛔ the room declares port 3001 and mcpPort 3101, and the process bound NEITHER',
    portOf(a.out) !== '3001' && portOf(a.out) !== '3101' && !/3101/.test(a.out.replace(/^ +room:.*$/m, '')),
    portOf(a.out));
  check('both bound an OS-assigned port, exactly as the shared presenterPort:0 asks',
    !!portOf(a.out) && !!portOf(b.out), JSON.stringify([portOf(a.out), portOf(b.out)]));

  const logLine = (o) => (o.match(/^ +session log:.*$/m) || [''])[0].replace(/[^ ]*\/logs\/[^ ]*/, '<id>');
  check('⛔ the recording state is identical, though one config declares record "30d" AND a transcript dir',
    logLine(a.out).replace(/\d+/g, '#') === logLine(b.out).replace(/\d+/g, '#'),
    JSON.stringify([logLine(a.out), logLine(b.out)]));

  const banner = (o) => o.split('\n').filter((l) => !/^ +room:/.test(l))
    .map((l) => l
      .replace(/:\d{2,5}\//g, ':<port>/')
      .replace(/\/logs\/[^ ]*/, '/logs/<id>')
      .replace(/\/tmp\/ap-0684-[^/ ]+/g, '<scratch>')).join('\n');
  check('⛔ and every other line of the startup banner is identical',
    banner(a.out) === banner(b.out), JSON.stringify([banner(a.out), banner(b.out)]));

  check('...while the ROOM line differs, and names every new capability WITH its source',
    /room: probe \(env\)/.test(a.out) && /profile profile-a\(config\)/.test(a.out)
      && /pluginsDir \/srv\/deploy\/other-plugins\(config\)/.test(a.out) && /mcpPort 3101\(config\)/.test(a.out)
      && /PRESENTER_ROOM unset/.test(b.out),
    JSON.stringify([(a.out.match(/^ +room:.*$/m) || [])[0], (b.out.match(/^ +room:.*$/m) || [])[0]]));

  check('⛔ and the line still says it is REPORTING, not describing what loaded',
    /PHASE 0: REPORTED ONLY/.test(a.out), (a.out.match(/^ +room:.*$/m) || [])[0]);
});
