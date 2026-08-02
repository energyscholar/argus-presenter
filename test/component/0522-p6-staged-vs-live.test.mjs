/*
 * Plan 0522 P6 — ⚠ STAGED vs LIVE MUST BE UNMISTAKABLE.
 *
 * This phase is the reason two-stage delivery is safe to ship. The flip it completes (R4: a
 * control-page click STAGES instead of publishing) converts a LOUD failure into a SILENT one:
 *
 *   before — the wrong beat ships, everyone sees it instantly, the GM corrects it
 *   after  — the GM stages, believes it shipped, and five people look at an unchanged screen
 *
 * The second failure is worse, because nothing on any player's screen contradicts it and years of
 * muscle memory say *click means ship*. The indicator is the only thing standing between that and
 * a table waiting at 20:05, which is why the gesture flip and this indicator are one commit.
 *
 *   t14 — STAGED and LIVE are visually distinct IN A SCREENSHOT. Not by class name: a class called
 *         `staged` that renders identically to `live` passes a DOM test and fails a human at 20:05.
 *         Compared as PIXELS (both states are screenshotted, decoded on a canvas, and their mean
 *         colour and per-pixel difference measured) and as COMPUTED COLOUR. The selector is only
 *         ever used to find the element to photograph.
 *   t15 — a send that reaches NOBODY says so, as loudly as one that works (I5). Sending to an
 *         unoccupied station currently succeeds in silence; that is the failure I5 was written for.
 *   t16 — staging a second beat over an unsent first one never discards it silently (I4/I5). The
 *         server half of t16 — the `replaced` field itself — lives in
 *         test/unit/0522-p6-declared-surface.test.mjs.
 *   R4  — the gesture flip: a beat row STAGES; ▶ Start and auto-follow still PUBLISH.
 *
 * Browser tier: screenshots, computed style and the live control DOM. Screenshots land in
 * test/screenshots/, the directory the other browser tests already use.
 *
 * ⛔ modules/*.json is gitignored and has no version history. Nothing here reads or writes the
 * repo's modules/ directory — every deck is injected through the existing __gm.setModule hook.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { WebSocket } from 'ws';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Plan 0529 P2: the content catalogue is control-credentialed and FAILS CLOSED, so a test
// that drives the GM panel must run a gated server and hand the page a token — exactly as a
// real deployment does. Nothing else about these tests changed.
const CTL_TOKEN = 'ap-test-control-token';

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const DECK = {
  title: 'P6 fixture',
  beats: [
    { id: 'p6a', component: 'card', promptId: 'pr-p6a', opts: { title: 'First candidate' } },
    { id: 'p6b', component: 'card', promptId: 'pr-p6b', opts: { title: 'Second candidate' } },
  ],
  sections: [{ title: 'Only', beatIds: ['p6a', 'p6b'] }],
};

/** A seated participant — `connectUser` cannot pass a stationUID, and empty seats are the point. */
function participant(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const frames = [];
    ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) {} });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws, frames }); });
  });
}

async function openControl(browser, server, deck = DECK) {
  const pg = await browser.newPage();
  pg.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
  await pg.goto(`${server.url()}/control?userId=op&role=presenter&token=${CTL_TOKEN}`, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => window.__gm && typeof window.__control === 'function' && !!document.getElementById('pvstate'));
  server.setModule(JSON.parse(JSON.stringify(deck)));
  await pg.evaluate((d) => window.__gm.setModule(d), deck);
  await pg.waitForFunction(() => document.querySelectorAll('#outline .beat').length > 0);
  // ▶ Start is enabled by the Validate & Load button, which this fixture bypasses by injecting the
  // deck straight into the panel. Enable it here so R4's "Start still publishes" claim is actually
  // exercised rather than silently no-oping on a disabled control.
  await pg.evaluate(() => { document.getElementById('btn-start').disabled = false; });
  return pg;
}

const clickBeat = (pg, n) => pg.evaluate((i) => { const r = document.querySelectorAll('#outline .beat')[i]; if (!r) return false; r.click(); return true; }, n);
const stagedNow = (pg) => pg.evaluate(() => window.__gm.staged());
const go = (pg) => pg.evaluate(() => document.getElementById('btn-go').click());
const untilStaged = (pg, id) => until(async () => { const s = await stagedNow(pg); return !!s && (id == null || s.beatId === id); }, { label: 'a candidate is staged' + (id ? ' (' + id + ')' : '') });

