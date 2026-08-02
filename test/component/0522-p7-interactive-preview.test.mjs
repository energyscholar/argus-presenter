/*
 * Plan 0522 P7 — INTERACTIVE PREVIEW, AND FULL SCREEN.
 *
 * P7.1 (R7). Bruce: "I made an error! I want shared forms active in presenter control preview."
 * The blocker was ONE declaration — `#preview iframe{ … pointer-events:none }`. The sandbox was
 * never the lever: components already decline native <form> submission on purpose and answer over
 * the postMessage bridge, so `allow-scripts` is sufficient and `allow-forms` would only re-open a
 * native submit that can navigate the preview away. t20 nails the flag down; t22 proves the
 * pointer actually reaches the content, with a REAL mouse click at real page coordinates — a
 * JavaScript `el.click()` fires straight through `pointer-events:none` and would have passed
 * against the unfixed page, which makes it the wrong instrument for this claim.
 *
 * P7.1 red team (R5). The bridge posts results to `parent`, and from the preview that parent is
 * the control page. Those results must never be recorded as a player's answer. They already fell
 * on the floor — but by ACCIDENT, because no message listener existed. t21 asserts the drop
 * POSITIVELY: the page now records each dropped result with its reason and tells the operator, so
 * the boundary is a thing that exists and can be checked, not an absence that a future listener
 * would quietly repeal.
 *
 * P7.2. Full screen at scale(1) — the source frame is 600x392, so this is the only mode at native
 * fidelity (t17). ESC exits, with a barely-visible hint (t18, R8). Nothing ships from full screen
 * (R9): the transport keys are swallowed and GO is physically covered, both asserted here.
 *
 * P7.2 red team. applyPreviewState() clears srcdoc when the tab is starved, to stop a rAF loop.
 * On a decoration that is right; under a half-typed form it destroys the operator's input. t19
 * drives that exact sequence — type, then degrade — and requires the characters to survive and
 * the deferral to be announced, then requires the CPU mitigation to still fire on exit so it was
 * scoped rather than deleted.
 *
 * Browser tier: real clicks, real keystrokes, computed style and the live control DOM.
 *
 * ⛔ modules/*.json is gitignored and has no version history. Nothing here reads or writes the
 * repo's modules/ directory; every fixture is pushed through the server's own content API.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, until, wait } from '../../harness/multi.mjs';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Plan 0529 P2: the content catalogue is control-credentialed and FAILS CLOSED, so a test
// that drives the GM panel must run a gated server and hand the page a token — exactly as a
// real deployment does. Nothing else about these tests changed.
const CTL_TOKEN = 'ap-test-control-token';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FORM_OPTS = {
  title: 'Rehearsal form',
  fields: [
    { name: 'who', label: 'Name', type: 'text' },
    { name: 'pick', label: 'Choose', type: 'select', options: [{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }] },
  ],
};

/** The control page, connected as the presenter, with its test hooks ready. */
async function openControl(browser, server, userId = 'op') {
  const pg = await browser.newPage();
  pg.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
  await pg.goto(`${server.url()}/control?userId=${userId}&role=presenter&token=${CTL_TOKEN}`, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => window.__gm && typeof window.__gm.setFullscreen === 'function' && !!document.getElementById('btn-pvfull'));
  await until(() => server.presence().some((u) => u.role === 'presenter'), { label: 'control page connected' });
  return pg;
}

/** The one iframe on the control page: #pvframe. Sandboxed, opaque origin, still reachable. */
function previewFrame(pg) {
  return pg.frames().find((f) => f !== pg.mainFrame()) || null;
}

/** Wait until the preview frame exists AND has rendered `sel`. Returns the frame. */
async function previewReady(pg, sel) {
  let f = null;
  await until(async () => {
    f = previewFrame(pg);
    if (!f) return false;
    try { return await f.evaluate((s) => !!document.querySelector(s), sel); } catch { return false; }
  }, { timeout: 8000, label: `preview frame rendered ${sel}` });
  return previewFrame(pg);
}

/**
 * Map a point INSIDE the preview frame to a page coordinate, through whatever transform the
 * preview is currently wearing. The scale is measured from the iframe's own painted width, not
 * assumed, so the same helper serves the .6 thumbnail and the scale(1) full-screen mode.
 */
async function pointIn(pg, frame, sel) {
  const inner = await frame.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const outer = await pg.$eval('#pvframe', (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width }; });
  const scale = outer.w / 600;
  return { x: outer.left + inner.x * scale, y: outer.top + inner.y * scale, scale };
}

const enterFullscreen = (pg) => pg.click('#btn-pvfull');
const isFullscreen = (pg) => pg.evaluate(() => window.__gm.fullscreen());

