/*
 * Plan 0529 P2 — THE SEVEN CALL SITES, DRIVEN IN A REAL BROWSER.
 *
 * WHY THIS FILE EXISTS AT ALL. Gating a route is three lines; the risk in this phase was never the
 * gate, it was the OTHER half — every place that already read those routes and sent no credential.
 * Miss one and it does not fail loudly: the GM's panel simply has an empty picker, mid-session,
 * with no error on screen. The server-side unit tests cannot see that. Only a browser can, because
 * only a browser runs the page's own fetches with the page's own headers.
 *
 * THE SEVEN, all on control-role pages, none of which sent a credential before this phase:
 *   control.html  — the module LIST (refreshModules)
 *                 — the module READ on picking one (#mod-select onchange)
 *                 — the module RE-READ when the file changes on disk (onModuleChanged, ?fresh=)
 *                 — the series LIST (refreshSeries)
 *                 — the series READ on picking one (#series-select onchange)
 *   creator.html  — the module LIST (refreshList, the Load picker)
 *                 — the module READ on Load
 *
 * t01 drives all seven against a GATED server and asserts each one produced its RESULT, not merely
 * that it was issued: options in a picker, a beat body in memory, a re-read that reflects disk.
 *
 * t02 is the control: the SAME seven surfaces on the same gated server with NO credential. Every
 * one must come up empty. Without it, t01 would pass identically on a server that never gated
 * anything — which is the whole class of "a gate you have only seen pass is untested".
 *
 * t03 pins the claim the plan makes about cost: the AUDIENCE page is untouched. It is asserted from
 * the network, not from reading the source — every request the participant page issues is recorded,
 * and none of them is a catalogue route.
 *
 * NAMES: invented and obviously fictional throughout (plan 0529 §0 / guard t0531-01).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, waitContentFrame } from '../../harness/multi.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const MOD_A = 'surf-alpha', MOD_B = 'surf-beta', SERIES = 'surf-run';
const TOKEN = 'surf-gate-token';
const PATIENT = 90000;

const deck = (title, ids) => ({
  manifest: { title },
  beats: ids.map((i) => ({ id: i, component: 'card', opts: { title: 'Beat ' + i } })),
});

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0529-p2s-'));
  writeFileSync(join(dir, MOD_A + '.json'), JSON.stringify(deck('Alpha Chapter', ['a1', 'a2'])));
  writeFileSync(join(dir, MOD_B + '.json'), JSON.stringify(deck('Beta Chapter', ['b1'])));
  writeFileSync(join(dir, SERIES + '.series.json'), JSON.stringify({
    manifest: { title: 'A Two-Part Run' }, moduleIds: [MOD_A, MOD_B],
  }));
  return dir;
}
async function boot(dir, opts) {
  const prev = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_MODULES_DIR = dir;
  try { return await createServer(Object.assign({ port: 0 }, opts || {})); }
  finally { if (prev === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prev; }
}

// Poll from the TEST process, not via requestAnimationFrame: Chrome pauses rAF in a backgrounded
// tab, so page.waitForFunction expires against pages that are perfectly healthy (diagnosed in
// plan 0522 P13). page.evaluate runs on demand and does not care which tab is frontmost.
const waitFor = (pg, fn, label, ...args) =>
  until(() => pg.evaluate(fn, ...args), { timeout: PATIENT, every: 150, label });

const modOptions = (pg) => pg.evaluate(() => document.getElementById('mod-select').options.length);
const seriesOptions = (pg) => pg.evaluate(() => document.getElementById('series-select').options.length);

test('t0529-p2-04 — all SEVEN catalogue call sites work on a gated server (the GM desk is whole)', async () => {
  const dir = fixtureDir();
  const server = await boot(dir, { controlToken: TOKEN });
  const browser = await launch();
  const errs = [];
  try {
    // ── control.html, credentialed by ?token= (the ordinary presenter_start / overlay path) ──
    const ctl = await browser.newPage();
    ctl.setDefaultTimeout(PATIENT);
    ctl.on('pageerror', (e) => { errs.push('control: ' + e.message); });
    await ctl.goto(`${server.url()}/control?userId=op&role=presenter&token=${TOKEN}`,
      { waitUntil: 'domcontentloaded', timeout: PATIENT });

    // SITE 1 — the module LIST (refreshModules).
    await waitFor(ctl, () => document.getElementById('mod-select').options.length > 1,
      'control module picker populated');
    const listed = await ctl.evaluate(() => Array.from(document.getElementById('mod-select').options).map((o) => o.value));
    expect('SITE 1 (control refreshModules) — both modules are in the picker',
      listed.includes(MOD_A) && listed.includes(MOD_B), JSON.stringify(listed));

    // SITE 2 — the module READ on picking one (#mod-select onchange).
    await ctl.evaluate((i) => { const s = document.getElementById('mod-select'); s.value = i; s.onchange(); }, MOD_A);
    await waitFor(ctl, () => { const m = window.__gm && window.__gm.module(); return !!m && (m.beats || []).length === 2; },
      'the picked module body arrived');
    expect('SITE 2 (control #mod-select onchange) — the module BODY arrived, not just a 200', true);

    // SITE 3 — the module RE-READ when the file changes on disk (onModuleChanged, ?fresh=).
    // The fs watcher fires module_changed; the page re-fetches the SELECTED module. If this site
    // were unauthenticated it would silently keep the stale copy and print the "reload FAILED"
    // note — a panel rendering content that is no longer on disk.
    writeFileSync(join(dir, MOD_A + '.json'), JSON.stringify(deck('Alpha Chapter', ['a1', 'a2', 'a3'])));
    await waitFor(ctl, () => { const m = window.__gm && window.__gm.module(); return !!m && (m.beats || []).length === 3; },
      'the on-disk change was re-read through the gated route');
    const info = await ctl.evaluate(() => document.getElementById('mod-info').textContent);
    expect('SITE 3 (control onModuleChanged ?fresh=) — re-read succeeded, no "reload FAILED" note',
      !/reload FAILED/.test(info), info);

    // SITE 4 — the series LIST (refreshSeries).
    await waitFor(ctl, () => document.getElementById('series-select').options.length > 1,
      'control series picker populated');
    const sListed = await ctl.evaluate(() => Array.from(document.getElementById('series-select').options).map((o) => o.value));
    expect('SITE 4 (control refreshSeries) — the series is in the picker', sListed.includes(SERIES), JSON.stringify(sListed));

    // SITE 5 — the series READ on picking one (#series-select onchange) — it resolves the series
    // and queues its FIRST module, so a working site is observable as the module picker moving.
    await ctl.evaluate((i) => { const s = document.getElementById('series-select'); s.value = i; s.onchange(); }, SERIES);
    await waitFor(ctl, (id) => document.getElementById('mod-select').value === id,
      'the series queued its first module', MOD_A);
    expect('SITE 5 (control #series-select onchange) — the series resolved and queued module 1', true);

    // ── creator.html, credentialed the same way ──
    const cre = await browser.newPage();
    cre.setDefaultTimeout(PATIENT);
    cre.on('pageerror', (e) => { errs.push('creator: ' + e.message); });
    await cre.goto(`${server.url()}/creator?userId=op&role=presenter&token=${TOKEN}`,
      { waitUntil: 'domcontentloaded', timeout: PATIENT });

    // SITE 6 — the creator's Load picker (refreshList).
    await waitFor(cre, () => document.getElementById('load-select').options.length > 0, 'creator load picker populated');
    const cListed = await cre.evaluate(() => Array.from(document.getElementById('load-select').options).map((o) => o.value));
    expect('SITE 6 (creator refreshList) — both modules are loadable', cListed.includes(MOD_A) && cListed.includes(MOD_B),
      JSON.stringify(cListed));

    // SITE 7 — the creator's Load (loadModule). Success is the EDITOR filling, not a status code.
    await cre.evaluate((i) => { document.getElementById('load-select').value = i; document.getElementById('btn-load').click(); }, MOD_B);
    await waitFor(cre, () => /loaded/.test(document.getElementById('save-msg').textContent), 'creator reported a load');
    const loadedId = await cre.evaluate(() => document.getElementById('save-id').value);
    expect('SITE 7 (creator loadModule) — the module loaded into the editor', loadedId === MOD_B, loadedId);

    expect('no page errors on either control-role page', errs.length === 0, JSON.stringify(errs));
  } finally { await browser.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('t0529-p2-05 — the SAME seven surfaces come up EMPTY with no credential (t04 is not passing on an open server)', async () => {
  const dir = fixtureDir();
  const server = await boot(dir, { controlToken: TOKEN });
  const browser = await launch();
  try {
    // Identical urls to t04, minus the token. The pages still load — this is not a login wall, the
    // panel is simply not given content it cannot prove it may read.
    const ctl = await browser.newPage();
    ctl.setDefaultTimeout(PATIENT);
    await ctl.goto(`${server.url()}/control?userId=op&role=presenter`, { waitUntil: 'domcontentloaded', timeout: PATIENT });
    await waitFor(ctl, () => !!window.__gm, 'control page booted');
    // Give every fetch the page will ever make time to land and fail.
    await until(async () => (await modOptions(ctl)) >= 1, { timeout: 10000, every: 150, label: 'picker settled' }).catch(() => {});

    // 1 option = the placeholder only. The catalogue never arrived.
    expect('SITES 1–3 (control modules) — the picker holds only its placeholder',
      (await modOptions(ctl)) <= 1, String(await modOptions(ctl)));
    expect('SITES 4–5 (control series) — the series picker holds only its placeholder',
      (await seriesOptions(ctl)) <= 1, String(await seriesOptions(ctl)));
    expect('and no module body was obtained', await ctl.evaluate(() => !window.__gm.module()), 'a module body leaked');

    const cre = await browser.newPage();
    cre.setDefaultTimeout(PATIENT);
    await cre.goto(`${server.url()}/creator?userId=op&role=presenter`, { waitUntil: 'domcontentloaded', timeout: PATIENT });
    await until(async () => (await cre.evaluate(() => !!document.getElementById('load-select'))), { timeout: 10000, every: 150, label: 'creator booted' });
    await until(async () => (await cre.evaluate(() => document.getElementById('load-select').options.length > 0)),
      { timeout: 5000, every: 150, label: 'creator picker (expected to stay empty)' }).catch(() => {});
    expect('SITES 6–7 (creator) — the Load picker is empty',
      await cre.evaluate(() => document.getElementById('load-select').options.length === 0),
      String(await cre.evaluate(() => document.getElementById('load-select').options.length)));
  } finally { await browser.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('t0529-p2-06 — PLAYER-VISIBLE COST IS NONE: the audience page never requests a catalogue route', async () => {
  const dir = fixtureDir();
  const server = await boot(dir, { controlToken: TOKEN });
  const browser = await launch();
  try {
    const pg = await browser.newPage();
    pg.setDefaultTimeout(PATIENT);
    // ⛓ Measured from the NETWORK, not read off the source. A claim that a page "never touches"
    // a route is exactly the kind of thing that is true when written and false a year later.
    const requested = [];
    pg.on('request', (r) => { try { requested.push(new URL(r.url()).pathname); } catch (e) {} });
    const errs = [];
    pg.on('pageerror', (e) => errs.push(e.message));

    // A participant with NO credential — the state every player is in.
    await pg.goto(`${server.url()}/?userId=viewer-one&name=Viewer&role=participant`,
      { waitUntil: 'domcontentloaded', timeout: PATIENT });
    // Drive it to a real working state so the assertion is about a LIVE page, not a blank one:
    // the presenter loads a module and shows a beat, and the participant renders it.
    server.setModule(deck('Alpha Chapter', ['a1', 'a2']));
    server.showBeat('a1');
    const frame = await waitContentFrame(pg, { timeout: PATIENT });
    expect('the audience page rendered a live beat with no credential of any kind', !!frame);

    const catalogue = requested.filter((p) => p === '/api/modules' || p.startsWith('/api/modules/')
      || p === '/api/series' || p.startsWith('/api/series/'));
    expect('the audience page issued ZERO catalogue requests', catalogue.length === 0, JSON.stringify(catalogue));

    const apis = requested.filter((p) => p.startsWith('/api/'));
    expect('the ONLY api route the audience page touches is /api/auth',
      apis.length > 0 && apis.every((p) => p === '/api/auth'), JSON.stringify(Array.from(new Set(apis))));
    expect('and it produced no page errors', errs.length === 0, JSON.stringify(errs));
  } finally { await browser.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
