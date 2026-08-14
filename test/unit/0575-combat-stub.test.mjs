/*
 * Plan 0575 PHASE 8 — COMBAT STUB FIELDS, AND THE DISPLAY PROJECTION.
 *
 * Bruce's stub, verbatim: "normal fighters need STUBBED_COMBATANT… tracks GUN-COMBAT-SKILL:2,
 * WEAPON:GAUSS_RIFLE, HEALTH:30/30, ARMOR:DR5."
 *
 * ⭐ §4.1 — "State Machines need to track BOTH internal state for RULES PURPOSES and also DISPLAY
 * INFO" — and the answer is that the pattern ALREADY EXISTS: ship-chart.json declares
 * label/colour/gloss and 0559 D7 publishes them BESIDE the state, so no client holds a lookup
 * table. A person uses the same shape. ⛔ NOT a second table.
 *
 * ⛔ AND THE CONDITION IS DERIVED, NEVER STORED. A stored condition beside the hit points is two
 * facts and one truth, with no way to tell which is stale — the mirror P3 took out of occupancy.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { REAL_PLUGINS, loadShipPluginModule, SHIP_ID } from './_0514-fixtures.mjs';

const PLUGIN = join(REAL_PLUGINS, 'starship-ops');
const haveDisplay = existsSync(join(PLUGIN, 'person-display.mjs'));

const toolResult = async (server, name, args) => {
  const r = await server.callPluginTool(name, args);
  return r && Object.prototype.hasOwnProperty.call(r, 'result') ? r.result : r;
};

test('t0575-08a — ⭐ THE DISPLAY FACE IS BUILT FROM THE CHART, and the component holds NO table', async () => {
  if (!haveDisplay) { expect(false, 'person-display.mjs is installed (run tools/install-system-plugins.sh)'); return; }
  const mod = await loadShipPluginModule('person-display.mjs');
  const chart = mod.loadPersonChart();

  const d = mod.personDisplay({ tier: 'stub', hits: 18, hitsMax: 30 }, chart);
  expect(d.state === 'wounded', '18/30 is WOUNDED', JSON.stringify(d));
  expect(d.label === chart.conditions.wounded.label && d.colour === chart.conditions.wounded.colour,
    '⭐ and its label AND colour come from the CHART, not from code', JSON.stringify(d));
  expect(d.hits === 18 && d.hitsMax === 30, 'the fraction rides along, so a bar needs no second arithmetic',
    JSON.stringify(d));
  expect(/§27/.test(d.rule), 'and the face names the rule that decided it', d.rule);

  /* ⛔⛔ THE COMPONENT MUST NOT CARRY A SECOND TABLE. This is the assertion §4.1 asks for: a second
     table is how a thing acquires two names and the two drift apart. Grep the component source for
     any condition LABEL — the words only exist in the chart. */
  const src = readFileSync(join(PLUGIN, 'crew-condition.js'), 'utf8');
  for (const [state, decl] of Object.entries(chart.conditions)) {
    expect(!src.includes(decl.label), `the component does not spell the label for "${state}"`, decl.label);
    if (decl.colour) expect(!src.includes(decl.colour), `nor its colour`, decl.colour);
  }
  /* And it reads the right BUS. `Argus.subscribe` is the in-page local bus; server state never
     arrives there, and this defect has shipped twice in this plugin.

     ⚠⚠ THIS HALF SCANS CODE, NOT PROSE, AND THE SPLIT IS DELIBERATE — I got it wrong first.
     The label rule above greps the WHOLE file, comments included, and that is right: a condition
     label has no business appearing in prose. The BUS rule cannot work that way, because the most
     valuable line in that component is the POST-MORTEM naming the wrong API — "Argus.subscribe is
     the in-page local bus", "Argus.get() does not exist". A guard that forbade naming them would
     delete the institutional memory that stops the defect shipping a third time. So comments are
     stripped for these four, exactly as t0531-01 exempts its own token list via GUARD_SELF: a
     guard cannot help containing the thing it hunts for. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  expect(code.includes('Argus.onMessage'), '⛔ it listens on Argus.onMessage, not the local bus');
  expect(!/Argus\.subscribe\s*\(/.test(code), '⛔⛔ and it never calls Argus.subscribe');
  expect(!/Argus\.get\s*\(/.test(code), '⛔ nor Argus.get, which does not exist');
  expect(/m\.type === 'snapshot'/.test(code) && /m\.type === 'diff'/.test(code),
    '⛔ and it handles BOTH snapshot and diff — a diff-only listener stays blank until the first change');
  /* ⭐ And the stripper must actually strip, or all four assertions above pass vacuously on an
     empty string — a test that can no longer fail. */
  expect(code.length > 400 && code.length < src.length, 'the comment stripper left real code behind',
    `${code.length} of ${src.length} bytes`);
});

