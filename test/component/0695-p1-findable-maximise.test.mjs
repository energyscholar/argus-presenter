/*
 * Plan 0695 PART A — THE MAXIMISE CONTROL IS FINDABLE.
 *
 * ⛔ READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * The Control preview's full-screen mode is NOT new and was NOT missing. It has worked since plan
 * 0522 P7.2 — `#btn-pvfull`, a `.fullscreen` class, ESC to exit — and six tests (0522 t17–t22)
 * have held it green ever since. What was wrong is that nobody could SEE it: a `⤢` glyph at
 * font-size 10px, padded `2px 5px`, inset TWO pixels into the corner of a 432×282 preview, drawn
 * in `var(--dim)` on a .72-opacity field. Bruce commissioned that preview, uses it constantly, and
 * reported the maximise capability as absent.
 *
 * ⭐ THAT IS THE MEASUREMENT THIS FILE EXISTS TO KEEP: a feature nobody can find has the same
 * value as a feature that does not exist, and it generates the same bug report. So every check
 * below is about VISIBILITY and REACHABILITY, and none of them is about behaviour — behaviour is
 * 0522 t17–t22's job, and t2 here is the guard that says so.
 *
 * Acceptance criteria covered (plan 0695 §5):
 *   1  the maximise control is ≥28px and labelled          → t1, t1b
 *   2  t17–t22 pass UNMODIFIED                             → t2 (pinned by content hash)
 *   3  ESC still restores                                  → 0522 t18, and 0695 t7 for the layering
 *   4  the docked preview still shows a live view at the
 *      same scale, and no --pv-* constant moved            → t3, t4
 *   A2 hover/focus hint + one-time cue                     → t5
 *   A3 a documented keyboard shortcut                      → t6
 *
 * Browser tier: real geometry, real hit-testing, real keystrokes.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const CTL_TOKEN = 'ap-test-control-token';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FORM_OPTS = {
  title: 'Rehearsal form',
  fields: [{ name: 'who', label: 'Name', type: 'text' }],
};

async function openControl(browser, server, userId = 'op') {
  const pg = await browser.newPage();
  pg.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
  await pg.goto(`${server.url()}/control?userId=${userId}&role=presenter&token=${CTL_TOKEN}`, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => window.__gm && typeof window.__gm.setFullscreen === 'function' && !!document.getElementById('btn-pvfull'));
  await until(() => server.presence().some((u) => u.role === 'presenter'), { label: 'control page connected' });
  return pg;
}

/* ─────────────────────────────────────────────────────────────────────────────────────────── */

test('0695 t1 — the maximise control is a ≥28px target, LABELLED, and nothing paints over it', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const pg = await openControl(browser, server);
    const b = await pg.evaluate(() => {
      const el = document.getElementById('btn-pvfull');
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // Hit-test the CENTRE of the control against the real paint order. A labelled 28px button
      // that some other layer covers is exactly as unusable as the 10px glyph was, and the class
      // of defect here is "invisible", so the topmost element at its own centre is the assertion.
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
        title: el.getAttribute('title') || '',
        aria: el.getAttribute('aria-label') || '',
        fontPx: parseFloat(cs.fontSize),
        display: cs.display, visibility: cs.visibility, opacity: +cs.opacity,
        insideSelf: !!hit && (hit === el || el.contains(hit)),
        hitId: hit ? (hit.tagName + '#' + (hit.id || '') + '.' + (hit.className || '')) : null,
        // The preview it sits on, so "≥28px" is reported against the surface it must be found on.
        pv: (() => { const p = document.getElementById('preview').getBoundingClientRect(); return Math.round(p.width) + '×' + Math.round(p.height); })(),
      };
    });
    expect('the control is at least 28×28 CSS px (it was 10px type in 2px of padding)',
      b.w >= 28 && b.h >= 28, b.w + '×' + b.h + ' on a ' + b.pv + ' preview');
    expect('it carries WORDS, not only a glyph', /[A-Za-z]{3,}/.test(b.text), JSON.stringify(b.text));
    expect('and the words say what it does', /full\s*screen/i.test(b.text), JSON.stringify(b.text));
    expect('its type is legible, not 10px', b.fontPx >= 12, b.fontPx + 'px');
    expect('it is actually painted', b.display !== 'none' && b.visibility !== 'hidden' && b.opacity > 0.85, JSON.stringify(b));
    expect('and it is the topmost thing at its own centre — nothing covers it', b.insideSelf, String(b.hitId));
    // An accessible name is part of being findable: a screen-reader user has no corner to squint at.
    expect('it has an accessible name naming full screen', /full\s*screen/i.test(b.aria || b.title), JSON.stringify({ aria: b.aria, title: b.title }));

    await pg.close();
  } finally { await browser.close(); await server.close(); }
});