/**
 * PIXELS, NOT SELECTORS. Two base64 PNGs are decoded on a canvas inside the page (a data: URL
 * does not taint it) and compared numerically: the mean colour of each, and the fraction of
 * pixels that actually differ. No pngjs, no image dependency, and no way for a renamed class to
 * make this pass — if the two states paint the same, the numbers are the same.
 */
function comparePixels(pg, aB64, bB64) {
  return pg.evaluate(async (a, b) => {
    const load = (b64) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = 'data:image/png;base64,' + b64; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
    const data = (im) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, w, h).data; };
    const A = data(ia), B = data(ib);
    let sa = [0, 0, 0], sb = [0, 0, 0], differing = 0, n = w * h;
    for (let i = 0; i < A.length; i += 4) {
      for (let k = 0; k < 3; k++) { sa[k] += A[i + k]; sb[k] += B[i + k]; }
      if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 40) differing++;
    }
    const ma = sa.map((v) => v / n), mb = sb.map((v) => v / n);
    const dist = Math.sqrt(ma.reduce((acc, v, k) => acc + (v - mb[k]) * (v - mb[k]), 0));
    return { w, h, meanA: ma.map((v) => Math.round(v)), meanB: mb.map((v) => Math.round(v)), dist: Math.round(dist), differingFraction: differing / n, sizeA: { w: ia.width, h: ia.height }, sizeB: { w: ib.width, h: ib.height } };
  }, aB64, bB64);
}

async function shot(pg, selector, file) {
  const el = await pg.$(selector);
  expect('the element to photograph exists: ' + selector, !!el, selector);
  const b64 = await el.screenshot({ encoding: 'base64' });
  if (file) writeFileSync(join(SHOTS, file), Buffer.from(b64, 'base64'));
  return b64;
}

test('0522 t14 — STAGED and LIVE are visually distinct in a SCREENSHOT, by pixels not by class name', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  let player = null;
  try {
    player = await participant(server.url().replace('http', 'ws'), { userName: 'Watcher' });
    await until(() => server.presence().length === 1, { label: 'a player is watching' });
    const ctl = await openControl(browser, server);

    // ── LIVE. The indicator states which it is from the first paint — never blank, never absent.
    const liveText = await ctl.$eval('#pvstate', (el) => el.textContent.trim());
    expect('the indicator reads LIVE before anything is staged', /LIVE/.test(liveText) && !/STAGED/.test(liveText), liveText);
    const liveStyle = await ctl.$eval('#pvstate', (el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, fg: s.color, size: parseFloat(s.fontSize), display: s.display, vis: s.visibility }; });
    expect('the LIVE indicator is actually rendered, not display:none', liveStyle.display !== 'none' && liveStyle.vis !== 'hidden', JSON.stringify(liveStyle));
    const liveShot = await shot(ctl, '#pvstate', '0522-t14-indicator-live.png');
    await shot(ctl, '#preview', '0522-t14-preview-live.png');

    // ── STAGE. The click is the flip R4 asked for; from here the room has NOT seen this beat.
    expect('a beat row is there to click', await clickBeat(ctl, 1) === true);
    await untilStaged(ctl, 'p6b');
    await wait(150);   // let the repaint settle before photographing it

    const stagedText = await ctl.$eval('#pvstate', (el) => el.textContent.trim());
    expect('the indicator now says STAGED, and says NOT SENT in words', /STAGED/.test(stagedText) && /NOT SENT/i.test(stagedText), stagedText);
    const stagedStyle = await ctl.$eval('#pvstate', (el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, fg: s.color, size: parseFloat(s.fontSize) }; });
    const stagedShot = await shot(ctl, '#pvstate', '0522-t14-indicator-staged.png');
    await shot(ctl, '#preview', '0522-t14-preview-staged.png');

    // ── THE ASSERTION THAT MATTERS. Photographs, decoded and measured.
    const px = await comparePixels(ctl, liveShot, stagedShot);
    expect('the two states are not the same picture — most of the indicator repaints',
      px.differingFraction > 0.5, JSON.stringify(px));
    expect('and they differ by COLOUR at a distance a human reads across a room',
      px.dist > 60, JSON.stringify(px));
    expect('the STAGED state is also physically BIGGER — size carries the warning when colour cannot',
      px.sizeB.h > px.sizeA.h, JSON.stringify({ live: px.sizeA, staged: px.sizeB }));

    // Computed colour, independently of the photograph: same conclusion by a second route.
    expect('background colour differs between the two states', liveStyle.bg !== stagedStyle.bg, liveStyle.bg + ' vs ' + stagedStyle.bg);
    expect('and the STAGED text is set larger', stagedStyle.size > liveStyle.size, liveStyle.size + ' vs ' + stagedStyle.size);

    // The GO button is ARMED, not idle — the second half of "unmistakable".
    const goState = await ctl.$eval('#btn-go', (el) => { const s = getComputedStyle(el); return { disabled: el.disabled, text: el.textContent, bg: s.backgroundColor, size: parseFloat(s.fontSize) }; });
    expect('GO is enabled while a beat is staged', goState.disabled === false, JSON.stringify(goState));
    expect('and it NAMES the beat it will send, so it cannot lie about its payload',
      goState.text.indexOf('Second candidate') >= 0, goState.text);

    // ...and the room still has not seen it. That is what STAGED means.
    expect('nothing was published by staging — the players\' screens are untouched',
      player.frames.filter((f) => f.t === 'content').length === 0, JSON.stringify(player.frames.map((f) => f.t)));

    // ── GO. The indicator must return to LIVE, and the button to idle.
    await go(ctl);
    await until(async () => (await stagedNow(ctl)) === null, { label: 'the candidate shipped and disarmed' });
    await wait(150);
    const afterText = await ctl.$eval('#pvstate', (el) => el.textContent.trim());
    expect('after GO the indicator reads LIVE again', /LIVE/.test(afterText) && !/STAGED/.test(afterText), afterText);
    const afterShot = await shot(ctl, '#pvstate', '0522-t14-indicator-after-go.png');
    const back = await comparePixels(ctl, liveShot, afterShot);
    expect('and it is the SAME picture as the LIVE state it started in — the indicator is not one-way',
      back.differingFraction < 0.02 && back.dist < 8, JSON.stringify(back));
    const goIdle = await ctl.$eval('#btn-go', (el) => ({ disabled: el.disabled, text: el.textContent }));
    expect('GO went back to idle once there is nothing armed', goIdle.disabled === true, JSON.stringify(goIdle));

    await ctl.close();
  } finally {
    if (player) player.ws.close();
    await browser.close();
    await server.close();
  }
});

