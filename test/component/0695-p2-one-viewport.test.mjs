/*
 * Plan 0695 PART B — ONE EXPANDABLE VIEWPORT, AND ONLY ONE.
 *
 * Two surfaces want the same gesture: a small live box that maximises, restores, and exits on ESC.
 * The Control preview has PROVED that gesture since 0522 P7.2; screen sharing (Part C) will want it
 * next. ⛔ Building it twice is how two maximise implementations begin to disagree about what
 * "maximised" means — so the behaviour moved into lib/viewport.js, and the preview became its first
 * CALLER rather than its private copy.
 *
 * Acceptance criteria covered (plan 0695 §5):
 *   5  one implementation, used by both surfaces — no duplicated maximise logic (by grep)  → t7
 *   6  no onEnd ⇒ NO End control IN THE DOM, not a hidden one                              → t8
 *   7  ESC closes the topmost layer only                                                   → t9
 *   plus the module contract the preview actually holds                                    → t10
 *
 * ⛔ NEGATIVE CONSTRAINTS asserted here too: no requestFullscreen() anywhere (it needs a user
 * gesture, is refused in our allow-scripts-only sandbox, and differs on iOS), and no screen-capture
 * API — `getDisplayMedia` is out of scope for the whole plan, and asserting its absence now means
 * Part C cannot reach for it quietly later.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { readdirSync, statSync, readFileSync } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const CTL_TOKEN = 'ap-test-control-token';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every browser-delivered source file under the given roots. */
function sources(roots) {
  const out = [];
  const walk = (d) => {
    let entries; try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(html|js|mjs)$/.test(e)) out.push(p);
    }
  };
  for (const r of roots) walk(join(ROOT, r));
  return out;
}
const rel = (p) => relative(ROOT, p).split(sep).join('/');

async function openControl(browser, server, userId = 'op') {
  const pg = await browser.newPage();
  pg.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
  await pg.goto(`${server.url()}/control?userId=${userId}&role=presenter&token=${CTL_TOKEN}`, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => window.__gm && typeof window.__gm.viewportMount === 'function' && !!document.getElementById('btn-pvfull'));
  await until(() => server.presence().some((u) => u.role === 'presenter'), { label: 'control page connected' });
  return pg;
}

/* ─────────────────────────────────────────────────────────────────────────────────────────── */

test('0695 t7 — exactly ONE file implements the maximise toggle, and it is not the Fullscreen API', () => {
  const files = sources(['app', 'lib', 'components', 'modules']);
  expect('there are source files to check (the grep has something to grep)', files.length > 5, String(files.length));

  // The maximise class NAME, as a JS string literal. CSS selectors (`.fullscreen{…}`) are how the
  // class is STYLED and are expected in the host page; a quoted literal is how it is TOGGLED, and
  // that must exist in one place only.
  const namers = files.filter((f) => /['"]fullscreen['"]/.test(readFileSync(f, 'utf8')));
  expect('only lib/viewport.js names the maximise class in JS', namers.length === 1 && rel(namers[0]) === 'lib/viewport.js',
    namers.map(rel).join(', ') || '(none — the module is missing)');

  // …and no other file reaches classList for it by any spelling.
  const togglers = files.filter((f) => {
    const src = readFileSync(f, 'utf8');
    if (rel(f) === 'lib/viewport.js') return false;
    return /classList\s*\.\s*(?:toggle|add|remove)\s*\([^)]*fullscreen/i.test(src);
  });
  expect('no second .fullscreen toggler exists anywhere', togglers.length === 0, togglers.map(rel).join(', '));

  /*
   * ⛔ Plan 0695 §6: the class-based maximise is kept ON PURPOSE. The Fullscreen API needs a user
   * gesture (so the __gm hook and the MCP path could not drive it), is refused inside the preview's
   * allow-scripts-only sandbox, and behaves differently on iOS. Same for screen capture, which the
   * whole plan rules out.
   *
   * ⚠ THE PATTERN MATCHES A CALL, NOT THE WORD — and that is deliberate, for the reason 0522 t20
   * already had to learn: control.html and lib/viewport.js NAME these APIs in their comments in
   * order to explain why they are refused. A check that punished the prose would push out the
   * documentation and keep the hazard. A call has a receiver and a dot; an explanation does not.
   */
  const CALLS = /[\w)\]]\s*\.\s*(?:requestFullscreen|webkitRequestFullscreen|exitFullscreen)\s*\(/;
  const rf = files.filter((f) => CALLS.test(readFileSync(f, 'utf8')));
  expect('nothing CALLS the Fullscreen API', rf.length === 0, rf.map(rel).join(', '));
  const CAPTURE = /[\w)\]]\s*\.\s*getDisplayMedia\s*\(/;
  const cap = files.filter((f) => CAPTURE.test(readFileSync(f, 'utf8')));
  expect('nothing reaches for getDisplayMedia', cap.length === 0, cap.map(rel).join(', '));
  // …and the refusal is WRITTEN DOWN where the next author will meet it, not only enforced here.
  const vp = readFileSync(join(ROOT, 'lib', 'viewport.js'), 'utf8');
  expect('the module says why it is a class and not the Fullscreen API',
    /requestFullscreen/.test(vp) && /sandbox/i.test(vp), 'rationale present');

  // The preview must be a CALLER, not a copy: control.html imports the module and mounts it.
  const ctl = readFileSync(join(ROOT, 'app', 'control.html'), 'utf8');
  expect('control.html imports the shared viewport', /import\s*\{[^}]*\}\s*from\s*'\/lib\/viewport\.js'/.test(ctl), 'import present');
  expect('…and mounts #preview through it', /mountViewport\s*\(\s*\$\('preview'\)/.test(ctl), 'mount present');
  // ⛔ The button 0522 t17–t22 click is ADOPTED, never rebuilt.
  expect('the existing #btn-pvfull is handed to the module, not replaced',
    /control:\s*\$\('btn-pvfull'\)/.test(ctl), 'adopted');
});

