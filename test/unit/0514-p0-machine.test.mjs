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

test('t0514-00 — the system plugin is installed (every Phase 0 test below needs it)', () => {
  expect(haveMachine, 'plugins/starship-ops/ship-machine.mjs exists — install the plugin from starship-operations/presenter-plugins/ if this fails', MACHINE_FILE);
});

test('t0514-23 — orthogonal regions advance INDEPENDENTLY: an alert event does not disturb nav', async () => {
  const m = await bareMachine();
  const before = m.state();
  expect(before.alert === 'normal' && before.nav === 'docked' && before.power === 'standard', 'all three regions start at their initial state', JSON.stringify(before));
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

test('t0514-27 — each region publishes its active state to the store at ship/<region>', async () => {
  const server = await createServer({ port: 0 });
  try {
    expect(server.store.get('ship/alert') === 'normal', 'ship/alert seeded at load', String(server.store.get('ship/alert')));
    expect(server.store.get('ship/nav') === 'docked', 'ship/nav seeded at load', String(server.store.get('ship/nav')));
    await server.callPluginTool('ship_event', { event: 'battle-stations' });
    expect(server.store.get('ship/alert') === 'action', 'a transition writes through to the store', String(server.store.get('ship/alert')));
    expect(server.store.get('ship/nav') === 'docked', 'and only its own region', String(server.store.get('ship/nav')));
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
 * directories. It has never looked for `s17`, `participant-a`, `Waypoint`, `Region` or `s15`, and it has
 * never looked outside `app harness mcp lib components`.
 *
 * This test is the missing half. It is deliberately a SEPARATE test rather than a widening of
 * t0514-28, because `expect` throws: folding the campaign scan into t0514-28 would abort before
 * its (b) behaviour check — "a deployment with no plugins at all is a working Presenter" — and
 * that check would silently stop running for the whole of plan 0531. Coverage must not be traded
 * for tidiness. G1 should gate on BOTH tests.
 */

/*
 * Bare word-boundary tokens, case-insensitive. Anything that names a session, a place, a person
 * or a setting belongs here. This list is a LOWER BOUND on what P2–P4 must remove, never a
 * ceiling: if you find campaign vocabulary the list misses, ADD IT, do not work around it.
 */
const CAMPAIGN_TOKENS = [
  // session ids
  's15', 's17',
  // places and setting
  'waypoint', 'region', 'typhon', 'flammarion', 'commander',
  'traveller', 'imperium', 'subsector', 'deckplan',
  // ships, kit, factions
  'astral dawn', "dragon.?s world", 'sandcaster', 'psion', 'vigil',
  // people: player seat slugs and the characters behind them
  'james', 'marina', 'asao', 'cassian',
  'von ?sydo', 'participant-a', 'sydo',
  'deveillter', 'planck', 'elara', 'holt',
];

/*
 * `max` is a player slug AND an ordinary identifier. A bare \bmax\b matches 129 tracked lines,
 * nearly all of them legitimate — `Math.max`, `max-width`, `maxOccupants`, the slider's `max`
 * option, `{ name: 'max', type: 'number' }` in the component manifest. Even a QUOTED 'max' is
 * ambiguous for that last reason. So the slug is matched only in the compound forms the campaign
 * actually uses. This is narrower than the other tokens by necessity, and it is the one token a
 * reviewer should re-check by eye rather than trust.
 */
const MAX_SLUG_FORMS = ['max planck', 'st-max', 'max-anomaly', 'max only', '[?&]u=max'];

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

/** Every real player seat slug. The allow-list must never contain one of these. */
const REAL_PLAYER_SLUGS = ['james', 'marina', 'asao', 'max', 'cassian', 'participant-a'];

test('t0531-01 — NO campaign vocabulary in ANY tracked file (the public repo is domain-free)', () => {
  // The allow-list is itself under guard: an exemption that smuggles a player slug back in would
  // defeat the whole test, so assert it before using it.
  for (const entry of ALLOW_LIST) {
    const bare = entry.split('/').pop().replace(/\.(mjs|js|md|html|json)$/, '');
    for (const slug of REAL_PLAYER_SLUGS) {
      expect(!new RegExp(`(^|[^a-z0-9])${slug}([^a-z0-9]|$)`, 'i').test(bare),
        `allow-list entry "${entry}" must not contain the real player slug "${slug}"`, entry);
    }
  }

  // Scan EVERY TRACKED FILE — `git ls-files`, not a hand-picked set of directories. -I skips
  // binaries; -w keeps `s15` from matching inside a longer word.
  const pattern = [...CAMPAIGN_TOKENS, ...MAX_SLUG_FORMS].join('|');
  let out = '';
  try {
    out = execSync(`git ls-files -z | xargs -0 grep -IlnwiE '${pattern}' || true`,
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) { out = e.stdout || ''; }

  const files = out.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((f) => !ALLOW_LIST.includes(f));

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

test('t0514-45 — a PARTICIPANT can READ ship/alert, and a component watching it is not blank', async () => {
  // Plan 0471 C3 made reads default-DENY with an allow-list, and the code comments its own
  // failure mode: "a missed allow rule renders a component BLANK … never a leak". Without a rule
  // for this prefix, promoting a placeholder to a live watching applet would render blank,
  // silently, and look like a broken component rather than a permissions denial.
  const server = await createServer({ port: 0 });
  try {
    const actor = { role: 'participant', userId: 'u1' };
    expect(server.store.perms.canRead(actor, 'ship/alert'), 'a participant may READ ship/alert');
    expect(server.store.perms.canRead(actor, 'ship/stations/1/occupants'), 'and the nested occupancy path (prefix rule)');
    const snap = server.store.snapshot(actor);
    expect(snap.state.ship && snap.state.ship.alert === 'normal', 'and it reaches the participant SNAPSHOT — not blank',
      JSON.stringify(snap.state.ship));
  } finally { await server.close(); }
});

test('t0514-46 — the machine writes as `system` (accepted); the same write as `participant` is DENIED', async () => {
  const server = await createServer({ port: 0 });
  try {
    // Accepted: the machine's own writes landed (proof the actor it uses is an override role).
    expect(server.store.get('ship/power') === 'standard', 'a machine write was accepted', String(server.store.get('ship/power')));

    // Denied, and QUIETLY — app/permissions.mjs is default-deny for participants and state.mjs
    // counts the refusal rather than throwing. This is the trap §4.2b exists to record: writing
    // as `participant` (the obvious choice, since the write is triggered by a player's action)
    // would have failed forever with no error anywhere.
    const res = server.store.apply({ path: 'ship/power', verb: 'set', value: 'combat' }, { role: 'participant', userId: 'u1' });
    expect(res === null, 'a participant write is refused', JSON.stringify(res));
    expect(server.store.get('ship/power') === 'standard', 'and the value did not change', String(server.store.get('ship/power')));
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
  expect(m.state().hull === 'breached' && m.state().alert === 'normal', 'and it is orthogonal to the rest', JSON.stringify(m.state()));
});
