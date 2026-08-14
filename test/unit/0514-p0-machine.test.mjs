/*
 * Plan 0514 PHASE 0 — the plugin server hook and the ship state machine.
 *
 * The machine is FIRST, not last, and that ordering is the point (§12, red-team M5): station
 * occupancy LIVES IN THE MACHINE (§13.2), so until the machine exists there is nowhere to put it
 * and every earlier draft grew an interim core map that then had to be torn out again.
 *
 * These tests import the machine from the INSTALLED plugin. That is deliberate: the engine lives
 * in the system plugin by Bruce's ruling (§4.1), and a test that could not see it would be
 * testing a different architecture from the one that ships.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { ROOT, REAL_PLUGINS, makePluginsDir, withPlugins, stationManifest, wait, connect, last } from './_0514-fixtures.mjs';

const MACHINE_FILE = join(REAL_PLUGINS, 'starship-ops', 'ship-machine.mjs');
const haveMachine = existsSync(MACHINE_FILE);
const loadMachineModule = () => import(pathToFileURL(MACHINE_FILE).href);

// A bare interpreter over the shipped chart, with no store and no occupancy — the pure engine.
async function bareMachine(guards = {}) {
  const mod = await loadMachineModule();
  return mod.createShipMachine(mod.loadChart(), { guards });
}

/*
 * ⭐ 0575 P1a — THE SHIP NAMESPACE IS KEYED (`ships/<shipId>/…`), NOT THE SINGLETON `ship/…`.
 *
 * ⛔ The id is ASKED FOR, never written down here. Two reasons, and either alone decides it:
 * this repo is PUBLIC and t0531 fails any test that spells a campaign value; and a literal here
 * would be a second source of truth for a key the plugin already owns — exactly the drift the
 * rename was done to stop. A deployment with no gitignored instance file answers `unknown`, and
 * every assertion below still means what it says.
 */
async function shipKey() {
  const mod = await loadMachineModule();
  const id = mod.loadShipInstance().shipId || mod.UNCOMMISSIONED_SHIP_ID;
  return { id, ns: mod.shipNs(id) };
}

test('t0514-00 — the system plugin is installed (every Phase 0 test below needs it)', () => {
  // 0532 P0: the plugin was mined into the content repo. Install it from
  // repertory/systems/traveller/plugins/ — the old private source repo is being retired, and
  // t0532-01 now fails if anything here points back at it.
  expect(haveMachine, 'plugins/starship-ops/ship-machine.mjs exists — install the plugin from repertory/systems/traveller/plugins/ if this fails', MACHINE_FILE);
});

test('t0514-23 — orthogonal regions advance INDEPENDENTLY: an alert event does not disturb nav', async () => {
  const m = await bareMachine();
  const before = m.state();
  // ⭐ 0575 P1c — alert now starts at `unknown`, NOT `normal`. A hull nobody has given an order
  // must not assert Condition Green; it has simply never reported.
  expect(before.alert === 'unknown' && before.nav === 'docked' && before.power === 'standard', 'all three regions start at their initial state', JSON.stringify(before));
  const res = m.send('battle-stations');
  const after = m.state();
  expect(res.changed && after.alert === 'action', 'the alert region moved', JSON.stringify(res));
  // This is the whole reason a statechart was chosen over a flat FSM: concurrency without a
  // cross-product of every combination.
  expect(after.nav === before.nav, 'nav is UNTOUCHED by an alert event', after.nav);
  expect(after.power === before.power, 'power is UNTOUCHED by an alert event', after.power);
});

test('t0514-24 — a nested transition resolves to the correct LEAF', async () => {
  const m = await bareMachine();
  m.send('undock');
  expect(m.state().nav === 'in-system', 'undock: docked -> in-system', m.state().nav);
  m.send('jump');
  // The chart's target is the COMPOSITE `in-jump`; entering it must descend its `initial` chain,
  // not park the machine on a non-leaf.
  expect(m.state().nav === 'in-jump.transit', 'jump enters the composite and lands on its initial leaf', m.state().nav);
  m.send('jump-exit');
  expect(m.state().nav === 'in-jump.verify-pending', 'a leaf-to-leaf transition inside the composite', m.state().nav);
});

