/*
 * Plan 0529 P3 — THE CONTESTED-SEAT LINE, DRIVEN IN REAL BROWSERS.
 *
 * Identity on a seat link is DERIVED and nothing else: userId = <stationCode>-<slug(userName)>
 * (app/server.mjs resolveIdentity). So two clients that open the same link and type the same name
 * ARRIVE AS ONE IDENTITY, by construction — and 0522 P3 made the roster collapse them into one row
 * that SAYS SO: `conns`, `contested`, and the `contested:` line at app/control.html:1063.
 *
 * ⛓ WHAT THIS FILE IS FOR, AND IT IS NOT "does contested fire".
 * 0522 t04–t06 already pin the flag at the wire, from raw sockets. This file exists to answer the
 * only question that decides whether a seat-binding gate is urgent: **can a person reading the GM
 * roster tell an IMPERSONATION from a BENIGN TWIN?** — one player who picked up their phone while
 * their laptop is still connected. The two produce the same wire input by construction, so the
 * question is entirely about what the roster EXPOSES, and it can only be answered by capturing both
 * cases and diffing them field by field. That is t03, and it is the deliverable.
 *
 * ⚠ A FALSE "we can detect impersonation" IS WORSE THAN A CLEAN "we cannot". This file is written
 * to be able to REFUTE indistinguishability: t03 compares every field the roster carries, so if a
 * field is ever added that separates the two cases, t03 goes red and the finding is retired. It is
 * an observation pinned as an assertion, not an assertion in search of an observation.
 *
 *   t0529-p3-01 — ATTACK: two people, one seat link, one typed name. The detector fires; capture
 *                 exactly what it reports (conns, contested, socketIds, ips) and the rendered line.
 *   t0529-p3-02 — BENIGN TWIN: one person, laptop + phone (different user-agent, different
 *                 viewport, different device class). The detector fires IDENTICALLY.
 *   t0529-p3-03 — SEPARABILITY: diff the two captures. Also probes the one field that varies at
 *                 all — `ip` — and finds it is asserted by the client.
 *
 * ⛔ NO GATE IS BUILT HERE. Whether a seat binds to its first claimant is the owner's call and it
 * depends on this phase's answer. This file only reads the detector that already exists.
 *
 * ── BREAK-TESTED, because a green test is not evidence (brief §4.2 / §6) ─────────────────────
 *   A. `row.contested = true` → `false` in byPerson()      ⇒ t01 AND t02 go red.
 *   B. control.html's `dupMeta` never rendered              ⇒ the rendered-line halves of t01/t02 red.
 *   C. THE FORBIDDEN IMPLEMENTATION for t03: capture `user-agent` at connect and accumulate a
 *      `uas[]` on the roster row — i.e. actually make the two cases separable ⇒ t03 goes red,
 *      naming both user-agent lists. So t03 is a falsifiable observation, not a tautology.
 *   ⚠ And note what C does NOT prove: a user-agent column would only separate THIS fixture's two
 *     scenarios. An impersonator on a matching laptop, or one person on two identical laptops,
 *     stays indistinguishable. Even the forbidden implementation is a hint, never a detector.
 *
 * NAMES: invented and obviously fictional throughout (plan 0529 §0 / guard t0531-01). The station
 * registry is the neutral 0514 fixture (alpha/beta), so this runs in a clean clone.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until } from '../../harness/multi.mjs';
import { makePluginsDir, stationManifest } from '../unit/_0514-fixtures.mjs';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TOKEN = 'p3-desk-token';
const PATIENT = 60000;

/*
 * ONE SEAT, ONE NAME — the collision, spelled out. `?stationUID=1` is fixture station `alpha`;
 * both clients type the same display name; the derived id is therefore `alpha-kestrelvane` for
 * both, whoever is behind the browser.
 *
 * uid 1 is the fixture's CAPPED station (maxOccupants: 1) on purpose — see the note in t01.
 */
const SEAT_UID = 1;
const SEAT_NAME = 'Kestrel Vane';
/** The rule's output, written out: stationCode `alpha` + slugForSeat('Kestrel Vane'). */
const DERIVED = 'alpha-kestrel-vane';

/*
 * The smallest thing that satisfies the {select,get,release} seat-resolver contract — core alone
 * never seats anyone (stationsActive() needs a plugin-provided resolver, server.mjs §4.2a). Same
 * shape as the 0522 P13 fixture. It does NOT enforce maxOccupants, and neither does core; capacity
 * is a deployment concern, so nothing here should be read as a claim about it either way.
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

/*
 * ⛔ PRESENTER_MODULES_DIR is set even though nothing here loads a module. Left unset, createServer
 * scans AND WATCHES the repo's real `modules/` — the one directory with no version history.
 */