/* ─────────────────────────────────────────────────────────────────────────────────────────── */

test('0522 t17 — full screen renders the preview at scale(1), and GO is out of reach (R9)', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const pg = await openControl(browser, server);

    const before = await pg.evaluate(() => {
      const f = document.getElementById('pvframe');
      const r = f.getBoundingClientRect();
      return { transform: getComputedStyle(f).transform, w: Math.round(r.width), h: Math.round(r.height) };
    });
    expect('the docked thumbnail is SCALED DOWN before full screen (so scale(1) is a real change)',
      before.transform !== 'none' && before.transform !== 'matrix(1, 0, 0, 1, 0, 0)' && before.w < 600,
      before.transform + ' painted ' + before.w + 'x' + before.h);

    await enterFullscreen(pg);
    expect('the ⤢ button enters full screen', await isFullscreen(pg), 'fullscreen');

    const geo = await pg.evaluate(() => {
      const pv = document.getElementById('preview'), f = document.getElementById('pvframe');
      const pr = pv.getBoundingClientRect(), fr = f.getBoundingClientRect();
      return {
        cls: pv.className,
        transform: getComputedStyle(f).transform,
        fw: Math.round(fr.width), fh: Math.round(fr.height),
        coversViewport: Math.round(pr.width) >= innerWidth && Math.round(pr.height) >= innerHeight,
        pos: getComputedStyle(pv).position,
      };
    });
    expect('#preview carries the fullscreen class', /\bfullscreen\b/.test(geo.cls), geo.cls);
    expect('the preview covers the whole viewport, position:fixed', geo.coversViewport && geo.pos === 'fixed',
      geo.pos + ' covers=' + geo.coversViewport);
    expect('the iframe transform is IDENTITY — scale(1)', geo.transform === 'none' || geo.transform === 'matrix(1, 0, 0, 1, 0, 0)', geo.transform);
    expect('and it therefore paints at the source frame\'s native 600x392', geo.fw === 600 && geo.fh === 392, geo.fw + 'x' + geo.fh);

    // R9 — full screen is strictly non-shipping. The GO button cannot be clicked from here.
    const go = await pg.evaluate(() => {
      const b = document.getElementById('btn-go');
      const r = b.getBoundingClientRect();
      const onScreen = r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
      if (!onScreen) return { onScreen, hit: null };
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { onScreen, hit: el ? (el.tagName + '#' + (el.id || '')) : null, isGo: !!el && (el === b || b.contains(el)) };
    });
    expect('GO cannot be reached while full screen is open (R9)', !go.onScreen || go.isGo === false,
      'onScreen=' + go.onScreen + ' topmost=' + go.hit);

    // …and the transport keys that PUBLISH are swallowed, so a leaned-on spacebar ships nothing.
    const sentBefore = await pg.evaluate(() => JSON.stringify(window.__gm.lastControl()));
    await pg.keyboard.press('Space');
    await pg.keyboard.press('ArrowRight');
    await wait(150);
    const sentAfter = await pg.evaluate(() => JSON.stringify(window.__gm.lastControl()));
    expect('Space / ArrowRight emit NO control frame while full screen (R9)', sentBefore === sentAfter,
      String(sentBefore) + ' -> ' + String(sentAfter));

    await pg.close();
  } finally { await browser.close(); await server.close(); }
});

