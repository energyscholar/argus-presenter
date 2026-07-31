/*
 * Plan 0522 R14 — THE CONTROL PAGE MUST ADDRESS BEATS BY ID, NOT BY INDEX.
 *
 * Found during P2 verification, folded into P4 because P4 reopens these call sites anyway and the
 * new staging path must not be built on broken addressing.
 *
 * P2 made the PANEL re-resolve the displayed beat by id when a module changes on disk, because an
 * edit moves every index at or below it. The CLICK PATH did not follow: beatRow, the TOC ⏵ jump,
 * ▶ Start and the digit jump all sent `show_beat {index:i}` — and the SERVER holds whatever module
 * copy it was last handed, until the GM clicks Validate & Load. Between those two moments the two
 * copies disagree about which beat index 2 names, so a click ships a DIFFERENT beat than the one
 * the GM is pointing at. Nothing on screen contradicts it; the players just see the wrong thing.
 *
 * The server has accepted `{id:…}` all along (handleControl 'show_beat'; maybeBranch already used
 * it), so the fix is client-side and the protocol is untouched.
 *
 * Shape of the test: load a 5-beat module into BOTH the panel and the server, then REORDER the
 * beats on disk. Every id still exists server-side, so both addressings resolve — they just
 * resolve to different beats. That is the whole point: an index-addressed click passes silently
 * while shipping the wrong content, so only an assertion on WHAT THE PLAYER RECEIVED can catch it.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocket } from 'ws';

const ID = 'r14mod';

// ⛔ modules/*.json is gitignored and has no version history. Every fixture here lives in a temp
// directory this suite creates and removes; the repo's modules/ is never read or written.
const deck = (ids) => ({
  manifest: { title: 'R14 fixture' },            // no defaultBeatId: setModule must not auto-show
  beats: ids.map((i) => ({ id: i, component: 'card', promptId: 'pr-' + i, opts: { title: 'Beat ' + i } })),
});

/** A server whose MODULES_DIR is a private temp dir seeded with one module. */
async function boot(beatIds) {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0522-r14-'));
  const file = join(dir, ID + '.json');
  writeFileSync(file, JSON.stringify(deck(beatIds)));
  const prev = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_MODULES_DIR = dir;                       // read once, inside createServer
  let server;
  try { server = await createServer({ port: 0 }); }
  finally { if (prev === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prev; }
  return { dir, file, server };
}

async function openControl(browser, server) {
  const pg = await browser.newPage();
  pg.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
  await pg.goto(`${server.url()}/control?userId=op&role=presenter`, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => window.__gm && typeof window.__control === 'function'
    && document.getElementById('mod-select').options.length > 1);
  return pg;
}

async function selectModule(pg, id, beats) {
  await pg.evaluate((i) => { const s = document.getElementById('mod-select'); s.value = i; s.onchange(); }, id);
  await pg.waitForFunction((n) => { const m = window.__gm.module(); return !!m && (m.beats || []).length === n; }, {}, beats);
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

test('0522 R14 — after a disk change, a click ships the beat that is ON SCREEN, not the one at that index', async () => {
  const { dir, file, server } = await boot(['b1', 'b2', 'b3', 'b4', 'b5']);
  const browser = await launch();
  let player = null;
  try {
    const ctl = await openControl(browser, server);
    player = await participant(server.url().replace('http', 'ws'), { userId: 'pl1', userName: 'Player One', role: 'participant' });
    await until(() => server.presence().some((u) => u.userId === 'pl1'), { label: 'player connected' });

    await selectModule(ctl, ID, 5);
    await ctl.evaluate(() => document.getElementById('mod-load').click());
    await until(() => (server.getModule() || {}).beats && server.getModule().beats.length === 5, { label: 'module loaded server-side' });

    // The module is REORDERED on disk — b3 and b4 move to the front. The panel re-fetches (P2);
    // the server keeps the copy it was handed. Both copies hold all five ids, so an index-
    // addressed click still resolves — to the wrong beat.
    writeFileSync(file, JSON.stringify(deck(['b3', 'b4', 'b1', 'b2', 'b5'])));
    await ctl.waitForFunction(() => { const m = window.__gm.module(); const b = (m || {}).beats || []; return b.length === 5 && b[0].id === 'b3'; },
      { timeout: 8000 });
    const serverOrder = server.getModule().beats.map((b) => b.id);
    expect('precondition: the SERVER still holds the old order', JSON.stringify(serverOrder) === JSON.stringify(['b1', 'b2', 'b3', 'b4', 'b5']), JSON.stringify(serverOrder));
    const panelOrder = await ctl.evaluate(() => ((window.__gm.module() || {}).beats || []).map((b) => b.id));
    expect('precondition: the PANEL holds the new order — the two disagree, which is the whole bug',
      JSON.stringify(panelOrder) === JSON.stringify(['b3', 'b4', 'b1', 'b2', 'b5']), JSON.stringify(panelOrder));

    // ── ▶ Start. The panel's first beat is b3. Addressed by INDEX 0 the server ships b1.
    await ctl.evaluate(() => document.getElementById('btn-start').click());
    await until(() => lastShown(player) !== null && player.frames.filter((f) => f.t === 'content').length > 0, { label: 'the player received something' });
    await wait(250);
    expect('▶ Start shipped the FIRST BEAT THE PANEL SHOWS (b3), not the beat at server index 0 (b1)',
      lastShown(player) === 'pr-b3', 'player last saw ' + lastShown(player));

    // ── A beat row. On screen, row 2 reads "Beat b1". Addressed by INDEX 2 the server ships b3.
    const clicked = await ctl.evaluate(() => {
      const rows = [...document.querySelectorAll('#outline .beat')];
      const target = rows.findIndex((r) => r.textContent.indexOf('Beat b1') === 0);
      if (target < 0) return null;
      rows[target].click();
      return { rowIndex: target, label: rows[target].textContent.slice(0, 12) };
    });
    expect('the row the test clicked is the one labelled b1, at panel index 2',
      clicked && clicked.rowIndex === 2, JSON.stringify(clicked));
    await until(() => lastShown(player) === 'pr-b1' || lastShown(player) === 'pr-b3', { label: 'the click produced a push' })
      .catch(() => {});
    await wait(250);
    expect('clicking the row labelled "Beat b1" shipped b1 — NOT the beat at server index 2 (b3)',
      lastShown(player) === 'pr-b1', 'player last saw ' + lastShown(player));
    expect('and the server\'s live beat is b1\'s index in the SERVER copy (0)',
      server.store.get('module/current') === 0, String(server.store.get('module/current')));

    // ── Same rule for the TOC ⏵ jump and the digit jump, which share the path.
    const secJump = await ctl.evaluate(() => {
      const btn = document.querySelector('#outline .sec summary .tocjump');
      if (!btn) return false;
      btn.click(); return true;
    });
    expect('the section ⏵ jump button exists', secJump === true);
    await wait(300);
    expect('the ⏵ jump ships the first beat of the tier AS THE PANEL SHOWS IT (b3)',
      lastShown(player) === 'pr-b3', 'player last saw ' + lastShown(player));
  } finally {
    if (player) player.ws.close();
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
