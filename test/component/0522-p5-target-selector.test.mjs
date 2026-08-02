/*
 * Plan 0522 P5 — THE UNIFIED TARGET SELECTOR, ON THE CONTROL PAGE.
 *
 * A target selector already existed and was already wired to the preview (`viewingAs` /
 * `selectView` / `requestMirror` / `view-all`). What it was NOT wired to was the send. Two
 * selectors — one for "previewing as", one for "sending to" — is the footgun with players waiting:
 * preview as Pilot, send to ALL, and the GM has verified something nobody received. P5 unifies
 * them into one variable with one mutator, so they cannot drift apart.
 *
 *   t10 — the control page emits `targets` as an ARRAY on the wire, even for one target, and even
 *         for the default. The UI is single-select; the protocol is not told about that.
 *   t11 — picking a target changes what the PREVIEW renders — including a station target, which
 *         resolves to whoever is sitting there.
 *   t12 — the dropdown lists ALL first, then every connected person, then every DECLARED station,
 *         in `sortOrder` and grouped by `group`.
 *   t13 — the target is ALL on every page load and is never persisted. A target that goes away
 *         falls back to ALL and says so, rather than silently addressing nobody.
 *
 * Browser tier: this is the control page's DOM and its outgoing frames, so it belongs in
 * test/component/ beside 0522-r14-beat-by-id.test.mjs.
 *
 * ⛔ modules/*.json is gitignored and has no version history — nothing here reads or writes the
 * repo's modules/ directory. The module used by t10 is injected straight into the panel through
 * the existing `__gm.setModule` hook.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { WebSocket } from 'ws';

// Plan 0529 P2: the content catalogue is control-credentialed and FAILS CLOSED, so a test
// that drives the GM panel must run a gated server and hand the page a token — exactly as a
// real deployment does. Nothing else about these tests changed.
const CTL_TOKEN = 'ap-test-control-token';

/** Raw seated participant — `connectUser` cannot pass a stationUID, and stations are the point. */
function participant(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const frames = [];
    ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) {} });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws, frames }); });
  });
}

async function openControl(browser, server) {
  const pg = await browser.newPage();
  pg.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
  await pg.goto(`${server.url()}/control?userId=op&role=presenter&token=${CTL_TOKEN}`, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => window.__gm && typeof window.__control === 'function' && !!document.getElementById('target-select'));
  return pg;
}

const PILOT = 2, GUNNER = 5;

