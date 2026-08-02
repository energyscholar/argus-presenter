/*
 * Plan 0522 P9 (R10) — STICKY DEFAULT MODULE.
 *
 * "Sticky" means the module stays the DEFAULT. It is PRESELECTED on the next load, not loaded.
 * There is no second reading (R10, settled by Bruce).
 *
 * The trap this suite exists to catch is the tempting over-delivery: if opening the control page
 * auto-LOADED the persisted module, then opening a SECOND control page mid-session — the ordinary
 * act of pulling up the panel on the laptop next to you — would push a module into the room and
 * blow away the live beat in front of five waiting players. t24 is the load-bearing test and it
 * asserts from the PLAYER's side: a real display page's rendered content frame, plus a raw
 * participant socket recording every frame the server sent, plus the server's own module copy.
 * The fixture makes the danger real rather than notional: the sticky module declares a
 * `manifest.defaultBeatId`, so a `load_module` would publish immediately (server.mjs DEF-1).
 *
 * And a persisted id whose file is gone must degrade SILENTLY to no selection — never an error
 * dialog at 20:05 (I4).
 *
 *   t23 — a persisted moduleId is preselected on reload (and is actionable, not a dead default).
 *   t24 — preselect does NOT load: the live display is unchanged by opening a control page.
 *   t25 — a missing persisted module yields no selection and no error.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait, connectUser, waitContentFrame } from '../../harness/multi.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocket } from 'ws';

// Plan 0529 P2: the content catalogue is control-credentialed and FAILS CLOSED, so a test
// that drives the GM panel must run a gated server and hand the page a token — exactly as a
// real deployment does. Nothing else about these tests changed.
const CTL_TOKEN = 'ap-test-control-token';

const A = 'p9a';          // the module that is LIVE in the room
const B = 'p9b';          // the module the GM last had selected — the sticky default
const GHOST = 'p9-gone';  // a persisted id with no file behind it

// The localStorage key the control page owns for this preference. Asserted by name on purpose:
// the key IS the contract between one session and the next, and a silent rename is a silent
// loss of the preference. It must not collide with TOKEN_KEY / NP_KEY / ACC_KEY.
const MOD_KEY = 'argus-presenter:module';

// ⛔ modules/*.json is gitignored and has no version history. Every fixture here lives in a temp
// directory this suite creates and removes; the repo's modules/ is never read or written.
const deck = (title, ids, defaultBeatId) => ({
  manifest: Object.assign({ title }, defaultBeatId ? { defaultBeatId } : {}),
  beats: ids.map((i) => ({ id: i, component: 'card', promptId: 'pr-' + i, opts: { title: 'Beat ' + i } })),
});

/** A server whose MODULES_DIR is a private temp dir holding both fixtures. */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0522-p9-'));
  // A: no defaultBeatId — loading it must not auto-show, so the test drives the live beat itself.
  writeFileSync(join(dir, A + '.json'), JSON.stringify(deck('P9 live module', ['a1', 'a2', 'a3'])));
  // B: HAS a defaultBeatId ⇒ a load_module would publish instantly. That is what t24 must not see.
  writeFileSync(join(dir, B + '.json'), JSON.stringify(deck('P9 sticky module', ['b1', 'b2'], 'b1')));
  const prev = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_MODULES_DIR = dir;                       // read once, inside createServer
  let server;
  try { server = await createServer({ port: 0, controlToken: CTL_TOKEN }); }
  finally { if (prev === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prev; }
  return { dir, server };
}

// t24 runs three browser pages at once, and the whole suite launches a browser per component
// file. On a loaded box puppeteer's 30 s default has been observed to expire on a page that was
// merely slow, not stuck — a timeout that reports a scheduling fact as a product defect. Every
// wait here is therefore explicit and generous; a genuinely broken page still fails, just later.
const PATIENT = 90000;