test('t0514-25 — a guard BLOCKS a transition and the machine stays exactly where it was', async () => {
  const m = await bareMachine({ astrogatorAboard: () => false });
  m.send('undock'); m.send('jump'); m.send('jump-exit');
  const before = m.state().nav;
  const res = m.send('verify-position');
  expect(!res.changed, 'the guarded transition did not fire', JSON.stringify(res));
  expect(res.blocked === 'astrogatorAboard', 'and it reports WHICH guard refused', JSON.stringify(res));
  expect(m.state().nav === before, 'the machine stayed put', m.state().nav);

  // The same event with the guard satisfied DOES fire — otherwise the test above proves nothing.
  const ok = await bareMachine({ astrogatorAboard: () => true });
  ok.send('undock'); ok.send('jump'); ok.send('jump-exit');
  const res2 = ok.send('verify-position');
  expect(res2.changed && ok.state().nav === 'in-system', 'with the guard satisfied it fires', JSON.stringify(res2));
});

test('t0514-26 — an unknown event is IGNORED, never thrown', async () => {
  const m = await bareMachine();
  const before = JSON.stringify(m.state());
  let threw = false, res = null;
  try { res = m.send('scuttle-the-whole-thing', { preset: 'nonsense' }); } catch (e) { threw = true; }
  expect(!threw, 'an unknown event does not throw — a GM typo must not stop a session');
  expect(res && res.changed === false, 'and nothing moved', JSON.stringify(res));
  expect(JSON.stringify(m.state()) === before, 'state is byte-identical afterwards');
  // An event-supplied target that names no real state is equally inert (untrusted input).
  const bogus = m.send('set-power', { preset: '../../etc/passwd' });
  expect(!bogus.changed && m.state().power === 'standard', 'a bogus $event target is refused', JSON.stringify(bogus));
  const good = m.send('set-power', { preset: 'combat' });
  expect(good.changed && m.state().power === 'combat', 'a valid $event target resolves', JSON.stringify(good));
});

test('t0514-27 — each region publishes its active state to the store at ships/<shipId>/<region>', async () => {
  const { ns } = await shipKey();
  const server = await createServer({ port: 0 });
  try {
    // ⭐ 0575 P1c / t0575-1c — seeded at `unknown`, and explicitly NOT at `normal`: a board that
    // reads GREEN before anyone has said so is the ship asserting a condition it never reported.
    expect(server.store.get(`${ns}/alert`) === 'unknown', `${ns}/alert seeded at load`, String(server.store.get(`${ns}/alert`)));
    expect(server.store.get(`${ns}/alert`) !== 'normal', 'and a freshly booted hull does NOT claim GREEN', String(server.store.get(`${ns}/alert`)));
    expect(server.store.get(`${ns}/nav`) === 'docked', `${ns}/nav seeded at load`, String(server.store.get(`${ns}/nav`)));
    await server.callPluginTool('ship_event', { event: 'battle-stations' });
    expect(server.store.get(`${ns}/alert`) === 'action', 'a transition writes through to the store', String(server.store.get(`${ns}/alert`)));
    expect(server.store.get(`${ns}/nav`) === 'docked', 'and only its own region', String(server.store.get(`${ns}/nav`)));
    // ⛔ 0575 P1a — AND THE SINGLETON IS GONE. Without this the rename could half-happen and every
    // assertion above would still pass while a stale `ship/alert` sat beside it, unread and wrong.
    expect(server.store.get('ship/alert') === undefined, 'nothing is published at the old singleton path ship/alert',
      String(server.store.get('ship/alert')));
  } finally { await server.close(); }
});

/*
 * ── Plan 0531 P1 — the CAMPAIGN-vocabulary guard ──────────────────────────────────────────────
 *
 * `argus-presenter` is PUBLIC and holds the presenter SOFTWARE. The admission test is Bruce's:
 * "nothing checked in that doesn't fly in a corporate training app." Domain content — a specific
 * campaign, its sessions, its players — lives in the PRIVATE `repertory` repo.
 *
 * t0514-28 below was named "CORE carries no machine and no domain vocabulary" and was cited as
 * proof of exactly that. It never was: its token list is MACHINE vocabulary, and it scanned five
 * directories. It has never looked for `s17` or `s15` (those are GENERIC_TOKENS below), and it has
 * never looked outside `app harness mcp lib components`.
 *
 * This test is the missing half. It is deliberately a SEPARATE test rather than a widening of
 * t0514-28, because `expect` throws: folding the campaign scan into t0514-28 would abort before
 * its (b) behaviour check — "a deployment with no plugins at all is a working Presenter" — and
 * that check would silently stop running for the whole of plan 0531. Coverage must not be traded
 * for tidiness. G1 should gate on BOTH tests.
 */

