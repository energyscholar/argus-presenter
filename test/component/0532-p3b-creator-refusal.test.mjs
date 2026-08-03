/*
 * Plan 0532 P3b — THE CREATOR PAGE SAYS WHY THE LOAD PICKER IS EMPTY. DRIVEN IN A REAL BROWSER.
 *
 * P3 made the refusal legible on app/control.html and named that page only. app/creator.html had
 * the identical hole — 0529 P2's call sites 6 and 7 — and it was WORSE here: refreshList() emptied
 * the <select> and only THEN choked on the 403 body, inside a .catch(function(){}). The operator
 * got a picker with zero options, a swallowed exception, and no words on the page at all.
 *
 * WHY A BROWSER. The server half is unchanged and already proved by
 * test/unit/0532-p3-refusal-reason.test.mjs; nothing about it is re-asserted here. What only a
 * browser can show is that the OPERATOR SEES the reason, and that is the entire failure.
 *
 * THE FOUR STATES, in the order that makes the last one mean something:
 *   t01 UNCONFIGURED — the notice is up and names the knob to turn. A configuration fault.
 *                      Both call sites are exercised: the picker (6) and the Load itself (7).
 *   t02 CONFIGURED, no credential — the notice is up and says nothing about the configuration.
 *                      ⛓ The same screen must not tell a stranger how the box is set up.
 *   t03 THE LAYOUT BUDGET, measured at 800x600. This page is tighter than the control page, not
 *                      roomier — see the numbers in the test itself.
 *   t04 CONFIGURED, credentialed — the notice is ABSENT and the picker fills. Without this the
 *                      first three would pass on a page that shows the warning permanently.
 *
 * ⛔ FAIL-CLOSED IS UNCHANGED, and it is checked in both refusing states: the picker holds zero
 * options, exactly as t0529-p2-05 requires. A "helpful" empty state that also handed over the list
 * would be a far worse bug than the blank one.
 *
 * NAMES: invented and obviously fictional throughout (plan 0529 SS0 / guard t0531-01).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until } from '../../harness/multi.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const MOD_A = 'creator-notice-alpha', MOD_B = 'creator-notice-beta';
const TOKEN = 'creator-notice-token';
const PATIENT = 90000;

const deck = (title, ids) => ({
  manifest: { title },
  beats: ids.map((i) => ({ id: i, component: 'card', opts: { title: 'Beat ' + i } })),
});

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0532-p3b-'));
  writeFileSync(join(dir, MOD_A + '.json'), JSON.stringify(deck('Alpha Chapter', ['a1', 'a2'])));
  writeFileSync(join(dir, MOD_B + '.json'), JSON.stringify(deck('Beta Chapter', ['b1'])));
  return dir;
}
async function boot(dir, opts) {
  const prev = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_MODULES_DIR = dir;
  try { return await createServer(Object.assign({ port: 0 }, opts || {})); }
  finally { if (prev === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prev; }
}

/*
 * What the operator can actually read, split the way the page splits it:
 *   cause — the always-visible line, costing this section ONE line of height
 *   fix   — the remedy, one click down inside the <details>
 */
const notice = (pg) => pg.evaluate(() => {
  const el = document.getElementById('load-notice');
  if (!el) return { present: false, shown: false, cause: '', fix: '', height: 0, selectTitle: '' };
  const g = (id) => (document.getElementById(id) || {}).textContent || '';
  return {
    present: true,
    shown: !el.hidden,
    open: !!el.open,
    cause: g('load-notice-cause'),
    fix: g('load-notice-fix'),
    height: Math.round(el.getBoundingClientRect().height),
    selectTitle: document.getElementById('load-select').title || '',
  };
});
const expandNotice = (pg) => pg.evaluate(() => { document.getElementById('load-notice').open = true; });
const loadOptions = (pg) => pg.evaluate(() => document.getElementById('load-select').options.length);
const saveMsg = (pg) => pg.evaluate(() => document.getElementById('save-msg').textContent || '');

async function openCreator(browser, url, viewport) {
  const pg = await browser.newPage();
  pg.setDefaultTimeout(PATIENT);
  if (viewport) await pg.setViewport(viewport);
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: PATIENT });
  await until(() => pg.evaluate(() => !!window.__creator), { timeout: PATIENT, every: 150, label: 'creator page booted' });
  return { pg, errs };
}