test('0522 t15 — a send that reaches NOBODY says so, as loudly as one that works (I5)', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  let seated = null;
  try {
    const url = server.url().replace('http', 'ws');
    const decl = server.stations().stations;
    expect('the deployment declares stations to send to', decl.length >= 2, String(decl.length));
    const occupied = decl[0].stationUid;

    seated = await participant(url, { stationUID: occupied, userName: 'Seated' });
    await until(() => server.presence().length === 1, { label: 'one player seated' });
    const ctl = await openControl(browser, server);
    await until(async () => ctl.evaluate(() => (window.__gm.users() || []).length >= 1), { label: 'the panel sees the player', timeout: 8000 });

    // ⚠ "Empty" means empty of EVERY connection, and the control page is itself a connection that
    // lands on the deployment's default seat. Derive the empty station from live occupancy rather
    // than assuming one — picking a uid by hand is how this test would silently start sending to
    // the presenter's own socket and calling the result a success.
    const busy = new Set(server.presence().map((u) => u.stationUid));
    const empty = (decl.find((s) => !busy.has(s.stationUid)) || {}).stationUid;
    expect('a genuinely unoccupied declared station exists to send into the void',
      empty != null, JSON.stringify({ declared: decl.map((s) => s.stationUid), busy: [...busy] }));

    const receipt = () => ctl.$eval('#gostat', (el) => { const s = getComputedStyle(el); return { text: el.textContent, size: parseFloat(s.fontSize), fg: s.color, bg: s.backgroundColor, weight: s.fontWeight }; });

    // ── A send that WORKS. This is the baseline the failure has to be measured against.
    await ctl.evaluate((u) => window.__gm.setTarget('station:' + u), occupied);
    await clickBeat(ctl, 0);
    await untilStaged(ctl, 'p6a');
    await go(ctl);
    await until(async () => !!(await ctl.evaluate(() => window.__gm.lastSent())), { label: 'the successful send acked' });
    const okAck = await ctl.evaluate(() => window.__gm.lastSent());
    expect('the occupied station really was reached', okAck.ok === true && okAck.recipients === 1, JSON.stringify(okAck));
    await wait(120);
    const okReceipt = await receipt();
    expect('and the UI states the recipient count', /1 recipient/.test(okReceipt.text), JSON.stringify(okReceipt));

    // ── A send that reaches NOBODY. It succeeds — publishBeat did exactly as asked — and that is
    // precisely why it must not be quiet. Nothing else on this page would ever contradict it.
    await ctl.evaluate((u) => window.__gm.setTarget('station:' + u), empty);
    await clickBeat(ctl, 1);
    await untilStaged(ctl, 'p6b');
    await go(ctl);
    await until(async () => { const s = await ctl.evaluate(() => window.__gm.lastSent()); return s && s.beatId === 'p6b'; }, { label: 'the empty-target send acked' });
    const zeroAck = await ctl.evaluate(() => window.__gm.lastSent());
    expect('send_beat REPORTS the recipient count, and it is 0', zeroAck.ok === true && zeroAck.recipients === 0, JSON.stringify(zeroAck));
    expect('and 0 sockets, not merely 0 people', zeroAck.sockets === 0, JSON.stringify(zeroAck));
    await wait(120);
    const zeroReceipt = await receipt();

    expect('the UI SURFACES it — the words "0 recipients" are on screen', /0 RECIPIENTS/i.test(zeroReceipt.text), JSON.stringify(zeroReceipt));
    expect('the player who WAS connected received nothing from the empty-target send',
      (seated.frames.filter((f) => f.t === 'content').pop() || {}).contentId === 'pr-p6a',
      JSON.stringify(seated.frames.filter((f) => f.t === 'content').map((f) => f.contentId)));

    // "As visible as success" is a measurable claim, so measure it: never smaller, never fainter,
    // and visibly different from the success receipt rather than a green line with a 0 in it.
    expect('the 0-recipient receipt is NOT smaller than the success receipt',
      zeroReceipt.size >= okReceipt.size, JSON.stringify({ ok: okReceipt.size, zero: zeroReceipt.size }));
    expect('it is rendered differently from success, not as a quieter variant of it',
      zeroReceipt.fg !== okReceipt.fg || zeroReceipt.bg !== okReceipt.bg,
      JSON.stringify({ ok: okReceipt, zero: zeroReceipt }));
    expect('and it is emphasised, not plain', parseInt(zeroReceipt.weight, 10) >= 600, zeroReceipt.weight);

    await ctl.close();
  } finally {
    if (seated) seated.ws.close();
    await browser.close();
    await server.close();
  }
});

