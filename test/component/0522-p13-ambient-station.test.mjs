/*
 * Plan 0522 P13 — AMBIENT STATION IDENTITY.
 *
 * 0514 Phase 4 put the station selector, and with it the only rendering of a station label on the
 * display page, INSIDE the config panel. So a player who wanted to know where they were sitting had
 * to open Settings to find out. Everything needed to answer that question was already on the wire
 * (welcome.stationRegistry + welcome.stationUid, 0514 §8); nothing rendered it where a player looks.
 *
 *   t35  — the seat's label is visible WITHOUT opening the config panel.
 *   t35a — no plugin declares stations ⇒ NOTHING is rendered (a teaching deployment sees no change).
 *   t35b — the label FOLLOWS a station change and does not fossilise the welcome's value.
 *
 * ⚠ VISIBILITY IS ASSERTED WITH checkVisibility(), NEVER WITH A RECT. A rect is not proof: a closed
 * <details>, a zero-opacity node and an element inside a display:none ancestor all keep non-zero
 * boxes in Chrome. checkVisibility() is the only API that answers the question actually being asked,
 * and every test here first asserts the API EXISTS, so a browser without it fails loudly instead of
 * passing on `undefined`.
 *
 * ⚠ I3 — TRANSIENT RENDER, DURABLE ASSIGNMENT. Showing a seat its own label must not WRITE that
 * seat. This suite proves that at the wire, not by inspection: WebSocket.prototype.send is wrapped
 * before the page's own script runs, so every frame the display page emits is recorded, and the
 * tests assert that not one of them is a station request.
 *
 * ⚠ ONE BROWSER, ONE PAGE, NOTHING LEFT BEHIND. Chrome pauses requestAnimationFrame in a
 * backgrounded tab, so a second open page can stall a `waitForFunction` in a completely different
 * FILE — the intermittent failure P12 finally pinned down. Each test here opens exactly one
 * browser and exactly one page and closes both, so at no instant do two pages exist; and every
 * wait uses multi.mjs `until()`, which is setTimeout-based and therefore immune to the rAF pause
 * in the first place. An earlier draft shared one browser across the three tests and reproducibly
 * broke `0522 t24` two full runs running, while a run with only the SOURCE change and this file
 * removed was clean — so the isolation below is measured, not decorative.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { makePluginsDir, stationManifest } from '../unit/_0514-fixtures.mjs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PATIENT = 60000;

/*
 * A throwaway seat resolver. The fixture manifest declares stations but core alone never seats
 * anyone — stationsActive() needs a plugin-provided resolver (server.mjs §4.2a) — so this supplies
 * the smallest thing that satisfies the {select,get,release} contract. An unknown uid resolves to
 * the deployment default rather than erroring, exactly as 0514 §5 requires of a real one.
 */
const RESOLVER = `
export function register(ctx) {
  const seats = new Map();
  const known = new Set((ctx.stations && ctx.stations.list || []).map(function(s){ return s.stationUid; }));
  const dflt = ctx.stations && ctx.stations.defaultUid;
  ctx.provideSeatResolver({
    select: function (userId, uid) { const u = known.has(uid) ? uid : dflt; seats.set(userId, { uid: u }); return { uid: u }; },
    get: function (userId) { return seats.get(userId) || null; },
    release: function (userId) { seats.delete(userId); },
  });
}
`;

/**
 * Boot a server against a THROWAWAY plugin tree AND a throwaway modules tree.
 *   stations:true  → the 0514 fixture registry (Post · Alpha/Beta) + the resolver above
 *   stations:false → a plugin that declares nothing at all — a teaching deployment
 *
 * ⛔ §ANNEAL E — PRESENTER_MODULES_DIR is set even though nothing here loads a module. Left
 * unset, createServer scans AND WATCHES the repo's real `modules/`, the one directory with no
 * version history. A test that merely reads it today is a test that writes it after one careless
 * edit, and the fs watcher it leaves on that directory is shared load nobody asked for.
 */
