/*
 * Plan 0522 P15 — THE `▸ STATIONS (n)` TIER ON THE CONTROL PAGE.
 *
 * Every declared station was reachable from the control page only as a TARGET (P5's dropdown) —
 * i.e. as a set of people to send something TO. There was no way to LOOK at the list of stations,
 * and no way to put one station's own screen on the room's displays. P15 adds ONE collapsed row at
 * the bottom of the content column: the cost of availability is a row, not a mode.
 *
 *   t38 — collapsed on first render.
 *   t39 — absent when no plugin declares stations (a teaching deployment sees nothing).
 *   t40 — renders with NO module loaded, and survives a module change.
 *   t41 — projecting a station to the room leaves EVERY seat's stationUid unchanged.
 *
 * ⚠ VISIBILITY IS ASSERTED WITH checkVisibility(), NEVER WITH A RECT — and t38 is precisely the
 * case that makes the difference: a CLOSED <details> keeps a non-zero bounding box in Chrome, so
 * `getBoundingClientRect().height > 0` on the collapsed contents passes whether the tier is open or
 * shut. Every test here first asserts the API EXISTS, so a browser without it fails loudly instead
 * of passing on `undefined`.
 *
 * ⚠ I3 — TRANSIENT RENDER, DURABLE ASSIGNMENT. The tempting implementation of "put station N on the
 * room's screens" is to seat the room at station N; that would durably re-seat every player through
 * the very resolver call P14 just gated, to show one screen for thirty seconds. t41 proves it does
 * not happen with THREE independent instruments, listed at the test.
 *
 * ⚠ ONE BROWSER, ONE PAGE PER TEST. Chrome pauses requestAnimationFrame in a backgrounded tab, so a
 * second open page can stall a wait in a completely different FILE (the intermittent 0522 t24
 * failure). Each test opens exactly one browser and exactly one page and closes both; the extra
 * participants in t41 are raw Node websockets, not pages; and every wait uses multi.mjs `until()`,
 * which is setTimeout-based and therefore immune to the rAF pause in the first place.
 *
 * ⛔ §ANNEAL E — nothing here reads or writes the repo's real `modules/` directory (the one
 * directory with no version history). PRESENTER_MODULES_DIR points at a throwaway dir, and t40's
 * modules are injected through the existing `__gm.setModule` hook rather than through disk.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { makePluginsDir, stationManifest } from '../unit/_0514-fixtures.mjs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocket } from 'ws';

// Plan 0529 P2: the content catalogue is control-credentialed and FAILS CLOSED, so a test
// that drives the GM panel must run a gated server and hand the page a token — exactly as a
// real deployment does. Nothing else about these tests changed.
const CTL_TOKEN = 'ap-test-control-token';

const PATIENT = 60000;

/*
 * FOUR stations in TWO groups, declared OUT of sortOrder and with the groups INTERLEAVED, because
 * the two-station fixture cannot tell "grouped by group" apart from "listed in order". Rendering
 * this correctly has exactly one right answer, hard-coded in t40: groups in the order their FIRST
 * member appears by sortOrder — Group B (3) then Group A (1) — and members in sortOrder within
 * each, i.e. uids 3, 4, 1, 2. `Delta` carries NO icon, so the icon-prefix branch is exercised in
 * both directions.
 */
const STATIONS = [
  { stationUid: 3, stationCode: 'gamma', stationLabel: 'Gamma', group: 'Group B', icon: 'G', color: '#333', maxOccupants: null, sortOrder: 1 },
  { stationUid: 1, stationCode: 'alpha', stationLabel: 'Alpha', group: 'Group A', icon: 'A', color: '#111', maxOccupants: 1, sortOrder: 2 },
  { stationUid: 4, stationCode: 'delta', stationLabel: 'Delta', group: 'Group B', color: '#444', maxOccupants: null, sortOrder: 3 },
  { stationUid: 2, stationCode: 'beta', stationLabel: 'Beta', group: 'Group A', icon: 'B', color: '#222', maxOccupants: null, sortOrder: 4 },
];
const EXPECT_GROUPS = ['Group B', 'Group A'];
const EXPECT_UIDS = [3, 4, 1, 2];
const WORD = 'Post';                 // the deployment's OWN word for a station (stationSelectorLabel)
const ALPHA = 1, BETA = 2;           // where t41's two players sit