test('0522 t18 — ESC exits full screen, the Press ESC hint is present and barely visible (R8)', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const pg = await openControl(browser, server);
    await enterFullscreen(pg);
    expect('full screen is open', await isFullscreen(pg), 'open');

    const hint = await pg.evaluate(() => {
      const h = document.getElementById('pvfshint');
      if (!h) return null;
      const cs = getComputedStyle(h), r = h.getBoundingClientRect(), pv = document.getElementById('preview').getBoundingClientRect();
      return {
        text: (h.textContent || '').trim(), display: cs.display, opacity: +cs.opacity, fontPx: parseFloat(cs.fontSize),
        dx: Math.round(r.left - pv.left), dy: Math.round(r.top - pv.top), w: r.width, h: r.height,
      };
    });
    expect('the hint element exists and is displayed in full screen', !!hint && hint.display !== 'none' && hint.w > 0, JSON.stringify(hint));
    expect('it says to press ESC', /press\s+esc/i.test(hint.text), hint.text);
    expect('it sits in the UPPER-LEFT of the preview', hint.dx >= 0 && hint.dx < 60 && hint.dy >= 0 && hint.dy < 60, 'dx=' + hint.dx + ' dy=' + hint.dy);
    expect('it is BARELY visible — small and faint, not a label competing with the content',
      hint.opacity < 0.5 && hint.fontPx <= 11, 'opacity=' + hint.opacity + ' font=' + hint.fontPx + 'px');

    // ESC must exit — and must NOT fall through to the STOP button, which is what Escape does
    // on this page when nothing else is open. A key that exits AND clears the room is not an exit.
    const ctlBefore = await pg.evaluate(() => JSON.stringify(window.__gm.lastControl()));
    await pg.keyboard.press('Escape');
    await wait(150);
    const after = await pg.evaluate(() => ({
      fs: window.__gm.fullscreen(),
      ctl: JSON.stringify(window.__gm.lastControl()),
      cls: document.getElementById('preview').className,
      hintShown: getComputedStyle(document.getElementById('pvfshint')).display !== 'none',
    }));
    expect('ESC exits full screen', after.fs === false, String(after.fs));
    expect('the fullscreen class is gone with it', !/\bfullscreen\b/.test(after.cls), after.cls);
    expect('the hint disappears outside full screen', after.hintShown === false, String(after.hintShown));
    expect('ESC did NOT fall through to STOP / any other control', after.ctl === ctlBefore, ctlBefore + ' -> ' + after.ctl);

    // A second ESC now reaches the ordinary handler again — full screen borrowed the key, it did
    // not confiscate it.
    await pg.keyboard.press('Escape');
    await wait(150);
    const ctl2 = await pg.evaluate(() => window.__gm.lastControl());
    expect('outside full screen ESC behaves as before (STOP → clear)', !!ctl2 && ctl2.action === 'clear', JSON.stringify(ctl2));

    await pg.close();
  } finally { await browser.close(); await server.close(); }
});

test('0522 t19 — a degrade during full-screen interaction does not destroy the operator\'s input', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const pg = await openControl(browser, server);
    server.pushComponent('all', 'form', { ...FORM_OPTS, promptId: 'p7-t19' });
    await previewReady(pg, '.ap-form-submit');
    await enterFullscreen(pg);

    // Type into the form the way a human does: a real click, then real keystrokes.
    let f = previewFrame(pg);
    const p = await pointIn(pg, f, 'input.ap-input');
    expect('full screen maps 1:1 — no scaling between the click and the content', Math.abs(p.scale - 1) < 0.01, 'scale=' + p.scale);
    await pg.mouse.click(p.x, p.y);
    await pg.keyboard.type('Ada Lovelace');
    f = previewFrame(pg);
    const typed = await f.$eval('input.ap-input', (el) => el.value);
    expect('the operator can type into the full-screen preview', typed === 'Ada Lovelace', JSON.stringify(typed));

    // Now the tab starves. Before P7 this cleared srcdoc and every character went with it.
    await pg.evaluate(() => window.__gm.degrade(true));
    await wait(200);
    f = previewFrame(pg);
    const survived = await f.$eval('input.ap-input', (el) => el.value).catch(() => null);
    const state = await pg.evaluate(() => {
      const fr = document.getElementById('pvframe'), note = document.getElementById('pvfsnote');
      return {
        srcdocHasForm: (fr.getAttribute('srcdoc') || '').indexOf('ap-form-submit') !== -1,
        frameVisible: getComputedStyle(fr).visibility !== 'hidden',
        warnShown: getComputedStyle(document.getElementById('pvwarn')).display !== 'none',
        noteShown: getComputedStyle(note).display !== 'none',
        noteText: (note.textContent || '').trim(),
      };
    });
    expect('the typed value SURVIVES the degrade', survived === 'Ada Lovelace', JSON.stringify(survived));
    expect('srcdoc was not wiped out from under it', state.srcdocHasForm, String(state.srcdocHasForm));
    expect('the frame stays visible and workable', state.frameVisible && !state.warnShown, JSON.stringify(state));
    expect('and the deferral is ANNOUNCED, not silent', state.noteShown && /busy|held/i.test(state.noteText), state.noteText);

    // ⚠ DECLARED LIMIT OF R8, asserted rather than left to be discovered live: a key pressed while
    // focus is INSIDE the sandboxed frame never reaches the control page, so ESC cannot exit from
    // there. That is why the ⤡ corner control exists and stays clickable in full screen. t18 covers
    // ESC proper, with focus on the page.
    await pg.keyboard.press('Escape');
    await wait(150);
    expect('with focus inside the frame ESC does NOT reach the page — the corner control is the exit',
      (await isFullscreen(pg)) === true, 'still full screen, as documented');

    // Scoped, not deleted: leaving full screen hands the CPU mitigation back.
    await pg.click('#btn-pvfull');
    await wait(250);
    const afterExit = await pg.evaluate(() => {
      const fr = document.getElementById('pvframe');
      return {
        fs: window.__gm.fullscreen(),
        srcdocHasForm: (fr.getAttribute('srcdoc') || '').indexOf('ap-form-submit') !== -1,
        warnShown: getComputedStyle(document.getElementById('pvwarn')).display !== 'none',
        noteShown: getComputedStyle(document.getElementById('pvfsnote')).display !== 'none',
      };
    });
    expect('on exit the pause finally applies — the rAF mitigation was suspended, not removed',
      afterExit.fs === false && afterExit.srcdocHasForm === false && afterExit.warnShown === true && afterExit.noteShown === false,
      JSON.stringify(afterExit));

    await pg.close();
  } finally { await browser.close(); await server.close(); }
});

