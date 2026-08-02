/*
 * Plan 0522 P11 (R11 / R13) — MODULE LIFECYCLE + GROUPED PICKER.
 *
 * The catalogue is long, not wrong. P11 adds exactly ONE optional manifest field — `status`
 * (active|working|retired, default active) — and groups the picker by the `kind` field the
 * manifests already carry, via native <optgroup>. R11 dropped the originally-proposed
 * `collection`/`sortOrder`: they would have been a FOURTH grouping axis for a list that already
 * had one.
 *
 * ⚠⚠ THIS PHASE MAKES THE PICKER ABLE TO HIDE THINGS, and a picker that hides things can hide
 * the one you need at 20:05 with five players waiting. Every test below exists to bound that:
 *
 *   t28 — nothing is dropped for a MISSING (or unrecognised) field. A module with no `status`
 *         appears; a module with no `kind` appears under `Uncategorized`; a module whose
 *         `status` is a typo appears, because only an explicit RECOGNISED status may hide.
 *   t29 — grouped by `kind`; groups A–Z and members A–Z by title (not by id, not by readdir).
 *   t30 — `Show All Modules` reveals BOTH `working` AND `retired` — one checkbox, no third
 *         state, no way to strand a module. Unchecked shows only `active`; checked, the count
 *         equals the full catalogue; the setting survives a reload.
 *         Also asserts the I1 decision on the MCP surface (see the note in that test).
 *   t31 — the LOADED module is visible even when its status would hide it, and so is the module
 *         the sticky default is pointing at.
 *
 * ⛔ modules/*.json is gitignored and has no version history (§ANNEAL E). Every fixture here
 * lives in a temp directory this suite creates and removes; the repo's modules/ is never read
 * or written, and the server binds port 0.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, wait } from '../../harness/multi.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Plan 0529 P2: the content catalogue is control-credentialed and FAILS CLOSED, so a test
// that drives the GM panel must run a gated server and hand the page a token — exactly as a
// real deployment does. Nothing else about these tests changed.
const CTL_TOKEN = 'ap-test-control-token';

const PATIENT = 90000;

// The localStorage key the checkbox owns. Asserted by name: the key IS the contract between one
// session and the next, and a silent rename is a silently lost preference.
const SHOWALL_KEY = 'argus-presenter:showAllModules';
const MOD_KEY = 'argus-presenter:module';

// ── The fixture catalogue. Ids ascend a..g so readdir order is KNOWN and is deliberately NOT
// the order the picker must produce — otherwise t29 would pass on an unsorted list.
//   id      title          kind            status
const CAT = [
  ['p11-a', 'Zebra Deck', 'zulu', null],
  ['p11-b', 'Apple Deck', 'zulu', null],
  ['p11-c', 'Middle Deck', 'alpha', null],
  ['p11-d', 'Working Deck', 'alpha', 'working'],
  ['p11-e', 'Retired Deck', 'alpha', 'retired'],
  ['p11-f', 'Nomad Deck', null, null],          // NO kind ⇒ must land in `Uncategorized`, never vanish
  ['p11-g', 'Odd Deck', 'alpha', 'banana'],     // UNRECOGNISED status ⇒ must be treated as active
];
const ACTIVE_IDS = ['p11-a', 'p11-b', 'p11-c', 'p11-f', 'p11-g'];
const HIDDEN_IDS = ['p11-d', 'p11-e'];

const deck = (title, kind, status) => ({
  manifest: Object.assign({ title },
    kind ? { kind } : {},
    status ? { status } : {}),
  beats: ['b1', 'b2'].map((i) => ({ id: i, component: 'card', promptId: 'pr-' + i, opts: { title: 'Beat ' + i } })),
});

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0522-p11-'));
  for (const [id, title, kind, status] of CAT) writeFileSync(join(dir, id + '.json'), JSON.stringify(deck(title, kind, status)));
  const prev = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_MODULES_DIR = dir;                       // read once, inside createServer
  let server;
  try { server = await createServer({ port: 0, controlToken: CTL_TOKEN }); }
  finally { if (prev === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prev; }
  return { dir, server };
}

async function openControl(browser, server, page) {
  const pg = page || await browser.newPage();
  pg.setDefaultTimeout(PATIENT);
  if (!page) pg.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
  await pg.goto(`${server.url()}/control?userId=op&role=presenter&token=${CTL_TOKEN}`, { waitUntil: 'domcontentloaded', timeout: PATIENT });
  await pg.waitForFunction(() => window.__gm && document.getElementById('mod-select').options.length > 1, { timeout: PATIENT });
  return pg;
}

/** The picker as the DOM holds it: the flat option list, plus the <optgroup> structure. */
const shape = (pg) => pg.evaluate(() => {
  const sel = document.getElementById('mod-select');
  return {
    // options is a FLAT collection that walks into optgroups — the P9 mechanisms rely on this.
    options: Array.from(sel.options).map((o) => ({
      value: o.value, label: o.textContent, tip: o.title,
      group: o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : null,
    })),
    groups: Array.from(sel.querySelectorAll('optgroup')).map((g) => ({
      label: g.label, members: Array.from(g.children).map((o) => o.textContent),
    })),
    value: sel.value, selectedIndex: sel.selectedIndex,
    showAllChecked: document.getElementById('mod-showall').checked,
    stored: (function () { try { return localStorage.getItem('argus-presenter:showAllModules'); } catch (e) { return 'THREW'; } })(),
  };
});