test('0522 t16 — staging over an UNSENT beat never discards it silently, and GO still ships (I4/I5)', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  let player = null;
  try {
    player = await participant(server.url().replace('http', 'ws'), { userName: 'Watcher' });
    await until(() => server.presence().length === 1, { label: 'a player is watching' });
    const ctl = await openControl(browser, server);
    const statText = () => ctl.$eval('#gostat', (el) => el.textContent);

    // Stage the first candidate; say nothing about a loss, because nothing was lost.
    await clickBeat(ctl, 0);
    await untilStaged(ctl, 'p6a');
    expect('a first stage claims no casualty', (await statText()).trim() === '', await statText());

    // Stage the second over it. The first never shipped, and it is now gone.
    await clickBeat(ctl, 1);
    await untilStaged(ctl, 'p6b');
    await wait(120);
    const note = await statText();
    expect('the UI says a STAGED beat was replaced without ever being sent', /replaced/i.test(note) && /NEVER SENT/i.test(note), note);
    expect('and NAMES the beat that was lost — a warning that will not say what it lost is noise', /p6a/.test(note), note);
    const alerting = await ctl.$eval('#gostat', (el) => { const s = getComputedStyle(el); return { weight: parseInt(s.fontWeight, 10), bg: s.backgroundColor }; });
    expect('the notice is rendered as an alert, not as body text', alerting.weight >= 600, JSON.stringify(alerting));

    // Re-staging the SAME beat loses nothing, so it must not cry wolf.
    await clickBeat(ctl, 1);
    await wait(250);
    expect('re-staging the same beat raises no false alarm', !/replaced/i.test(await statText()), await statText());

    // GO ships the SURVIVOR, not the beat that was replaced.
    await go(ctl);
    await until(() => (player.frames.filter((f) => f.t === 'content').pop() || {}).contentId === 'pr-p6b',
      { label: 'GO shipped the surviving candidate' });
    expect('the room received the second candidate, which is what the indicator named',
      (player.frames.filter((f) => f.t === 'content').pop() || {}).contentId === 'pr-p6b',
      JSON.stringify(player.frames.filter((f) => f.t === 'content').map((f) => f.contentId)));

    // And a candidate discarded by publishing something ELSE is announced too — the same loss by
    // another route. ▶ Start publishes (R4), so it destroys any armed candidate.
    await clickBeat(ctl, 1);
    await untilStaged(ctl, 'p6b');
    await ctl.evaluate(() => document.getElementById('btn-start').click());
    await until(async () => (await stagedNow(ctl)) === null, { label: '▶ Start disarmed the candidate' });
    await wait(200);
    const afterStart = await statText();
    expect('discarding by publishing something else is announced, not silent (I4)',
      /discarded/i.test(afterStart), afterStart);
    expect('and the delivery receipt for what DID ship is still shown alongside it',
      /recipient/i.test(afterStart), afterStart);
    expect('the server agrees the slot is empty — both surfaces, one truth',
      server.stagedBeat({ key: 'ws:' + (server.presence().find((u) => u.role === 'presenter') || {}).socketId }) === null,
      JSON.stringify(server.presence().map((u) => u.role)));

    await ctl.close();
  } finally {
    if (player) player.ws.close();
    await browser.close();
    await server.close();
  }
});