test('t0575-08b — ⛔ HEALTH NOBODY RECORDED READS `unknown`, NOT `unharmed` (the 1c ruling, for people)', async () => {
  if (!haveDisplay) { expect(false, 'person-display.mjs is installed'); return; }
  const mod = await loadShipPluginModule('person-display.mjs');
  /* ⭐ The same argument plan §5a makes for a ship at CONDITION GREEN: a board that reports a
     confident, safe-sounding condition about somebody nobody has looked at is making a claim it
     cannot support. `unknown` is what makes not-having-looked VISIBLE. */
  for (const p of [{}, { tier: 'stub' }, { tier: 'stub', hits: 5 }, { tier: 'stub', hitsMax: 0 }, null]) {
    const d = mod.personDisplay(p);
    expect(d.state === 'unknown', `unrecorded reads unknown: ${JSON.stringify(p)}`, JSON.stringify(d));
    expect(d.state !== 'unharmed', '⛔ and NEVER unharmed', JSON.stringify(d));
    expect(d.rule === null, 'with no rule claimed, because none was applied', String(d.rule));
  }
  const chart = mod.loadPersonChart();
  const hues = new Set(Object.values(chart.conditions).map((c) => c.colour));
  expect(hues.size === Object.keys(chart.conditions).length,
    '⭐ every condition has a DISTINCT colour — unknown must not be readable as a dim green',
    JSON.stringify([...hues]));
});

test('t0575-08c — the five conditions, each by its own tier’s published rule', async () => {
  if (!haveDisplay) { expect(false, 'person-display.mjs is installed'); return; }
  const mod = await loadShipPluginModule('person-display.mjs');
  const st = (p) => mod.personDisplay(p).state;
  expect(st({ tier: 'stub', hits: 30, hitsMax: 30 }) === 'unharmed', 'full pool ⇒ unharmed');
  expect(st({ tier: 'stub', hits: 29, hitsMax: 30 }) === 'wounded', 'one point off ⇒ wounded');
  expect(st({ tier: 'stub', hits: 3, hitsMax: 30 }) === 'unconscious', '1/10 or less ⇒ unconscious (§27)');
  expect(st({ tier: 'stub', hits: 0, hitsMax: 30 }) === 'dead', 'nothing left ⇒ dead');
  // ⭐ A FULL person is judged on characteristics, and the difference is visible right here.
  expect(st({ tier: 'full', chars: { END: 10, STR: 10, DEX: 10 }, charsMax: { END: 10, STR: 10, DEX: 10 } }) === 'unharmed',
    'full and untouched ⇒ unharmed');
  expect(st({ tier: 'full', chars: { END: 0, STR: 10, DEX: 10 }, charsMax: { END: 10, STR: 10, DEX: 10 } }) === 'wounded',
    '⭐ END at 0 is WOUNDED, not unconscious — §22 names STR or DEX, not END');
  expect(st({ tier: 'full', chars: { END: 0, STR: 0, DEX: 10 }, charsMax: { END: 10, STR: 10, DEX: 10 } }) === 'unconscious',
    'STR at 0 ⇒ unconscious (§22 step 5)');
  expect(st({ tier: 'full', chars: { END: 0, STR: 0, DEX: 0 }, charsMax: { END: 10, STR: 10, DEX: 10 } }) === 'dead',
    'all three at 0 ⇒ dead (§22 step 6)');
});

