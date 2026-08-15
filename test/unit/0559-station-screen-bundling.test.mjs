/*
 * 0559 — A STATION SCREEN MUST ACTUALLY REACH THE SEAT.
 *
 * The defect this locks down, found 2026-08-11: assemble.mjs bundles core components always but
 * plugin components ONLY for the transitive closure of a descriptor's `requires` —
 * "No requires ⇒ pluginSet=[] ⇒ ZERO plugin bytes", deliberately, so content that does not use a
 * plugin never ships its code.
 *
 * The station-screen descriptor declared no `requires`, so every station screen rendered
 * "No component registered". ⭐ It is also why `ship-status` — declared in plugin.json,
 * implemented, and referenced by ten authored beats — had never rendered anywhere.
 *
 * Nothing in the system reported this. The manifest said the component existed, the file existed,
 * and the seat showed an error string in a sandboxed iframe where no test was looking.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { resolveClosure } from '../../harness/plugins.mjs';
import { assemble } from '../../harness/assemble.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '../../plugins/starship-ops');
const MANIFEST = JSON.parse(readFileSync(join(PLUGIN, 'plugin.json'), 'utf8'));

/* The station registry as CORE hands it to the plugin: a Map by uid plus a default. Built from
   the manifest so it tracks the real deployment rather than a fixture that can drift. */
const STATION_LIST = MANIFEST.stations || [];
const STATIONS = Object.assign(
  new Map(STATION_LIST.map((st) => [st.stationUid, st])),
  { defaultUid: MANIFEST.stationDefaultUid },
);
/** The first station that actually declares a screen — the only kind that yields a descriptor. */
const FIRST_SCREEN_UID = (STATION_LIST.find((st) => st.stationScreen) || {}).stationUid;

test('t0559-20 — every component the manifest declares has an implementation file', () => {
  for (const c of MANIFEST.components) {
    const js = join(PLUGIN, `${c}.js`);
    assert.doesNotThrow(() => readFileSync(js), `${c} is declared but ${c}.js does not exist`);
  }
});

test('t0559-21 — every declared component REGISTERS itself through the registry API', () => {
  /* Assigning into window.ApComponents LOOKS equivalent and is not: assemble.mjs asks
     ApComponents.has(), which only sees names passed to register(). The first cut of both new
     components did the former and the seat reported "No component registered". */
  for (const c of MANIFEST.components) {
    const src = readFileSync(join(PLUGIN, `${c}.js`), 'utf8');
    assert.match(src, new RegExp(`register\\(\\s*['"\`]${c}['"\`]`),
      `${c}.js must call ApComponents.register('${c}', …)`);
  }
});

test('t0559-22 — ⛔ the station descriptor DECLARES its plugin, or zero plugin bytes ship', async () => {
  /*
   * ⚠ THIS TEST USED TO GREP THE SOURCE for /requires:\s*\[/ and it was worthless. The object
   * literal carried the key TWICE — `requires: [PLUGIN_NAME]` and, three lines later,
   * `requires: []` — and in JS the LAST key wins, so the runtime value was `[]`. The regex
   * matched the empty one and the test went green over a completely broken descriptor.
   *
   * ⇒ DRIVE THE REAL PATH AND READ WHAT COMES BACK. descriptorFor is not exported; it reaches
   *   the world through the seat resolver the plugin hands to core, so capture that and ask it
   *   for a seat, exactly as core does. A test that reads source text asserts what somebody
   *   typed, never what the program does.
   */
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

  assert.ok(resolver && typeof resolver.select === 'function', 'the plugin must provide a seat resolver');
  const { descriptor } = resolver.select('test-user', FIRST_SCREEN_UID);
  assert.ok(descriptor, `station ${FIRST_SCREEN_UID} declares a screen, so it must yield a descriptor`);
  assert.ok(Array.isArray(descriptor.requires), '`requires` must be an array');
  assert.ok(descriptor.requires.includes(MANIFEST.name),
    '⛔ requires must name the plugin, got ' + JSON.stringify(descriptor.requires)
    + ' — an empty array ships ZERO plugin bytes and the screen renders "No component registered"');
});


test('t0559-23 — resolveClosure accepts the plugin name and returns it', () => {
  assert.deepEqual(resolveClosure([MANIFEST.name]), [MANIFEST.name]);
  assert.deepEqual(resolveClosure([]), [], 'no requires ⇒ no plugin bytes, by design');
});

test('t0559-24 — ⭐ END TO END: assembling a station screen SHIPS the components it needs', () => {
  const html = assemble({ component: 'station-screen', opts: { svg: '<svg/>' }, requires: [MANIFEST.name] });
  for (const c of ['station-screen', 'alert-band']) {
    assert.ok(html.includes(`register('${c}'`), `assembled page must contain ${c}'s registration`);
  }
  /* ⭐ 0571 — the band is gone, so the stylesheet is checked by what it styles NOW: the alert pip
     in the station header. The assertion is still "the component's CSS shipped", not "the CSS says
     any particular thing". */
  assert.ok(html.includes('apAlertPip'), 'and its stylesheet');
  /* ⚠ NOT `!html.includes('No component registered')` — that string is the ELSE branch of the
     assembled page's own boot script and is present in every page ever assembled. Asserting its
     absence tests the template, not the outcome. What matters is that `has()` will find the name,
     which is what the registration check above establishes. */
  assert.ok(html.includes("ApComponents.has(\"station-screen\")") || html.includes("ApComponents.has('station-screen')"),
    'the boot script must ask the registry for this component by name');
});

test('t0559-25 — the SAME assembly WITHOUT requires ships none of it (the design holds)', () => {
  const html = assemble({ component: 'station-screen', opts: { svg: '<svg/>' }, requires: [] });
  assert.ok(!html.includes("register('station-screen'"),
    'omitting requires must still ship zero plugin bytes — that behaviour is deliberate, not a bug');
});
