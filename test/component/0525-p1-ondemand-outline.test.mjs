/*
 * Plan 0525 P1.2 (R5) — t74: THE GM OUTLINE MARKS AN ON-DEMAND BEAT, AND STAGES IT UNCHANGED.
 *
 * `onDemand` is a note to whoever is presenting: *this beat is prepared, but it is not on the
 * path; show it only when they ask for it.* Until this phase the GM outline rendered a beat's
 * title and its component badge and nothing else, so a human scanning the outline mid-session
 * could not tell a beat-behind-the-door from any other row — the marker has been invisible on
 * this surface since the day it was authored.
 *
 * TWO HALVES, AND THE SECOND IS NOT OPTIONAL:
 *
 *   (a) the marked row carries a badge and ordinary rows do not — the visibility fix itself;
 *   (b) the marked row STAGES ON CLICK EXACTLY AS BEFORE, and GO ships it.
 *
 * Without (b) this phase could silently become an ENFORCEMENT — an outline that labels a beat and
 * then declines to serve it. R5 forbids that: the product's job is to make the marker visible and
 * nothing else, because when they DO find the door the presenter opens it, with one ordinary
 * click. ⛔ No fold, no <details> tier, no accBind: the row is a row.
 *
 * ⚠ VISIBILITY IS ASSERTED WITH checkVisibility(), NEVER WITH A RECT — a closed or clipped element
 * keeps a non-zero bounding box, so a rect answers a question nobody asked.
 * ⚠ One browser, one page. Waiting is `until()` + page.evaluate from harness/multi.mjs, never
 * page.waitForFunction: Chrome throttles rAF in a backgrounded tab and a rAF-driven wait can hang.
 * ⛔ modules/*.json is gitignored and has no version history. The fixture below lives in a temp
 * directory this file creates and removes; the repo's modules/ is never read or written.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocket } from 'ws';

// Plan 0529 P2: the content catalogue is control-credentialed and FAILS CLOSED, so a test
// that drives the GM panel must run a gated server and hand the page a token — exactly as a
// real deployment does. Nothing else about these tests changed.
const CTL_TOKEN = 'ap-test-control-token';

const ID = 'odmod';
const MARKED = 'behind-the-door';

/** Five beats; exactly one of them — the beat behind the door — is marked on demand. */
const deck = () => ({
  manifest: { title: 'On-demand fixture' },      // no defaultBeatId: setModule must not auto-show
  beats: [
    { id: 'approach', component: 'card', promptId: 'pr-approach', opts: { title: 'The approach' } },
    { id: 'corridor', component: 'card', promptId: 'pr-corridor', opts: { title: 'The corridor' } },
    { id: MARKED, component: 'card', promptId: 'pr-door', opts: { title: 'Behind the door' }, onDemand: true },
    { id: 'stairwell', component: 'card', promptId: 'pr-stairwell', opts: { title: 'The stairwell' } },
    { id: 'roof', component: 'card', promptId: 'pr-roof', opts: { title: 'The roof' } },
  ],
});

/** A server whose MODULES_DIR is a private temp dir seeded with one module. */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0525-p1-'));
  writeFileSync(join(dir, ID + '.json'), JSON.stringify(deck()));
  const prev = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_MODULES_DIR = dir;                       // read once, inside createServer
  let server;
  try { server = await createServer({ port: 0, controlToken: CTL_TOKEN }); }
  finally { if (prev === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prev; }
  return { dir, server };
}

/** Raw participant socket that records every frame it receives. */
function participant(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const frames = [];
    ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) {} });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws, frames }); });
  });
}

const lastShown = (p) => { const f = p.frames.filter((x) => x.t === 'content'); return f.length ? f[f.length - 1].contentId : null; };

/** Per-row state of the outline, read in one pass so the two halves cannot disagree. */
const readOutline = (pg) => pg.evaluate(() => [...document.querySelectorAll('#outline .beat')].map((row) => {
  const badge = row.querySelector('.ondemand');
  return {
    label: row.textContent.slice(0, 24),
    hasBadge: !!badge,
    hasApi: !!(badge && typeof badge.checkVisibility === 'function'),
    badgeVisible: badge && typeof badge.checkVisibility === 'function' ? badge.checkVisibility() : null,
    badgeText: badge ? badge.textContent : null,
    // The component badge is the visual grammar the new one joins: assert it is still there.
    hasComp: !!row.querySelector('.comp'),
  };
}));

