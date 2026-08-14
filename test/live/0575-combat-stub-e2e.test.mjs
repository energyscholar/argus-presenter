/*
 * Plan 0575 PHASE 8 — THE DISPLAY PROJECTION, RENDERED.
 *
 * §5's plumbing trace for this phase is "state → display face → **rendered**". This walks it in a
 * real browser: the GM sets a mook's hit points with a tool, the server derives the display face
 * from person-chart.json and publishes it beside the rules face, and the component paints it —
 * label, colour and a bar — with NO lookup table of its own.
 *
 * ⭐ THE COLOUR IS THE ASSERTION THAT MATTERS. It is declared in the chart, published by the
 * server, and read back off the LIVE ELEMENT with getComputedStyle. If any link in that chain were
 * broken the row would still render, still say something, and be wrong — which is the failure mode
 * every phase of this plan has been about.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { toolMap, _server } from '../../mcp/tools.mjs';
import { launch, connectUser, waitContentFrame, contentFrame, until } from '../../harness/multi.mjs';
import { assertResources } from '../../harness/resources.mjs';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadShipPluginModule, SHIP_ID } from '../unit/_0514-fixtures.mjs';

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
async function shoot(page, name) {
  try {
    mkdirSync(SHOTS, { recursive: true });
    const file = join(SHOTS, name);
    await page.screenshot({ path: file });
    console.log(`      [shot] ${file}`);
    return file;
  } catch (e) { console.log(`      [shot] FAILED ${name} — ${e && e.message}`); return null; }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every crew row, as DRAWN: attributes, words, computed colour, and a box. */
const rowsOf = (p) =>
  contentFrame(p).evaluate(() => {
    return [...document.querySelectorAll('.ap-crew-row')].map((el) => {
      const r = el.getBoundingClientRect();
      const pip = el.querySelector('.ap-crew-pip');
      const fill = el.querySelector('.ap-crew-fill');
      return {
        person: el.getAttribute('data-person'),
        condition: el.getAttribute('data-condition'),
        conditionLabel: el.getAttribute('data-condition-label'),
        conditionColour: el.getAttribute('data-condition-colour'),
        tier: el.getAttribute('data-tier'),
        hits: el.getAttribute('data-hits'),
        hitsMax: el.getAttribute('data-hits-max'),
        labelText: (el.querySelector('.ap-crew-label') || {}).textContent || '',
        hitsText: (el.querySelector('.ap-crew-hits') || {}).textContent || '',
        pipFill: pip ? getComputedStyle(pip).backgroundColor : null,
        fillWidth: fill ? getComputedStyle(fill).width : null,
        box: [Math.round(r.width), Math.round(r.height)],
      };
    });
  });