/*
 * ── 0532 P7 — THE TOKEN SET IS STORED AS SALTED SHA-256 HASHES, NOT PLAINTEXT ─────────────────
 *
 * Until P7 this guard was the single largest privacy exposure in a PUBLIC repo, because the only
 * way it knew what to hunt for was to publish it: the handles it exists to keep out were listed
 * here, in the clear, in the current tree. Purging them from history while the tree still carried
 * the list would have been theatre. So the scan now compares HASHES. Every capability the guard
 * had it still has; the handles are simply no longer written down.
 *
 * TO ADD A HANDLE — one shell command. The salt is the literal prefix `guard-v1:`:
 *
 *     printf '%s' 'guard-v1:some-handle' | sha256sum
 *
 * Paste the hex into NAME_HASHES. Rules for the plaintext you feed it:
 *   - LOWERCASE it. The scan lowercases each file first, which is where case-insensitivity went.
 *   - Hash the LITERAL text to be caught, punctuation and internal single spaces included
 *     (`some name`, `some-name`). It is matched whole and bounded by non-word characters — the
 *     same boundary `grep -w` used to apply.
 *   - A token with an optional or alternative spelling gets ONE HASH PER SPELLING.
 *   - To stand in for exactly one arbitrary character (what `.` did in the old regexes), put
 *     U+0001 (`ANY_CHAR` below) at that position before hashing.
 *
 * The salt is public and these are short words, so this is not secrecy. It is the whole of the
 * difference between a handle that is greppable and indexable in a public repo and one that is
 * not present in it at all.
 */
const HASH_SALT = 'guard-v1:';
const ANY_CHAR = String.fromCharCode(1);  // U+0001 — never a real separator, so it is safe as a wildcard
const digest = (s) => createHash('sha256').update(HASH_SALT + s, 'utf8').digest('hex');

/*
 * GENERIC vocabulary, deliberately left in PLAINTEXT. Session ids, the published name of a game
 * system, ordinary setting nouns and an obvious seat placeholder are nobody's handle, and hashing
 * them would cost readability for no privacy gain whatever. (Same call as the register list in
 * t0532-03, `0532-neutral-register-guard.test.mjs`, and for the same reason.)
 *
 * This list is a LOWER BOUND on what must stay out of the repo, never a ceiling: if you find
 * campaign vocabulary it misses, ADD IT — here if it is generic, to NAME_HASHES if it names
 * someone or somewhere real.
 */
const GENERIC_TOKENS = [
  // session ids
  's15', 's17',
  // setting nouns and ranks
  'traveller', 'imperium', 'subsector', 'deckplan',
  // kit and factions
  'sandcaster', 'psion', 'vigil',
  // a seat placeholder, not a person
];

/*
 * NAMES — people, places, ships. 14 tokens, expanded to 22 literal forms: two of them have two
 * spellings each and one carries the ANY_CHAR wildcard. Nothing here is readable, by design; the
 * recipe above is how you verify or extend it.
 */