test('0695 t1b — the control keeps its identity: id btn-pvfull, still a single click to maximise', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const pg = await openControl(browser, server);
    // ⛔ The id is load-bearing: 0522 t17–t22 click it by that selector, and the plan forbids
    // deleting, renaming or reimplementing the button. This asserts the id survived Part A.
    const exists = await pg.evaluate(() => !!document.getElementById('btn-pvfull'));
    expect('#btn-pvfull still exists under that exact id', exists, String(exists));
    await pg.click('#btn-pvfull');
    expect('one click maximises', await pg.evaluate(() => window.__gm.fullscreen()), 'maximised');
    // …and the glyph flipped without eating the label, which is the whole point of the two spans.
    const after = await pg.evaluate(() => {
      const el = document.getElementById('btn-pvfull');
      return { text: (el.textContent || '').replace(/\s+/g, ' ').trim(), pressed: el.getAttribute('aria-pressed') };
    });
    expect('maximised, it still carries words (it does not collapse back to a bare glyph)',
      /[A-Za-z]{3,}/.test(after.text), JSON.stringify(after.text));
    expect('and it reports its state to assistive tech', after.pressed === 'true', String(after.pressed));
    await pg.click('#btn-pvfull');
    expect('a second click restores', (await pg.evaluate(() => window.__gm.fullscreen())) === false, 'restored');
    await pg.close();
  } finally { await browser.close(); await server.close(); }
});

test('0695 t2 — ⛔ 0522 t17–t22 are UNMODIFIED (byte-for-byte), which is the point of Part A', () => {
  /*
   * ⛔ IF THIS FAILS, DO NOT EDIT THE HASH TO MAKE IT GREEN.
   *
   * Plan 0695 §2 A4: "t17–t22 must pass UNMODIFIED. If a Generator edits those tests to fit new
   * markup, that is the regression: the behaviour is correct, only its visibility is wrong."
   * A "the six tests still pass" check cannot see that failure — a rewritten test passes too. The
   * only instrument that can is the FILE ITSELF, pinned. The hash below is the file as it stood on
   * master before plan 0695 was written.
   *
   * A later plan that legitimately changes that file must change this constant in the same commit,
   * deliberately and visibly, with the reason in its message. That deliberateness IS the guard.
   */
  const PINNED = '489e1da04d9b4e6e671bd388bcb7f2d039f8910f69bade3e4fa1a68ff5fed1bc';
  const p = join(ROOT, 'test', 'component', '0522-p7-interactive-preview.test.mjs');
  const src = readFileSync(p, 'utf8');
  const got = createHash('sha256').update(src, 'utf8').digest('hex');
  expect('the 0522 P7 test file is byte-for-byte what plan 0695 inherited', got === PINNED,
    'pinned=' + PINNED + ' got=' + got);
  // Belt and braces, and readable in the failure output: the six tests are still THERE and still
  // drive the same selector, so a green hash cannot be produced by an empty file of the same size.
  for (const n of ['t17', 't18', 't19', 't20', 't21', 't22'])
    expect(`0522 ${n} is still declared in that file`, src.indexOf(`0522 ${n} —`) !== -1, n);
  expect('and they still reach the control by its real id', src.indexOf("pg.click('#btn-pvfull')") !== -1, 'selector present');
});

