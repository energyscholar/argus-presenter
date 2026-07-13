/*
 * SCH-2 — Series: the level above Module (Library › SERIES › Module › Section › Sequence › Beat › Layer).
 * A series is a file `<id>.series.json` = { manifest, moduleIds:[...] } listing modules to walk in order.
 * Guards: (1) listModules SKIPS *.series.json; (2) /api/series lists series; (3) /api/series/:id resolves
 * its modules in order (with titles); (4) the GM panel picks a series -> #mod-select points at module 1,
 * "Next in series" advances to module 2.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until } from '../../harness/multi.mjs';
import { writeFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = join(__dirname, '..', '..', 'modules');   // default createServer MODULES_DIR

const MOD_A = 'sch2-mod-a', MOD_B = 'sch2-mod-b', SERIES = 'sch2-demo';
const fileA = join(MODULES_DIR, MOD_A + '.json');
const fileB = join(MODULES_DIR, MOD_B + '.json');
const fileS = join(MODULES_DIR, SERIES + '.series.json');

function writeFixtures() {
  writeFileSync(fileA, JSON.stringify({ manifest: { title: 'Chapter One' }, beats: [{ id: 'a', component: 'card', opts: { title: 'A' } }] }));
  writeFileSync(fileB, JSON.stringify({ manifest: { title: 'Chapter Two' }, beats: [{ id: 'b', component: 'card', opts: { title: 'B' } }] }));
  writeFileSync(fileS, JSON.stringify({ manifest: { title: 'Two-Part Demo', summary: 'a→b' }, moduleIds: [MOD_A, MOD_B] }));
}
function cleanup() { for (const f of [fileA, fileB, fileS]) { try { unlinkSync(f); } catch (e) {} } }

test('SCH2 — /api/series lists series; series file is NOT listed as a module', async () => {
  writeFixtures();
  const server = await createServer({ port: 0 });
  try {
    const series = await (await fetch(server.url() + '/api/series')).json();
    const s = series.find((x) => x.id === SERIES);
    expect(!!s, '/api/series lists the series', JSON.stringify(series));
    expect(s.title === 'Two-Part Demo' && s.count === 2, 'series carries title + module count', JSON.stringify(s));
    const mods = await (await fetch(server.url() + '/api/modules')).json();
    expect(mods.some((m) => m.id === MOD_A) && mods.some((m) => m.id === MOD_B), 'modules ARE listed', JSON.stringify(mods.map((m) => m.id)));
    expect(!mods.some((m) => m.id === SERIES || m.id === SERIES + '.series'), 'series file is NOT listed as a module', JSON.stringify(mods.map((m) => m.id)));
  } finally { await server.close(); cleanup(); }
});

test('SCH2 — /api/series/:id resolves its modules in order (with titles)', async () => {
  writeFixtures();
  const server = await createServer({ port: 0 });
  try {
    const d = await (await fetch(server.url() + '/api/series/' + SERIES)).json();
    expect(d.id === SERIES && Array.isArray(d.series.moduleIds), 'returns series manifest', JSON.stringify(d.series));
    expect(d.modules.length === 2, 'resolves both modules', JSON.stringify(d.modules));
    expect(d.modules[0].id === MOD_A && d.modules[0].title === 'Chapter One', 'module 1 resolved in order with title', JSON.stringify(d.modules[0]));
    expect(d.modules[1].id === MOD_B && d.modules[1].title === 'Chapter Two', 'module 2 resolved in order with title', JSON.stringify(d.modules[1]));
    // A missing moduleId marks {id, error:'missing'} rather than throwing.
    writeFileSync(fileS, JSON.stringify({ manifest: { title: 'T' }, moduleIds: [MOD_A, 'sch2-nope'] }));
    const d2 = await (await fetch(server.url() + '/api/series/' + SERIES)).json();
    expect(d2.modules[1].error === 'missing', 'missing module id marked error:missing', JSON.stringify(d2.modules[1]));
  } finally { await server.close(); cleanup(); }
});

test('SCH2 — GM panel: choosing a series queues module 1; "Next in series" advances to module 2', async () => {
  writeFixtures();
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const ctl = await browser.newPage();
    await ctl.goto(`${server.url()}/control?userId=gm&role=presenter`, { waitUntil: 'domcontentloaded' });
    await ctl.waitForFunction(() => window.__gm && typeof window.__gm.series === 'function');
    // Wait for both async registries to populate the selects.
    await ctl.waitForFunction((sid, a, b) => {
      const ser = document.querySelector('#series-select option[value="' + sid + '"]');
      const ma = document.querySelector('#mod-select option[value="' + a + '"]');
      const mb = document.querySelector('#mod-select option[value="' + b + '"]');
      return ser && ma && mb;
    }, {}, SERIES, MOD_A, MOD_B);

    // Choose the series -> #mod-select should point at module 1.
    await ctl.select('#series-select', SERIES);
    await until(async () => (await ctl.$eval('#mod-select', (e) => e.value)) === MOD_A, { label: 'mod-select queued to module 1', timeout: 5000 });
    const nav1 = await ctl.evaluate(() => window.__gm.series());
    expect(nav1.pos === 0 && nav1.mods.length === 2, 'series active at position 0', JSON.stringify(nav1));
    const nextDisabled1 = await ctl.$eval('#series-next', (b) => b.disabled);
    expect(nextDisabled1 === false, '"Next in series" enabled (not at end)', 'disabled=' + nextDisabled1);

    // Advance -> #mod-select should point at module 2, and the button disables at the end.
    await ctl.click('#series-next');
    await until(async () => (await ctl.$eval('#mod-select', (e) => e.value)) === MOD_B, { label: 'mod-select advanced to module 2', timeout: 5000 });
    const nav2 = await ctl.evaluate(() => window.__gm.series());
    expect(nav2.pos === 1, 'series advanced to position 1', JSON.stringify(nav2));
    const nextDisabled2 = await ctl.$eval('#series-next', (b) => b.disabled);
    expect(nextDisabled2 === true, '"Next in series" disabled at the end', 'disabled=' + nextDisabled2);

    await ctl.close();
  } finally { await browser.close(); await server.close(); cleanup(); }
});