const NAME_HASHES = [
  '644b580b034e0e0a0b9de6fa6b6877ed4ab9e6c10c23353b6602ebebd5ce2952',
  'e648c2f90407fc5c80f50f7069ddf2d8f08015fc80385de3e836e0b5084a4898',
  'bccc334b81ee5adc782b36b9d36be2eb311537dd2299363b2963d76aed8656e0',
  'ae92bc5eec065a07a62602c6b83a0e0870401c274c8fbf3c1017d15ca38d8b99',
  '8598be76b060bb884c03ad8ca89bd84bf33e71efef19c742586b5f894b019ae5',
  '5100bf7026c622fa3bdaf746d23444b1693cff1740674a517f0255060f698a0d',
  'da0893dc92788c08b4dc8b49719e4819f3636ef86a9123d1f15d6c8dcd2d1258',
  '6ad935b42cf8bf2c890a92b5adacf475938430ab8c05049339b799f672e46a47',
  '315317489867c72c721963d51d8d0aeefc82d579bcaf5027e92a76963341921f',
  '16d916ae27dc3ec6b65a3645b81772a3bcdb92164e76da5d5662192588b424a4',
  '3b12f3bfee21f830bdc6420bc94e41213d614b8057d3a39ad3fd4274367b7583',
  '6b1370fa54983df17d2da53f5b43f4ad141dc56bee2f790b8dbeb97046540b7c',
  '231a10b0cb6bb6ae8f5e71312f312dad05fb6179afd43961025ae34ab16aa292',
  '54a30e1b44816eb4991a1e0c0815943dd084303723469682f5a1057733d99b22',
  '954be8d79f93f37ee5ac8d71302027de924f46826c8382ef36b6a2c9c9709cbb',
  '717b463f908b0d0508e3095577b040ad9363e6813e15acdeb9e687a60a3f4e99',
  // ↻ S227 — RESTORED. The history purge substituted placeholder words into this list
  // ('WORLD-A'->'Waypoint', 'WORLD-B'->'Region', 'SURNAME-A'->'Commander', 'SLUG-A'->'participant-a'),
  // which are ordinary English and flagged 8 innocent files (ARIA `live region`, a fixture comment).
  // The placeholders are gone from GENERIC_TOKENS; these are the REAL names, hashed, so a
  // reintroduction is still caught. Recipe above.
  '17099f1205b970dffa325fbe155244bac638be57ab669cc63da64cf7cf8a02c4',  // world A
  'e2d1f9773085550e01ee338ef49e6dc9e65b92e9aa50d150569c5f9ca2acee3c',  // world B
  '2cbdb141169e217398c745a0df3edde5cb28bf755717460ef51620cd8a76f988',  // surname
  '3b12f3bfee21f830bdc6420bc94e41213d614b8057d3a39ad3fd4274367b7583',  // slug
  '16d916ae27dc3ec6b65a3645b81772a3bcdb92164e76da5d5662192588b424a4',  // spaced form
];

/*
 * One guarded name is also an ordinary programming identifier. As a bare word it matches 129
 * tracked lines, effectively all of them legitimate — a numeric helper, a CSS width property, an
 * occupancy cap, a slider bound, a typed field in the component manifest — and even the QUOTED
 * form is ambiguous for that last reason. So it is guarded ONLY in the compound forms the content
 * repo actually uses, never bare. This is narrower than every other token by necessity. It is
 * unchanged from the pre-P7 guard: five forms in, five forms out.
 */
const AMBIGUOUS_SLUG_HASHES = [
  '81776c8f8e0e13233f753778155b139ea74a56c1d51a9dab0dcd7c68fed0049e',
  'b7a7370b073d1b695fbc1cd57bf79d0973b87059ae1b1c99ea0b4acfcd529a3f',
  'ac332d43fad355ed70b0117e21ad1d39930d80755797c1b261edd7144d70ac93',
  '3b431a3e991a25cb83824e79b410affe83232ba7882ce6fa41cc4ad24352d37c',
  // the query-string form, anchored on its leading punctuation — one hash per anchor character
  'b07d23b3e67c08bb955be0c31b3956017c54ae418be461cf2ba3e8822d4d6c96',
  '157f896118ab733b3141ee5b8bd729f04e140c8c4c6a4ab67a6e73f6a80da418',
];

/*
 * ── Candidate generation: the exact shape `grep -wiE` matched, minus the plaintext ────────────
 *
 * Lowercase the text and take every maximal run of [a-z0-9]. Those runs ARE grep's word
 * boundaries. Emit the RAW substring spanned by each window of 1..3 consecutive runs, plus:
 *   - the same window with one preceding non-word character attached, so a pattern may be
 *     anchored on punctuation the way the query-string form is;
 *   - for a 3-run window whose FIRST gap is exactly one character, the window with that character
 *     replaced by ANY_CHAR — this is the old `.` wildcard, and grep's `.` never crossed a newline
 *     either, because grep is line-based.
 *
 * Separators are carried through VERBATIM, which is what keeps this from widening. A hyphenated
 * token is only ever compared against the same hyphen: if `oo-ban` were guarded, `foo-ban` would
 * still not match it, exactly as `grep -w` refused. `participant-authored` and
 * `probe-participant-ack` still do not look like `participant-a` — both appear in tracked files
 * today, and both were correctly ignored before. A window spanning a newline still cannot match a
 * single-line pattern, because grep was line-based and would not have matched it either.
 */