test('0695 t3 — ⛔ F11: not one --pv-* constant moved, and the docked preview still paints at .72', async () => {
  /*
   * F11, the constant-drift bug class. control.html opens by recording that the preview was resized
   * three times, each move needing FIVE hand-synchronised constants, and that plan 0508 moved four
   * and missed the fifth — leaving TF1 red for months. Part A enlarges a button that lives INSIDE
   * #preview as position:absolute and takes part in no layout, so it cannot legitimately need any
   * of them. This asserts the source is untouched AND that the rendered result agrees.
   */
  const src = readFileSync(join(ROOT, 'app', 'control.html'), 'utf8');
  const DECLS = [
    '--pv-src-w:600px; --pv-src-h:392px;',
    '--pv-scale:.72;',
    '--pv-w:calc(var(--pv-src-w) * var(--pv-scale));',
    '--pv-h:calc(var(--pv-src-h) * var(--pv-scale));',
    '--pv-border:1px;',
    '--pv-dock-right:96px;',
    '--pv-gap:8px;',
    '--pv-left:calc(var(--pv-dock-right) + var(--pv-w) + 2 * var(--pv-border));',
    '--pv-slack:10px;',
  ];
  for (const d of DECLS) expect('untouched: ' + d, src.indexOf(d) !== -1, d);
  // …and nothing ELSE declares a --pv-* value. A second declaration anywhere is the drift itself.
  // TEN names (the first DECLS entry carries two on one line), each declared exactly once.
  const declared = [...src.matchAll(/--pv-[a-z-]+\s*:/g)].map((m) => m[0]);
  expect('exactly the ten --pv-* declarations exist, all in the one :root block',
    declared.length === 10 && new Set(declared).size === 10, declared.length + ': ' + declared.join(' '));

  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const pg = await openControl(browser, server);
    const geo = await pg.evaluate(() => {
      const pv = document.getElementById('preview').getBoundingClientRect();
      const f = document.getElementById('pvframe');
      const fr = f.getBoundingClientRect();
      return {
        pvw: Math.round(pv.width), pvh: Math.round(pv.height),
        transform: getComputedStyle(f).transform,
        fw: Math.round(fr.width),
        scaleVar: getComputedStyle(document.documentElement).getPropertyValue('--pv-scale').trim(),
      };
    });
    expect('the docked preview is still 432×282 (±3 for its border)',
      Math.abs(geo.pvw - 432) <= 3 && Math.abs(geo.pvh - 282) <= 3, geo.pvw + '×' + geo.pvh);
    expect('still the SAME .72 transform on the same 600×392 source frame',
      /matrix\(0\.72,/.test(geo.transform) && geo.scaleVar === '.72', geo.transform + ' var=' + geo.scaleVar);
    await pg.close();
  } finally { await browser.close(); await server.close(); }
});

test('0695 t4 — the docked preview still shows a LIVE view at that scale, with the control on top of it', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const pg = await openControl(browser, server);
    server.pushComponent('all', 'form', { ...FORM_OPTS, promptId: '0695-t4' });
    await until(async () => {
      const f = pg.frames().find((fr) => fr !== pg.mainFrame());
      if (!f) return false;
      try { return await f.evaluate(() => !!document.querySelector('.ap-form-submit')); } catch { return false; }
    }, { timeout: 8000, label: 'the docked preview rendered the pushed form' });

    const state = await pg.evaluate(() => {
      const el = document.getElementById('btn-pvfull');
      const r = el.getBoundingClientRect();
      const pv = document.getElementById('preview').getBoundingClientRect();
      return {
        fs: window.__gm.fullscreen(),
        // The control must be INSIDE the preview it belongs to (a maximise button that has drifted
        // out of its own box is how the dock geometry of TF1 / t50 gets broken).
        inside: r.left >= pv.left - 1 && r.right <= pv.right + 1 && r.top >= pv.top - 1 && r.bottom <= pv.bottom + 1,
        // …and it must not cover the whole surface it is a control FOR.
        areaShare: (r.width * r.height) / (pv.width * pv.height),
      };
    });
    expect('the preview is still DOCKED (this is not a full-screen-only feature)', state.fs === false, String(state.fs));
    expect('the control sits inside the preview box', state.inside, JSON.stringify(state));
    expect('and takes a small share of it — findable, not obstructive', state.areaShare < 0.12,
      (state.areaShare * 100).toFixed(1) + '% of the preview');
    await pg.close();
  } finally { await browser.close(); await server.close(); }
});

