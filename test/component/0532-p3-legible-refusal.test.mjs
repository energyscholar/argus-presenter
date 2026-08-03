/*
 * Plan 0532 P3 — THE CONTROL PAGE SAYS WHY THE PICKER IS EMPTY. DRIVEN IN A REAL BROWSER.
 *
 * WHY A BROWSER. The server-side half (test/unit/0532-p3-refusal-reason.test.mjs) proves the two
 * refusals are distinct and actionable. It cannot prove the operator ever SEES one — that is the
 * whole failure being fixed here, and it lives in the page's own fetch handlers, which only a
 * browser runs. 0529 P2's own component test already showed the empty picker; nothing showed that
 * the emptiness was explained, because it was not.
 *
 * THE THREE STATES, and they are asserted in the order that makes the last one mean something:
 *   t04 UNCONFIGURED  — the notice is up and names the knob to turn. A configuration fault.
 *   t05 CONFIGURED, no credential — the notice is up and says nothing about the configuration.
 *                       ⛓ The same screen must not tell a stranger how the box is set up.
 *   t06 CONFIGURED, credentialed — the notice is ABSENT and the picker fills. Without this the
 *                       first two would pass on a page that shows the warning permanently.
 *
 * ⛔ FAIL-CLOSED IS UNCHANGED, and it is checked in both refusing states: the picker holds its
 * placeholder and nothing else. A "helpful" empty state that also handed over the list would be a
 * far worse bug than the blank one.
 *
 * NAMES: invented and obviously fictional throughout (plan 0529 §0 / guard t0531-01).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until } from '../../harness/multi.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const MOD_A = 'notice-alpha', MOD_B = 'notice-beta';
const TOKEN = 'notice-gate-token';
const PATIENT = 90000;

const deck = (title, ids) => ({
  manifest: { title },
  beats: ids.map((i) => ({ id: i, component: 'card', opts: { title: 'Beat ' + i } })),
});

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0532-p3c-'));
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
 *   cause — the always-visible line, costing the header ONE line of height
 *   fix   — the remedy, one click down inside the <details>
 * `height` is the collapsed pixel cost, and it is asserted: this page is a `grid auto 1fr`, so
 * every pixel the header takes is a pixel the digest column loses. A paragraph here measured
 * 153 px at 800×600 and pushed the one-click resolve off-screen.
 */
const notice = (pg) => pg.evaluate(() => {
  const el = document.getElementById('mod-notice');
  if (!el) return { present: false, shown: false, cause: '', fix: '', height: 0 };
  const g = (id) => (document.getElementById(id) || {}).textContent || '';
  return {
    present: true,
    shown: !el.hidden,
    open: !!el.open,
    cause: g('mod-notice-cause'),
    fix: g('mod-notice-fix'),
    height: Math.round(el.getBoundingClientRect().height),
    selectTitle: document.getElementById('mod-select').title || '',
  };
});
/** Open the disclosure and read the remedy as a human would after one click. */
const expandNotice = (pg) => pg.evaluate(() => { document.getElementById('mod-notice').open = true; });
const modOptions = (pg) => pg.evaluate(() => document.getElementById('mod-select').options.length);

async function openControl(browser, url) {
  const pg = await browser.newPage();
  pg.setDefaultTimeout(PATIENT);
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: PATIENT });
  await until(() => pg.evaluate(() => !!window.__gm), { timeout: PATIENT, every: 150, label: 'control page booted' });
  return { pg, errs };
}

test('t0532-p3-04 — UNCONFIGURED server: the control page shows a notice naming what to configure', async () => {
  const dir = fixtureDir();
  const server = await boot(dir, {});          // no controlToken, no rolePassword
  const browser = await launch();
  try {
    const { pg, errs } = await openControl(browser, `${server.url()}/control?userId=op&role=presenter`);
    // ⚠ until() resolves to `true`, not to the value the predicate saw — read the notice again
    // afterwards rather than asserting on a boolean.
    await until(async () => (await notice(pg)).shown,
      { timeout: 20000, every: 200, label: 'the refusal notice appeared' });
    const n = await notice(pg);

    expect('the notice is on screen', n.shown, JSON.stringify(n));
    // The CAUSE, with no interaction at all.
    expect('the visible line says nothing is listed and why', /Nothing listed/.test(n.cause)
      && /no control credential is configured/.test(n.cause), n.cause);
    // ⛓ The layout budget. Collapsed, the whole notice costs about one line.
    expect('collapsed, it costs the header ~one line (<= 40px)', n.height > 0 && n.height <= 40,
      n.height + 'px');
    // The REMEDY, one click down — and the click is performed, not assumed.
    expect('before the click the remedy is not on screen', !n.open, JSON.stringify(n));
    await expandNotice(pg);
    const open = await notice(pg);
    expect('one click reveals the knobs to turn', /rolePassword/.test(open.fix) && /controlToken/.test(open.fix), open.fix);
    expect('and it says the catalogue FAILS CLOSED rather than that there is no content',
      /fails closed/.test(open.fix), open.fix);
    // The picker itself carries the whole thing, because that is where the operator is looking.
    expect('the picker\'s own tooltip carries cause AND remedy',
      /no control credential/.test(open.selectTitle) && /rolePassword/.test(open.selectTitle), open.selectTitle);
    // ⛔ Legible, not open.
    expect('and the picker still holds only its placeholder', (await modOptions(pg)) <= 1,
      String(await modOptions(pg)));
    expect('no page errors', errs.length === 0, JSON.stringify(errs));
  } finally { await browser.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('t0532-p3-05 — CONFIGURED server, no credential: the notice is up and describes the CALLER, not the server', async () => {
  const dir = fixtureDir();
  const server = await boot(dir, { controlToken: TOKEN });
  const browser = await launch();
  try {
    const { pg, errs } = await openControl(browser, `${server.url()}/control?userId=op&role=presenter`);
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
    expect('the picker still holds only its placeholder', (await modOptions(pg)) <= 1,
      String(await modOptions(pg)));
    expect('no page errors', errs.length === 0, JSON.stringify(errs));
  } finally { await browser.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('t0532-p3-06 — CONFIGURED server, credentialed: no notice at all, and the picker fills', async () => {
  const dir = fixtureDir();
  const server = await boot(dir, { controlToken: TOKEN });
  const browser = await launch();
  try {
    const { pg, errs } = await openControl(browser,
      `${server.url()}/control?userId=op&role=presenter&token=${TOKEN}`);
    await until(async () => (await modOptions(pg)) > 1, { timeout: 20000, every: 150, label: 'picker populated' });

    const listed = await pg.evaluate(() => Array.from(document.getElementById('mod-select').options).map((o) => o.value));
    expect('the catalogue arrived intact', listed.includes(MOD_A) && listed.includes(MOD_B), JSON.stringify(listed));
    const n = await notice(pg);
    expect('the notice element exists but is hidden', n.present && !n.shown, JSON.stringify(n));
    expect('and carries no text at all', !n.cause.trim() && !n.fix.trim(), JSON.stringify(n));
    expect('and the picker carries no warning tooltip either', !n.selectTitle.trim(), n.selectTitle);
    expect('no page errors', errs.length === 0, JSON.stringify(errs));
  } finally { await browser.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