// ⚠ FIXED BY PLAN 0522 (Auditor, S224) — t24 WAS INTERMITTENT, AND THE CAUSE WAS THE WAIT PRIMITIVE.
//
// Diagnosed during P12 and confirmed during P13: puppeteer's `page.waitForFunction` polls on
// `requestAnimationFrame`, and **Chrome PAUSES rAF in a backgrounded tab**. t24 holds three pages
// open at once, so whichever is not frontmost stops polling — and the wait expires against a page
// that is perfectly healthy. It is not slowness and it is not memory: P13 reproduced the failure at
// baseline with its own test file entirely REMOVED, so more patience was never going to fix it.
// (An earlier Auditor diagnosis blamed ~100 sequential browser launches. That was wrong.)
//
// ⇒ `waitFor()` below polls from the TEST process via setTimeout (harness `until()`), driving
// `page.evaluate` — which runs on demand and does not care whether the tab is backgrounded.
// PATIENT is kept as the ceiling so a genuinely broken page still fails, just later.
//
// A suite that fails intermittently trains people to re-run instead of read — the exact habit that
// let this harness print ALL PASS for months (P1). That is why this was worth fixing, not tolerating.
const waitFor = (pg, fn, label, ...args) =>
  until(() => pg.evaluate(fn, ...args), { timeout: PATIENT, every: 150, label });

/** Control page, connected, with the module list populated. Collects page errors. */
async function openControl(browser, server, errs) {
  const pg = await browser.newPage();
  pg.setDefaultTimeout(PATIENT);
  pg.on('pageerror', (e) => { if (errs) errs.push(e.message); console.log('CTRL PAGEERR', e.message); });
  await pg.goto(`${server.url()}/control?userId=op&role=presenter&token=${CTL_TOKEN}`, { waitUntil: 'domcontentloaded', timeout: PATIENT });
  await waitFor(pg, () => !!(window.__gm && typeof window.__control === 'function'
    && document.getElementById('mod-select').options.length > 1), 'control page ready with a populated picker');
  return pg;
}

/** Pick a module in the picker (the fetch-and-validate path) and wait for the body to arrive. */
async function selectModule(pg, id, beats) {
  await pg.evaluate((i) => { const s = document.getElementById('mod-select'); s.value = i; s.onchange(); }, id);
  await waitFor(pg, (n) => { const m = window.__gm.module(); return !!m && (m.beats || []).length === n; },
    'the picked module body arrived', beats);
}

/** Raw participant socket that records every frame it receives — the wire, not an inference. */
function participant(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const frames = [];
    ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) {} });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws, frames }); });
  });
}

const pickerState = (pg) => pg.evaluate(() => {
  const s = document.getElementById('mod-select');
  return {
    value: s.value,
    index: s.selectedIndex,
    options: s.options.length,
    loadDisabled: document.getElementById('mod-load').disabled,
    info: document.getElementById('mod-info').textContent,
    held: (window.__gm.module() || {}).manifest ? window.__gm.module().manifest.title : null,
    lastControl: window.__gm.lastControl(),
  };
});