test('0522 t12/t13 — the dropdown lists ALL + people + declared stations, and defaults to ALL on every load', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  let alice = null, bob = null;
  try {
    const url = server.url().replace('http', 'ws');
    alice = await participant(url, { stationUID: PILOT, userName: 'Alice' });
    bob = await participant(url, { stationUID: GUNNER, userName: 'Bob' });
    await until(() => server.presence().length === 2, { label: 'two players seated' });
    const aliceId = server.presence().find((u) => u.userName === 'Alice').userId;

    const ctl = await openControl(browser, server);
    await until(async () => ctl.evaluate(() => (window.__gm.users() || []).length >= 2), { label: 'the panel sees both players', timeout: 8000 });
    await until(async () => ctl.evaluate(() => (window.__gm.stations() || []).length > 0), { label: 'the panel received the station registry', timeout: 8000 });

    // ── t12 ────────────────────────────────────────────────────────────────────────────────
    const opts = await ctl.evaluate(() => [...document.getElementById('target-select').options]
      .map((o) => ({ v: o.value, t: o.textContent, g: o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : null })));
    expect('ALL is the first option, always', opts.length > 0 && opts[0].v === 'all', JSON.stringify(opts.slice(0, 3)));
    expect('every CONNECTED person is offered as a target',
      opts.some((o) => o.v === aliceId) && opts.some((o) => o.v === server.presence().find((u) => u.userName === 'Bob').userId),
      JSON.stringify(opts.map((o) => o.v)));

    // The registry as the PAGE received it (welcome.stationRegistry) — the same source the
    // dropdown builds from, so this compares the rendering against its input, not against a
    // second copy that could drift.
    const declared = await ctl.evaluate(() => (window.__gm.stations() || []).map((s) => ({ uid: s.stationUid, so: s.sortOrder, g: s.group })));
    expect('precondition: the deployment declares more than one station, in more than one group',
      declared.length > 1 && new Set(declared.map((s) => s.g)).size > 1, JSON.stringify(declared));

    const stationOpts = opts.filter((o) => /^station:\d+$/.test(o.v));
    expect('every DECLARED station is offered, occupied or not (an empty station is a legitimate target)',
      stationOpts.length === declared.length, stationOpts.length + ' options for ' + declared.length + ' declared stations');
    const wantOrder = declared.slice().sort((a, b) => (a.so - b.so) || (a.uid - b.uid)).map((s) => 'station:' + s.uid);
    expect('stations are listed in sortOrder', JSON.stringify(stationOpts.map((o) => o.v)) === JSON.stringify(wantOrder),
      JSON.stringify(stationOpts.map((o) => o.v)));
    const groupsSeen = stationOpts.map((o) => o.g);
    expect('and each station sits under an optgroup named for its `group`',
      groupsSeen.every((g, i) => g === (declared.find((s) => 'station:' + s.uid === stationOpts[i].v).g)), JSON.stringify(groupsSeen));
    // Occupied stations show a count, empty ones say so. The control page is itself seated (at the
    // deployment default), so "occupied" is read from presence, not assumed to be the two players.
    const occupied = new Set(await ctl.evaluate(() => (window.__gm.users() || []).map((u) => u.stationUid).filter((x) => x != null)));
    const emptyLabelled = stationOpts.filter((o) => / \(empty\)$/.test(o.t)).map((o) => o.v).sort();
    const wantEmpty = declared.filter((s) => !occupied.has(s.uid)).map((s) => 'station:' + s.uid).sort();
    expect('an unoccupied station SAYS it is empty — the GM sees "0 recipients" before pressing GO, not after',
      JSON.stringify(emptyLabelled) === JSON.stringify(wantEmpty), 'marked empty ' + JSON.stringify(emptyLabelled) + ' / expected ' + JSON.stringify(wantEmpty));

    // ── t13 ────────────────────────────────────────────────────────────────────────────────
    const fresh = await ctl.evaluate(() => ({ t: window.__gm.target(), v: document.getElementById('target-select').value }));
    expect('a freshly loaded control page targets ALL', fresh.t === 'all' && fresh.v === 'all', JSON.stringify(fresh));

    await ctl.evaluate((uid) => window.__gm.setTarget(uid), aliceId);
    await wait(150);
    expect('picking a person takes hold', await ctl.evaluate(() => window.__gm.target()) === aliceId);
    const stored = await ctl.evaluate((uid) => {
      const hits = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); const v = localStorage.getItem(k) || ''; if (v.indexOf(uid) >= 0 || /target/i.test(k)) hits.push(k + '=' + v); }
      return hits;
    }, aliceId);
    expect('nothing about the target is written to localStorage', stored.length === 0, JSON.stringify(stored));

    // A RELOAD is the test of stickiness that matters: the sender must never inherit a narrow
    // target they cannot see from a session they do not remember.
    await ctl.reload({ waitUntil: 'domcontentloaded' });
    await ctl.waitForFunction(() => window.__gm && !!document.getElementById('target-select'));
    const afterReload = await ctl.evaluate(() => ({ t: window.__gm.target(), v: document.getElementById('target-select').value }));
    expect('after a reload the target is ALL again — it is deliberately NOT sticky',
      afterReload.t === 'all' && afterReload.v === 'all', JSON.stringify(afterReload));

    // A target that goes away must not stay selected, addressing nobody.
    await until(async () => ctl.evaluate(() => (window.__gm.users() || []).length >= 2), { label: 'the reloaded panel sees both players', timeout: 8000 });
    await ctl.evaluate((uid) => window.__gm.setTarget(uid), aliceId);
    expect('precondition: alice is the target', await ctl.evaluate(() => window.__gm.target()) === aliceId);
    alice.ws.close(); alice = null;
    await until(() => !server.presence().some((u) => u.userName === 'Alice'), { label: 'alice disconnected' });
    await until(async () => ctl.evaluate(() => window.__gm.target() === 'all'), { label: 'the vanished target falls back to ALL', timeout: 8000 });
    const note = await ctl.evaluate(() => document.getElementById('viewingas').textContent);
    expect('and it SAYS the target went away rather than silently retargeting the room',
      /gone/.test(note) && /ALL/.test(note), JSON.stringify(note));
    await ctl.close();
  } finally {
    for (const p of [alice, bob]) if (p) p.ws.close();
    await browser.close();
    await server.close();
  }
});