test('t0532-p3b-01 — UNCONFIGURED server: the creator names what to configure, on BOTH call sites', async () => {
  const dir = fixtureDir();
  const server = await boot(dir, {});          // no controlToken, no rolePassword
  const browser = await launch();
  try {
    const { pg, errs } = await openCreator(browser, `${server.url()}/creator?userId=op&role=presenter`);
    // ⚠ until() resolves to `true`, not to the value the predicate saw — read the notice again
    // afterwards rather than asserting on a boolean.
    await until(async () => (await notice(pg)).shown,
      { timeout: 20000, every: 200, label: 'the refusal notice appeared' });
    const n = await notice(pg);

    // ── SITE 6: the Load picker (refreshList) ──
    expect('the notice is on screen', n.shown, JSON.stringify(n));
    expect('the visible line says nothing is listed and why', /Nothing listed/.test(n.cause)
      && /no control credential is configured/.test(n.cause), n.cause);
    expect('before the click the remedy is not on screen', !n.open, JSON.stringify(n));
    await expandNotice(pg);
    const open = await notice(pg);
    expect('one click reveals the knobs to turn', /rolePassword/.test(open.fix) && /controlToken/.test(open.fix), open.fix);
    expect('and it says the catalogue FAILS CLOSED rather than that there is no content',
      /fails closed/.test(open.fix), open.fix);
    expect('the picker\'s own tooltip carries cause AND remedy',
      /no control credential/.test(open.selectTitle) && /rolePassword/.test(open.selectTitle), open.selectTitle);
    // ⛔ Legible, not open. t0529-p2-05 asserts exactly this count on this page.
    expect('and the picker still holds ZERO options', (await loadOptions(pg)) === 0,
      String(await loadOptions(pg)));

    // ── SITE 7: the Load itself (loadModule). Refused where it used to print a bare HTTP code. ──
    const res = await pg.evaluate((id) => window.__creator.load(id), MOD_A);
    expect('a refused Load resolves rather than throwing', !!res, JSON.stringify(res));
    expect('the Load points the reader at the notice instead of a status code',
      /refused/.test(await saveMsg(pg)) && !/HTTP/.test(await saveMsg(pg)), await saveMsg(pg));
    const after = await notice(pg);
    expect('and the notice is still the one that names the configuration',
      after.shown && /no control credential is configured/.test(after.cause), JSON.stringify(after));
    expect('no module body reached the editor', await pg.evaluate(() => window.__creator.getModule().beats.length) === 0,
      String(await pg.evaluate(() => window.__creator.getModule().beats.length)));
    expect('no page errors', errs.length === 0, JSON.stringify(errs));
  } finally { await browser.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('t0532-p3b-02 — CONFIGURED server, no credential: the notice describes the CALLER, not the server', async () => {
  const dir = fixtureDir();
  const server = await boot(dir, { controlToken: TOKEN });
  const browser = await launch();
  try {
    const { pg, errs } = await openCreator(browser, `${server.url()}/creator?userId=op&role=presenter`);
    await until(async () => (await notice(pg)).shown,
      { timeout: 20000, every: 200, label: 'the refusal notice appeared' });
    await expandNotice(pg);
    const n = await notice(pg);

    expect('the notice is on screen', n.shown, JSON.stringify(n));
    expect('the visible line says this page is not unlocked', /not unlocked/.test(n.cause), n.cause);
    expect('the remedy points at unlocking, the reader\'s actual next move', /[Uu]nlock/.test(n.fix), n.fix);
    // ⛓ The disclosure line, checked on EVERY string this screen can show — the visible one, the
    // one behind the click, and the tooltip. This page is reachable by anyone who can reach the box.
    const all = n.cause + ' ' + n.fix + ' ' + n.selectTitle;
    expect('nothing on this screen names the server configuration',
      !/rolePassword|controlToken|fails closed/.test(all), all);
    expect('the picker still holds ZERO options', (await loadOptions(pg)) === 0,
      String(await loadOptions(pg)));
    expect('no page errors', errs.length === 0, JSON.stringify(errs));
  } finally { await browser.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

/*
 * ⛓ THE LAYOUT BUDGET, AND IT IS TIGHTER HERE THAN ON THE CONTROL PAGE.
 *
 * P3's first attempt at the control page was a three-sentence block: 153 px in a 200 px column at
 * 800x600, and it pushed V0473's one-click resolve off screen. The obvious assumption — that the
 * creator, with a whole 340 px column and a scrollable body, has more room — is WRONG, and these
 * are the measured numbers rather than an argument:
 *
 *   at 800x600, empty document, catalogue REFUSED
 *     left column         548 px tall, floor at y=590
 *     Save / Load section  BEFORE 116 px, ending y=565  ⇒  25 px of slack, and it is the LAST
 *                          ...section in the column
 *     Save / Load section  AFTER  140 px, ending y=588  ⇒  2 px of slack
 *     the collapsed notice  17 px + 6 px margin
 *   at 800x600, catalogue SERVED: the section is 116 px and ends at y=565, byte for byte the
 *     before-state — a hidden notice costs nothing.
 *
 * ⇒ There is no room for a paragraph here. A three-sentence block would put the notice and the
 * save message below the fold at the exact moment the operator needs to read them. If this test
 * goes red at 2-3 px over, that is the budget being genuinely spent, not the test being fussy.
 */
test('t0532-p3b-03 — the notice costs ~one line, and Save / Load still fits the column at 800x600', async () => {
  const dir = fixtureDir();
  const server = await boot(dir, {});
  const browser = await launch();
  try {
    const { pg, errs } = await openCreator(browser, `${server.url()}/creator?userId=op&role=presenter`,
      { width: 800, height: 600 });
    await until(async () => (await notice(pg)).shown,
      { timeout: 20000, every: 200, label: 'the refusal notice appeared' });
    const n = await notice(pg);

    // Collapsed, the whole notice costs about one line. Parity with the control page's t0532-p3-04.
    expect('collapsed, the notice costs ~one line (<= 40px)', n.height > 0 && n.height <= 40,
      n.height + 'px');

    const box = await pg.evaluate(() => {
      const col = document.querySelectorAll('.col')[0];
      const secs = col.querySelectorAll('section');
      const sl = secs[secs.length - 1].getBoundingClientRect();     // Save / Load, the last section
      const c = col.getBoundingClientRect();
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      return {
        colBottom: Math.round(c.bottom), colScrolls: col.scrollHeight > col.clientHeight + 1,
        saveLoadHeight: Math.round(sl.height), saveLoadBottom: Math.round(sl.bottom),
        pickerBottom: Math.round(r('load-select').bottom), loadBtnBottom: Math.round(r('btn-load').bottom),
      };
    });
    // The controls themselves must stay reachable — this is the failure P3 actually hit.
    expect('the Load picker is still inside the visible column', box.pickerBottom <= box.colBottom, JSON.stringify(box));
    expect('the Load button is still inside the visible column', box.loadBtnBottom <= box.colBottom, JSON.stringify(box));
    // ⛓ And the notice the operator must read is on screen without scrolling, empty-document.
    expect('the whole Save / Load section still fits, notice included', box.saveLoadBottom <= box.colBottom,
      JSON.stringify(box));
    expect('an empty document does not need the column scrolled to read it', !box.colScrolls, JSON.stringify(box));
    expect('no page errors', errs.length === 0, JSON.stringify(errs));
  } finally { await browser.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('t0532-p3b-04 — CONFIGURED server, credentialed: no notice at all, and the picker fills', async () => {
  const dir = fixtureDir();
  const server = await boot(dir, { controlToken: TOKEN });
  const browser = await launch();
  try {
    const { pg, errs } = await openCreator(browser,
      `${server.url()}/creator?userId=op&role=presenter&token=${TOKEN}`, { width: 800, height: 600 });
    await until(async () => (await loadOptions(pg)) > 0, { timeout: 20000, every: 150, label: 'picker populated' });

    const listed = await pg.evaluate(() => Array.from(document.getElementById('load-select').options).map((o) => o.value));
    expect('the catalogue arrived intact', listed.includes(MOD_A) && listed.includes(MOD_B), JSON.stringify(listed));
    const n = await notice(pg);
    expect('the notice element exists but is hidden', n.present && !n.shown, JSON.stringify(n));
    expect('and carries no text at all', !n.cause.trim() && !n.fix.trim(), JSON.stringify(n));
    expect('and the picker carries no warning tooltip either', !n.selectTitle.trim(), n.selectTitle);
    // A hidden notice must cost the layout nothing — otherwise the working case pays for the broken one.
    expect('the hidden notice occupies zero pixels', n.height === 0, n.height + 'px');
    expect('no page errors', errs.length === 0, JSON.stringify(errs));
  } finally { await browser.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