const WORD_RUN = /[a-z0-9]+/g;
function* candidates(text) {
  const s = text.toLowerCase();
  const runs = [];
  let m;
  WORD_RUN.lastIndex = 0;
  while ((m = WORD_RUN.exec(s)) !== null) runs.push([m.index, m.index + m[0].length]);
  for (let i = 0; i < runs.length; i++) {
    const start = runs[i][0];
    const anchored = start > 0 && !/[a-z0-9]/.test(s[start - 1]);
    for (let n = 1; n <= 3 && i + n <= runs.length; n++) {
      const end = runs[i + n - 1][1];
      yield s.slice(start, end);
      if (anchored) yield s.slice(start - 1, end);
      if (n === 3 && runs[i + 1][0] - runs[i][1] === 1) {
        yield s.slice(start, runs[i][1]) + ANY_CHAR + s.slice(runs[i + 1][0], end);
      }
    }
  }
}

/** The first candidate in `text` whose hash is in `hashes`, or null. Returns the HIT, not a name. */
function firstHit(text, hashes) {
  for (const c of candidates(text)) if (hashes.has(digest(c))) return c;
  return null;
}

/*
 * ALLOW-LIST — invented, obviously-fictional fixture names ONLY.
 *
 * The one entry that is not a fixture name is this file itself: the guard cannot help containing
 * the vocabulary it hunts for. Nothing else earns a place here by being inconvenient — a real file
 * carrying a real session id is a violation to FIX (P2–P4), never to exempt.
 */
const GUARD_SELF = 'test/unit/0514-p0-machine.test.mjs';
const ALLOW_LIST = [
  GUARD_SELF,   // the guard's own token list
];

/*
 * Every real player seat slug, hashed. The allow-list must never contain one of these. The bare
 * ambiguous slug IS in this set — the 129-line collision above only matters when scanning source,
 * and this set is only ever run against an allow-list FILENAME.
 */
const PLAYER_SLUG_HASHES = new Set([
  '5100bf7026c622fa3bdaf746d23444b1693cff1740674a517f0255060f698a0d',
  'da0893dc92788c08b4dc8b49719e4819f3636ef86a9123d1f15d6c8dcd2d1258',
  '6ad935b42cf8bf2c890a92b5adacf475938430ab8c05049339b799f672e46a47',
  '8dec150ca68b331f206b0bc88b5945868c96035fb7cae31dc3b6567874f652c0',
  '315317489867c72c721963d51d8d0aeefc82d579bcaf5027e92a76963341921f',
  digest('participant-a'),   // plaintext above: a placeholder, hashed here only for one code path
]);

/** Everything the tree scan hunts for: the hashed names, plus the generic words hashed at load. */
const TOKEN_HASHES = new Set([
  ...NAME_HASHES, ...AMBIGUOUS_SLUG_HASHES, ...GENERIC_TOKENS.map(digest),
]);