test('t0575-08d — a person’s two faces are PUBLISHED TOGETHER, and the display one is DERIVED', async () => {
  const server = await createServer({ port: 0 });
  try {
    if (!server.stations().stations.length) { expect(true, 'skipped — no station plugin'); return; }
    const people = await loadShipPluginModule('people.mjs');

    const made = await toolResult(server, 'ship_person_set', {
      personId: 'mook-1', name: 'Rank And File', placeId: SHIP_ID,
      hits: 30, hitsMax: 30, armour: 5,
      skill: { name: 'gun-combat', level: 2 }, weapon: { name: 'gauss-rifle', damage: '4D' },
    });
    expect(made.ok === true, 'the GM can create a stub combatant', JSON.stringify(made));

    const rec = server.store.get(people.personPath('mook-1'));
    // ── the RULES face, exactly Bruce's stub ─────────────────────────────────────────────────
    expect(rec.tier === 'stub' && rec.needsFullState === false, 'a stub by default, with no machine',
      JSON.stringify({ tier: rec.tier, needsFullState: rec.needsFullState }));
    expect(rec.hits === 30 && rec.hitsMax === 30 && rec.armour === 5, 'HEALTH 30/30, ARMOR DR5',
      JSON.stringify(rec));
    expect(rec.skill.name === 'gun-combat' && rec.skill.level === 2, 'ONE skill', JSON.stringify(rec.skill));
    expect(rec.weapon.name === 'gauss-rifle', 'ONE weapon', JSON.stringify(rec.weapon));
    // ── and the DISPLAY face, beside it, in the same record ──────────────────────────────────
    expect(rec.display && rec.display.state === 'unharmed', '⭐ the display face is PUBLISHED BESIDE it',
      JSON.stringify(rec.display));
    expect(rec.display.colour && rec.display.label, 'carrying its own label and colour', JSON.stringify(rec.display));

    // ⛔ DERIVED: change ONLY the hit points and the face follows, with nothing else written.
    await toolResult(server, 'ship_person_set', { personId: 'mook-1', hits: 2 });
    const hurt = server.store.get(people.personPath('mook-1'));
    expect(hurt.display.state === 'unconscious',
      '⭐⭐ the condition followed the hit points — it is DERIVED, not stored beside them',
      JSON.stringify(hurt.display));
    expect(hurt.armour === 5 && hurt.skill.level === 2, 'and the rest of the record is untouched', JSON.stringify(hurt));
    expect(hurt.display.hits === 2 && hurt.display.hitsMax === 30, 'the face carries the same numbers as the record',
      JSON.stringify(hurt.display));

    // Promotion re-derives it under the OTHER tier's rule, and says which.
    const prom = await toolResult(server, 'ship_person_promote', { personId: 'mook-1', overflowTo: 'DEX' });
    expect(prom.ok === true, 'promoted through the tool', JSON.stringify(prom));
    const full = server.store.get(people.personPath('mook-1'));
    expect(full.tier === 'full' && full.chars, 'now a full person with characteristics', JSON.stringify(full.chars));
    expect(/§22/.test(full.display.rule), '⭐ and the face now names the EXACT rule', full.display.rule);
    expect(prom.machines === 1, 'and exactly one machine was built for them', String(prom.machines));

    // A participant may READ it, or the component would render blank and look broken.
    const actor = { role: 'participant', userId: 'u1' };
    expect(server.store.perms.canRead(actor, people.personPath('mook-1')), 'a participant may read the person');
    const snap = server.store.snapshot(actor);
    expect(snap.state.people['mook-1'].display, 'and the display face reaches their SNAPSHOT',
      JSON.stringify(snap.state.people['mook-1'] && snap.state.people['mook-1'].display));
  } finally { await server.close(); }
});

test('t0575-08e — the component is DECLARED, so its bytes actually ship', async () => {
  if (!haveDisplay) { expect(false, 'person-display.mjs is installed'); return; }
  /* ⛔ "ship-status — declared, implemented, referenced by ten beats — had never actually rendered
     anywhere" (0559, found 2026-08-11). assemble.mjs bundles plugin components ONLY for the
     transitive closure of `requires`, and only names put through `ApComponents.register()` are
     visible to it. A component that exists on disk and is not in the manifest ships zero bytes. */
  const manifest = JSON.parse(readFileSync(join(PLUGIN, 'plugin.json'), 'utf8'));
  expect(manifest.components.includes('crew-condition'), 'the manifest declares it',
    JSON.stringify(manifest.components));
  expect(existsSync(join(PLUGIN, 'crew-condition.js')), 'the implementation is beside it');
  expect(existsSync(join(PLUGIN, 'crew-condition.css')), 'and so is its stylesheet');
  const src = readFileSync(join(PLUGIN, 'crew-condition.js'), 'utf8');
  expect(/ApComponents\.register\(\s*'crew-condition'/.test(src),
    '⛔ and it registers THROUGH the registry API — assemble.mjs asks has(), which only sees register()');
});
