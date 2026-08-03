/*
 * Plan 0534 W4c — THE PARTICIPANT CONTROL FOR `peek`.
 *
 * W4b put `{t:'peek', surfaceUid}` / `{t:'unpeek'}` on the wire and said plainly that nothing on
 * `app/presenter.html` could send either. A verb only a raw websocket client can say is not a
 * feature: the deck is meant to be SHARED, which means a participant calls it up themselves.
 *
 *   t0534-w4c-01  a participant reaches a declared surface WITH NO WEBSOCKET CLIENT — the picker
 *                 lists the peekable surface (and only that one), choosing it renders the surface,
 *                 and the wire frame carries an INTEGER uid (naming canon §3).
 *   t0534-w4c-02  the peeking STATE is legible without opening Settings, and the badge is itself
 *                 the way back: one click and the room's screen is on the display again.
 *   t0534-w4c-03  a deployment that declares no surfaces renders NO control at all — an empty
 *                 picker is worse than no picker.
 *
 * ⚠ VISIBILITY IS ASSERTED WITH checkVisibility(), NEVER WITH A RECT — same reason as 0522 P13: a
 * zero-opacity node and one inside a display:none ancestor both keep non-zero boxes. Every test
 * first asserts the API exists, so a browser without it fails loudly instead of passing on
 * `undefined`.
 *
 * ⚠ ONE BROWSER, ONE PAGE per test, closed in a finally — a backgrounded second page stalls
 * `waitForFunction` in unrelated files (the P12 intermittent).
 *
 * The rendered surface lands in a SANDBOXED iframe with an opaque origin, so its DOM is
 * unreachable from the test. `#frame`'s `srcdoc` is the artifact that is actually readable, and it
 * is the same string the server sent — checking it is checking what was rendered, not a claim.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { makePluginsDir } from '../unit/_0514-fixtures.mjs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PATIENT = 60000;
const OPEN_MARK = 'W4C-OPEN-SURFACE-MARK';
const SHUT_MARK = 'W4C-SHUT-SURFACE-MARK';
const ROOM_MARK = 'W4C-ROOM-MARK';
const OPEN_LABEL = 'The open screen';
const SHUT_LABEL = 'The closed screen';

/*
 * One plugin, two surfaces: one offered to viewers, one that never said it may be. The second is
 * the whole reason the picker is filtered client-side — listing a row the server would refuse by
 * name is a control that lies.
 */
const SURFACES = {
  name: 'w4csurf', requires: [], components: [], presets: {}, fieldSchemas: {},
  surfaces: [
    { surfaceId: 'open-screen', surfaceLabel: OPEN_LABEL, peekable: true, icon: '#', sortOrder: 1,
      screen: { component: 'card', opts: { title: OPEN_LABEL, body: OPEN_MARK } } },
    { surfaceId: 'shut-screen', surfaceLabel: SHUT_LABEL, sortOrder: 2,
      screen: { component: 'card', opts: { title: SHUT_LABEL, body: SHUT_MARK } } },
  ],
};

/** A plugin that declares nothing — the deployment that must see no change whatsoever. */
const BARE = { name: 'w4cbare', requires: [], components: [], presets: {}, fieldSchemas: {} };

/*
 * ⛔ PRESENTER_MODULES_DIR is set even though nothing here loads a module: left unset, createServer
 * scans AND WATCHES the repo's real `modules/`, the one directory with no version history.
 */