const ids = (s) => s.options.map((o) => o.value).filter(Boolean);

/**
 * Tick/untick the checkbox the way a human does, and wait for the rebuild to land.
 * ⚠ The sentinel is `p11-d`, NOT `p11-e`: t31 exists precisely because a LOADED module stays
 * visible when the box is unticked, so `p11-e` is not a reliable signal that the rebuild ran.
 * `p11-d` is `working` and is never exempt in this suite.
 */
async function setShowAll(pg, on) {
  await pg.evaluate((want) => {
    const c = document.getElementById('mod-showall');
    if (c.checked !== want) c.click();
  }, on);
  await pg.waitForFunction((want) => {
    const has = Array.from(document.getElementById('mod-select').options).some((o) => o.value === 'p11-d');
    return has === want;
  }, { timeout: PATIENT }, on);
  await wait(120);
}

test('0522 t28 — nothing is dropped for a missing field: no status, no kind, or a nonsense status', async () => {
  const { dir, server } = await boot();
  const browser = await launch();
  try {
    const ctl = await openControl(browser, server);
    const s = await shape(ctl);
    const present = ids(s);

    // ── No `status` at all. This is 29 of 29 modules on disk today: P11 must be a no-op for them.
    expect('a module with NO status is in the picker', present.indexOf('p11-a') >= 0, JSON.stringify(present));
    const a = s.options.find((o) => o.value === 'p11-a');
    expect('…and it is described as active', /status: active/.test(a.tip), JSON.stringify(a));

    // ── No `kind`. sec-write-probe.json is exactly this on disk today. It is the module most
    // likely to be silently swallowed by a grouping change, so it gets its own group.
    expect('a module with NO kind is STILL in the picker (I4)', present.indexOf('p11-f') >= 0, JSON.stringify(present));
    const f = s.options.find((o) => o.value === 'p11-f');
    expect('…it is inside an <optgroup>, not orphaned at the top level', !!f.group, JSON.stringify(f));
    expect('…and that group is Uncategorized', String(f.group).toUpperCase() === 'UNCATEGORIZED', JSON.stringify(f));

    // ── An UNRECOGNISED status. The red-team line: hiding is caused by an explicit, recognised
    // status and by nothing else, so a typo can never make a module disappear.
    expect('a module whose status is a typo is STILL in the picker', present.indexOf('p11-g') >= 0, JSON.stringify(present));
    const g = s.options.find((o) => o.value === 'p11-g');
    expect('…the typo is reported rather than swallowed', /unrecognized status/.test(g.tip) && /banana/.test(g.tip), JSON.stringify(g));

    // The server half — the same normalisation, visible on the wire.
    const api = await ctl.evaluate((t) => fetch('/api/modules', { cache: 'no-store', headers: { 'x-control-token': t } }).then((r) => r.json()), CTL_TOKEN);
    const row = (id) => api.find((m) => m.id === id);
    expect('/api/modules sends the whole catalogue — the FILTER IS THE CLIENT\'S, not the server\'s',
      api.length === CAT.length, JSON.stringify(api.map((m) => m.id)));
    expect('a manifest with no status reports status:"active"', row('p11-a').status === 'active', JSON.stringify(row('p11-a')));
    expect('a manifest with no kind reports kind:null', row('p11-f').kind === null, JSON.stringify(row('p11-f')));
    expect('an unrecognised status degrades to active and keeps the raw value',
      row('p11-g').status === 'active' && row('p11-g').statusInvalid === 'banana', JSON.stringify(row('p11-g')));

    // The placeholder must survive the DOM-shape change — it is the fallback for everything.
    expect('the placeholder is still options[0] and still empty-valued',
      s.options[0].value === '' && /select a module/i.test(s.options[0].label), JSON.stringify(s.options[0]));
    expect('…and it is NOT inside a group', s.options[0].group === null, JSON.stringify(s.options[0]));
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('0522 t29 — the picker is grouped by kind, groups A–Z and members A–Z by title', async () => {
  const { dir, server } = await boot();
  const browser = await launch();
  try {
    const ctl = await openControl(browser, server);
    const s = await shape(ctl);

    expect('the picker uses native <optgroup> — no new widget', s.groups.length > 0, JSON.stringify(s.groups));
    expect('EVERY non-placeholder option lives in a group',
      s.options.slice(1).every((o) => !!o.group), JSON.stringify(s.options));

    // Group ORDER. readdir hands these back as zulu, alpha, Uncategorized (ids ascend a..g), so
    // an unsorted implementation produces a different array and this fails.
    const labels = s.groups.map((g) => g.label);
    expect('groups are labelled with the kind, uppercased', labels.every((l) => l === l.toUpperCase()), JSON.stringify(labels));
    expect('groups are ordered A–Z', JSON.stringify(labels) === JSON.stringify(['ALPHA', 'UNCATEGORIZED', 'ZULU']), JSON.stringify(labels));

    // Member ORDER, inside a group whose id order is the REVERSE of its title order.
    const zulu = s.groups.find((g) => g.label === 'ZULU');
    expect('members are ordered A–Z by TITLE, not by id or readdir order',
      JSON.stringify(zulu.members) === JSON.stringify(['Apple Deck', 'Zebra Deck']), JSON.stringify(zulu));

    // Kind reaches the client at all — grouping cannot show what the API never sent.
    const api = await ctl.evaluate((t) => fetch('/api/modules', { cache: 'no-store', headers: { 'x-control-token': t } }).then((r) => r.json()), CTL_TOKEN);
    expect('/api/modules carries `kind` for the picker to group by',
      api.find((m) => m.id === 'p11-a').kind === 'zulu', JSON.stringify(api.find((m) => m.id === 'p11-a')));

    // ⚠ <optgroup> changes the DOM shape; P9's selection machinery must be unaffected by it.
    await ctl.evaluate(() => { document.getElementById('mod-select').value = 'p11-b'; });
    const s2 = await shape(ctl);
    expect('sel.value= still resolves ACROSS groups', s2.value === 'p11-b', JSON.stringify(s2));
    expect('…and selectedIndex is a real index into the flat option list, never -1',
      s2.selectedIndex > 0 && s2.options[s2.selectedIndex].value === 'p11-b', JSON.stringify(s2));
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('0522 t30 (R13) — Show All Modules reveals BOTH working AND retired, and the setting sticks', async () => {
  const { dir, server } = await boot();
  const browser = await launch();
  try {
    const ctl = await openControl(browser, server);

    // ── DEFAULT VIEW: active only.
    let s = await shape(ctl);
    expect('the checkbox exists and is unticked by default', s.showAllChecked === false, JSON.stringify(s.showAllChecked));
    expect('the default view is the ACTIVE modules', JSON.stringify(ids(s).slice().sort()) === JSON.stringify(ACTIVE_IDS.slice().sort()), JSON.stringify(ids(s)));
    for (const h of HIDDEN_IDS) expect(`${h} is hidden by its explicit status`, ids(s).indexOf(h) < 0, JSON.stringify(ids(s)));

    // ── ONE CLICK. R13's whole point: not "show working" — EVERYTHING. A checkbox that revealed
    // only `working` would leave `retired` with no path back into the picker at all, which is
    // precisely the I4 violation this control exists to prevent.
    await setShowAll(ctl, true);
    s = await shape(ctl);
    expect('the WORKING module is revealed', ids(s).indexOf('p11-d') >= 0, JSON.stringify(ids(s)));
    expect('the RETIRED module is revealed TOO — no module is stranded', ids(s).indexOf('p11-e') >= 0, JSON.stringify(ids(s)));
    expect('the visible count equals the FULL catalogue', ids(s).length === CAT.length, JSON.stringify(ids(s)));

    // With the list mixed, lifecycle must be legible without hovering — a retired module that
    // looked identical to a live one would be a trap of a different kind.
    const retired = s.options.find((o) => o.value === 'p11-e');
    expect('a non-active module is marked in the LABEL, not only in the tooltip',
      /retired/.test(retired.label), JSON.stringify(retired));
    expect('…and it is still findable by NAME', retired.label.indexOf('Retired Deck') === 0, JSON.stringify(retired));
    const active = s.options.find((o) => o.value === 'p11-c');
    expect('an ACTIVE module carries no lifecycle marker at all', active.label === 'Middle Deck', JSON.stringify(active));

    // Grouping is unaffected by the filter — the revealed modules join their own kind.
    expect('the revealed modules are grouped with their kind', retired.group === 'ALPHA', JSON.stringify(retired));

    // ── PERSISTENCE. The preference is stored under its own key and survives a reload.
    expect('the choice is stored in localStorage under its own key', s.stored === '1', JSON.stringify(s.stored));
    await openControl(browser, server, ctl);                 // full page reload, same origin
    s = await shape(ctl);
    expect('the checkbox is still ticked after a reload', s.showAllChecked === true, JSON.stringify(s));
    expect('…and the first list the GM sees is the full one', ids(s).length === CAT.length, JSON.stringify(ids(s)));

    // ── And back. One click, both directions — there is no third state to get stuck in.
    await setShowAll(ctl, false);
    s = await shape(ctl);
    expect('unticking restores the active-only view', ids(s).length === ACTIVE_IDS.length, JSON.stringify(ids(s)));
    expect('…and that is persisted too', s.stored === '0', JSON.stringify(s.stored));

    // ── I1, THE DECLARED DIFFERENCE. `presenter_modules` is a SECOND directory scan; if P11 only
    // changed /api/modules the two surfaces would disagree about the catalogue. They now share
    // one normaliser (app/server.mjs moduleLifecycle) — same fields, same defaults — and the
    // difference that remains is DELIBERATE and stated in the tool's own description: the agent
    // has no checkbox to tick, so it is never filtered and is told which rows the human picker
    // hides. Asserted here so it cannot silently become a real gap.
    const prev = process.env.PRESENTER_MODULES_DIR;
    process.env.PRESENTER_MODULES_DIR = dir;
    let mcp;
    try { mcp = await import('../../mcp/tools.mjs?p11-modules-dir=' + encodeURIComponent(dir)); }
    finally { if (prev === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prev; }
    const tool = mcp.coreTools.find((t) => t.name === 'presenter_modules');
    const out = await tool.handler({});
    const byId = Object.fromEntries(out.modules.map((m) => [m.id, m]));
    expect('the MCP surface lists the WHOLE catalogue — it applies no status filter',
      out.modules.length === CAT.length, JSON.stringify(out.modules.map((m) => m.id)));
    expect('…and it carries the same `status` the control page reads',
      byId['p11-e'].status === 'retired' && byId['p11-d'].status === 'working' && byId['p11-a'].status === 'active',
      JSON.stringify(out.modules));
    expect('…and the same `kind`', byId['p11-f'].kind === null && byId['p11-a'].kind === 'zulu', JSON.stringify(out.modules));
    expect('…and it FLAGS which rows the human picker hides by default, so the difference is visible to the agent',
      byId['p11-e'].unlisted === true && byId['p11-a'].unlisted === false, JSON.stringify(out.modules));
    expect('the difference is DECLARED in the tool description, not just in behaviour',
      /DECLARED DIFFERENCE/.test(tool.description) && /never filtered by status/i.test(tool.description), tool.description);
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('0522 t31 — the LOADED module is never hidden, and neither is the sticky default', async () => {
  const { dir, server } = await boot();
  const browser = await launch();
  try {
    const ctl = await openControl(browser, server);

    // Reveal the retired module, select it, and put it in the room.
    await setShowAll(ctl, true);
    await ctl.evaluate(() => { const s = document.getElementById('mod-select'); s.value = 'p11-e'; s.onchange(); });
    await ctl.waitForFunction(() => document.getElementById('mod-load').disabled === false, { timeout: PATIENT });
    await ctl.evaluate(() => document.getElementById('mod-load').click());
    await wait(200);

    // Now browse AWAY from it, so the current selection no longer protects it. This is the whole
    // point of the test: only the fact that it is LOADED can keep it visible from here.
    await ctl.evaluate(() => { const s = document.getElementById('mod-select'); s.value = 'p11-c'; s.onchange(); });
    await wait(200);
    await setShowAll(ctl, false);
    let s = await shape(ctl);

    expect('the picker is back to the filtered view', ids(s).indexOf('p11-d') < 0, JSON.stringify(ids(s)));
    expect('…but the module that is LIVE IN THE ROOM is still listed', ids(s).indexOf('p11-e') >= 0, JSON.stringify(ids(s)));
    expect('…and it is still findable by name, still marked retired',
      /Retired Deck/.test(s.options.find((o) => o.value === 'p11-e').label), JSON.stringify(s.options));
    expect('the selection the GM moved to is intact', s.value === 'p11-c', JSON.stringify(s));

    // ── The other exemption: the STICKY DEFAULT (P9). A stored default that the filter dropped
    // would degrade to the placeholder, and the preference would look like it had been forgotten.
    await ctl.evaluate((k) => { try { localStorage.setItem(k, 'p11-e'); localStorage.setItem('argus-presenter:showAllModules', '0'); } catch (e) {} }, MOD_KEY);
    await openControl(browser, server, ctl);
    s = await shape(ctl);
    expect('a fresh page still hides the OTHER non-active module', ids(s).indexOf('p11-d') < 0, JSON.stringify(ids(s)));
    expect('…but the sticky default is listed even though its status would hide it', ids(s).indexOf('p11-e') >= 0, JSON.stringify(ids(s)));
    expect('…and it is actually PRESELECTED, not merely present', s.value === 'p11-e', JSON.stringify(s));
    expect('…with the checkbox still unticked — nothing turned itself on', s.showAllChecked === false, JSON.stringify(s));

    // ── The third way a module gets asked for BY NAME: a series queueing its next chapter. The
    // filter must yield to that too, or `Next in series ▶` silently blanks the picker instead of
    // advancing. p11-d is `working` and has been hidden throughout this test.
    await ctl.evaluate(() => window.__gm.queueModule('p11-d'));
    await ctl.waitForFunction(() => document.getElementById('mod-select').value === 'p11-d', { timeout: PATIENT });
    s = await shape(ctl);
    expect('a module queued by name is revealed rather than dropped', ids(s).indexOf('p11-d') >= 0, JSON.stringify(ids(s)));
    expect('…and it is SELECTED, not left at selectedIndex -1', s.value === 'p11-d' && s.selectedIndex > 0, JSON.stringify(s));
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