test('0522 t11 — picking a target changes what the PREVIEW renders, stations included', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  let alice = null, bob = null;
  try {
    const url = server.url().replace('http', 'ws');
    alice = await participant(url, { stationUID: PILOT, userName: 'Alice' });
    bob = await participant(url, { stationUID: GUNNER, userName: 'Bob' });
    await until(() => server.presence().length === 2, { label: 'two players seated' });
    const aliceId = server.presence().find((u) => u.userName === 'Alice').userId;
    const bobId = server.presence().find((u) => u.userName === 'Bob').userId;

    // Distinct per-user displays, so the preview's CONTENT names who it is a preview of.
    server.pushContent(aliceId, '<b id="who">ALICE-VIEW</b>', 'a1');
    server.pushContent(bobId, '<b id="who">BOB-VIEW</b>', 'b1');

    const ctl = await openControl(browser, server);
    await until(async () => ctl.evaluate(() => (window.__gm.users() || []).length >= 2), { label: 'the panel sees both players', timeout: 8000 });
    await until(async () => ctl.evaluate(() => (window.__gm.stations() || []).length > 0), { label: 'the panel received the station registry', timeout: 8000 });
    const srcdoc = () => ctl.$eval('#pvframe', (el) => el.getAttribute('srcdoc') || '');

    await ctl.evaluate((uid) => window.__gm.setTarget(uid), aliceId);
    await until(async () => (await srcdoc()).includes('ALICE-VIEW'), { label: 'the preview shows the pilot\'s view', timeout: 8000 });
    expect('targeting a PERSON previews that person\'s live display', (await srcdoc()).includes('ALICE-VIEW'));

    // The same one control, addressed by STATION — it must resolve to whoever is sitting there.
    await ctl.evaluate(() => window.__gm.setTarget('station:5'));
    await until(async () => (await srcdoc()).includes('BOB-VIEW'), { label: 'the preview follows the target to the Gunner station', timeout: 8000 });
    const atGunner = await srcdoc();
    expect('targeting a STATION previews its occupant\'s live display', atGunner.includes('BOB-VIEW') && !atGunner.includes('ALICE-VIEW'), atGunner.slice(0, 120));

    await ctl.evaluate(() => window.__gm.setTarget('station:2'));
    await until(async () => (await srcdoc()).includes('ALICE-VIEW'), { label: 'the preview follows the target back to the Pilot station', timeout: 8000 });

    // And the label states WHICH target, not merely that one is set — a station has no userId, and
    // the old `viewingAs ? 'as X' : 'default (ALL)'` line called every station "default (ALL)".
    const shown = await ctl.evaluate(() => document.getElementById('np-what').textContent);
    expect('the Now Playing line names the station being previewed, not "default (ALL)"',
      /Pilot/.test(shown) && !/default \(ALL\)/.test(shown), JSON.stringify(shown));

    // An EMPTY station is previewable and says so — the GM learns nobody is there BEFORE GO (I5).
    await ctl.evaluate(() => window.__gm.setTarget('station:9'));
    await until(async () => /nobody here|Medic/.test(await ctl.evaluate(() => document.getElementById('pvlabel').textContent)),
      { label: 'the empty-station preview reports itself', timeout: 8000 });
    const note = await ctl.evaluate(() => document.getElementById('viewingas').textContent);
    expect('an empty station target says NOBODY IS CONNECTED HERE', /NOBODY IS CONNECTED HERE/.test(note), JSON.stringify(note));
    await ctl.close();
  } finally {
    for (const p of [alice, bob]) if (p) p.ws.close();
    await browser.close();
    await server.close();
  }
});