test('0522 t20 — the preview sandbox is allow-scripts and ONLY allow-scripts (no allow-forms)', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const pg = await openControl(browser, server);
    const sb = await pg.evaluate(() => {
      const f = document.getElementById('pvframe');
      return { attr: f.getAttribute('sandbox'), list: Array.from(f.sandbox || []) };
    });
    expect('the live attribute is exactly "allow-scripts"', sb.attr === 'allow-scripts', String(sb.attr));
    expect('allow-forms is NOT in the token list', sb.list.indexOf('allow-forms') === -1, sb.list.join(' '));
    expect('nor allow-same-origin, allow-top-navigation or allow-popups', sb.list.length === 1, sb.list.join(' '));
    await pg.close();
  } finally { await browser.close(); await server.close(); }

  // Source-level, so the flag cannot creep back in on a code path this fixture never renders.
  // Every sandbox ATTRIBUTE in the file is checked, not every mention of the string: the comments
  // in control.html name `allow-forms` precisely in order to explain why it is refused, and a test
  // that punished that prose would push out the documentation and keep the hazard.
  const src = readFileSync(join(ROOT, 'app', 'control.html'), 'utf8');
  const attrs = Array.from(src.matchAll(/sandbox\s*=\s*"([^"]*)"/g)).map((m) => m[1]);
  expect('control.html declares at least one sandbox attribute (the check has something to check)', attrs.length >= 1, JSON.stringify(attrs));
  expect('no sandbox attribute in control.html grants allow-forms', attrs.every((a) => !/allow-forms/.test(a)), JSON.stringify(attrs));
  expect('every sandbox attribute in control.html is exactly allow-scripts', attrs.every((a) => a.trim() === 'allow-scripts'), JSON.stringify(attrs));
  // …and the declaration that made the preview inert is gone, which is the whole of P7.1 (R7).
  const rule = (src.match(/#preview iframe\{[^}]*\}/) || [''])[0];
  expect('the #preview iframe rule no longer sets pointer-events:none', !!rule && !/pointer-events\s*:\s*none/.test(rule), rule || 'RULE NOT FOUND');
});

