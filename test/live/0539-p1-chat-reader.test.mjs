/*
 * Plan 0539 P1 — THE CHAT READER, in three real browsers.
 *
 * Bruce, S229: "the nifty message widget you put in works great BUT it needs to include a larger
 * space above that shows actual output … Currently one can type and send a chat but there's no
 * reader screen location."
 *
 * ⛓ WHY THIS IS A BROWSER TEST AND NOT A SOCKET TEST. 0537 P2.2 already proved, over raw sockets,
 * that the `chat` slice reaches a participant. It does, and it always did. What was missing was the
 * thing only a browser can answer: whether a human can SEE it. A socket test would have passed on
 * the day the feature did not exist — it did.
 *
 *   C1  A types, B reads it — the headline (P1.6)
 *   C2  every line is attributed (P1.3)
 *   C3  a `/gm` aside is visible to its SENDER and to the facilitator, and NOT to the third person
 *   C4  ⚠ P1.5 — a hostile string renders as TEXT. Untrusted input now reaches every participant,
 *       and nothing upstream escapes it for a browser. Proven with markup + a script tag.
 *   C5  P1.4 — rolls appear in the reader, read from the `rolls` SLICE, with an expandable breakdown
 *   C6  P1.7 — a labelled modifier survives from the server record into what a human reads
 *   C7  P1.1 — the view is NOT yanked while somebody is reading back
 *   C8  P1.2 — the panel got bigger, and the always-present count is STILL 7
 *
 * ⛔ MEASUREMENT NOTE: nothing here counts `.ap-card`. The stage is an opaque-origin sandboxed
 * iframe and such a count returns 0 whether it rendered perfectly or not at all. Every claim below
 * is read out of the HOST page's own DOM (which this test owns) or seen in a screenshot.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, until, wait } from '../../harness/multi.mjs';
import { WebSocket } from 'ws';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = join(ROOT, 'test', 'screenshots');

/* The same inventory method as 0537 P4 / docs/display-chrome-budget.md — everything laid out in the
 * FIXED chrome layer, minus the stage and minus the two containers the doc counts by their children.
 * Copied rather than imported because the doc's number is defined by THIS method, and a shared helper
 * that drifted would silently redefine the budget. */
const INVENTORY = () => {
  const out = [];
  const stage = document.getElementById('stage');
  document.querySelectorAll('body *').forEach((el) => {
    if (stage && (el === stage || stage.contains(el))) return;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    let n = el, fixed = false;
    while (n && n !== document.body) { if (getComputedStyle(n).position === 'fixed') { fixed = true; break; } n = n.parentElement; }
    if (!fixed) return;
    if (el.id === 'ap-seat' || el.id === 'ap-chat') return;
    out.push(el.id || el.tagName.toLowerCase());
  });
  return out;
};

/* Type into the summoned panel and send. Opens the panel first — it is summoned, not permanent.
 *
 * ⚠ THE `$eval(el => el.click())` IS LOAD-BEARING, AND `page.click()` HERE IS A 180-SECOND TRAP.
 * With three pages open only ONE is foregrounded; the other two are backgrounded, and a backgrounded
 * page in headless Chrome never fires an IntersectionObserver callback. `page.click()` begins with
 * `isIntersectingViewport({threshold:1})`, which awaits exactly such a callback — so the call does
 * not fail, it HANGS until puppeteer's 180 s protocolTimeout, and the error it finally throws
 * ("Runtime.callFunctionOn timed out") names neither the page nor the element and reads like a
 * browser fault. VERIFIED: the same handle answers `true` immediately after `bringToFront()`, and
 * `elementFromPoint` at the button's own centre returns the button — it is visible, enabled and
 * unobstructed the whole time. ⛔ This is NOT a defect in the panel. multi.mjs's own header already
 * says it: use a DOM click, not a synthesized input one.
 */
async function say(page, text) {
  await page.evaluate(() => window.__apChatPanel.set(true));
  await page.$eval('#ap-chat-input', (el, v) => { el.value = v; }, text);
  await page.$eval('#ap-chat-send', (el) => el.click());
}
const logText = (page) => page.evaluate(() => window.__apChatLog.text());
const logRows = (page) => page.evaluate(() => window.__apChatLog.rows());

/* A screenshot that is actually EVIDENCE.
 * ⚠ Two ways this quietly produces a worthless artifact, both seen in the first run of this file:
 *   1. the panel slides in over .16 s, so a shot taken immediately after `set(true)` catches it
 *      MID-TRANSITION, half off the right edge — a picture of an animation, not of a feature;
 *   2. a backgrounded page composites a stale frame, so it must be brought to the front first.
 * And the shots are taken AT THE MOMENT THE CLAIM IS MADE. Deferring them to the end of the test
 * photographs 25 filler lines with the interesting row scrolled out of the box. */