test('t0531-01 — NO campaign vocabulary in ANY tracked file (the public repo is domain-free)', () => {
  // The allow-list is itself under guard: an exemption that smuggles a player slug back in would
  // defeat the whole test, so assert it before using it.
  for (const entry of ALLOW_LIST) {
    const bare = entry.split('/').pop().replace(/\.(mjs|js|md|html|json)$/, '');
    const hit = firstHit(bare, PLAYER_SLUG_HASHES);
    expect(hit === null,
      `allow-list entry "${entry}" must not contain a real player seat slug`, `${entry} -> ${hit}`);
  }

  // Scan EVERY TRACKED FILE — `git ls-files`, not a hand-picked set of directories. Files are read
  // here rather than piped through grep because the patterns no longer exist in plaintext to pipe.
  // A NUL byte in the first 8 KB means binary, which is the same heuristic `grep -I` applies.
  const tracked = execSync('git ls-files -z', { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\0').filter(Boolean);

  const files = [];
  for (const rel of tracked) {
    if (ALLOW_LIST.includes(rel)) continue;
    let buf;
    try { buf = readFileSync(join(ROOT, rel)); } catch { continue; }          // deleted / unreadable
    if (buf.subarray(0, 8192).includes(0)) continue;                          // binary, as -I skips
    if (firstHit(buf.toString('utf8'), TOKEN_HASHES) !== null) files.push(rel);
  }

  expect(files.length === 0,
    `${files.length} tracked file(s) carry campaign vocabulary — move or neutralise them (plan 0531 P2–P4)`,
    '\n  ' + files.join('\n  '));
});

test('t0514-28 — CORE carries no machine and no domain vocabulary; deleting the plugin leaves a working Presenter', async () => {
  // (a) the source check — scoped exactly as A3 scopes it, so the plugin's own content is untouched.
  // NOTE (0531 P1): this half covers MACHINE vocabulary in the five core directories only. The
  // campaign-vocabulary half, over every tracked file, is t0531-01 above.
  const TOKENS = ['statechart', 'ship-chart', 'ship_event', 'ship_state', 'starship',
    'Traveller', 'Waypoint', 'turret', 'Captain', 'Astrogator', 'Gunner', 'Marines', 'Steward'];
  let out = '';
  try { out = execSync(`grep -rniwE '${TOKENS.join('|')}' app harness mcp lib components || true`, { cwd: ROOT, encoding: 'utf8' }); }
  catch (e) { out = e.stdout || ''; }
  const hits = out.split('\n').filter((l) => l.trim().length && !l.includes('harness/_shots/'));
  expect(hits.length === 0, 'no machine/domain vocabulary in core', JSON.stringify(hits));

  // (b) the behaviour check — a deployment with NO plugins at all is a working, machine-free
  // Presenter, not a crash and not a half-configured one.
  const dir = makePluginsDir({});
  await withPlugins(dir, async () => {
    const server = await createServer({ port: 0 });
    try {
      expect(server.store.get('ship') === undefined, 'no machine state exists', JSON.stringify(server.store.get('ship')));
      expect(server.stations().stations.length === 0, 'the registry is empty', JSON.stringify(server.stations()));
      expect(server.pluginTools().length === 0, 'no plugin tools', JSON.stringify(server.pluginTools()));
      expect(typeof server.url() === 'string', 'and the server is up and serving');
    } finally { await server.close(); }
  });
});

test('t0514-29 — a plugin with NO `server` key loads clean and registers nothing (teaching untouched)', async () => {
  const dir = makePluginsDir({ teaching: { 'plugin.json': { name: 'teaching', requires: [], components: [], presets: {}, fieldSchemas: {} } } });
  await withPlugins(dir, async () => {
    const server = await createServer({ port: 0 });
    try {
      expect(server.pluginTools().length === 0, 'nothing registered', JSON.stringify(server.pluginTools()));
      expect(server.stations().stations.length === 0, 'no stations declared ⇒ empty registry');
      expect(server.store.get('ship') === undefined, 'no machine state');
    } finally { await server.close(); }
  });
});

test('t0514-30 — a `server` module that THROWS on import is logged and does NOT take the server down', async () => {
  const dir = makePluginsDir({
    broken: {
      'plugin.json': { name: 'broken', requires: [], components: [], presets: {}, fieldSchemas: {}, server: 'boom.mjs' },
      'boom.mjs': 'throw new Error("deliberate plugin explosion");\nexport function register(){}\n',
    },
  });
  await withPlugins(dir, async () => {
    let server = null;
    try { server = await createServer({ port: 0 }); }
    catch (e) { expect(false, 'a broken plugin must NOT prevent the server starting', String(e && e.message || e)); }
    if (!server) return;
    try {
      // A broken plugin degrades the deployment to a plain Presenter; it does not end the session.
      expect(server.pluginTools().length === 0, 'the broken plugin contributed nothing');
      expect(typeof server.url() === 'string', 'the server is up');
      const logs = (await import('../../app/log.mjs')).tail(200);
      expect(logs.some((l) => l.msg === 'server-module-failed'), 'the failure was LOGGED, not swallowed silently',
        JSON.stringify(logs.slice(-4)));
    } finally { await server.close(); }
  });
});

test('t0514-42 — NO seat resolver registered ⇒ stations are INERT, and the server stays healthy', async () => {
  // A plugin that declares stations but no server module: core has a registry and nobody to
  // resolve seats against it. The correct behaviour is inert, not half-working.
  const dir = makePluginsDir({ fixture: { 'plugin.json': stationManifest() } });
  await withPlugins(dir, async () => {
    const server = await createServer({ port: 0 });
    const url = server.url().replace('http', 'ws');
    try {
      const c = await connect(WebSocket, url, { userId: 'u1', userName: 'U' });
      const w = last(c, 'welcome');
      expect(w && w.stationRegistry === undefined, 'welcome carries NO registry ⇒ the selector stays hidden', JSON.stringify(w));
      c.clear(); c.send({ t: 'station-select', stationUid: 1 }); await wait(140);
      const r = last(c, 'station');
      expect(r && r.ok === false && r.reason === 'no-stations', 'station-select is answered no-stations', JSON.stringify(r));
      expect(server.health().up !== false, 'the server is healthy');
      c.ws.close();
    } finally { await server.close(); }
  });
});

test('t0514-45 — a PARTICIPANT can READ the ship alert, and a component watching it is not blank', async () => {
  // Plan 0471 C3 made reads default-DENY with an allow-list, and the code comments its own
  // failure mode: "a missed allow rule renders a component BLANK … never a leak". Without a rule
  // for this prefix, promoting a placeholder to a live watching applet would render blank,
  // silently, and look like a broken component rather than a permissions denial.
  const { id, ns } = await shipKey();
  const server = await createServer({ port: 0 });
  try {
    const actor = { role: 'participant', userId: 'u1' };
    expect(server.store.perms.canRead(actor, `${ns}/alert`), `a participant may READ ${ns}/alert`);
    expect(server.store.perms.canRead(actor, `${ns}/stations/1/occupants`), 'and the nested occupancy path (prefix rule)');
    const snap = server.store.snapshot(actor);
    // ⛔ 0575 P1b — THE SNAPSHOT SHAPE IS PART OF THE NAMESPACE. Three components read this tree by
    // path (`d.state.ships[id]…`), and each guards on its own root — so a rename that stopped at
    // the store would leave every one of them fetching `undefined`, failing CLOSED and LOOKING FINE.
    const sh = snap.state.ships && snap.state.ships[id];
    // 0575 P1c — the boot value is `unknown`; what this test asserts is that it ARRIVES, not what it is.
    expect(sh && sh.alert === 'unknown', 'and it reaches the participant SNAPSHOT — not blank',
      JSON.stringify(snap.state.ships));
    expect(sh && sh.identity && sh.identity.shipId === id, 'the identity is filed under its own key — one name, not two',
      JSON.stringify(sh && sh.identity));
  } finally { await server.close(); }
});

test('t0514-46 — the machine writes as `system` (accepted); the same write as `participant` is DENIED', async () => {
  const { ns } = await shipKey();
  const server = await createServer({ port: 0 });
  try {
    // Accepted: the machine's own writes landed (proof the actor it uses is an override role).
    expect(server.store.get(`${ns}/power`) === 'standard', 'a machine write was accepted', String(server.store.get(`${ns}/power`)));

    // Denied, and QUIETLY — app/permissions.mjs is default-deny for participants and state.mjs
    // counts the refusal rather than throwing. This is the trap §4.2b exists to record: writing
    // as `participant` (the obvious choice, since the write is triggered by a player's action)
    // would have failed forever with no error anywhere.
    const res = server.store.apply({ path: `${ns}/power`, verb: 'set', value: 'combat' }, { role: 'participant', userId: 'u1' });
    expect(res === null, 'a participant write is refused', JSON.stringify(res));
    expect(server.store.get(`${ns}/power`) === 'standard', 'and the value did not change', String(server.store.get(`${ns}/power`)));
  } finally { await server.close(); }
});

test('t0514-28b — the chart is DATA: adding a region is a plugin edit, not a core edit', async () => {
  const mod = await loadMachineModule();
  const chart = JSON.parse(readFileSync(join(REAL_PLUGINS, 'starship-ops', 'ship-chart.json'), 'utf8'));
  chart.regions.hull = { initial: 'intact', states: { intact: {}, breached: {} } };
  chart.transitions.push({ on: 'hull-breach', region: 'hull', from: '*', to: 'breached' });
  const m = mod.createShipMachine(chart, {});
  expect(m.state().hull === 'intact', 'the new region is live with no engine change', JSON.stringify(m.state()));
  m.send('hull-breach');
  expect(m.state().hull === 'breached' && m.state().alert === 'unknown', 'and it is orthogonal to the rest', JSON.stringify(m.state()));
});