test('t0575-08p — ⭐ A PERSON’S CONDITION IS RENDERED FROM THE SERVER’S DISPLAY FACE', async () => {
  const T = toolMap();
  await T.presenter_start.handler({ port: 0 });
  const server = _server();
  let browser = null;
  try {
    if (!server.stations().stations.length) { expect('skipped — no station plugin on this deployment', true, 'skipped'); return; }
    const chart = (await loadShipPluginModule('person-display.mjs')).loadPersonChart();

    // Three mooks, in three different conditions, so one screenshot answers three questions.
    const mooks = [
      ['mook-fit', 30, 'unharmed'],
      ['mook-hurt', 18, 'wounded'],
      ['mook-down', 2, 'unconscious'],
    ];
    for (const [id, hits] of mooks) {
      await server.callPluginTool('ship_person_set', {
        personId: id, name: id.toUpperCase().replace('-', ' '), placeId: SHIP_ID,
        hits, hitsMax: 30, armour: 5,
        skill: { name: 'gun-combat', level: 2 }, weapon: { name: 'gauss-rifle', damage: '4D' },
      });
    }
    // ⛔ And one nobody has looked at — the 1c ruling, on a person.
    await server.callPluginTool('ship_person_set', { personId: 'mook-unseen', name: 'UNSEEN', placeId: SHIP_ID });

    assertResources({ needMB: 900, label: '0575 P8 painted crew' });
    browser = await launch();
    const p = await connectUser(browser, server, { userId: 'u1', userName: 'Alice' });
    await until(() => server.presence().length === 1, { label: '1 connected' });

    /* ⛔ `requires` IS THE WHOLE OF WHETHER THIS RENDERS. assemble.mjs bundles plugin components
       ONLY for the transitive closure of `requires` — "No requires ⇒ pluginSet=[] ⇒ ZERO plugin
       bytes". A push without it renders "No component registered", which is how `ship-status`
       spent months declared, implemented and never drawn. */
    await T.push_component.handler({
      component: 'crew-condition',
      opts: { title: 'Boarding party', personIds: [...mooks.map((m) => m[0]), 'mook-unseen'] },
      target: 'all',
      requires: ['starship-ops'],
    });
    await waitContentFrame(p);
    await until(async () => (await rowsOf(p).catch(() => [])).length === 4, { timeout: 8000, label: 'four crew rows' });
    await wait(400);

    const rows = await rowsOf(p);
    for (const r of rows) console.log(`      [painted] ${JSON.stringify(r)}`);
    await shoot(p, 'p8-crew-condition-four-people-four-conditions.png');

    const by = Object.fromEntries(rows.map((r) => [r.person, r]));
    expect('all four people are drawn', rows.length === 4, String(rows.length));

    for (const [id, hits, want] of mooks) {
      const r = by[id];
      expect(`${id}: the condition is ${want}`, r && r.condition === want, JSON.stringify(r));
      expect(`${id}: the LABEL is the chart's, drawn in words`,
        r && r.labelText === chart.conditions[want].label, `${r && r.labelText} vs ${chart.conditions[want].label}`);
      /* ⭐ THE COLOUR, off the LIVE ELEMENT. Declared in the chart → published by the server →
         through the snapshot → into `--cc` → computed by the browser. Nothing in the component
         knows this value. */
      const hex = chart.conditions[want].colour;
      const rgb = `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
      expect(`${id}: the pip is PAINTED with the chart's colour (${hex})`, r && r.pipFill === rgb, `${r && r.pipFill} vs ${rgb}`);
      expect(`${id}: and the attribute agrees`, r && String(r.conditionColour).toLowerCase() === hex, r && r.conditionColour);
      expect(`${id}: the hit points are drawn`, r && r.hitsText === `${hits}/30`, r && r.hitsText);
      expect(`${id}: NON-ZERO BOUNDING BOX`, r && r.box[0] > 0 && r.box[1] > 0, JSON.stringify(r && r.box));
    }

    // ⛔ THE ONE NOBODY LOOKED AT. Not 'unharmed', and visually distinct from every condition.
    const unseen = by['mook-unseen'];
    expect('⛔⛔ a person whose health nobody recorded reads UNKNOWN, not UNHARMED',
      unseen && unseen.condition === 'unknown', JSON.stringify(unseen));
    expect('and it is NOT drawn in the unharmed colour',
      unseen && unseen.conditionColour !== chart.conditions.unharmed.colour, unseen && unseen.conditionColour);
    expect('with no hit points claimed', unseen && unseen.hitsText === '—', unseen && unseen.hitsText);

    // ── ⭐⭐ LIVE: injure someone and watch the SAME row change, over the wire ───────────────
    await server.callPluginTool('ship_person_set', { personId: 'mook-fit', hits: 1 });
    await until(async () => {
      const rs = await rowsOf(p).catch(() => []);
      const r = rs.find((x) => x.person === 'mook-fit');
      return r && r.condition === 'unconscious';
    }, { timeout: 8000, label: 'the diff reaches the glass' });
    const after = (await rowsOf(p)).find((r) => r.person === 'mook-fit');
    console.log(`      [painted] after the hit ${JSON.stringify(after)}`);
    await shoot(p, 'p8-crew-condition-LIVE-diff-fit-becomes-unconscious.png');
    expect('⭐⭐ the row followed a DIFF, not just the mount snapshot',
      after && after.condition === 'unconscious' && after.labelText === chart.conditions.unconscious.label,
      JSON.stringify(after));
    expect('and the bar shrank with it', after && after.fillWidth && parseFloat(after.fillWidth) < 20,
      String(after && after.fillWidth));
  } finally { if (browser) await browser.close(); await T.presenter_stop.handler({}); }
});