async function boot() {
  const plugins = makePluginsDir({ p3seats: { 'plugin.json': stationManifest({ name: 'p3seats', server: 'seats.mjs' }), 'seats.mjs': RESOLVER } });
  const mods = mkdtempSync(join(tmpdir(), 'ap-0529-p3-mod-'));
  const prevP = process.env.PRESENTER_PLUGINS_DIR, prevM = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_PLUGINS_DIR = plugins;
  process.env.PRESENTER_MODULES_DIR = mods;
  let server;
  try { server = await createServer({ port: 0, controlToken: TOKEN }); }
  finally {
    if (prevP === undefined) delete process.env.PRESENTER_PLUGINS_DIR; else process.env.PRESENTER_PLUGINS_DIR = prevP;
    if (prevM === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prevM;
  }
  return { server, plugins, mods };
}

// Poll from the TEST process, never page.waitForFunction: Chrome pauses requestAnimationFrame in a
// backgrounded tab, and with three pages open two are always backgrounded (0522 P13).
const waitFor = (pg, fn, label) => until(() => pg.evaluate(fn), { timeout: PATIENT, every: 150, label });

/** A device: its own browser CONTEXT (own storage, as a separate machine has), UA and viewport. */
const LAPTOP = { label: 'laptop', ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', vp: { width: 1280, height: 800 } };
const DESKTOP2 = { label: 'other desktop', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', vp: { width: 1440, height: 900 } };
const PHONE = { label: 'phone', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', vp: { width: 412, height: 915, isMobile: true, hasTouch: true } };

/**
 * Drive ONE scenario end to end and return everything the GM's desk can see about the seat.
 *
 * `devices` is the pair of client machines claiming the seat. Everything else — the link, the typed
 * name, the station — is IDENTICAL across scenarios, because that is precisely the point: an
 * impersonation and a benign twin differ only in who is holding the second device, and the wire
 * cannot carry that fact.
 */
async function observeSeat(devices) {
  const { server, plugins, mods } = await boot();
  const browser = await launch();
  const contexts = [];
  try {
    // The GM's desk — a real control page, so what gets captured is what a human actually reads.
    const ctl = await browser.newPage();
    ctl.setDefaultTimeout(PATIENT);
    await ctl.goto(`${server.url()}/control?userId=op&role=presenter&token=${TOKEN}`,
      { waitUntil: 'domcontentloaded', timeout: PATIENT });
    await waitFor(ctl, () => !!(window.__gm && window.__gm.users), 'the control page is live');

    // Both claimants, in separate browser contexts — separate storage, as two machines have.
    for (const d of devices) {
      const ctx = await browser.createBrowserContext();
      contexts.push(ctx);
      const pg = await ctx.newPage();
      pg.setDefaultTimeout(PATIENT);
      await pg.setUserAgent(d.ua);
      await pg.setViewport(d.vp);
      await pg.goto(`${server.url()}/?stationUID=${SEAT_UID}&n=${encodeURIComponent(SEAT_NAME)}`,
        { waitUntil: 'domcontentloaded', timeout: PATIENT });
      await waitFor(pg, () => /\(/.test(document.getElementById('who').textContent || ''), `${d.label} is seated`);
    }

    // The roster row for the seat, as the GM's page holds it, once BOTH claimants are on it.
    await until(() => ctl.evaluate(() => (window.__gm.users().find((u) => u.conns > 1) || null) !== null),
      { timeout: PATIENT, every: 150, label: 'the roster reports more than one connection on a seat' });

    const row = await ctl.evaluate(() => window.__gm.users().find((u) => u.conns > 1) || null);
    const rows = await ctl.evaluate(() => window.__gm.users());
    // What the human SEES, not what the wire carries — the rendered line at control.html:1063.
    const rendered = await ctl.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.user')).find((d) => /contested:/.test(d.textContent || ''));
      if (!el) return null;
      const meta = el.querySelector('.u-meta');
      const dup = el.querySelector('.u-dup');
      return { meta: (meta ? meta.textContent : '').replace(/\s+/g, ' ').trim(), badge: dup ? dup.textContent.trim() : null };
    });
    // The per-socket view, which is the ONLY other place a GM could look.
    const conns = server.debugDump('presenter').connections.filter((c) => c.userId === row.userId);
    return { row, rows, rendered, conns, userAgents: devices.map((d) => d.ua) };
  } finally {
    for (const c of contexts) { try { await c.close(); } catch {} }
    try { await browser.close(); } catch {}
    await server.close();
    rmSync(plugins, { recursive: true, force: true });
    rmSync(mods, { recursive: true, force: true });
  }
}

/*
 * The two captures live here so t03 can diff them. If either scenario fails to capture, t03 says so
 * rather than passing on absent evidence — an indistinguishability claim built on `null === null`
 * would be exactly the false reassurance this phase exists to avoid.
 */
const CAP = { attack: null, twin: null };

test('t0529-p3-01 — ATTACK: two people, one seat link, one name → the roster fires `contested:`', async () => {
  // The impersonator needs nothing an attacker would not have: the link, and the name. Both are
  // visible to anyone at the table, and the name is rendered on every roster and attendance list.
  const cap = await observeSeat([LAPTOP, DESKTOP2]);
  CAP.attack = cap;

  expect('the two claimants collapse to ONE roster row (identity collided, as derivation guarantees)',
    cap.rows.filter((u) => u.userId === cap.row.userId).length === 1, JSON.stringify(cap.rows.map((u) => u.userId)));
  expect('the derived id is <stationCode>-<slug(name)>, from the link and the name alone',
    cap.row.userId === DERIVED, cap.row.userId);
  expect('THE DETECTOR FIRES: the row is flagged contested with 2 live connections',
    cap.row.contested === true && cap.row.conns === 2, JSON.stringify(cap.row));
  expect('and it names BOTH sockets, so the collapse is not a silent deletion of a human (I4)',
    Array.isArray(cap.row.socketIds) && cap.row.socketIds.length === 2, JSON.stringify(cap.row.socketIds));
  expect('and BOTH addresses', Array.isArray(cap.row.ips) && cap.row.ips.length === 2, JSON.stringify(cap.row.ips));
  expect('the per-socket view survives on the debug surface, one entry per socket',
    cap.conns.length === 2, JSON.stringify(cap.conns.map((c) => c.id)));

  // ⛓ THE HUMAN-VISIBLE HALF. A flag on the wire that no page renders is not a detector a GM has.
  expect('the GM page RENDERS the contested line (control.html:1063), not just the flag',
    cap.rendered && /contested:/.test(cap.rendered.meta), JSON.stringify(cap.rendered));
  expect('and the ×N ⚠ badge is on the row', cap.rendered && /×2/.test(cap.rendered.badge || ''),
    JSON.stringify(cap.rendered && cap.rendered.badge));

  // Recorded, NOT asserted as a core property: the fixture station declares maxOccupants: 1 and two
  // clients hold it anyway. `maxOccupants` is validated by harness/plugins.mjs and shipped to the
  // wire, and is read by NOTHING in app/ or lib/ — seating is delegated to the deployment's
  // resolver, and this fixture's does not enforce it either. Out of scope for this phase.
});

test('t0529-p3-02 — BENIGN TWIN: one person, laptop + phone → the detector fires the same way', async () => {
  // One human, two devices: the ordinary thing a participant does when they pick up their phone
  // and their laptop has not been reaped yet. Different user-agent, different viewport, different
  // device class — every difference a browser can express.
  const cap = await observeSeat([LAPTOP, PHONE]);
  CAP.twin = cap;

  expect('the twin also collapses to ONE row', cap.rows.filter((u) => u.userId === cap.row.userId).length === 1,
    JSON.stringify(cap.rows.map((u) => u.userId)));
  expect('THE DETECTOR FIRES ON THE INNOCENT CASE TOO: contested, 2 connections',
    cap.row.contested === true && cap.row.conns === 2, JSON.stringify(cap.row));
  expect('the same rendered line appears on the GM page for a player who did nothing wrong',
    cap.rendered && /contested:/.test(cap.rendered.meta), JSON.stringify(cap.rendered));
  expect('the two devices ARE genuinely different clients (the fixture is not a false twin)',
    cap.userAgents[0] !== cap.userAgents[1] && /Mobile/.test(cap.userAgents[1]), JSON.stringify(cap.userAgents));
});

test('t0529-p3-03 — the two cases are NOT separable from the roster alone (THE FINDING)', async () => {
  expect('precondition: BOTH scenarios were captured (an absent capture must not read as a match)',
    !!CAP.attack && !!CAP.twin, JSON.stringify({ attack: !!CAP.attack, twin: !!CAP.twin }));
  if (!CAP.attack || !CAP.twin) return;

  /*
   * `lastSeen` is a wall clock and `display` is whatever the page is showing; neither carries any
   * information about WHO is behind a socket. Everything else the roster row exposes is compared
   * verbatim. If a field is ever added that DOES separate the cases, this assertion goes red — and
   * that is the point: the finding is falsifiable, not decorative.
   */
  const shape = (r) => { const o = Object.assign({}, r); delete o.lastSeen; return o; };
  const a = shape(CAP.attack.row), t = shape(CAP.twin.row);
  expect('every field the GM roster carries is IDENTICAL between impersonation and benign twin',
    JSON.stringify(a) === JSON.stringify(t), 'attack=' + JSON.stringify(a) + '  twin=' + JSON.stringify(t));
  const meta = (c) => (c.rendered && c.rendered.meta) || null;   // a missing render must FAIL, not throw
  expect('and the rendered line a human reads is identical too',
    meta(CAP.attack) !== null && meta(CAP.attack) === meta(CAP.twin),
    'attack=' + meta(CAP.attack) + '  twin=' + meta(CAP.twin));

  /*
   * THE ONE THING THAT DID DIFFER between the two devices in BOTH scenarios was the user-agent —
   * and the server never records it. `conns.set(ws, {...})` (server.mjs:1155) keeps id, userId,
   * userName, role, timestamps and ip. Nothing else about the client exists to be shown.
   */
  const keys = Object.keys(CAP.attack.row).sort();
  expect('the roster exposes no client-fingerprint field at all — no user-agent, no device, no fingerprint',
    !keys.some((k) => /agent|device|fingerprint|browser|platform/i.test(k)), JSON.stringify(keys));
  expect('nor does the per-socket debug view, the only other place to look',
    !Object.keys(CAP.attack.conns[0] || {}).some((k) => /agent|device|fingerprint|browser|platform/i.test(k)),
    JSON.stringify(Object.keys(CAP.attack.conns[0] || {})));

  /*
   * ⚠ AND THE ONE FIELD THAT COULD EVER VARY — `ip` — IS ASSERTED BY THE CLIENT.
   * server.mjs:1150 takes the LEFTMOST value of `x-forwarded-for` when the header is present, with
   * no trusted-proxy check, so a claimant chooses the address the GM sees. A GM who resolved a
   * contested row by comparing addresses would be comparing two strings the clients wrote.
   * ⛔ RECORDED, NOT FIXED — out of this phase's scope (the deployment terminates TLS at an ingress
   * that supplies this header, so the fix is a trusted-proxy policy, not a one-line deletion).
   */
  const { server, plugins, mods } = await boot();
  const sockets = [];
  try {
    const wsUrl = server.url().replace('http', 'ws');
    const open = (headers, hello) => new Promise((res) => {
      const ws = new WebSocket(wsUrl, headers ? { headers } : undefined);
      const frames = [];
      ws.on('message', (b) => { try { frames.push(JSON.parse(b.toString())); } catch {} });
      ws.on('open', () => {
        ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello || { stationUID: SEAT_UID, userName: SEAT_NAME })));
        setTimeout(() => res({ ws, frames }), 200);
      });
    });
    // The address column lives ONLY on the control roster (pushPresence), and pushPresence is a
    // no-op unless a control socket is listening — so the probe needs a desk to read from.
    const desk = await open(null, { userId: 'op', userName: 'Op', role: 'presenter', token: TOKEN });
    sockets.push(desk);
    sockets.push(await open(null));
    sockets.push(await open({ 'x-forwarded-for': '198.51.100.4' }));   // TEST-NET-2, RFC 5737
    await until(() => (server.presence().find((u) => u.userId === DERIVED) || {}).conns === 2,
      { timeout: 8000, every: 100, label: 'both wire claimants seated' }).catch(() => {});
    const users = [...desk.frames].reverse().find((f) => f.t === 'presence');
    const seat = ((users && users.users) || []).find((u) => u.userId === DERIVED) || {};
    const ips = seat.ips || [];
    expect('the address column prints what the CLIENT said (x-forwarded-for, leftmost, untrusted)',
      ips.includes('198.51.100.4'), JSON.stringify(ips));
  } finally {
    for (const s of sockets) { try { s.ws.close(); } catch {} }
    await server.close();
    rmSync(plugins, { recursive: true, force: true });
    rmSync(mods, { recursive: true, force: true });
  }
});
