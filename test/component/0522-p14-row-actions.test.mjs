/*
 * Plan 0522 P14 — THE ROSTER ROW GROWS ITS THREE ACTIONS.
 *
 * `mirror` (PRIM-mirror / MON-2), `spotlight` (0508) and set-station (the 0514 resolver) have all
 * existed server-side for several plans with NO button on any human surface. `spotlight` and
 * set-station were reachable only from MCP, so a GM running a session without an AI in the loop
 * could not use them at all — which is an I1 (surface parity) defect, not a matter of taste.
 *
 *   t36 — all three actions are present on the roster row, AND set-station routes through the
 *         0514 `select()` resolver rather than a second seat-writing code path.
 *
 * ⚠ "Not a second code path" is asserted THREE ways, because the interesting failure is a
 * plausible-looking duplicate rather than an absent feature: (a) the plugin's resolver observes
 * the call, (b) it observes EXACTLY ONE call, and (c) core still contains exactly three
 * `seatResolver.select(` sites and the only one taking a foreign userId is inside `stationSet`.
 * The gate on that site is proved in test/unit/0522-p14-station-gate.test.mjs.
 *
 * ⚠ ONE BROWSER, ONE PAGE. Chrome pauses requestAnimationFrame in a backgrounded tab, so a second
 * open page can stall a `waitForFunction` in a completely different FILE. Every participant here
 * is a raw Node websocket, not a page, and every wait uses multi.mjs `until()` (setTimeout-based,
 * immune to the rAF pause) rather than `page.waitForFunction`.
 *
 * ⛔ §ANNEAL E — PRESENTER_MODULES_DIR points at a throwaway dir. Left unset, createServer scans
 * AND WATCHES the repo's real `modules/`, the one directory with no version history.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { makePluginsDir, stationManifest, ROOT } from '../unit/_0514-fixtures.mjs';
import { WebSocket } from 'ws';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Plan 0529 P2: the content catalogue is control-credentialed and FAILS CLOSED, so a test
// that drives the GM panel must run a gated server and hand the page a token — exactly as a
// real deployment does. Nothing else about these tests changed.
const CTL_TOKEN = 'ap-test-control-token';

const PATIENT = 30000;
const ALPHA = 1, BETA = 2;   // stationManifest's two declared stations; BETA is the deployment default

/** A seat resolver that RECORDS every select() call, so "routed through it" is observed, not assumed. */
const SPY = `
export function register(ctx) {
  const seats = new Map();
  const known = new Set((ctx.stations && ctx.stations.list || []).map(function(s){ return s.stationUid; }));
  const dflt = ctx.stations && ctx.stations.defaultUid;
  globalThis.__p14ui = { calls: [] };
  ctx.provideSeatResolver({
    select: function (userId, uid) {
      globalThis.__p14ui.calls.push([userId, uid]);
      const u = known.has(uid) ? uid : dflt;
      seats.set(userId, { uid: u });
      return { uid: u };
    },
    get: function (userId) { return seats.get(userId) || null; },
    release: function (userId) { seats.delete(userId); },
  });
}
`;

async function boot() {
  const dir = makePluginsDir({ p14ui: { 'plugin.json': stationManifest({ name: 'p14ui', server: 'spy.mjs' }), 'spy.mjs': SPY } });
  const mods = mkdtempSync(join(tmpdir(), 'ap-0522-p14ui-mod-'));
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
  return server;
}

function participant(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const frames = [];
    ws.on('message', (b) => { try { frames.push(JSON.parse(b.toString())); } catch (e) {} });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); setTimeout(() => resolve({ ws, frames }), 140); });
  });
}

const calls = () => (globalThis.__p14ui ? globalThis.__p14ui.calls : []);

/** Everything the assertions need about one roster row, read in ONE evaluate. */
const rowState = (pg, uid) => pg.evaluate((id) => {
  const rows = [...document.querySelectorAll('#users .user')];
  const row = rows.find((r) => r.querySelector('[data-copy="' + id + '"]'));
  if (!row) return { found: false, rows: rows.length };
  const q = (s) => row.querySelector(s);
  const spot = q('[data-spot]');
  const sel = q('select[data-station-for]');
  return {
    found: true,
    mirror: !!q('[data-mirror]'),
    mirrorFor: q('[data-mirror]') ? q('[data-mirror]').getAttribute('data-mirror') : null,
    spot: !!spot,
    spotFor: spot ? spot.getAttribute('data-spot') : null,
    spotGranted: spot ? spot.getAttribute('data-granted') : null,
    spotOn: spot ? spot.classList.contains('on') : null,
    station: !!sel,
    stationFor: sel ? sel.getAttribute('data-station-for') : null,
    stationValue: sel ? sel.value : null,
    stationOptions: sel ? [...sel.options].map((o) => o.value) : null,
    ustat: (document.getElementById('u-stat') || {}).textContent || '',
  };
}, uid);