test('0522 R4 — the control-page click STAGES; ▶ Start and auto-follow still PUBLISH', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  let player = null;
  try {
    player = await participant(server.url().replace('http', 'ws'), { userName: 'Watcher' });
    await until(() => server.presence().length === 1, { label: 'a player is watching' });
    const ctl = await openControl(browser, server);
    const shown = () => (player.frames.filter((f) => f.t === 'content').pop() || {}).contentId || null;

    // ── EVERY gesture that selects a beat must stage. A mouse that stages and a key that ships is
    // the muscle-memory trap this phase exists to close, so all three are asserted, not one.
    for (const [label, fire] of [
      ['a beat row', () => clickBeat(ctl, 1)],
      ['the outline ⏵ jump', () => ctl.evaluate(() => { const b = document.querySelector('#outline .sec summary .tocjump'); if (!b) return false; b.click(); return true; })],
      ['the digit jump', async () => { await ctl.evaluate(() => document.activeElement && document.activeElement.blur()); await ctl.keyboard.press('1'); return true; }],
    ]) {
      const before = shown();
      const emitted = await (async () => { await fire(); await wait(250); return ctl.evaluate(() => window.__gm.lastControl()); })();
      expect(label + ' emits stage_beat, not a publish (R4)', emitted && emitted.action === 'stage_beat', label + ': ' + JSON.stringify(emitted));
      expect(label + ' shipped NOTHING to the room on its own', shown() === before, label + ': player saw ' + shown());
      expect(label + ' left GO armed', !!(await stagedNow(ctl)), label);
    }

    // ── ▶ Start still PUBLISHES (R4). It is "begin", not "consider".
    await ctl.evaluate(() => document.getElementById('btn-start').click());
    await until(() => shown() === 'pr-p6a', { label: '▶ Start published immediately, with no GO' });
    const startFrame = await ctl.evaluate(() => window.__gm.lastControl());
    expect('▶ Start is a publish, and carries the target (P5) and the beat id (R14)',
      startFrame.action === 'send_beat' && Array.isArray(startFrame.args.targets) && startFrame.args.id === 'p6a',
      JSON.stringify(startFrame));

    // ── Auto-follow still PUBLISHES with show_beat (R4). It is the system advancing, not the
    // operator choosing, and there is nobody at the keyboard to press GO.
    const branchDeck = {
      title: 'branch fixture',
      beats: [
        { id: 'q1', component: 'choice', promptId: 'pq1', opts: { title: 'Pick', options: [{ label: 'A', value: 'a' }] }, branch: { a: 'q2' } },
        { id: 'q2', component: 'card', promptId: 'pq2', opts: { title: 'Followed' } },
      ],
    };
    server.setModule(JSON.parse(JSON.stringify(branchDeck)));
    await ctl.evaluate((d) => window.__gm.setModule(d), branchDeck);
    await ctl.evaluate(() => { document.getElementById('autofollow').checked = true; });
    server.showBeat('q1');
    await until(() => shown() === 'pq1', { label: 'the branching beat is live' });
    await until(async () => (await ctl.evaluate(() => window.__gm.cur())) === 0, { label: 'the panel agrees the branching beat is live' });
    // A player answers → the control page's branch resolver fires auto-follow.
    player.ws.send(JSON.stringify({ t: 'result', msg: { promptId: 'pq1', type: 'answer', value: 'a' } }));
    await until(() => shown() === 'pq2', { label: 'auto-follow PUBLISHED the next beat with no GO press' });
    const followFrame = await ctl.evaluate(() => window.__gm.lastControl());
    expect('auto-follow used show_beat, never the staged gesture (R4)',
      followFrame && followFrame.action === 'show_beat' && followFrame.args.id === 'q2', JSON.stringify(followFrame));

    await ctl.close();
  } finally {
    if (player) player.ws.close();
    await browser.close();
    await server.close();
  }
});