test('0525 t74 — the GM outline MARKS an on-demand beat, marks nothing else, and stages it exactly as before', async () => {
  const { dir, server } = await boot();
  const browser = await launch();
  let player = null;
  try {
    const ctl = await browser.newPage();
    ctl.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
    await ctl.goto(`${server.url()}/control?userId=op&role=presenter&token=${CTL_TOKEN}`, { waitUntil: 'domcontentloaded' });
    await until(async () => ctl.evaluate(() => !!(window.__gm && typeof window.__control === 'function')
      && document.getElementById('mod-select').options.length > 1), { label: 'control page ready' });

    player = await participant(server.url().replace('http', 'ws'), { userId: 'pl1', userName: 'Player One', role: 'participant' });
    await until(() => server.presence().some((u) => u.userId === 'pl1'), { label: 'player connected' });

    await ctl.evaluate((i) => { const s = document.getElementById('mod-select'); s.value = i; s.onchange(); }, ID);
    await until(async () => ctl.evaluate(() => ((window.__gm.module() || {}).beats || []).length === 5), { label: 'module in the panel' });
    await ctl.evaluate(() => document.getElementById('mod-load').click());
    await until(() => ((server.getModule() || {}).beats || []).length === 5, { label: 'module loaded server-side' });
    await until(async () => (await readOutline(ctl)).length === 5, { label: 'the outline rendered five rows' });

    // ── (a) THE MARKER IS VISIBLE, AND ONLY ON THE MARKED ROW ───────────────────────────────
    const rows = await readOutline(ctl);
    const marked = rows.filter((r) => r.hasBadge);
    expect('exactly one row carries the on-demand badge', marked.length === 1, JSON.stringify(rows.map((r) => [r.label, r.hasBadge])));
    expect('and it is the row labelled "Behind the door"', marked[0] && /Behind the door/.test(marked[0].label), JSON.stringify(marked));
    expect('checkVisibility() is available (a rect would not be proof)', marked[0] && marked[0].hasApi === true, JSON.stringify(marked[0]));
    expect('the badge IS visible, per checkVisibility()', marked[0] && marked[0].badgeVisible === true, JSON.stringify(marked[0]));
    expect('the badge says what it means in words a human can scan', marked[0] && /on demand/i.test(marked[0].badgeText || ''), JSON.stringify(marked[0]));
    expect('no ORDINARY row is marked — the badge distinguishes, or it says nothing',
      rows.filter((r) => !/Behind the door/.test(r.label)).every((r) => r.hasBadge === false),
      JSON.stringify(rows.map((r) => [r.label, r.hasBadge])));
    expect('and every row still carries its component badge — nothing else about the row changed',
      rows.every((r) => r.hasComp === true), JSON.stringify(rows.map((r) => [r.label, r.hasComp])));

    // ── (b) IT STILL STAGES ON CLICK. R5: the marker informs the presenter, it does not gate. ─
    const clicked = await ctl.evaluate(() => {
      const row = [...document.querySelectorAll('#outline .beat')].find((r) => /Behind the door/.test(r.textContent));
      if (!row) return false;
      row.click();
      return true;
    });
    expect('the on-demand row is clickable, like any other row', clicked === true);
    await until(async () => { const s = await ctl.evaluate(() => window.__gm.staged()); return !!s && s.beatId === MARKED; },
      { label: 'the click STAGED the on-demand beat, exactly as an ordinary row does' });
    expect('P6/R4 unchanged — the click alone shipped nothing', lastShown(player) === null, String(lastShown(player)));

    await ctl.evaluate(() => document.getElementById('btn-go').click());
    await until(() => lastShown(player) === 'pr-door', { label: 'GO shipped the on-demand beat to the player' });
    await wait(200);
    expect('GO on an on-demand row ships it — when they ask, the presenter opens the door and it opens',
      lastShown(player) === 'pr-door', 'player last saw ' + lastShown(player));
    expect('and the server\'s live beat is the on-demand beat\'s own index (2)',
      server.store.get('module/current') === 2, String(server.store.get('module/current')));
  } finally {
    if (player) player.ws.close();
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