test('0522 t36 — the roster row carries mirror + spotlight + set-station, and set-station routes through the 0514 resolver', async () => {
  const server = await boot();
  const browser = await launch();
  let vic = null, ctl = null;
  try {
    const wsUrl = server.url().replace('http', 'ws');
    vic = await participant(wsUrl, { userId: 'vic', userName: 'Victor' });
    await until(() => server.presence().some((u) => u.userId === 'vic'), { label: 'the player is on the roster', timeout: PATIENT });
    // Seat them at ALPHA by their OWN (ungated) selection, so the row starts somewhere definite.
    vic.ws.send(JSON.stringify({ t: 'station-select', stationUid: ALPHA }));
    await until(() => (server.stations().seats.find((s) => s.userId === 'vic') || {}).stationUid === ALPHA,
      { label: 'seated at ALPHA', timeout: PATIENT });

    ctl = await browser.newPage();
    ctl.setDefaultTimeout(PATIENT);
    const errs = [];
    ctl.on('pageerror', (e) => { errs.push(e.message); console.log('CTRL PAGEERR', e.message); });
    await ctl.goto(`${server.url()}/control?userId=op&role=presenter&token=${CTL_TOKEN}`, { waitUntil: 'domcontentloaded', timeout: PATIENT });
    await until(async () => ctl.evaluate(() => !!(window.__gm && typeof window.__control === 'function')),
      { label: 'the control panel booted', timeout: PATIENT });
    await until(async () => ctl.evaluate(() => (window.__gm.users() || []).some((u) => u.userId === 'vic') && (window.__gm.stations() || []).length > 0),
      { label: 'the panel sees the player and the station registry', timeout: PATIENT });

    // ── (1) ALL THREE ACTIONS ARE PRESENT ────────────────────────────────────────────────────
    let st = await rowState(ctl, 'vic');
    expect('the player has a roster row', st.found === true, JSON.stringify(st));
    expect('ACTION 1/3 — ◱ mirror is on the row, addressed to that person',
      st.mirror === true && st.mirrorFor === 'vic', JSON.stringify(st));
    expect('ACTION 2/3 — the 0508 spotlight grant is on the row, addressed to that person',
      st.spot === true && st.spotFor === 'vic', JSON.stringify(st));
    expect('ACTION 3/3 — a set-station control is on the row, addressed to that person',
      st.station === true && st.stationFor === 'vic', JSON.stringify(st));
    const declared = await ctl.evaluate(() => (window.__gm.stations() || []).map((s) => String(s.stationUid)));
    expect('the set-station control offers EVERY declared station (I4: the permissive default)',
      JSON.stringify(st.stationOptions) === JSON.stringify(declared), JSON.stringify(st.stationOptions) + ' vs ' + JSON.stringify(declared));
    expect('and it opens showing where the person is ACTUALLY sitting, not a blank',
      st.stationValue === String(ALPHA), st.stationValue);
    expect('the spotlight control starts OFF, because 0508 is default-deny',
      st.spotGranted === '0' && st.spotOn === false, JSON.stringify(st));

    // ── (2) SET-STATION ROUTES THROUGH THE 0514 RESOLVER, NOT A SECOND CODE PATH ─────────────
    const before = calls().length;
    await ctl.evaluate((uid) => {
      const sel = document.querySelector('select[data-station-for="' + uid + '"]');
      sel.value = '2';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, 'vic');
    await until(() => (server.stations().seats.find((s) => s.userId === 'vic') || {}).stationUid === BETA,
      { label: 'the seat moved to BETA', timeout: PATIENT });

    const frame = await ctl.evaluate(() => window.__gm.lastControl());
    expect('the row emits the set_station control action addressed by userId + stationUid',
      frame && frame.action === 'set_station' && frame.args && frame.args.userId === 'vic' && frame.args.stationUid === BETA,
      JSON.stringify(frame));
    const seen = calls().slice(before);
    expect('the 0514 resolver observed the seating — it was not written around it',
      seen.length === 1 && seen[0][0] === 'vic' && seen[0][1] === BETA, JSON.stringify(seen));
    expect('EXACTLY ONE resolver call: no duplicate seat-writing path ran alongside it',
      seen.length === 1, JSON.stringify(seen));

    // The receipt. A seat action that says nothing is indistinguishable from one that failed (I5).
    await until(async () => (await rowState(ctl, 'vic')).ustat.indexOf('seated') >= 0,
      { label: 'the roster reports the seating', timeout: PATIENT });
    st = await rowState(ctl, 'vic');
    expect('the roster reports the seating AND how many clients it reached (I5)',
      /seated/.test(st.ustat) && /1 client/.test(st.ustat), JSON.stringify(st.ustat));
    expect('and the row now shows the new station', st.stationValue === String(BETA), st.stationValue);

    // ── (3) THE SPOTLIGHT ACTION REALLY GRANTS, AND THE ROW REFLECTS THE SERVER'S STATE ──────
    await ctl.evaluate(() => document.querySelector('[data-spot="vic"]').click());
    await until(() => server.spotlightHolders().includes('vic'), { label: 'the grant landed on the server', timeout: PATIENT });
    await until(async () => (await rowState(ctl, 'vic')).spotOn === true, { label: 'the row shows the grant', timeout: PATIENT });
    st = await rowState(ctl, 'vic');
    expect('the spotlight row action grants the 0508 capability',
      server.spotlightHolders().includes('vic'), JSON.stringify(server.spotlightHolders()));
    expect('and the row renders the grant from the SERVER roster, not from its own last click',
      st.spotOn === true && st.spotGranted === '1', JSON.stringify(st));
    expect('the granted seat was told, so its Share control can appear',
      vic.frames.some((f) => f.t === 'station' && f.granted === true), JSON.stringify(vic.frames.filter((f) => f.t === 'station')));

    // ── (4) THE MIRROR ACTION ASKS THE SERVER, AND SAYS WHICH SOCKET ANSWERED ────────────────
    // A contested seat is ONE row with two live sockets behind it and the server picks the latest
    // (A4); disclosing the socketId is the difference between the GM knowing and the GM assuming.
    await ctl.evaluate(() => window.__gm.degrade(false));
    await ctl.evaluate(() => document.querySelector('[data-mirror="vic"]').click());
    await until(async () => {
      const f = await ctl.evaluate(() => window.__gm.lastControl());
      return !!(f && f.action === 'mirror');
    }, { label: 'the mirror request went out', timeout: PATIENT });
    await until(async () => /socket/.test((await rowState(ctl, 'vic')).ustat), { label: 'the mirror names its socket', timeout: PATIENT });
    st = await rowState(ctl, 'vic');
    const sockId = server.debugDump('presenter').connections.find((c) => c.userId === 'vic').socketId;
    expect('the mirror action reports WHICH socket answered, so a contested seat is not ambiguous',
      st.ustat.indexOf(sockId) >= 0, JSON.stringify(st.ustat) + ' expected to contain ' + sockId);
    expect('and it retargeted the preview to that person', await ctl.evaluate(() => window.__gm.target()) === 'vic');

    expect('no page error while doing any of it', errs.length === 0, JSON.stringify(errs));

    // ── (5) STRUCTURAL — core still has exactly THREE select() sites, and one foreign-userId one ──
    // §ANNEAL A: the plan named one call site and there were three. This assertion is what stops
    // a fourth appearing unnoticed, which is the only way the gate proved in the unit tier could
    // be bypassed without anybody editing it.
    /* ⭐ TWO FILES, ONE INVARIANT (Plan 0661 phase 1c). "Core" used to be one file; the wire
     * fuseactions have since moved to app/wire-actions.mjs behind an explicit context. The two
     * SELF-scoped select() sites went with them and are now spelled `ctx.seatResolver.select(` —
     * which still contains `seatResolver.select(`, so every filter below is unchanged.
     * ⛔ THE ASSERTION IS NOT RELAXED. Still exactly three sites, still exactly two self-scoped,
     *   still exactly one taking a foreign userId, and that one is still inside stationSet in
     *   server.mjs — it did not move, because it is the only site that lets one person seat
     *   another. Scanning one file after the seam was cut would have counted one site and passed
     *   for the wrong reason. [[feedback-the-coupling-may-be-by-name-not-by-path]] */
    const CORE = ['app/server.mjs', 'app/wire-actions.mjs'];
    const src = CORE.map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
    // Comment lines are excluded — this phase ADDED prose naming the three sites, and a scan that
    // counted its own documentation would report four and be wrong in the safe direction, which
    // is still wrong. Only executable lines count.
    const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);
    const sites = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('seatResolver.select(') && !isComment(l));
    expect('core calls seatResolver.select() from exactly THREE places',
      sites.length === 3, JSON.stringify(sites.map(([n, l]) => n + ': ' + l.trim())));
    const selfSites = sites.filter(([, l]) => l.includes('seatResolver.select(c.userId'));
    expect('TWO of them are SELF-scoped (join and self-select) — they pass the caller\'s own connection id',
      selfSites.length === 2, JSON.stringify(selfSites.map(([n]) => n)));
    const foreign = sites.filter(([, l]) => !l.includes('seatResolver.select(c.userId'));
    expect('exactly ONE takes a foreign userId', foreign.length === 1, JSON.stringify(foreign.map(([n, l]) => n + ': ' + l.trim())));
    const body = src.slice(src.indexOf('stationSet(userId, stationUid, actor'));
    const end = body.indexOf('\n    },');
    expect('precondition: stationSet\'s body was located', end > 0, String(end));
    expect('and that ONE site lives inside stationSet, where the gate is',
      body.slice(0, end).includes('seatResolver.select(userId'), body.slice(0, 400));
    expect('the gate runs BEFORE it, in the same function',
      body.indexOf('isControllerActor(actor)') >= 0 && body.indexOf('isControllerActor(actor)') < body.indexOf('seatResolver.select(userId'),
      body.indexOf('isControllerActor(actor)') + ' vs ' + body.indexOf('seatResolver.select(userId'));
  } finally {
    if (ctl) await ctl.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (vic) vic.ws.close();
    await server.close();
  }
});