/*
 * A throwaway seat resolver that ALSO KEEPS A LEDGER. The fixture manifest declares stations but
 * core alone seats nobody — stationsActive() needs a plugin-provided resolver (server.mjs §4.2a).
 * Every `select()` — the ONE call that writes a seat — is recorded on `globalThis`, which the test
 * shares with this module because the plugin is imported into the very same process. That ledger is
 * t41's primary instrument: it does not ask whether a seat LOOKS unchanged afterwards, it asks
 * whether the function that could have changed one was ever reached.
 */
const RESOLVER = `
export function register(ctx) {
  const seats = new Map();
  const known = new Set((ctx.stations && ctx.stations.list || []).map(function(s){ return s.stationUid; }));
  const dflt = ctx.stations && ctx.stations.defaultUid;
  globalThis.__p15 = { selects: [] };
  ctx.provideSeatResolver({
    select: function (userId, uid) {
      globalThis.__p15.selects.push([userId, uid]);
      const u = known.has(uid) ? uid : dflt;
      seats.set(userId, { uid: u });
      return { uid: u };
    },
    get: function (userId) { return seats.get(userId) || null; },
    release: function (userId) { seats.delete(userId); },
  });
}
`;

/**
 * Boot against a THROWAWAY plugin tree and a throwaway modules tree.
 *   stations:true  → the four-station registry above + the ledger resolver
 *   stations:false → a plugin declaring nothing at all — a teaching deployment
 */