async function boot({ surfaces }) {
  const dir = makePluginsDir(surfaces
    ? { w4csurf: { 'plugin.json': SURFACES } }
    : { w4cbare: { 'plugin.json': BARE } });
  const mods = mkdtempSync(join(tmpdir(), 'ap-0534-w4c-mod-'));
  const prevP = process.env.PRESENTER_PLUGINS_DIR;
  const prevM = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_PLUGINS_DIR = dir;
  process.env.PRESENTER_MODULES_DIR = mods;
  let server;
  try { server = await createServer({ port: 0 }); }
  finally {
    if (prevP === undefined) delete process.env.PRESENTER_PLUGINS_DIR; else process.env.PRESENTER_PLUGINS_DIR = prevP;
    if (prevM === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prevM;
  }
  return { dir, mods, server };
}

/** Open the display page as one participant, recording every websocket frame it SENDS. */
async function openDisplay(browser, server, query, errs) {
  const pg = await browser.newPage();
  pg.setDefaultTimeout(PATIENT);
  pg.on('pageerror', (e) => { if (errs) errs.push(e.message); console.log('DISPLAY PAGEERR', e.message); });
  await pg.evaluateOnNewDocument(() => {
    window.__sent = [];
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { try { window.__sent.push(String(d)); } catch (e) {} return orig.call(this, d); };
  });
  await pg.goto(`${server.url()}/?${query}`, { waitUntil: 'domcontentloaded', timeout: PATIENT });
  return pg;
}

/** Everything the assertions need, read in ONE evaluate so it is a single consistent moment. */
const peekState = (pg) => pg.evaluate(() => {
  const vis = (el) => (el && typeof el.checkVisibility === 'function' ? el.checkVisibility() : 'NO-API');
  const sel = document.getElementById('cfg-surface-select');
  const badge = document.getElementById('ap-peek');
  const frame = document.getElementById('frame');
  return {
    hasApi: !!(badge && typeof badge.checkVisibility === 'function'),
    rowPresent: !!document.getElementById('cfg-surface-row'),
    rowVisible: vis(document.getElementById('cfg-surface-row')),
    selVisible: vis(sel),
    selValue: sel ? sel.value : null,
    options: sel ? Array.from(sel.querySelectorAll('option')).map((o) => ({ value: o.value, text: o.textContent })) : null,
    backVisible: vis(document.getElementById('cfg-surface-back-row')),
    badgePresent: !!badge,
    badgeVisible: vis(badge),
    badgeText: badge ? badge.textContent : null,
    badgeLabel: document.getElementById('ap-peek-v') ? document.getElementById('ap-peek-v').textContent : null,
    cfgOpen: document.getElementById('ap-config') ? document.getElementById('ap-config').classList.contains('open') : null,
    srcdoc: frame ? (frame.getAttribute('srcdoc') || '') : null,
    sent: (window.__sent || []).slice(),
  };
});

/** Open Settings the way a human does — the connectivity dot IS the settings button. */
async function openSettings(pg) {
  await pg.click('#led-btn');
  await until(async () => (await pg.evaluate(() => document.getElementById('ap-config').classList.contains('open'))),
    { label: 'the settings panel opens', timeout: PATIENT });
}

/** Choose a surface in the picker exactly as a user does: set it, then fire `change`. */
async function choose(pg, value) {
  await pg.evaluate((v) => {
    const sel = document.getElementById('cfg-surface-select');
    sel.value = v;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, String(value));
}

const waitWelcome = (pg) => until(async () => (await pg.evaluate(() => !!window.__sent && window.__sent.length > 0)),
  { label: 'the page has said hello', timeout: PATIENT });

test('0534 t-w4c-01 — a participant reaches a declared surface from the page alone, by UID', async () => {
  const { dir, mods, server } = await boot({ surfaces: true });
  const browser = await launch();
  const errs = [];
  try {
    const reg = server.surfaces().surfaces;
    const open = reg.find((s) => s.peekable === true);
    const shut = reg.find((s) => s.peekable !== true);
    expect('fixture: the deployment offers one peekable surface and one that is not',
      !!open && !!shut && Number.isInteger(open.surfaceUid), JSON.stringify(reg));

    const pg = await openDisplay(browser, server, 'userId=w4c1&name=Viewer', errs);
    await waitWelcome(pg);
    await openSettings(pg);
    await until(async () => (await pg.evaluate(() => {
      const s = document.getElementById('cfg-surface-select');
      return !!s && s.options.length > 1;
    })), { label: 'the picker is populated from the welcome', timeout: PATIENT });

    const before = await peekState(pg);
    expect('checkVisibility() is available (a rect would not be proof)', before.hasApi === true, JSON.stringify(before));
    expect('the picker IS visible in the settings panel', before.selVisible === true && before.rowVisible === true, JSON.stringify(before));
    expect('it offers the peekable surface, by its registry label', before.options.some((o) => o.text.includes(OPEN_LABEL)), JSON.stringify(before.options));
    expect('⛔ and NOT the surface that never declared itself peekable', !before.options.some((o) => o.text.includes(SHUT_LABEL)), JSON.stringify(before.options));
    expect('the option carries the INTEGER uid, never the authoring code (canon §3)',
      before.options.some((o) => o.value === String(open.surfaceUid)) && !before.options.some((o) => o.value === 'open-screen'),
      JSON.stringify(before.options));
    expect('nothing claims a peek before one happened', before.badgeVisible === false && before.backVisible === false, JSON.stringify(before));

    await choose(pg, open.surfaceUid);
    await until(async () => (await pg.evaluate((mark) => {
      const f = document.getElementById('frame');
      return !!f && (f.getAttribute('srcdoc') || '').includes(mark);
    }, OPEN_MARK)), { label: 'the surface renders on this viewer\'s stage', timeout: PATIENT });

    const after = await peekState(pg);
    expect('the surface is what is on the stage — read from the frame the server filled', after.srcdoc.includes(OPEN_MARK), String(after.srcdoc).slice(0, 200));
    const peekFrames = after.sent.filter((s) => s.includes('"t":"peek"'));
    expect('exactly one peek frame was sent', peekFrames.length === 1, JSON.stringify(after.sent));
    expect('…and its surfaceUid is a JSON INTEGER, not a string',
      new RegExp('"surfaceUid":' + open.surfaceUid + '(,|})').test(peekFrames[0]), peekFrames[0]);
    expect('the Back control appeared with the peek', after.backVisible === true, JSON.stringify(after));
    expect('no uncaught page error', errs.length === 0, errs.join(' | '));
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(mods, { recursive: true, force: true });
  }
});

test('0534 t-w4c-02 — "you are peeking" is legible WITHOUT Settings, and the badge is the way back', async () => {
  const { dir, mods, server } = await boot({ surfaces: true });
  const browser = await launch();
  const errs = [];
  try {
    const open = server.surfaces().surfaces.find((s) => s.peekable === true);
    const pg = await openDisplay(browser, server, 'userId=w4c2&name=Viewer', errs);
    await waitWelcome(pg);

    // The room puts something on every screen first, so "went back" means something.
    server.presentText({ text: ROOM_MARK, title: 'The room' });
    await until(async () => (await pg.evaluate((mark) => {
      const f = document.getElementById('frame');
      return !!f && (f.getAttribute('srcdoc') || '').includes(mark);
    }, ROOM_MARK)), { label: 'the room\'s screen is up', timeout: PATIENT });

    // Peek is driven from the picker, then Settings is SHUT again — the badge must stand alone.
    await openSettings(pg);
    await until(async () => (await pg.evaluate(() => document.getElementById('cfg-surface-select').options.length > 1)),
      { label: 'the picker is populated', timeout: PATIENT });
    await choose(pg, open.surfaceUid);
    await until(async () => (await pg.evaluate((mark) => {
      const f = document.getElementById('frame');
      return !!f && (f.getAttribute('srcdoc') || '').includes(mark);
    }, OPEN_MARK)), { label: 'the surface renders', timeout: PATIENT });
    await pg.click('#cfg-close');
    await until(async () => (await pg.evaluate(() => !document.getElementById('ap-config').classList.contains('open'))),
      { label: 'the settings panel closes', timeout: PATIENT });

    const peeking = await peekState(pg);
    expect('checkVisibility() is available', peeking.hasApi === true, JSON.stringify(peeking));
    expect('the settings panel is SHUT — nothing here is relying on it', peeking.cfgOpen === false, JSON.stringify(peeking));
    expect('the badge IS visible on the display itself', peeking.badgeVisible === true, JSON.stringify(peeking));
    expect('…and names the surface, from the registry', peeking.badgeLabel === OPEN_LABEL, JSON.stringify(peeking));
    expect('…and says this is private to the viewer', /only you see this/i.test(peeking.badgeText), peeking.badgeText);
    expect('…and says how to get back', /go back/i.test(peeking.badgeText), peeking.badgeText);

    // The badge is the control: one click, no Settings.
    await pg.click('#ap-peek');
    await until(async () => (await pg.evaluate((mark) => {
      const f = document.getElementById('frame');
      return !!f && (f.getAttribute('srcdoc') || '').includes(mark);
    }, ROOM_MARK)), { label: 'the room\'s screen is back', timeout: PATIENT });

    const back = await peekState(pg);
    expect('one click on the badge sent unpeek', back.sent.some((s) => s.includes('"t":"unpeek"')), JSON.stringify(back.sent));
    expect('the room\'s screen is on the stage again', back.srcdoc.includes(ROOM_MARK) && !back.srcdoc.includes(OPEN_MARK), String(back.srcdoc).slice(0, 200));
    expect('…and the badge is gone — it does not outlive the peek', back.badgeVisible === false, JSON.stringify(back));
    expect('no uncaught page error', errs.length === 0, errs.join(' | '));
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(mods, { recursive: true, force: true });
  }
});

test('0534 t-w4c-03 — no surfaces declared ⇒ NO control at all, not an empty one', async () => {
  const { dir, mods, server } = await boot({ surfaces: false });
  const browser = await launch();
  const errs = [];
  try {
    expect('fixture: this deployment really declares no surfaces', server.surfaces().surfaces.length === 0,
      JSON.stringify(server.surfaces()));

    const pg = await openDisplay(browser, server, 'userId=w4c3&name=Viewer', errs);
    await waitWelcome(pg);
    await openSettings(pg);
    await wait(600);   // a welcome that was going to paint anything has landed by now

    const st = await peekState(pg);
    expect('checkVisibility() is available', st.hasApi === true, JSON.stringify(st));
    expect('the row exists in the markup — it ships hidden, it is not conditional HTML', st.rowPresent === true, JSON.stringify(st));
    expect('…and is NOT visible even with Settings OPEN', st.rowVisible === false && st.selVisible === false, JSON.stringify(st));
    expect('…and neither is the Back control', st.backVisible === false, JSON.stringify(st));
    expect('the badge is present but hidden and blank', st.badgePresent === true && st.badgeVisible === false && st.badgeLabel === '', JSON.stringify(st));
    expect('the panel really is open, so this is not passing on a shut panel', st.cfgOpen === true, JSON.stringify(st));
    expect('no uncaught page error', errs.length === 0, errs.join(' | '));
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(mods, { recursive: true, force: true });
  }
});