async function shot(page, name) {
  await page.evaluate(() => window.__apChatPanel.set(true));
  await page.bringToFront();
  await wait(400);
  await page.screenshot({ path: join(SHOTS, name), captureBeyondViewport: false });
}

test('0539 P1 — A types, B reads; the aside stays private; hostile text stays text; rolls show their arithmetic', async () => {
  try { mkdirSync(SHOTS, { recursive: true }); } catch {}
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const gm = await connectUser(browser, server, { userId: 'gm', userName: 'Facilitator', role: 'presenter' });
    const A = await connectUser(browser, server, { userId: 'u1', userName: 'Ada', role: 'participant' });
    const B = await connectUser(browser, server, { userId: 'u2', userName: 'Bo', role: 'participant' });
    for (const p of [gm, A, B]) await p.setViewport({ width: 1280, height: 800 });
    for (const p of [gm, A, B]) await p.waitForFunction(() => window.__apChatLog && window.__apChat && window.__apChatPanel);
    // The input enables only when a listener is attached; the facilitator page IS one.
    await until(async () => (await A.evaluate(() => window.__apChat.enabled())) === true, { label: 'A can type', timeout: 8000 });

    // ── C1 + C2 — A speaks, B reads it, attributed ───────────────────────────────────────────────
    await say(A, 'the fuel plant is live');
    await until(async () => /fuel plant is live/.test(await logText(B)), { label: 'B reads A', timeout: 8000 });
    const bRows = await logRows(B);
    const said = bRows.find((r) => /fuel plant is live/.test(r.text));
    expect(!!said, '⭐ B READS what A typed — the thing 0537 shipped without', JSON.stringify(bRows));
    expect(/Ada/.test(said.text), 'P1.3 — and it says WHO said it', said.text);
    expect(said.kind === 'say', 'an ordinary line is an ordinary line', said.kind);
    // A sees their own line too — a sender who cannot see their own message cannot tell it landed.
    expect(/fuel plant is live/.test(await logText(A)), 'the sender sees their own line');

    // ── C3 — the aside: sender + facilitator, and NOBODY ELSE ───────────────────────────────────
    await say(A, '/gm the reactor is a decoy');
    await until(async () => /reactor is a decoy/.test(await logText(gm)), { label: 'facilitator reads the aside', timeout: 8000 });
    await until(async () => /reactor is a decoy/.test(await logText(A)), { label: 'sender reads their own aside', timeout: 8000 });
    const aRows = await logRows(A);
    const aside = aRows.find((r) => /reactor is a decoy/.test(r.text));
    expect(/aside/.test(aside.kind), 'P1.3 — the sender can SEE that this line was private', JSON.stringify(aside));
    expect(/private/i.test(aside.text), '…and it says so in words, not only in colour', aside.text);
    // ⛓ The load-bearing negative. Give it a generous settle so this is a real absence, not a race:
    // B has already received two later frames (the roll below arrives after), so a slow delivery
    // would have shown up by the time this is read.
    await wait(600);
    const bText = await logText(B);
    expect(!/reactor is a decoy/.test(bText), '⛔ the third person NEVER sees the aside', bText);
    // ⛓ THE PAIR IS THE EVIDENCE. One picture of the facilitator's log showing the aside, and one of
    // the third person's log at the same moment NOT showing it. Either alone proves nothing.
    await shot(gm, '0539-p1-facilitator-sees-aside.png');
    await shot(B, '0539-p1-third-person-does-not.png');

    // ── C4 — P1.5: UNTRUSTED TEXT. The participant-visible render path is new and inherits nothing ──
    const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1<\/script></div><b>BOLD</b>';
    await say(A, HOSTILE);
    await until(async () => /BOLD/.test(await logText(B)), { label: 'B receives the hostile string', timeout: 8000 });
    const xss = await B.evaluate(() => ({
      pwned: typeof window.__pwned !== 'undefined',
      imgs: document.querySelectorAll('#ap-chat-log img').length,
      scripts: document.querySelectorAll('#ap-chat-log script').length,
      bolds: document.querySelectorAll('#ap-chat-log b').length,
      html: window.__apChatLog.html(),
      text: window.__apChatLog.text(),
    }));
    expect(xss.pwned === false, '⛔ NO SCRIPT RAN — window.__pwned is undefined');
    expect(xss.imgs === 0 && xss.scripts === 0 && xss.bolds === 0,
      '⛔ NO ELEMENT was created from a message', JSON.stringify({ i: xss.imgs, s: xss.scripts, b: xss.bolds }));
    expect(/&lt;img/.test(xss.html) && /&lt;b&gt;BOLD/.test(xss.html),
      'the markup is ESCAPED in the serialised DOM, i.e. it is text', xss.html.slice(0, 400));
    expect(xss.text.indexOf('<b>BOLD</b>') >= 0, '…and a human reads the string VERBATIM', xss.text.slice(-200));
    await shot(B, '0539-p1-B-reads-hostile.png');

    // ── C5 — P1.4: rolls appear, from the `rolls` SLICE, with an expandable breakdown ────────────
    await say(A, '/roll 2d6+2 8 Gunnery');
    await until(async () => (await logRows(B)).some((r) => /roll/.test(r.kind)), { label: 'B sees the roll', timeout: 8000 });
    /* ⛔ MEASURE THE RENDERED BOX, NOT `textContent`. `textContent` returns a <details> body whether
     * it is open or shut, so "the string got longer" cannot distinguish an expansion from a no-op —
     * it reported 104 → 104 and would have passed just as happily on a breakdown nobody can open.
     * The honest probe is the laid-out HEIGHT of the body, driven by a real click on the summary. */
    const roll = await B.evaluate(() => {
      const row = [...document.querySelectorAll('#ap-chat-log .ap-cl-row.roll')].pop();
      const det = row.querySelector('details.ap-bd');
      const body = det.querySelector('.ap-bd-body');
      // ⚠ Measure the <details> ITSELF, not its body. In current Chrome a shut <details> hides its
      // content through `::details-content` rather than by display:none, so the body's own
      // getBoundingClientRect() still reports its full height while shut (91.95 → 91.95, seen). The
      // element's outer box is the honest one: summary-only when shut, summary+body when open.
      const shutOpen = det.open, shutH = det.getBoundingClientRect().height;
      det.querySelector('summary').click();             // ⛔ not hover-only: a real click, as a person would
      return { summary: det.querySelector('summary').textContent, bodyH: body.getBoundingClientRect().height,
               shutOpen, shutH, openOpen: det.open, openH: det.getBoundingClientRect().height,
               rows: [...det.querySelectorAll('.ap-bd-row')].map((e) => e.textContent) };
    });
    expect(/Gunnery/.test(roll.summary), 'the roll carries its label', roll.summary);
    expect(roll.rows.some((r) => /\+2/.test(r)), 'P1.7 — the +2 is shown as a MODIFIER, not swallowed into the total',
      JSON.stringify(roll.rows));
    expect(roll.rows.some((r) => /total/.test(r)), 'and the total is a row of its own', JSON.stringify(roll.rows));
    expect(roll.shutOpen === false, 'the breakdown starts COLLAPSED — the log stays readable', JSON.stringify(roll));
    expect(roll.openOpen === true && roll.openH > roll.shutH + 20,
      '⛓ and a CLICK genuinely opens it — not a title= tooltip, which touch and keyboard can never reach',
      JSON.stringify(roll));
    // ⛔ The record, not the prose. The dice values in the breakdown must equal the server's record.
    const rec = Object.values(server.store.snapshot({ role: 'presenter' }).state.rolls || {}).pop();
    expect(Array.isArray(rec.modifiers) && rec.modifiers.length === 1 && rec.modifiers[0].value === 2,
      'the SERVER record carries modifiers: [{label, value}] — the schema change, not a UI trick',
      JSON.stringify(rec.modifiers));
    expect(rec.modifiers[0].label === null,
      '…and an unlabelled +2 records label:null — honest, rather than an invented reason', JSON.stringify(rec.modifiers));

    // ── C6 — P1.7: a LABELLED modifier, supplied by a controller, survives to what a human reads ──
    const ctl = new WebSocket(server.url().replace('http', 'ws'));
    await new Promise((r) => ctl.on('open', () => { ctl.send(JSON.stringify({ t: 'hello', userId: 'ai', role: 'ai' })); r(); }));
    await wait(200);
    ctl.send(JSON.stringify({ t: 'roll', spec: '2d6', target: 8, label: 'Sensors',
      modifiers: [{ label: 'Sensors skill', value: 2 }, { label: 'long range', value: -1 }] }));
    await until(async () => /Sensors skill/.test(await logText(B)), { label: 'the REASON reaches a reader', timeout: 8000 });
    const labelled = await B.evaluate(() => {
      const row = [...document.querySelectorAll('#ap-chat-log .ap-cl-row.roll')].pop();
      const det = row.querySelector('details.ap-bd'); det.open = true;
      return [...det.querySelectorAll('.ap-bd-row')].map((e) => e.textContent);
    });
    expect(labelled.some((r) => /Sensors skill/.test(r) && /\+2/.test(r)), 'the labelled modifier reads as reason + number',
      JSON.stringify(labelled));
    expect(labelled.some((r) => /long range/.test(r) && /−1/.test(r)), 'including a NEGATIVE one, with a real minus sign',
      JSON.stringify(labelled));
    // ⭐ The P1.7 artifact: an EXPANDED breakdown, each modifier beside the reason it came from.
    await shot(B, '0539-p1-roll-breakdown-expanded.png');
    // ⛔ …and a PARTICIPANT cannot mint a reason. Same frame, participant role: the labels are dropped.
    const pw = new WebSocket(server.url().replace('http', 'ws'));
    await new Promise((r) => pw.on('open', () => { pw.send(JSON.stringify({ t: 'hello', userId: 'u3', role: 'participant' })); r(); }));
    await wait(200);
    pw.send(JSON.stringify({ t: 'roll', spec: '1d6', modifiers: [{ label: 'Command 4', value: 4 }] }));
    await wait(400);
    const rolls = Object.values(server.store.snapshot({ role: 'presenter' }).state.rolls || {});
    const theirs = rolls.filter((r) => r.who === 'u3').pop();
    expect(theirs && theirs.modifiers.length === 0,
      '⛔ a participant may ask for a number but may NOT attach a reason to it', JSON.stringify(theirs && theirs.modifiers));
    expect(theirs && theirs.total === theirs.rolls[0],
      '…and the dropped modifier did not move the total either', JSON.stringify(theirs));
    pw.close(); ctl.close();

    // ── C7 — P1.1: reading back is not interrupted ───────────────────────────────────────────────
    for (let i = 0; i < 25; i++) await say(A, 'filler line ' + i);
    await until(async () => /filler line 24/.test(await logText(B)), { label: 'the log filled', timeout: 15000 });
    const scrolled = await B.evaluate(() => { const l = document.getElementById('ap-chat-log'); l.scrollTop = 0; return { top: l.scrollTop, atBottom: window.__apChatLog.atBottom() }; });
    expect(scrolled.atBottom === false, 'the reader has scrolled up (precondition for the claim)', JSON.stringify(scrolled));
    await say(A, 'a message that arrives while you are reading up');
    await until(async () => /while you are reading up/.test(await logText(B)), { label: 'the new line landed', timeout: 8000 });
    const after = await B.evaluate(() => document.getElementById('ap-chat-log').scrollTop);
    expect(after === 0, '⛔ the view was NOT yanked to the bottom while someone was reading up', String(after));
    // …but a reader who IS at the bottom follows along.
    await B.evaluate(() => { const l = document.getElementById('ap-chat-log'); l.scrollTop = l.scrollHeight; });
    await say(A, 'and a reader at the bottom keeps following');
    await until(async () => (await B.evaluate(() => window.__apChatLog.atBottom())) === true, { label: 'follows at the bottom', timeout: 8000 });

    // ── C8 — P1.2: bigger when open, and the always-present count is unchanged ───────────────────
    await B.evaluate(() => window.__apChatPanel.set(false));
    await wait(300);
    const closed = await B.evaluate(INVENTORY);
    expect(closed.length === 7,
      '⛓ SEVEN always-present elements — the reader cost ZERO chrome, which is the whole point of summoning it',
      `${closed.length}: ${JSON.stringify(closed)}`);
    expect(!closed.includes('ap-chat-log'), 'the log is not always-present', JSON.stringify(closed));
    await B.evaluate(() => window.__apChatPanel.set(true));
    await wait(300);
    const size = await B.evaluate(() => {
      const p = document.getElementById('ap-chat').getBoundingClientRect();
      const l = document.getElementById('ap-chat-log').getBoundingClientRect();
      return { w: Math.round(p.width), h: Math.round(p.height), lw: Math.round(l.width), lh: Math.round(l.height) };
    });
    expect(size.w >= 380, 'P1.2 — the panel is wider when folded out ("can be a bit bigger")', JSON.stringify(size));
    expect(size.lh >= 120, 'and the log is a real reading surface, not a slot', JSON.stringify(size));
    await shot(B, '0539-p1-B-reader.png');
  } finally { await browser.close(); await server.close(); }
});