test('0695 t8 — ⭐ NO onEnd ⇒ NO End control IN THE DOM (absence, not a hidden element)', async () => {
  /*
   * Bruce, on the Control preview: "END SHARING doesn't apply." That is expressed as the ABSENCE of
   * a callback, and the End control is then never CREATED — not rendered-and-hidden, and with no
   * `showEnd:false` flag anyone can set wrongly. ⭐ Enforce by construction, not by refusal.
   *
   * Asserted against a REAL DOM on the real page, through the module the page actually loaded, so
   * this cannot pass against a stub that happens to agree with a wrong implementation.
   */
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const pg = await openControl(browser, server);
    const r = await pg.evaluate(() => {
      const mk = (id) => { const d = document.createElement('div'); d.id = id; document.body.appendChild(d); return d; };
      const a = mk('vp-no-end'), b = mk('vp-with-end');
      let ended = 0;
      const va = window.__gm.viewportMount(a, { title: 'no end' });
      const vb = window.__gm.viewportMount(b, { title: 'with end', onEnd: () => { ended++; }, endLabel: 'End sharing' });
      const out = {
        // The negative, stated three ways: nothing in the subtree, nothing on the api, and no
        // element that a stylesheet could later reveal.
        noEndNode: a.querySelector('[data-vp-end]') === null,
        noEndApi: va.endControl === null,
        noEndMarkup: a.innerHTML.indexOf('vp-end') === -1,
        buttonsInA: a.querySelectorAll('button').length,
        // The positive control: the SAME module, given a callback, does create one and wire it.
        endNode: !!b.querySelector('[data-vp-end]'),
        endLabel: (b.querySelector('[data-vp-end]') || {}).textContent,
        endApi: vb.endControl === b.querySelector('[data-vp-end]'),
        // …and the page's own preview, which is mounted without onEnd, likewise has none.
        previewHasEnd: document.querySelector('#preview [data-vp-end]') !== null,
      };
      b.querySelector('[data-vp-end]').click();
      out.endFired = ended;
      va.destroy(); vb.destroy();
      out.destroyedA = a.querySelectorAll('button').length;
      out.destroyedB = b.querySelectorAll('button').length;
      a.remove(); b.remove();
      return out;
    });
    expect('no onEnd ⇒ no [data-vp-end] node exists', r.noEndNode, JSON.stringify(r));
    expect('no onEnd ⇒ the api reports null, not a hidden element', r.noEndApi, String(r.noEndApi));
    expect('no onEnd ⇒ the markup does not even mention it', r.noEndMarkup, String(r.noEndMarkup));
    expect('such a viewport has exactly ONE button — the maximise control', r.buttonsInA === 1, String(r.buttonsInA));
    expect('POSITIVE CONTROL: given onEnd, the same module DOES create the End control', r.endNode, String(r.endNode));
    expect('it is labelled', /end/i.test(String(r.endLabel)), String(r.endLabel));
    expect('the api exposes that exact node', r.endApi, String(r.endApi));
    expect('and clicking it calls the callback', r.endFired === 1, String(r.endFired));
    expect('⛔ the CONTROL PREVIEW has no End control at all — "END SHARING doesn\'t apply"',
      r.previewHasEnd === false, String(r.previewHasEnd));
    expect('destroy() removes what the module created, from both', r.destroyedA === 0 && r.destroyedB === 0,
      r.destroyedA + ' / ' + r.destroyedB);
    await pg.close();
  } finally { await browser.close(); await server.close(); }
});

