/*
 * THE TUI PANE, IN A REAL BROWSER.
 *
 * ⛔⛔ WHY THIS EXISTS, AND IT IS NOT A FORMALITY. The store round trip behind this component was
 *   proved headlessly and pronounced done while the component itself had NEVER BEEN EXECUTED.
 *   Opening it once found four defects, every one of them SILENT: a multi-line HTML comment that
 *   killed the page's scripts, a mount scripted in the page instead of declared server-side, an
 *   `add` on a shared collection that lands nowhere and reports nothing, and a snapshot arriving
 *   after mount so a seat joining a round saw an empty console. Plus a fifth introduced while
 *   fixing them — `window.Argus` captured at mount time, so every typed line was dropped while the
 *   local echo still drew.
 *
 * ⇒ NOT ONE would have been caught by a store-level test. The estate this work replaces died with
 *   its interactive layer covered by source-greps; this file is the refusal to repeat that.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, waitContentFrame } from '../../harness/multi.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = '<div class="tui-demo"><div id="m-tui"></div></div>';
const MOUNTS = [{ at: '#m-tui', component: 'tui',
  opts: { seat: 'gunner', log: 'shared/tui/log', input: 'shared/tui/in', rows: 12 } }];

test('tui — the pane mounts, shows the backlog, follows the log, and sends what is typed', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const p = await connectUser(browser, server, { userId: 'ann', userName: 'Ann' });
    await wait(400);

    /* ⭐ WRITTEN BEFORE THE PAGE IS PUSHED, deliberately: this is the seat that joins a round already
       in progress, and the case that was broken. */
    server.set('shared/tui/log/00001', { v: 1, kind: 'render', to: null,
      text: 'GUNNER · patrol-corvette\n  Weapon system           green' });
    server.pushPage('all', PAGE, { mounts: MOUNTS, requires: ['tui'], contentId: 'tui-test' });
    await wait(1500);
    const f = await waitContentFrame(p);

    expect('the component mounts at all',
      await f.evaluate(() => !!document.querySelector('.ap-tui-log')), true);

    /* ⛔ THE BACKLOG. A pane that only shows what arrives after it opens is useless to anyone who
       was not there first. */
    expect('the pane shows traffic written BEFORE it mounted',
      /Weapon system\s+green/.test(await f.evaluate(
        () => document.querySelector('.ap-tui-log').textContent)), true);

    /* ⛔⛔ COLUMNS — AND THE STYLESHEET IS ACTUALLY LOADED. `pre-wrap` re-flows a station board and
       destroys the alignment that IS its content. ⚠ MEASURED: asserting only `white-space:pre` and
       a monospace face is VACUOUS — a bare `<pre>` gives both by default, so breaking the component's
       selector entirely still passed. ⇒ assert something ONLY this stylesheet provides. */
    const css = await f.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('.ap-tui-log'));
      return { ws: cs.whiteSpace, mono: /mono|courier/i.test(cs.fontFamily),
        border: cs.borderTopWidth, overflow: cs.overflowY, rows: Math.round(parseFloat(cs.height)) };
    });
    expect('white-space is pre — a wrapped line breaks every column', css.ws, 'pre');
    expect('the pane is monospace', css.mono, true);
    expect('the component stylesheet loaded (its border)', css.border, '1px');
    expect('the log scrolls rather than growing the page', css.overflow, 'auto');
    expect('and it is sized by its rows opt, not by content',
      css.rows > 120 && css.rows < 400, true);

    /* ⭐ AND IT FOLLOWS THE LOG LIVE. */
    server.set('shared/tui/log/00002', { v: 1, kind: 'say', seat: 'pilot', to: null, text: 'thrust 2' });
    await wait(800);
    expect('a line appended after mount reaches the pane',
      /pilot> thrust 2/.test(await f.evaluate(
        () => document.querySelector('.ap-tui-log').textContent)), true);

    /* ⛔⛔ THE HALF THAT WAS SILENTLY BROKEN. An `add` on the collection landed nowhere and said
       nothing, while the local echo still drew — a console that looks like it works and sends
       nothing. This asserts the STORE, never the echo. */
    await f.evaluate(() => {
      const i = document.querySelector('.ap-tui-input');
      i.value = 'fire mount=mount-1';
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await wait(800);
    const sent = Object.values(server.store.get('shared/tui/in') || {}).map((v) => v && v.text);
    expect(`what was typed reaches the STORE (got ${JSON.stringify(sent)})`,
      sent.includes('fire mount=mount-1'), true);

    /* ⭐ VERBATIM. A client that rewrites a line before sending becomes a second dispatcher. */
    const entry = Object.values(server.store.get('shared/tui/in') || {})
      .find((v) => v && v.text === 'fire mount=mount-1');
    expect('the line carries the seat that typed it', entry.seat, 'gunner');
    expect('and an id, so the server echo can be reconciled', typeof entry.id, 'string');
  } finally {
    await browser.close();
    server.close?.();
  }
});
