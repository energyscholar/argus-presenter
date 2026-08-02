/*
 * Plan 0522 P2.1 (B2) — `module-changed` must invalidate the control page's CACHED module body.
 *
 * Observed live 2026-07-28: disk held 9 beats, the server reported 9, the control page rendered 5.
 * `presenter_refresh_modules` re-scans the directory, but a control page already holding a module
 * kept — and would re-push — its stale copy. The old code printed "re-select to reload" and left
 * the false content on screen.
 *
 * The trap this suite exists to catch: invalidation MUST NOT blow away the live beat. A module
 * gains beats precisely when this event fires, so every index at or below an insertion point
 * moves. The displayed beat is re-resolved BY ID; resetting the panel to beat 0 (or to nothing)
 * in front of five waiting players is worse than the stale cache it fixes. And invalidation is a
 * GM-side refresh only: it pushes nothing, so what the players see cannot change (I3).
 *
 *   t01 — after module-changed, the client's beat count equals disk.
 *   t02 — the live beat is still displayed after invalidation, resolved by id.
 *   t03 — invalidation when beat ids have shifted does not change what players see.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocket } from 'ws';

// Plan 0529 P2: the content catalogue is control-credentialed and FAILS CLOSED, so a test
// that drives the GM panel must run a gated server and hand the page a token — exactly as a
// real deployment does. Nothing else about these tests changed.
const CTL_TOKEN = 'ap-test-control-token';

const ID = 'p2mod';

// ⛔ modules/*.json is gitignored and has no version history. Every fixture here lives in a temp
// directory this suite creates and removes; the repo's modules/ is never read or written.
const deck = (ids) => ({
  manifest: { title: 'P2 fixture' },            // no defaultBeatId: setModule must not auto-show
  beats: ids.map((i) => ({ id: i, component: 'card', promptId: 'pr-' + i, opts: { title: 'Beat ' + i } })),
});

/** A server whose MODULES_DIR is a private temp dir seeded with one module. */
async function boot(beatIds) {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0522-p2-'));
  const file = join(dir, ID + '.json');
  writeFileSync(file, JSON.stringify(deck(beatIds)));
  const prev = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_MODULES_DIR = dir;                       // read once, inside createServer
  let server;
  try { server = await createServer({ port: 0, controlToken: CTL_TOKEN }); }
  finally { if (prev === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prev; }
  return { dir, file, server };
}

/** Control page, connected, with the module list populated. */
async function openControl(browser, server) {
  const pg = await browser.newPage();
  pg.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
  await pg.goto(`${server.url()}/control?userId=op&role=presenter&token=${CTL_TOKEN}`, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => window.__gm && typeof window.__control === 'function'
    && document.getElementById('mod-select').options.length > 1);
  return pg;
}

/** Pick the fixture in the picker (the fetch-and-validate path) and wait for the body to arrive. */
async function selectModule(pg, id, beats) {
  await pg.evaluate((i) => { const s = document.getElementById('mod-select'); s.value = i; s.onchange(); }, id);
  await pg.waitForFunction((n) => { const m = window.__gm.module(); return !!m && (m.beats || []).length === n; }, {}, beats);
}

/** The count of beat rows the OUTLINE actually renders — the surface that lied on 2026-07-28. */
const renderedBeats = (pg) => pg.evaluate(() => document.querySelectorAll('#outline .beat').length);

const diskBeats = (file) => JSON.parse(readFileSync(file, 'utf8')).beats.length;

/** Raw participant socket that records every frame it receives. */
function participant(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const frames = [];
    ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) {} });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws, frames }); });
  });
}

