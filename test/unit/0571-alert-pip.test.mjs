/*
 * Plan 0571 — THE ALERT PIP. Bruce, 2026-08-13: "Alert Status is a SMALL FEATURE and should take
 * up SMALL SPACE. Screen real estate is at a premium."
 *
 * The alert condition used to be a bordered band at the top right of every station plus a row of
 * three chunky buttons across the bottom of the Captain's. It is now a 5.5 x 5.5 unit square in
 * the header, immediately left of the ship's name, and one compact select.
 *
 * ⛔ THE STATION ART IS GENERATED. `stations/stations.py` writes all thirteen SVGs; hand-editing
 * one is silently undone on the next run. These tests read the COMMITTED OUTPUT, which is what a
 * browser actually loads, so a forgotten regeneration fails here rather than on the glass.
 *
 * ⛔ NO CAMPAIGN VOCABULARY in this file (t0531-01): every value it compares is READ from the
 * plugin, never written down here — with one exception that is the whole point of t0571-01.
 */
import { test, expect } from '../../harness/test.mjs';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { REAL_PLUGINS } from './_0514-fixtures.mjs';

const PLUGIN = join(REAL_PLUGINS, 'starship-ops');
const STATIONS = join(PLUGIN, 'stations');
const CHART = join(PLUGIN, 'ship-chart.json');
const have = existsSync(STATIONS) && existsSync(CHART);

const svgs = () => (have ? readdirSync(STATIONS).filter((f) => f.endsWith('.svg')).sort() : []);
const chart = () => JSON.parse(readFileSync(CHART, 'utf8'));

test('t0571-01 — ⭐ the pip carries a STABLE ID in all thirteen stations, and its at-rest fill IS the chart’s `unknown` colour', () => {
  if (!have) { expect(true, 'skipped — the station plugin is not installed on this deployment'); return; }
  const files = svgs();
  expect(files.length === 13, `all thirteen stations are generated (found ${files.length})`, files.join(','));

  const missing = files.filter((f) => !readFileSync(join(STATIONS, f), 'utf8').includes('id="apAlertPip"'));
  expect(missing.length === 0,
    '⛔ every station carries id="apAlertPip" — without it alert-band.js has nothing to paint',
    `missing in: ${missing.join(', ') || 'none'}`);

  /*
   * ⭐⭐ THE DUPLICATION GUARD. 0571 §2·0: the art is GENERATED OFFLINE, before any chart is read,
   * so the pip's at-rest fill is the ONE chart value that has to be copied — into
   * `stations.py`'s ALERT_UNKNOWN. Every other colour the pip wears arrives at RUNTIME over
   * ships/<id>/display/alert and is copied nowhere.
   *
   * ⛔ The copy is allowed; a SILENT copy is not. This reads both files and fails if they have
   * drifted, so "amber before the first message, grey after it" — one condition wearing two
   * colours — cannot come back. The colour itself is never written down here.
   */
  const want = String(chart().regions.alert.states.unknown.colour).toLowerCase();
  const wrong = files.map((f) => {
    const m = readFileSync(join(STATIONS, f), 'utf8').match(/id="apAlertPip"[^>]*fill="([^"]*)"/);
    return { f, fill: m ? String(m[1]).toLowerCase() : null };
  }).filter((r) => r.fill !== want);
  expect(wrong.length === 0,
    '⛔ the generated pip fill agrees with the chart’s `unknown` colour (the one deliberate duplication)',
    `chart says ${want}; disagreeing: ${JSON.stringify(wrong)}`);
});

test('t0571-01b — the art stays SCRIPT-FREE: the pip is painted from outside, never by the SVG', () => {
  if (!have) { expect(true, 'skipped — no station plugin'); return; }
  const bad = svgs().filter((f) => /<script/i.test(readFileSync(join(STATIONS, f), 'utf8')));
  expect(bad.length === 0,
    '⛔ stations/README.md: "SMIL only, no <script>" — content modules block scripts',
    bad.join(', '));
});

test('t0571-03 — ⭐ the tooltip and the colours come from the CHART: the component holds NO copy of either', () => {
  if (!have) { expect(true, 'skipped — no station plugin'); return; }
  const src = readFileSync(join(PLUGIN, 'alert-band.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // prose may DISCUSS them
  const states = chart().regions.alert.states;

  /* Read the forbidden strings out of the chart rather than spelling them — the same trick
     t0559-08 uses, and it keeps working when the chart gains a fifth state. */
  const literals = [];
  for (const [name, d] of Object.entries(states)) {
    for (const k of ['label', 'colour', 'tooltip', 'gloss']) if (d[k]) literals.push([name, k, String(d[k])]);
  }
  expect(literals.length > 0, 'the chart declares display values to guard against', JSON.stringify(Object.keys(states)));

  const found = literals.filter(([, , v]) => src.includes(v));
  expect(found.length === 0,
    '⛔ alert-band.js contains none of the chart’s display strings — "a second table is how a thing '
    + 'acquires two names and the two drift" (its own header)',
    JSON.stringify(found));
});

test('t0571-05b — ⭐ `unknown` CANNOT BE ORDERED, and it is structural: the order set is exactly the three', () => {
  if (!have) { expect(true, 'skipped — no station plugin'); return; }
  /*
   * 0571 §2·0: do NOT add a guard that filters `unknown` out of the select — a filter is something
   * a later edit can delete. The protection is that the commanding seat's order set never contained
   * it, and the select is built FROM that set. This asserts the set, so the day someone adds a
   * fourth order the test says so rather than the dropdown quietly offering a state nobody can be
   * ordered into.
   *
   * The events are read out of the machine source's own map so this PUBLIC repo spells no campaign
   * vocabulary; the three alert events are RULES-level names, and they are what the chart's
   * transitions already declare.
   */
  const src = readFileSync(join(PLUGIN, 'ship-machine.mjs'), 'utf8');
  const m = src.match(/ORDERS_BY_STATION_CODE\s*=\s*\{([\s\S]*?)\}\s*;/);
  expect(!!m, 'ship-machine.mjs declares an order set per station code', 'ORDERS_BY_STATION_CODE not found');
  if (!m) return;
  const events = (m[1].match(/'([a-z-]+)'/g) || []).map((s) => s.replace(/'/g, ''));
  const alertEvents = chart().transitions.filter((t) => t.region === 'alert').map((t) => t.on).sort();
  expect(JSON.stringify(events.slice().sort()) === JSON.stringify(alertEvents),
    '⛔ the commanding seat is offered EXACTLY the alert transitions the chart declares — no more',
    `orders=${JSON.stringify(events)} chartAlertEvents=${JSON.stringify(alertEvents)}`);
  expect(!events.includes('unknown'),
    '⛔ and `unknown` is not among them — it is a state you LEAVE, never one you ORDER',
    JSON.stringify(events));
});