async function boot({ stations }) {
  const dir = stations
    ? makePluginsDir({ p15seats: {
        'plugin.json': stationManifest({ name: 'p15seats', server: 'seats.mjs', stationSelectorLabel: WORD, stationDefaultUid: BETA, stations: STATIONS }),
        'seats.mjs': RESOLVER } })
    : makePluginsDir({ p15teach: { 'plugin.json': { name: 'p15teach', requires: [], components: [], presets: {}, fieldSchemas: {} } } });
  const mods = mkdtempSync(join(tmpdir(), 'ap-0522-p15-mod-'));
  const prevP = process.env.PRESENTER_PLUGINS_DIR;
  const prevM = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_PLUGINS_DIR = dir;
  process.env.PRESENTER_MODULES_DIR = mods;
  let server;
  try { server = await createServer({ port: 0, controlToken: CTL_TOKEN }); }
  finally {
    if (prevP === undefined) delete process.env.PRESENTER_PLUGINS_DIR; else process.env.PRESENTER_PLUGINS_DIR = prevP;
    if (prevM === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prevM;
  }
  return { dir, mods, server };
}

/** Open the CONTROL page as the operator, recording every websocket frame it SENDS. */
async function openControl(browser, server, errs) {
  const pg = await browser.newPage();
  pg.setDefaultTimeout(PATIENT);
  pg.on('pageerror', (e) => { if (errs) errs.push(e.message); console.log('CTRL PAGEERR', e.message); });
  // Installed before ANY page script runs, so the hello itself is captured too.
  await pg.evaluateOnNewDocument(() => {
    window.__sent = [];
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { try { window.__sent.push(String(d)); } catch (e) {} return orig.call(this, d); };
  });
  await pg.goto(`${server.url()}/control?userId=op&role=presenter&token=${CTL_TOKEN}`, { waitUntil: 'domcontentloaded', timeout: PATIENT });
  await until(async () => pg.evaluate(() => !!(window.__gm && typeof window.__control === 'function' && document.getElementById('st-tier-wrap'))),
    { label: 'the control page booted', timeout: PATIENT });
  return pg;
}

/** Everything the assertions need, read in ONE evaluate so it is a single consistent moment. */
const tierState = (pg) => pg.evaluate(() => {
  const wrap = document.getElementById('st-tier-wrap');
  const det = document.getElementById('st-tier');
  const list = document.getElementById('st-tier-list');
  const sum = det ? det.querySelector('summary') : null;
  const title = document.getElementById('st-tier-title');
  const count = document.getElementById('st-tier-count');
  const outline = document.getElementById('outline');
  const vis = (el) => (el && typeof el.checkVisibility === 'function' ? el.checkVisibility() : 'NO-API');
  return {
    hasApi: !!(wrap && typeof wrap.checkVisibility === 'function'),
    present: !!wrap,
    wrapVisible: vis(wrap),
    sumVisible: vis(sum),
    listVisible: vis(list),
    open: det ? det.open : null,
    titleText: title ? title.textContent : null,
    countText: count ? count.textContent : null,
    // .trim(): the markup's own indentation is whitespace text nodes, not rendered content.
    tierText: det ? det.textContent.trim() : null,
    rows: list ? [...list.querySelectorAll('.st-row')].map((r) => ({ uid: Number(r.dataset.uid), text: r.textContent })) : null,
    groups: list ? [...list.querySelectorAll('.st-grp')].map((g) => g.textContent) : null,
    buttons: list ? list.querySelectorAll('[data-project]').length : null,
    // The tier lives OUTSIDE #outline by construction — assert the structure, not just the effect.
    insideOutline: !!(outline && wrap && outline.contains(wrap)),
    outlineHtmlLen: outline ? outline.innerHTML.length : null,
    stations: (window.__gm.stations() || []).length,
    word: window.__gm.stationWord(),
    stat: (document.getElementById('st-stat') || {}).textContent || '',
  };
});

/** Wait until the control page has taken delivery of the registry AND painted its rows. */
const awaitTier = (pg) => until(async () => pg.evaluate(() => document.querySelectorAll('#st-tier-list .st-row').length > 0),
  { label: 'the tier painted its rows', timeout: PATIENT });

async function teardown({ browser, server, dir, mods }) {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (mods) rmSync(mods, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────────────────────────────────
test('0522 t38 — the station tier is COLLAPSED on first render', async () => {
  const { dir, mods, server } = await boot({ stations: true });
  const browser = await launch();
  const errs = [];
  try {
    const reg = server.stations();
    expect('fixture: the deployment declares stations', reg.stations.length === STATIONS.length, JSON.stringify(reg.stations.map((s) => s.stationUid)));

    const pg = await openControl(browser, server, errs);
    await awaitTier(pg);
    const st = await tierState(pg);

    // The API the whole visibility claim rests on. A rect here would prove nothing at all: a closed
    // <details> keeps a non-zero box, so a rect assertion passes whether it is open or shut.
    expect('checkVisibility() is available (a rect would NOT be proof for a closed <details>)', st.hasApi === true, JSON.stringify(st));

    // The tier is THERE — this is not passing because nothing at all was rendered.
    expect('the tier is present and visible', st.present === true && st.wrapVisible === true, JSON.stringify(st));
    expect('its summary row is visible — one row is the entire cost', st.sumVisible === true, JSON.stringify(st));
    expect('and it names the count of declared stations', st.countText === '(' + reg.stations.length + ')', JSON.stringify(st));
    expect('and it is fully populated underneath', st.rows.length === reg.stations.length, JSON.stringify(st.rows));

    // The phase.
    expect('the <details> is CLOSED — no `open` attribute in the markup, and nothing opened it', st.open === false, JSON.stringify(st));
    expect('…and checkVisibility() agrees the contents are NOT visible', st.listVisible === false, JSON.stringify(st));
    expect('the caret says so too', st.titleText.indexOf('▸') === 0, JSON.stringify(st.titleText));

    // Opening it works, so "collapsed" is a chosen default and not a broken tier.
    await pg.evaluate(() => { document.getElementById('st-tier').open = true; });
    await until(async () => pg.evaluate(() => document.getElementById('st-tier-list').checkVisibility()),
      { label: 'the tier opens', timeout: PATIENT });
    const open = await tierState(pg);
    expect('opened, the contents ARE visible', open.listVisible === true && open.open === true, JSON.stringify(open));
    expect('and the caret follows the state it describes', open.titleText.indexOf('▾') === 0, JSON.stringify(open.titleText));

    expect('no uncaught page error', errs.length === 0, errs.join(' | '));
  } finally { await teardown({ browser, server, dir, mods }); }
});

// ────────────────────────────────────────────────────────────────────────────────────────────
test('0522 t39 — no plugin declares stations ⇒ the tier is ABSENT, entirely', async () => {
  const { dir, mods, server } = await boot({ stations: false });
  const browser = await launch();
  const errs = [];
  try {
    // Precondition asserted at the server, not assumed.
    expect('fixture: the deployment declares no stations', server.stations().stations.length === 0, JSON.stringify(server.stations()));

    const pg = await openControl(browser, server, errs);
    // Settle: a welcome that was going to paint anything would have landed long since.
    await until(async () => pg.evaluate(() => !!window.__sent && window.__sent.length > 0), { label: 'the page has said hello', timeout: PATIENT });
    await wait(600);

    const st = await tierState(pg);
    expect('checkVisibility() is available', st.hasApi === true, JSON.stringify(st));
    expect('the wrapper exists in the markup (it ships hidden; it is not conditional HTML)', st.present === true, JSON.stringify(st));
    expect('…and is NOT visible, per checkVisibility()', st.wrapVisible === false, JSON.stringify(st));
    expect('…its summary is not visible either — the whole surface is gone, not just its body',
      st.sumVisible === false && st.listVisible === false, JSON.stringify(st));
    expect('…and it renders NO text at all — not an empty tier, no tier', st.tierText === '', JSON.stringify(st.tierText));
    expect('…no heading and no count', st.titleText === '' && st.countText === '', JSON.stringify(st));
    expect('…and no rows and no buttons to press', st.rows.length === 0 && st.buttons === 0, JSON.stringify(st));
    expect('the page agrees it holds an empty registry', st.stations === 0, JSON.stringify(st));
    expect('no uncaught page error', errs.length === 0, errs.join(' | '));
  } finally { await teardown({ browser, server, dir, mods }); }
});

// ────────────────────────────────────────────────────────────────────────────────────────────
test('0522 t40 — the tier renders with NO module loaded, and survives a module change', async () => {
  const { dir, mods, server } = await boot({ stations: true });
  const browser = await launch();
  const errs = [];
  try {
    const reg = server.stations();
    const pg = await openControl(browser, server, errs);
    await awaitTier(pg);

    // ── with NO module loaded ──────────────────────────────────────────────────────────────
    const noMod = await pg.evaluate(() => ({ module: window.__gm.module(), outline: document.getElementById('outline').innerHTML }));
    expect('precondition: no module is loaded and the outline is empty', noMod.module === null && noMod.outline === '', JSON.stringify(noMod));

    const before = await tierState(pg);
    expect('the tier renders anyway — it is not a child of the module outline',
      before.wrapVisible === true && before.rows.length === reg.stations.length, JSON.stringify(before));
    expect('…structurally: it lives OUTSIDE #outline, so no outline rebuild can reach it', before.insideOutline === false, JSON.stringify(before));
    expect('…grouped by `group`, groups in the order their first member appears by sortOrder',
      JSON.stringify(before.groups) === JSON.stringify(EXPECT_GROUPS), JSON.stringify(before.groups));
    expect('…and in sortOrder within each group', JSON.stringify(before.rows.map((r) => r.uid)) === JSON.stringify(EXPECT_UIDS),
      JSON.stringify(before.rows.map((r) => r.uid)));
    expect('…every row names its station, icon-prefixed where one is declared',
      before.rows[0].text.indexOf('G Gamma') === 0 && before.rows[1].text.indexOf('Delta') === 0, JSON.stringify(before.rows.map((r) => r.text)));
    expect('…under the deployment\'s OWN word for a station, taken from the wire',
      before.word === reg.stationSelectorLabel && before.word === WORD && before.titleText.indexOf(WORD) > -1,
      JSON.stringify({ word: before.word, title: before.titleText, expected: reg.stationSelectorLabel }));
    expect('…and every row can be projected', before.buttons === reg.stations.length, String(before.buttons));

    const signature = JSON.stringify(before.rows);

    // ── a module is loaded ─────────────────────────────────────────────────────────────────
    const modA = { id: 'p15-a', manifest: { title: 'A' }, beats: [{ id: 'b1', component: 'card', opts: { title: 'one' } }], sections: [{ title: 'Sec A', beatIds: ['b1'] }] };
    const modB = { id: 'p15-b', manifest: { title: 'B' }, beats: [{ id: 'b2', component: 'card', opts: { title: 'two' } }], sections: [{ title: 'Sec B', beatIds: ['b2'] }] };
    await pg.evaluate((m) => window.__gm.setModule(m), modA);
    await until(async () => pg.evaluate(() => document.getElementById('outline').innerHTML.length > 0), { label: 'module A drew an outline', timeout: PATIENT });
    let now = await tierState(pg);
    expect('with a module loaded the tier is untouched', JSON.stringify(now.rows) === signature && now.wrapVisible === true, JSON.stringify(now.rows));
    expect('…and it did not spring open', now.open === false, JSON.stringify(now));

    // ── THE MODULE CHANGE, by both paths that wipe #outline ────────────────────────────────
    // Path 1: renderOutline() itself does `$('outline').innerHTML=''` on every rebuild.
    await pg.evaluate((m) => window.__gm.setModule(m), modB);
    await until(async () => pg.evaluate(() => document.getElementById('outline').innerHTML.indexOf('Sec B') > -1), { label: 'module B drew an outline', timeout: PATIENT });
    now = await tierState(pg);
    expect('after a module CHANGE the tier is still there, identical', JSON.stringify(now.rows) === signature && now.wrapVisible === true, JSON.stringify(now.rows));

    // Path 2: the picker's own onchange wipes #outline a SECOND time, before any fetch, and never
    // calls renderOutline when the placeholder is chosen. A tier living inside #outline would be
    // destroyed here with nothing left to rebuild it.
    await pg.evaluate(() => { const s = document.getElementById('mod-select'); s.value = ''; s.onchange(); });
    await until(async () => pg.evaluate(() => document.getElementById('outline').innerHTML === ''), { label: 'the picker wiped the outline', timeout: PATIENT });
    const after = await tierState(pg);
    expect('precondition: the outline really was emptied', after.outlineHtmlLen === 0, JSON.stringify(after));
    expect('precondition: and the page is holding no module again', await pg.evaluate(() => window.__gm.module()) === null, 'module');
    expect('the tier SURVIVED the wipe, identical and still visible',
      JSON.stringify(after.rows) === signature && after.wrapVisible === true && after.rows.length === reg.stations.length, JSON.stringify(after.rows));
    expect('…and still collapsed', after.open === false, JSON.stringify(after));
    expect('no uncaught page error', errs.length === 0, errs.join(' | '));
  } finally { await teardown({ browser, server, dir, mods }); }
});

// ────────────────────────────────────────────────────────────────────────────────────────────
/*
 * t41 — THE I3 TEST. Three deliberately independent instruments:
 *
 *   1. A LEDGER ON `select()` ITSELF. The fixture resolver records every call to the one function
 *      that can write a seat. Stronger than inspecting the outcome: it fails even for an
 *      implementation that re-seats everybody and then puts them back.
 *   2. THE SEATS, BEFORE AND AFTER, from `server.stations().seats` — the plugin's own answer, asked
 *      fresh. t41's literal claim is that every entry's stationUid is unchanged.
 *   3. THE CONTROL PAGE'S OUTGOING FRAMES, captured by wrapping WebSocket.prototype.send in
 *      evaluateOnNewDocument before any page script ran. It proves the page asked for a PROJECTION
 *      and did not quietly emit a set_station per seat.
 *
 * And the positive half, because "changed nothing" is also what a dead button does: both
 * participants receive the projected station's screen while REMAINING SEATED SOMEWHERE ELSE —
 * transient render and durable assignment, demonstrated in one frame.
 */
test('0522 t41 — projecting a station to the room leaves EVERY seat\'s stationUid unchanged', async () => {
  const { dir, mods, server } = await boot({ stations: true });
  const browser = await launch();
  const errs = [];
  const sockets = [];
  try {
    const reg = server.stations();
    const alpha = reg.stations.find((s) => s.stationUid === ALPHA);
    const beta = reg.stations.find((s) => s.stationUid === BETA);
    expect('fixture: two distinct stations to sit at', !!alpha && !!beta && alpha.stationLabel !== beta.stationLabel, JSON.stringify(reg.stations));

    // Two seated participants as RAW SOCKETS — no second browser page (the rAF hazard). They seat
    // themselves through the ungated 0514 §8 self-select, so the row starts somewhere definite.
    const url = server.url().replace('http', 'ws');
    const players = [{ userId: 'pa', name: 'PlayerA', uid: ALPHA }, { userId: 'pb', name: 'PlayerB', uid: BETA }].map((p) => {
      const ws = new WebSocket(url);
      const frames = [];
      ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) {} });
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'hello', userId: p.userId, userName: p.name }));
        ws.send(JSON.stringify({ t: 'station-select', stationUid: p.uid }));
      });
      sockets.push(ws);
      return { ...p, ws, frames };
    });
    for (const p of players) {
      await until(() => (server.stations().seats.find((s) => s.userId === p.userId) || {}).stationUid === p.uid,
        { label: p.name + ' is seated', timeout: PATIENT });
    }

    const pg = await openControl(browser, server, errs);
    await awaitTier(pg);
    await until(() => server.stations().seats.length === 3, { label: 'the control page is seated too', timeout: PATIENT });

    // ── the state under test, recorded ─────────────────────────────────────────────────────
    const snap = () => server.stations().seats.map((s) => ({ userId: s.userId, stationUid: s.stationUid }))
      .sort((x, y) => String(x.userId).localeCompare(String(y.userId)));
    const seatsBefore = snap();
    expect('precondition: the two players sit at DIFFERENT stations',
      new Set(seatsBefore.map((s) => s.stationUid)).size > 1, JSON.stringify(seatsBefore));
    // Instrument 1, zeroed AFTER everybody has joined, so only the projection can move it.
    globalThis.__p15.selects.length = 0;
    players.forEach((p) => { p.frames.length = 0; });

    // ── the phase: press ▣ on ALPHA ────────────────────────────────────────────────────────
    const targetBefore = await pg.evaluate(() => window.__gm.target());
    expect('precondition: P5\'s target is the default ALL, so nothing here depends on it', targetBefore === 'all', targetBefore);
    const pressed = await pg.evaluate((uid) => {
      document.getElementById('st-tier').open = true;
      const btn = document.querySelector('#st-tier-list [data-project="' + uid + '"]');
      if (!btn) return false;
      btn.click();
      return true;
    }, ALPHA);
    expect('the ▣ button for that station exists and was pressed', pressed === true, 'button');

    await until(async () => pg.evaluate(() => (document.getElementById('st-stat').textContent || '').indexOf('▣ projected') === 0),
      { label: 'the projection receipt lands', timeout: PATIENT });
    const receipt = await pg.evaluate(() => document.getElementById('st-stat').textContent);

    // ── instrument 1: select() was NEVER called ────────────────────────────────────────────
    expect('the seat resolver\'s select() — the ONE call that writes a seat — was never reached',
      globalThis.__p15.selects.length === 0, JSON.stringify(globalThis.__p15.selects));

    // ── instrument 2: every seat, unchanged ────────────────────────────────────────────────
    await wait(300);   // give any (forbidden) re-seat time to show up rather than racing it
    const seatsAfter = snap();
    expect('EVERY seat\'s stationUid is unchanged after the projection',
      JSON.stringify(seatsAfter) === JSON.stringify(seatsBefore), JSON.stringify({ before: seatsBefore, after: seatsAfter }));
    expect('…and specifically, the player sitting at the OTHER station was not dragged to this one',
      (seatsAfter.find((s) => s.userId === 'pb') || {}).stationUid === BETA, JSON.stringify(seatsAfter));

    // ── instrument 3: what the page actually asked for ─────────────────────────────────────
    const sent = await pg.evaluate(() => (window.__sent || []).slice());
    const projections = sent.filter((s) => s.indexOf('project_station') > -1);
    expect('the page asked for a PROJECTION, once', projections.length === 1, JSON.stringify(projections));
    const args = JSON.parse(projections[0]).args;
    expect('…for THAT station, addressed at the ROOM, as an array (P5\'s wire form)',
      args && args.stationUid === ALPHA && JSON.stringify(args.targets) === JSON.stringify(['all']), projections[0]);
    expect('…and it emitted NO seat write of any kind — not set_station, not station-select',
      sent.filter((s) => /set_station|station-select/.test(s)).length === 0,
      JSON.stringify(sent.filter((s) => /station/.test(s))));

    // ── the positive half: it really did project ───────────────────────────────────────────
    // The fixture stations carry no screen descriptor, so each viewer gets the CORE generic
    // placeholder, built from registry values only (t0514-15) — which carries the station's label.
    for (const p of players) {
      await until(() => p.frames.some((f) => f.t === 'content' && typeof f.html === 'string' && f.html.includes(alpha.stationLabel)),
        { label: p.name + ' received the projected screen', timeout: PATIENT });
    }
    expect('the player at the OTHER station saw ALPHA\'s screen WHILE STILL SEATED AT BETA — transient render, durable assignment, in one frame',
      players[1].frames.some((f) => f.t === 'content' && f.html.includes(alpha.stationLabel))
        && (seatsAfter.find((s) => s.userId === 'pb') || {}).stationUid === BETA,
      JSON.stringify(seatsAfter));
    expect('…and nobody was sent BETA\'s screen instead of the one that was asked for',
      !players[1].frames.some((f) => f.t === 'content' && typeof f.html === 'string' && f.html.includes(beta.stationLabel)),
      JSON.stringify(players[1].frames.filter((f) => f.t === 'content').length));
    expect('the receipt names the station and the number of screens reached (I5)',
      receipt.includes(alpha.stationLabel) && /→ \d+ screens?/.test(receipt), receipt);
    expect('…and at least the two players plus the operator were reached',
      Number((/→ (\d+) screens?/.exec(receipt) || [])[1]) >= 3, receipt);
    expect('no uncaught page error', errs.length === 0, errs.join(' | '));
  } finally {
    for (const ws of sockets) { try { ws.close(); } catch (e) {} }
    await teardown({ browser, server, dir, mods });
  }
});