test('0695 t9 — ESC closes the TOPMOST layer only: the maximised preview, then the config overlay', async () => {
  /*
   * Two ESC handlers now exist on this page: the viewport's (capture phase) and control.html's own
   * chain — attendance → config → STOP. One press must peel exactly one layer. An exit that ALSO
   * closed the settings overlay underneath, or STOPPED the room, is not an exit; 0522 t18 asserts
   * the STOP half, and this asserts the stacking half.
   */
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const pg = await openControl(browser, server);
    const isOpen = () => pg.evaluate(() => document.getElementById('ap-config').classList.contains('open'));

    await pg.click('#led-btn');
    await wait(120);
    expect('the config overlay is open (the lower layer)', await isOpen(), 'open');

    await pg.click('#btn-pvfull');
    await wait(120);
    const stacked = await pg.evaluate(() => ({ fs: window.__gm.fullscreen(), open: window.__gm.viewportsOpen(), cfg: document.getElementById('ap-config').classList.contains('open') }));
    expect('the preview is maximised OVER it', stacked.fs === true && stacked.open === 1, JSON.stringify(stacked));
    expect('and opening the upper layer did not disturb the lower one', stacked.cfg === true, String(stacked.cfg));

    const ctlBefore = await pg.evaluate(() => JSON.stringify(window.__gm.lastControl()));
    await pg.keyboard.press('Escape');
    await wait(150);
    const one = await pg.evaluate(() => ({
      fs: window.__gm.fullscreen(), open: window.__gm.viewportsOpen(),
      cfg: document.getElementById('ap-config').classList.contains('open'),
      ctl: JSON.stringify(window.__gm.lastControl()),
    }));
    expect('ONE press restores the preview', one.fs === false && one.open === 0, JSON.stringify(one));
    expect('…and the config overlay is STILL OPEN — only the topmost layer closed', one.cfg === true, String(one.cfg));
    expect('…and nothing was published to the room', one.ctl === ctlBefore, ctlBefore + ' -> ' + one.ctl);

    await pg.keyboard.press('Escape');
    await wait(150);
    const two = await pg.evaluate(() => ({
      cfg: document.getElementById('ap-config').classList.contains('open'),
      ctl: JSON.stringify(window.__gm.lastControl()),
    }));
    expect('the SECOND press reaches the layer below and closes the overlay', two.cfg === false, String(two.cfg));
    expect('and still nothing was published', two.ctl === ctlBefore, ctlBefore + ' -> ' + two.ctl);

    // The key is BORROWED, not confiscated: with every layer gone, ESC means STOP again.
    await pg.keyboard.press('Escape');
    await wait(200);
    const three = await pg.evaluate(() => window.__gm.lastControl());
    expect('with no layer open ESC behaves as it always did (STOP → clear)', !!three && three.action === 'clear', JSON.stringify(three));

    await pg.close();
  } finally { await browser.close(); await server.close(); }
});

test('0695 t10 — the preview holds a real viewport instance, and the module contract is what it uses', async () => {
  const server = await createServer({ port: 0, controlToken: CTL_TOKEN });
  const browser = await launch();
  try {
    const pg = await openControl(browser, server);
    const c = await pg.evaluate(() => {
      const vp = window.__gm.previewViewport();
      return {
        shape: ['maximise', 'restore', 'toggle', 'isMaximised', 'destroy'].filter((k) => typeof vp[k] === 'function'),
        isEl: vp.el === document.getElementById('preview'),
        control: vp.control === document.getElementById('btn-pvfull'),
      };
    });
    expect('the contract is maximise · restore · toggle · isMaximised · destroy', c.shape.length === 5, c.shape.join(' '));
    expect('it is mounted on #preview itself', c.isEl, String(c.isEl));
    expect('⛔ and it ADOPTED #btn-pvfull rather than building a second control', c.control, String(c.control));

    // The class the CSS has styled since 0522 is the class the module toggles — on the preview AND
    // on #pvdock, which owns the stacking context and would otherwise leave the maximised surface
    // underneath the settings overlay.
    await pg.evaluate(() => window.__gm.previewViewport().maximise());
    await wait(80);
    const on = await pg.evaluate(() => ({
      pv: document.getElementById('preview').className,
      dock: document.getElementById('pvdock').className,
      hook: window.__gm.fullscreen(),
      api: window.__gm.previewViewport().isMaximised(),
    }));
    expect('maximise() puts the fullscreen class on the preview', /\bfullscreen\b/.test(on.pv), on.pv);
    expect('…and on the dock that owns its stacking context', /\bfullscreen\b/.test(on.dock), on.dock);
    expect('the page flag and the module agree — one state, not two', on.hook === true && on.api === true, JSON.stringify(on));

    await pg.evaluate(() => window.__gm.previewViewport().restore());
    await wait(80);
    const off = await pg.evaluate(() => ({
      pv: document.getElementById('preview').className,
      dock: document.getElementById('pvdock').className,
      hook: window.__gm.fullscreen(),
      open: window.__gm.viewportsOpen(),
    }));
    expect('restore() takes it off both', !/\bfullscreen\b/.test(off.pv) && !/\bfullscreen\b/.test(off.dock), JSON.stringify(off));
    expect('and the layer stack is empty again', off.hook === false && off.open === 0, JSON.stringify(off));

    await pg.close();
  } finally { await browser.close(); await server.close(); }
});