async function boot({ stations }) {
  const dir = stations
    ? makePluginsDir({ p13seats: { 'plugin.json': stationManifest({ name: 'p13seats', server: 'seats.mjs' }), 'seats.mjs': RESOLVER } })
    : makePluginsDir({ p13teach: { 'plugin.json': { name: 'p13teach', requires: [], components: [], presets: {}, fieldSchemas: {} } } });
  const mods = mkdtempSync(join(tmpdir(), 'ap-0522-p13-mod-'));
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

/** Open the DISPLAY page as one seat, recording every websocket frame it SENDS. */
async function openDisplay(browser, server, query, errs) {
  const pg = await browser.newPage();
  pg.setDefaultTimeout(PATIENT);
  pg.on('pageerror', (e) => { if (errs) errs.push(e.message); console.log('DISPLAY PAGEERR', e.message); });
  // Installed before ANY page script runs, so the hello itself is captured too.
  await pg.evaluateOnNewDocument(() => {
    window.__sent = [];
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { try { window.__sent.push(String(d)); } catch (e) {} return orig.call(this, d); };
  });
  await pg.goto(`${server.url()}/?${query}`, { waitUntil: 'domcontentloaded', timeout: PATIENT });
  return pg;
}

/** Everything the assertions need, read in ONE evaluate so it is a single consistent moment. */
const seatState = (pg) => pg.evaluate(() => {
  const seat = document.getElementById('ap-seat');
  const cfg = document.getElementById('ap-config');
  const sel = document.getElementById('cfg-station-select');
  const row = document.getElementById('cfg-station-row');
  const vis = (el) => (el && typeof el.checkVisibility === 'function' ? el.checkVisibility() : 'NO-API');
  return {
    hasApi: !!(seat && typeof seat.checkVisibility === 'function'),
    present: !!seat,
    seatVisible: vis(seat),
    seatText: seat ? seat.textContent : null,
    key: document.getElementById('ap-seat-k') ? document.getElementById('ap-seat-k').textContent : null,
    value: document.getElementById('ap-seat-v') ? document.getElementById('ap-seat-v').textContent : null,
    cfgOpen: cfg ? cfg.classList.contains('open') : null,
    cfgVisible: vis(cfg),
    selVisible: vis(sel),
    rowVisible: vis(row),
    selValue: sel ? sel.value : null,
    sent: (window.__sent || []).slice(),
  };
});

/*
 * The userId of the ONE seat on this server.
 *
 * ⚠ NOT the id in the URL. A link carrying `?stationUID=` makes identity SERVER-DERIVED
 * (`<stationCode>-<slug(name)>`, server.mjs §5/§5.1), which is the whole point of a seat link —
 * a reload comes back to the same seat. A test that addressed the URL's id instead would find
 * `stationSet` reporting ok:true against a seat nobody is sitting in, and would then "prove" the
 * badge follows a change no socket ever received. Ask the server who is actually here.
 */
async function theSeat(server) {
  await until(() => server.stations().seats.length === 1, { label: 'exactly one seat is occupied', timeout: PATIENT });
  return server.stations().seats[0];
}

/** The frames a seat must never emit merely to LEARN where it is sitting (I3). */
const WRITES = ['station-select', 'station-show', 'station-share', 'station-default'];
const stationWrites = (sent) => sent.filter((s) => WRITES.some((w) => s.includes(w)));

test('0522 t35 — a seat sees its own station label WITHOUT opening the config panel', async () => {
  const { dir, mods, server } = await boot({ stations: true });
  const browser = await launch();
  const errs = [];
  try {
    const reg = server.stations();
    const target = reg.stations.find((s) => s.stationUid !== reg.stationDefaultUid);
    expect('fixture: the registry offers a station that is NOT the default', !!target, JSON.stringify(reg.stations));

    const pg = await openDisplay(browser, server, `userId=p13a&name=Seated&stationUID=${target.stationUid}`, errs);
    await until(async () => (await pg.evaluate(() => {
      const v = document.getElementById('ap-seat-v');
      return !!(v && v.textContent);
    })), { label: 'the ambient badge paints', timeout: PATIENT });

    const st = await seatState(pg);

    // The API this whole file's visibility claim rests on. If it is missing, say so — never pass.
    expect('checkVisibility() is available (a rect would not be proof)', st.hasApi === true, JSON.stringify(st));

    // The precondition: the config panel is SHUT. Nothing in this test opened it.
    expect('the config panel is closed — no .open class', st.cfgOpen === false, JSON.stringify(st));
    expect('…and checkVisibility() agrees the panel is NOT visible', st.cfgVisible === false, JSON.stringify(st));
    expect('…so the station SELECTOR — until now the only place a label rendered on this page — is not visible',
      st.selVisible === false && st.rowVisible === false, JSON.stringify(st));
    // It is genuinely populated, so the test is not passing because there was nothing to see.
    expect('…even though the selector is populated and holds this seat', st.selValue === String(target.stationUid), JSON.stringify(st));

    // The phase.
    expect('the ambient badge IS visible, per checkVisibility()', st.seatVisible === true, JSON.stringify(st));
    expect('and it carries THIS seat\'s label, from the registry', st.value.includes(target.stationLabel), JSON.stringify(st));
    expect('…with the deployment\'s own word for a station, also from the wire',
      st.key === reg.stationSelectorLabel && !!st.key, JSON.stringify({ key: st.key, expected: reg.stationSelectorLabel }));
    if (target.icon) expect('…and the registry icon', st.value.includes(target.icon), JSON.stringify(st));

    // I3: it READ. It did not write.
    expect('the page sent NO station request to learn this (I3: transient render, durable assignment)',
      stationWrites(st.sent).length === 0, JSON.stringify(st.sent));
    const seat = await theSeat(server);
    expect('the server still holds the seat it resolved on join — nothing re-seated it',
      seat.stationUid === target.stationUid, JSON.stringify(server.stations().seats));
    expect('no uncaught page error', errs.length === 0, errs.join(' | '));
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(mods, { recursive: true, force: true });
  }
});

test('0522 t35a — no plugin declares stations ⇒ NOTHING is rendered', async () => {
  const { dir, mods, server } = await boot({ stations: false });
  const browser = await launch();
  const errs = [];
  try {
    // Precondition: this really is a stationless deployment, asserted at the server, not assumed.
    expect('fixture: the deployment declares no stations', server.stations().stations.length === 0,
      JSON.stringify(server.stations()));

    const pg = await openDisplay(browser, server, 'userId=p13t&name=Learner', errs);
    // Settle: a welcome that was going to paint anything would have landed long since.
    await until(async () => (await pg.evaluate(() => !!window.__sent && window.__sent.length > 0)),
      { label: 'the page has said hello', timeout: PATIENT });
    await wait(600);

    const st = await seatState(pg);
    expect('checkVisibility() is available', st.hasApi === true, JSON.stringify(st));
    expect('the badge element exists in the markup (it ships hidden, it is not conditional HTML)', st.present === true, JSON.stringify(st));
    expect('…and is NOT visible, per checkVisibility()', st.seatVisible === false, JSON.stringify(st));
    expect('…and renders no text at all — not a blank badge, no badge', st.seatText === '', JSON.stringify(st));
    expect('…nor any label text in its parts', st.key === '' && st.value === '', JSON.stringify(st));
    // The guarantee 0514 already made for the selector still holds, unchanged.
    expect('the station selector row is still hidden too — the whole surface is absent', st.rowVisible === false, JSON.stringify(st));
    expect('no uncaught page error', errs.length === 0, errs.join(' | '));
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(mods, { recursive: true, force: true });
  }
});

test('0522 t35b — the ambient label FOLLOWS a station change, and does not fossilise the welcome', async () => {
  const { dir, mods, server } = await boot({ stations: true });
  const browser = await launch();
  const errs = [];
  try {
    const reg = server.stations();
    const from = reg.stations[0];
    const to = reg.stations.find((s) => s.stationUid !== from.stationUid);
    expect('fixture: two distinct stations to move between', !!to && from.stationLabel !== to.stationLabel,
      JSON.stringify(reg.stations));

    const pg = await openDisplay(browser, server, `userId=p13b&name=Moved&stationUID=${from.stationUid}`, errs);
    await until(async () => (await pg.evaluate(() => {
      const v = document.getElementById('ap-seat-v');
      return !!(v && v.textContent);
    })), { label: 'the ambient badge paints', timeout: PATIENT });

    const before = await seatState(pg);
    expect('before: the badge shows the station the welcome delivered', before.value.includes(from.stationLabel), JSON.stringify(before));
    expect('before: and not the other one', !before.value.includes(to.stationLabel), JSON.stringify(before));

    // ⚠ The change is driven from OUTSIDE the page — stationSet is the API/MCP surface, the one a
    // GM uses for the player who cannot find the dropdown. If the badge only tracked the local
    // <select> it would silently go stale here, in front of the player it just misinformed.
    const seat = await theSeat(server);
    const res = server.stationSet(seat.userId, to.stationUid);
    expect('the server accepted the re-seat', res.ok === true && res.stationUid === to.stationUid, JSON.stringify(res));

    await until(async () => (await pg.evaluate((label) => {
      const v = document.getElementById('ap-seat-v');
      return !!(v && v.textContent.includes(label));
    }, to.stationLabel)), { label: 'the badge follows the change', timeout: PATIENT });

    const after = await seatState(pg);
    expect('the badge now shows the NEW station', after.value.includes(to.stationLabel), JSON.stringify(after));
    expect('…and no longer the old one — it did not append, it replaced', !after.value.includes(from.stationLabel), JSON.stringify(after));
    expect('…it actually changed (not two names that happen to match)', after.value !== before.value,
      JSON.stringify({ before: before.value, after: after.value }));
    expect('…and it is still visible', after.seatVisible === true, JSON.stringify(after));
    expect('…without the config panel ever being opened', after.cfgOpen === false && after.cfgVisible === false, JSON.stringify(after));
    // The selector agrees — one seat, one answer, on both surfaces of this page.
    expect('the config selector moved with it', after.selValue === String(to.stationUid), JSON.stringify(after));
    // I3 again: the page followed a change it was TOLD about. It never asked, and never re-seated.
    expect('the page STILL sent no station request of its own', stationWrites(after.sent).length === 0, JSON.stringify(after.sent));
    expect('the server records exactly one seat for this user, at the new station',
      server.stations().seats.filter((s) => s.userId === seat.userId).length === 1
      && server.stations().seats.find((s) => s.userId === seat.userId).stationUid === to.stationUid,
      JSON.stringify(server.stations().seats));
    expect('no uncaught page error', errs.length === 0, errs.join(' | '));
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(mods, { recursive: true, force: true });
  }
});