test('0522 t10 — the control page ships every beat with `targets` as an ARRAY, default included', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  let alice = null;
  try {
    const url = server.url().replace('http', 'ws');
    alice = await participant(url, { stationUID: PILOT, userName: 'Alice' });
    await until(() => server.presence().length === 1, { label: 'alice seated' });
    const aliceId = server.presence().find((u) => u.userName === 'Alice').userId;

    const ctl = await openControl(browser, server);
    await until(async () => ctl.evaluate(() => (window.__gm.users() || []).length >= 1), { label: 'the panel sees alice', timeout: 8000 });

    // Load a deck into the PANEL (no disk, no modules/ directory) and into the server.
    const deck = { title: 'P5 wire fixture', beats: [{ id: 'w1', component: 'card', promptId: 'pr-w1', opts: { title: 'Beat w1' } }] };
    await ctl.evaluate((d) => window.__gm.setModule(d), deck);
    server.setModule(JSON.parse(JSON.stringify(deck)));
    await wait(150);

    const clickFirstBeat = () => ctl.evaluate(() => { const r = document.querySelector('#outline .beat'); if (!r) return false; r.click(); return true; });
    const go = () => ctl.evaluate(() => document.getElementById('btn-go').click());

    // Default target: still an ARRAY. `['all']` is the array's DEFAULT VALUE, not a special case —
    // a scalar here is what would force every later call site to be touched again.
    //
    // ⚠ AMENDED BY PLAN 0522 P6 (R4). When P5 shipped, a beat click was still a PUBLISH, so this
    // asserted `send_beat`. P6 flips the gesture: the click is now `stage_beat` and GO is the
    // publish. The CLAIM UNDER TEST — one target, carried as an array, verbatim, for every kind of
    // target — is unchanged, and is now asserted on BOTH frames of the two-stage gesture rather
    // than one. The delivery assertion is preserved, behind a GO.
    expect('the beat row exists to be clicked', await clickFirstBeat() === true);
    await wait(250);
    const atAll = await ctl.evaluate(() => window.__gm.lastControl());
    expect('a click at the default target emits stage_beat with targets as an ARRAY (P6/R4)',
      atAll && atAll.action === 'stage_beat' && Array.isArray(atAll.args.targets) && atAll.args.targets.length === 1 && atAll.args.targets[0] === 'all',
      JSON.stringify(atAll));
    expect('and addresses the beat by ID, not by index (R14 is not undone)', atAll.args.id === 'w1', JSON.stringify(atAll.args));
    await go();
    await wait(250);
    const goFrame = await ctl.evaluate(() => window.__gm.lastControl());
    expect('GO emits send_beat carrying the SAME array the stage carried — one target, not two',
      goFrame && goFrame.action === 'send_beat' && JSON.stringify(goFrame.args.targets) === JSON.stringify(['all']) && goFrame.args.id === 'w1',
      JSON.stringify(goFrame));
    await until(() => (alice.frames.filter((f) => f.t === 'content').pop() || {}).contentId === 'pr-w1',
      { label: 'the default send still reaches the room exactly as it always did' });

    // A narrowed target: the SAME shape, one element, carrying the picked target verbatim.
    await ctl.evaluate((uid) => window.__gm.setTarget(uid), aliceId);
    await wait(150);
    expect('the beat row still clicks with a target selected', await clickFirstBeat() === true);
    await wait(250);
    const atAlice = await ctl.evaluate(() => window.__gm.lastControl());
    expect('a click with a person targeted emits that ONE target inside an array',
      atAlice && atAlice.action === 'stage_beat' && Array.isArray(atAlice.args.targets) && JSON.stringify(atAlice.args.targets) === JSON.stringify([aliceId]),
      JSON.stringify(atAlice));
    // P6: GO ships the targets captured AT STAGE TIME, so preview and delivery cannot diverge.
    await go();
    await wait(200);
    const goAlice = await ctl.evaluate(() => window.__gm.lastControl());
    expect('and GO sends to exactly those targets, not to whatever the selector says now',
      goAlice && goAlice.action === 'send_beat' && JSON.stringify(goAlice.args.targets) === JSON.stringify([aliceId]),
      JSON.stringify(goAlice));

    // A STATION target — same shape again. One control, one wire format, three kinds of target.
    await ctl.evaluate(() => window.__gm.setTarget('station:2'));
    await wait(150);
    await clickFirstBeat();
    await wait(250);
    const atStation = await ctl.evaluate(() => window.__gm.lastControl());
    expect('and a station target travels the same way',
      atStation && JSON.stringify(atStation.args.targets) === JSON.stringify(['station:2']), JSON.stringify(atStation));
    await go();
    await wait(200);
    const goStation = await ctl.evaluate(() => window.__gm.lastControl());
    expect('a station target survives the stage→GO handoff unchanged',
      goStation && goStation.action === 'send_beat' && JSON.stringify(goStation.args.targets) === JSON.stringify(['station:2']),
      JSON.stringify(goStation));

    // ⚠ Auto-follow is deliberately NOT routed through the target (R4): it is not a choice the GM
    // made for this beat. It must still be a plain show_beat.
    //
    // ⚠ AMENDED BY PLAN 0522 P6. The claim is unchanged — auto-follow PUBLISHES with `show_beat`
    // and is not routed through the gesture — but P5's regex pinned the exact byte sequence
    // `recBeat=-1; control('show_beat'`, and P6 legitimately inserts a disarm between them
    // (publishing something else must drop this page's staged candidate). Pinning bytes made a
    // true assertion fail for a false reason, so it now reads the auto-follow BRANCH and asserts
    // what it calls — which is strictly what R4 says, and survives the next edit to that line.
    const src = await (await fetch(server.url() + '/control')).text();
    const branch = (src.split("autofollow').checked)")[1] || '').slice(0, 200);
    expect('the auto-follow branch is locatable in the served source', branch.length > 0, 'autofollow branch not found');
    expect('auto-follow still calls show_beat (R4)', /control\('show_beat'/.test(branch), branch.slice(0, 120));
    expect('auto-follow is NOT routed through the staged gesture, and not through the targeted send (R4)',
      !/stage_beat|send_beat/.test(branch), branch.slice(0, 160));
    await ctl.close();
  } finally {
    if (alice) alice.ws.close();
    await browser.close();
    await server.close();
  }
});