test('0695 t5 — A2: a hint on hover AND on focus, and a ONE-TIME cue when content first lands', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const pg = await openControl(browser, server);

    const idle = await pg.evaluate(() => getComputedStyle(document.getElementById('pvfulltip')).display);
    expect('the hint is NOT permanently on screen (it would become furniture)', idle === 'none', idle);

    // HOVER. A real pointer move, because :hover cannot be simulated by dispatching an event.
    await pg.hover('#btn-pvfull');
    const hovered = await pg.evaluate(() => {
      const t = document.getElementById('pvfulltip');
      return { display: getComputedStyle(t).display, text: (t.textContent || '').replace(/\s+/g, ' ').trim() };
    });
    expect('hovering the control shows the hint', hovered.display !== 'none', hovered.display);
    expect('and the hint names ESC', /esc/i.test(hovered.text), hovered.text);

    // FOCUS. A control reachable only by mouse is half-findable.
    await pg.evaluate(() => document.getElementById('btn-pvfull').focus());
    await pg.mouse.move(0, 0);
    await wait(60);
    const focused = await pg.evaluate(() => getComputedStyle(document.getElementById('pvfulltip')).display);
    expect('focusing it from the keyboard shows the same hint', focused !== 'none', focused);
    await pg.evaluate(() => document.getElementById('btn-pvfull').blur());
    await wait(60);
    expect('and it goes away again', (await pg.evaluate(() => getComputedStyle(document.getElementById('pvfulltip')).display)) === 'none', 'hidden');

    // THE ONE-TIME CUE. It fires when real content first lands in the DOCKED preview — the first
    // moment there is anything worth enlarging — and never again on this page load.
    expect('nothing has been pushed yet, so nothing has been cued', (await pg.evaluate(() => window.__gm.previewCued())) === false, 'not cued');
    server.pushComponent('all', 'form', { ...FORM_OPTS, promptId: '0695-t5' });
    await until(async () => await pg.evaluate(() => window.__gm.previewCued()), { timeout: 8000, label: 'the first docked render cued the control' });
    const cued = await pg.evaluate(() => ({
      cls: document.getElementById('btn-pvfull').className,
      tip: getComputedStyle(document.getElementById('pvfulltip')).display,
    }));
    expect('the control is cued, and the cue brings the hint with it so it EXPLAINS itself',
      /\bcue\b/.test(cued.cls) && cued.tip !== 'none', JSON.stringify(cued));

    // ONE time. A second push must not re-cue: a control that pulses forever is decoration, and
    // decoration is what people learn to stop seeing.
    await pg.evaluate(() => document.getElementById('btn-pvfull').classList.remove('cue'));
    server.pushComponent('all', 'form', { ...FORM_OPTS, promptId: '0695-t5b' });
    await wait(600);
    const again = await pg.evaluate(() => document.getElementById('btn-pvfull').className);
    expect('a later push does NOT cue again', !/\bcue\b/.test(again), again);

    await pg.close();
  } finally { await browser.close(); await server.close(); }
});

test('0695 t6 — A3: F toggles full screen, it is DOCUMENTED on the control, and it never ships a beat', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const pg = await openControl(browser, server);
    // Documented where the user is, not in a manual: the shortcut is named on the control's own
    // tooltip and on the hint it shows. A shortcut nobody is told about repeats Part A's defect.
    const doc = await pg.evaluate(() => ({
      title: document.getElementById('btn-pvfull').getAttribute('title') || '',
      tip: (document.getElementById('pvfulltip').textContent || '').replace(/\s+/g, ' ').trim(),
    }));
    expect('the shortcut is named on the button itself', /\bF\b/.test(doc.title), doc.title);
    expect('and on the hint', /\bF\b/.test(doc.tip), doc.tip);

    const before = await pg.evaluate(() => JSON.stringify(window.__gm.lastControl()));
    await pg.keyboard.press('f');
    await wait(120);
    expect('F maximises', await pg.evaluate(() => window.__gm.fullscreen()), 'maximised');
    await pg.keyboard.press('f');
    await wait(120);
    expect('F restores — it works in BOTH directions', (await pg.evaluate(() => window.__gm.fullscreen())) === false, 'restored');
    const after = await pg.evaluate(() => JSON.stringify(window.__gm.lastControl()));
    // R9's ruling stands: nothing about full screen may publish to the room.
    expect('F emitted NO control frame — it ships nothing (R9)', before === after, before + ' -> ' + after);

    // …and it must not hijack typing. A key that fires while the operator is filling a field is
    // the reason this page guards every other shortcut the same way.
    await pg.evaluate(() => {
      const i = document.createElement('input');
      i.id = 'vp-typing-probe'; i.type = 'text';
      document.body.appendChild(i); i.focus();
    });
    await pg.keyboard.press('f');
    await wait(120);
    const typing = await pg.evaluate(() => {
      const v = document.getElementById('vp-typing-probe').value;
      const fs = window.__gm.fullscreen();
      document.getElementById('vp-typing-probe').remove();
      return { v, fs };
    });
    expect('F typed into an input does NOT maximise — it types', typing.fs === false && typing.v === 'f', JSON.stringify(typing));

    await pg.close();
  } finally { await browser.close(); await server.close(); }
});