test('0522 t21 — a form submitted in the PREVIEW produces no answer on the real channel; the drop is recorded', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  const PID = 'p7-t21';
  try {
    const pg = await openControl(browser, server, 'op');
    const player = await connectUser(browser, server, { userId: 'p1', userName: 'Player One' });
    await until(() => server.presence().some((u) => u.userId === 'p1'), { label: 'a real player is connected' });

    server.pushComponent('all', 'form', { ...FORM_OPTS, promptId: PID });
    const f = await previewReady(pg, '.ap-form-submit');

    // The operator rehearses: fills the form in the preview and presses Submit, with a real
    // pointer, exactly as they would at the table.
    const pIn = await pointIn(pg, f, 'input.ap-input');
    await pg.mouse.click(pIn.x, pIn.y);
    await pg.keyboard.type('Rehearsal');
    const pBtn = await pointIn(pg, previewFrame(pg), '.ap-form-submit');
    await pg.mouse.click(pBtn.x, pBtn.y);
    await wait(400);

    // POSITIVE: the page caught the result at the boundary and RECORDED the drop with its reason.
    // This is the assertion that matters. "No listener exists" would also produce no answer, and
    // would silently stop being true the day somebody adds one — a record cannot rot that way.
    const drops = await pg.evaluate(() => window.__gm.previewDrops());
    expect('the preview posted a result and this page recorded DROPPING it', drops.length >= 1, JSON.stringify(drops));
    const answerDrop = drops.find((d) => d.type === 'answer');
    expect('the dropped result is the form ANSWER, identified by its promptId', !!answerDrop && answerDrop.promptId === PID, JSON.stringify(drops));
    expect('the drop carries a stated REASON, so it reads as a decision and not a bug', !!answerDrop && /rehearsal/i.test(answerDrop.reason || ''), (answerDrop || {}).reason || '');

    // POSITIVE: the operator is told, in the preview, that nothing was sent.
    const told = await pg.evaluate(() => {
      const el = document.getElementById('pvrehearse');
      return { shown: getComputedStyle(el).display !== 'none', text: (el.textContent || '').trim() };
    });
    expect('the operator is told the poke was a rehearsal', told.shown && /not sent/i.test(told.text), JSON.stringify(told));

    // NEGATIVE: nothing whatsoever reached the real channel.
    const answers = server.store.get('answers/' + PID);
    expect('NO answer was recorded for the operator', server.store.get('answers/' + PID + '/op') === undefined, JSON.stringify(answers));
    expect('the answers subtree for this prompt is empty', answers === undefined || Object.keys(answers).length === 0, JSON.stringify(answers));

    // PARITY: the same submit from a REAL player still lands. The boundary is the preview frame,
    // not the form — a fix that made forms stop answering everywhere would pass every check above.
    const pf = player.frames().find((fr) => fr !== player.mainFrame());
    await until(async () => { try { return await pf.evaluate(() => !!document.querySelector('.ap-form-submit')); } catch { return false; } },
      { timeout: 8000, label: 'the player sees the form too' });
    await pf.evaluate(() => {
      document.querySelector('input.ap-input').value = 'Player answer';
      document.querySelector('.ap-form-submit').click();
    });
    await until(() => server.store.get('answers/' + PID + '/p1') !== undefined, { timeout: 3000, label: 'the player\'s answer reaches the store' });
    const real = server.store.get('answers/' + PID + '/p1');
    expect('a real player\'s answer still lands unchanged', !!real && real.who === 'Player answer', JSON.stringify(real));
    expect('and the operator still has none', server.store.get('answers/' + PID + '/op') === undefined, JSON.stringify(server.store.get('answers/' + PID)));

    await pg.close();
  } finally { await browser.close(); await server.close(); }
});

test('0522 t22 — a shared form is INTERACTIVE in the docked preview: real click, real typing, handler fires (R7)', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const pg = await openControl(browser, server);
    server.pushComponent('all', 'form', { ...FORM_OPTS, promptId: 'p7-t22' });
    let f = await previewReady(pg, '.ap-form-submit');

    const css = await pg.evaluate(() => getComputedStyle(document.getElementById('pvframe')).pointerEvents);
    expect('the preview iframe no longer refuses pointer events', css !== 'none', css);

    // Everything below is a REAL mouse click at a REAL page coordinate. el.click() would fire
    // through pointer-events:none and prove nothing; this is the instrument that can fail.
    const pIn = await pointIn(pg, f, 'input.ap-input');
    expect('the docked preview is still the SCALED thumbnail (the click has to survive the scale)', pIn.scale < 0.99, 'scale=' + pIn.scale);
    await pg.mouse.click(pIn.x, pIn.y);
    f = previewFrame(pg);
    const focused = await f.evaluate(() => document.activeElement && document.activeElement.className);
    expect('a click lands INSIDE the frame and focuses the field', /ap-input/.test(String(focused)), String(focused));

    await pg.keyboard.type('Grace');
    f = previewFrame(pg);
    expect('typing reaches the field', (await f.$eval('input.ap-input', (el) => el.value)) === 'Grace', 'typed');

    // The select is a second, different control — a preview that only accepts text is not interactive.
    await f.$eval('select.ap-input', (el) => { el.value = 'two'; el.dispatchEvent(new Event('change', { bubbles: true })); });

    const pBtn = await pointIn(pg, f, '.ap-form-submit');
    await pg.mouse.click(pBtn.x, pBtn.y);
    await wait(300);
    f = previewFrame(pg);
    const btn = await f.$eval('.ap-form-submit', (el) => ({ text: (el.textContent || '').trim(), cls: el.className }));
    expect('the submit button\'s OWN handler ran (it reports Submitted)', /submitted/i.test(btn.text), JSON.stringify(btn));
    expect('and it marked itself selected', /is-selected/.test(btn.cls), btn.cls);

    // Focus stays where the operator put it: P7 reconciled the anti-steal kick, it did not keep
    // blurring the frame out from under a working human.
    const held = await pg.evaluate(() => document.activeElement && (document.activeElement.tagName + '#' + (document.activeElement.id || '')));
    expect('the preview is allowed to KEEP focus once a human put it there', held === 'IFRAME#pvframe', String(held));

    await pg.close();
  } finally { await browser.close(); await server.close(); }
});