test('0522 t23 — a persisted moduleId is PRESELECTED on the next load', async () => {
  const { dir, server } = await boot();
  const browser = await launch();
  try {
    const ctl = await openControl(browser, server);

    // Pre-state: nothing is selected and nothing is stored. Without this the test could pass on
    // a picker that happened to default to B for some unrelated reason.
    const before = await pickerState(ctl);
    expect('before: no module is selected on a virgin page', before.value === '' && before.index === 0, JSON.stringify(before));
    expect('before: nothing is persisted', (await ctl.evaluate((k) => localStorage.getItem(k), MOD_KEY)) === null,
      String(await ctl.evaluate((k) => localStorage.getItem(k), MOD_KEY)));

    // The GM picks a module — the ordinary path, no test-only shortcut.
    await selectModule(ctl, B, 2);
    expect('selecting a module persists it as the default', (await ctl.evaluate((k) => localStorage.getItem(k), MOD_KEY)) === B,
      String(await ctl.evaluate((k) => localStorage.getItem(k), MOD_KEY)));

    // …and the page is reloaded, as it is between sessions.
    await ctl.reload({ waitUntil: 'domcontentloaded', timeout: PATIENT });
    await waitFor(ctl, () => !!(window.__gm && document.getElementById('mod-select').options.length > 1), 'the picker repopulated after reload');
    await waitFor(ctl, (id) => document.getElementById('mod-select').value === id, 'B is preselected', B).catch(() => {});

    const after = await pickerState(ctl);
    expect('the persisted module is preselected after reload', after.value === B, JSON.stringify(after));
    expect('it is a real option, not a blank picker (selectedIndex is not -1)', after.index > 0, JSON.stringify(after));

    // A default the GM cannot act on is a trap: ▶ Validate & Load is disabled until the body has
    // been fetched, and re-picking an already-selected <option> fires no change event. So the
    // preselection also runs the picker's own fetch+validate — "ready to Load", NOT loaded.
    await waitFor(ctl, () => !document.getElementById('mod-load').disabled, 'Validate & Load became enabled').catch(() => {});
    const ready = await pickerState(ctl);
    expect('the preselection is ACTIONABLE — Validate & Load is enabled', ready.loadDisabled === false, JSON.stringify(ready));
    expect('…and it is still only a selection: nothing was pushed to the server', ready.lastControl === null, JSON.stringify(ready));

    // Deselecting clears the default — sticky must not be a one-way door.
    await ctl.evaluate(() => { const s = document.getElementById('mod-select'); s.value = ''; s.onchange(); });
    expect('picking the placeholder CLEARS the stored default', (await ctl.evaluate((k) => localStorage.getItem(k), MOD_KEY)) === null,
      String(await ctl.evaluate((k) => localStorage.getItem(k), MOD_KEY)));
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('0522 t24 — PRESELECT DOES NOT LOAD: opening a second control page changes NOTHING for players', async () => {
  const { dir, server } = await boot();
  const browser = await launch();
  try {
    const ctl1 = await openControl(browser, server);

    // A real player, watching a real display page, plus a raw socket recording the wire.
    const display = await connectUser(browser, server, { userId: 'pl1', userName: 'Player One' });
    const player = await participant(server.url().replace('http', 'ws'), { userId: 'pl2', userName: 'Player Two', role: 'participant' });
    await until(() => server.presence().some((u) => u.userId === 'pl1') && server.presence().some((u) => u.userId === 'pl2'),
      { label: 'both players connected', timeout: PATIENT });

    // Module A goes live on beat a2.
    await selectModule(ctl1, A, 3);
    await ctl1.evaluate(() => document.getElementById('mod-load').click());
    await until(() => (server.getModule() || {}).beats && server.getModule().beats.length === 3, { label: 'module A loaded server-side', timeout: PATIENT });
    await ctl1.evaluate(() => window.__control('show_beat', { index: 1 }));
    await until(() => player.frames.some((f) => f.t === 'content' && f.contentId === 'pr-a2'), { label: 'players are showing a2', timeout: PATIENT });

    const frame = await waitContentFrame(display, { timeout: PATIENT });
    await waitFor(frame, () => /Beat a2/.test(document.body.innerText), 'the player is showing Beat a2');

    // The GM's stored default is module B — last session's choice, NOT what is live. B declares a
    // defaultBeatId, so if opening a page auto-loaded it the room would jump to 'Beat b1'.
    await ctl1.evaluate((k, v) => localStorage.setItem(k, v), MOD_KEY, B);

    const snap = async () => ({
      text: await frame.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim()),
      content: player.frames.filter((f) => f.t === 'content').length,
      clear: player.frames.filter((f) => f.t === 'clear').length,
      last: (player.frames.filter((f) => f.t === 'content').slice(-1)[0] || {}).contentId,
      serverBeats: (server.getModule() || {}).beats.length,
      serverTitle: server.getModule().title,
    });
    const before = await snap();
    expect('before: the player is looking at Beat a2', /Beat a2/.test(before.text) && before.last === 'pr-a2', JSON.stringify(before));

    // ⚠ THE ACT UNDER TEST: a second control page is opened mid-session.
    const ctl2 = await openControl(browser, server);
    await waitFor(ctl2, (id) => document.getElementById('mod-select').value === id, 'the SECOND control page preselected B', B).catch(() => {});
    await wait(800);   // settle: any load_module the new page fired would have landed long since

    const after = await snap();
    const st2 = await pickerState(ctl2);

    // The point of the phase, asserted three independent ways.
    expect('the DISPLAY still renders Beat a2 — what the player actually sees is unchanged',
      after.text === before.text && /Beat a2/.test(after.text), JSON.stringify({ before: before.text, after: after.text }));
    expect('the player received NO new content frame', after.content === before.content, JSON.stringify({ before, after }));
    expect('the player received NO clear frame', after.clear === before.clear, JSON.stringify({ before, after }));
    expect('the room is still on pr-a2', after.last === before.last && after.last === 'pr-a2', JSON.stringify({ before, after }));
    expect('the SERVER still holds module A — nothing was loaded', after.serverTitle === before.serverTitle && after.serverBeats === 3,
      JSON.stringify({ before, after }));
    expect('the new page emitted NO control frame at all (no load_module, no show_beat)', st2.lastControl === null, JSON.stringify(st2));

    // …and it is not passing by doing nothing: the preselection DID happen on that second page.
    expect('meanwhile the second page DID preselect the sticky module', st2.value === B && st2.index > 0, JSON.stringify(st2));

    player.ws.close();
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('0522 t25 — a persisted module that is GONE yields no selection and no error (I4)', async () => {
  const { dir, server } = await boot();
  const browser = await launch();
  const errs = [];
  let dialogs = 0;
  try {
    const seed = await openControl(browser, server);
    await seed.evaluate((k, v) => localStorage.setItem(k, v), MOD_KEY, GHOST);

    // Reload: the page now boots holding a default whose file does not exist. Mid-session this is
    // the ordinary case — a module renamed or moved between sessions.
    seed.on('dialog', async (d) => { dialogs++; await d.dismiss(); });
    seed.on('pageerror', (e) => errs.push(e.message));
    await seed.reload({ waitUntil: 'domcontentloaded', timeout: PATIENT });
    await waitFor(seed, () => !!(window.__gm && document.getElementById('mod-select').options.length > 1), 'seed page picker populated');
    await wait(600);   // settle: an error path would have painted by now

    const st = await pickerState(seed);
    expect('no selection — the picker sits on the placeholder', st.value === '', JSON.stringify(st));
    expect('and on the placeholder OPTION, not on nothing (selectedIndex 0, never -1)', st.index === 0, JSON.stringify(st));
    expect('the real modules are still listed — the whole picker did not fail shut', st.options === 3, JSON.stringify(st));
    expect('no module body was fetched or held', st.held === null, JSON.stringify(st));
    expect('Validate & Load stays disabled', st.loadDisabled === true, JSON.stringify(st));
    expect('NO error text on the panel', !/error/i.test(st.info || ''), JSON.stringify(st));
    expect('NO modal dialog', dialogs === 0, 'dialogs=' + dialogs);
    expect('NO uncaught page error', errs.length === 0, errs.join(' | '));
    expect('nothing was pushed to the server', st.lastControl === null, JSON.stringify(st));

    // Permissive by design (I4): the stale key is NOT deleted. If the file comes back, so does the
    // default. A missing module is a nuisance; a silently discarded preference is a loss.
    expect('the stored default is kept, not discarded', (await seed.evaluate((k) => localStorage.getItem(k), MOD_KEY)) === GHOST,
      String(await seed.evaluate((k) => localStorage.getItem(k), MOD_KEY)));

    // The SAME degradation rule, reached the other way: a module that disappears from disk while
    // it is the CURRENT selection. `sel.value = <an id with no option>` leaves selectedIndex at
    // -1 — a picker rendering blank, with no placeholder, that reads to a GM as "broken", and it
    // is what the old keep-restore did on every module-changed after a rename. It must land on
    // the placeholder instead.
    await selectModule(seed, B, 2);
    expect('mid-check: B is selected', (await pickerState(seed)).value === B, JSON.stringify(await pickerState(seed)));
    rmSync(join(dir, B + '.json'), { force: true });
    await seed.evaluate(() => document.getElementById('mod-refresh').click());
    await waitFor(seed, () => document.getElementById('mod-select').options.length === 2, 'the deleted module left the picker');
    await wait(300);

    const gone = await pickerState(seed);
    expect('a selection that vanished from disk falls back to the PLACEHOLDER, not to blank',
      gone.value === '' && gone.index === 0, JSON.stringify(gone));
    expect('…still no error text and still nothing pushed', !/error/i.test(gone.info || '') && gone.lastControl === null, JSON.stringify(gone));
    expect('…and no dialog, no page error', dialogs === 0 && errs.length === 0, 'dialogs=' + dialogs + ' errs=' + errs.join(' | '));
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