test('0522 t01 — after module-changed the control page beat count equals DISK', async () => {
  const { dir, file, server } = await boot(['b1', 'b2', 'b3', 'b4', 'b5']);
  const browser = await launch();
  try {
    const ctl = await openControl(browser, server);
    await selectModule(ctl, ID, 5);

    // Pre-state: the panel holds the 5-beat copy. Without this the test could pass on a no-op.
    expect('before: panel renders the 5 beats on disk', (await renderedBeats(ctl)) === 5, 'rendered=' + (await renderedBeats(ctl)));

    // Four more beats land on disk while the panel holds the module — the live 2026-07-28 shape.
    writeFileSync(file, JSON.stringify(deck(['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9'])));
    expect('disk now holds 9 beats', diskBeats(file) === 9, String(diskBeats(file)));

    await ctl.waitForFunction(() => { const m = window.__gm.module(); return !!m && (m.beats || []).length === 9; },
      { timeout: 8000 }).catch(() => {});

    const held = await ctl.evaluate(() => ((window.__gm.module() || {}).beats || []).length);
    expect('cached module body was invalidated: client beats === disk beats', held === diskBeats(file), `client=${held} disk=${diskBeats(file)}`);
    const rows = await renderedBeats(ctl);
    expect('the OUTLINE renders every beat on disk (the surface that lied)', rows === diskBeats(file), `rendered=${rows} disk=${diskBeats(file)}`);
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('0522 t02 — the live beat survives invalidation, resolved by ID not index', async () => {
  const { dir, file, server } = await boot(['b1', 'b2', 'b3', 'b4', 'b5']);
  const browser = await launch();
  try {
    const ctl = await openControl(browser, server);
    await selectModule(ctl, ID, 5);
    await ctl.evaluate(() => document.getElementById('mod-load').click());
    await until(() => (server.getModule() || {}).beats && server.getModule().beats.length === 5, { label: 'module loaded server-side' });

    // Go live on b3 (index 2) and let the server's diff drive the panel, as in play.
    await ctl.evaluate(() => window.__control('show_beat', { index: 2 }));
    await ctl.waitForFunction(() => window.__gm.cur() === 2, { timeout: 5000 });

    // Three beats inserted BEFORE b3 — the exact case where index-preservation silently lies:
    // index 2 now names x3, and b3 has moved to index 5.
    writeFileSync(file, JSON.stringify(deck(['b1', 'b2', 'x1', 'x2', 'x3', 'b3', 'b4', 'b5'])));
    await ctl.waitForFunction(() => { const m = window.__gm.module(); return !!m && (m.beats || []).length === 8; },
      { timeout: 8000 }).catch(() => {});

    const st = await ctl.evaluate(() => {
      const m = window.__gm.module() || { beats: [] }, i = window.__gm.cur();
      const row = document.querySelector('#outline .beat.cur');
      return { i, id: (m.beats[i] || {}).id, len: (m.beats || []).length, row: row ? row.textContent : null };
    });
    expect('the display was not reset (not -1, not beat 0)', st.i > 0, JSON.stringify(st));
    expect('the live beat is still b3 — re-resolved by id, index moved 2 → 5', st.id === 'b3' && st.i === 5, JSON.stringify(st));
    expect('the highlighted OUTLINE row is b3', !!st.row && st.row.indexOf('Beat b3') === 0, JSON.stringify(st));
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('0522 t03 — invalidation with shifted beat ids changes NOTHING for players', async () => {
  const { dir, file, server } = await boot(['b1', 'b2', 'b3', 'b4', 'b5']);
  const browser = await launch();
  try {
    const ctl = await openControl(browser, server);
    const player = await participant(server.url().replace('http', 'ws'), { userId: 'pl1', userName: 'Player One', role: 'participant' });
    await until(() => server.presence().some((u) => u.userId === 'pl1'), { label: 'player connected' });

    await selectModule(ctl, ID, 5);
    await ctl.evaluate(() => document.getElementById('mod-load').click());
    await until(() => (server.getModule() || {}).beats && server.getModule().beats.length === 5, { label: 'module loaded server-side' });
    await ctl.evaluate(() => window.__control('show_beat', { index: 2 }));
    await until(() => player.frames.some((f) => f.t === 'content' && f.contentId === 'pr-b3'), { label: 'player is showing b3' });

    // What the player is looking at, immediately before invalidation.
    const before = {
      content: player.frames.filter((f) => f.t === 'content').length,
      clear: player.frames.filter((f) => f.t === 'clear').length,
      last: player.frames.filter((f) => f.t === 'content').slice(-1)[0].contentId,
      serverBeats: server.getModule().beats.length,
    };

    // Every id below the insertion point shifts; b3 goes 2 → 5.
    writeFileSync(file, JSON.stringify(deck(['n1', 'n2', 'n3', 'b1', 'b2', 'b3', 'b4', 'b5'])));
    await ctl.waitForFunction(() => { const m = window.__gm.module(); return !!m && (m.beats || []).length === 8; },
      { timeout: 8000 }).catch(() => {});
    await wait(500);   // settle: any push invalidation triggered would have landed by now

    const after = {
      content: player.frames.filter((f) => f.t === 'content').length,
      clear: player.frames.filter((f) => f.t === 'clear').length,
      last: player.frames.filter((f) => f.t === 'content').slice(-1)[0].contentId,
      serverBeats: server.getModule().beats.length,
    };
    expect('the player received NO new content frame', after.content === before.content, JSON.stringify({ before, after }));
    expect('the player received NO clear frame', after.clear === before.clear, JSON.stringify({ before, after }));
    expect('the player is still showing b3', after.last === before.last && after.last === 'pr-b3', JSON.stringify({ before, after }));
    expect('invalidation pushed nothing: the SERVER copy is untouched', after.serverBeats === before.serverBeats, JSON.stringify({ before, after }));

    // ...and the GM's panel did refresh, so this is not passing by doing nothing at all.
    const held = await ctl.evaluate(() => ((window.__gm.module() || {}).beats || []).length);
    expect('meanwhile the GM panel DID invalidate (8 beats)', held === 8, 'client=' + held);

    player.ws.close();
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
