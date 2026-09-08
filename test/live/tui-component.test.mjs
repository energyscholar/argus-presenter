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
      await f.evaluate(() => !!document.querySelector('.ap-tui-log')), 'no .ap-tui-log in the frame');

    /* ⛔ THE BACKLOG. A pane that only shows what arrives after it opens is useless to anyone who
       was not there first. */
    expect('the pane shows traffic written BEFORE it mounted',
      /Weapon system\s+green/.test(await f.evaluate(
        () => document.querySelector('.ap-tui-log').textContent)), 'the backlog never drew');

    /* ⛔⛔ COLUMNS — AND THE STYLESHEET IS ACTUALLY LOADED. `pre-wrap` re-flows a station board and
       destroys the alignment that IS its content. ⚠ MEASURED: asserting only `white-space:pre` and
       a monospace face is VACUOUS — a bare `<pre>` gives both by default, so breaking the component's
       selector entirely still passed. ⇒ assert something ONLY this stylesheet provides. */
    const css = await f.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('.ap-tui-log'));
      return { ws: cs.whiteSpace, mono: /mono|courier/i.test(cs.fontFamily),
        border: cs.borderTopWidth, overflow: cs.overflowY, rows: Math.round(parseFloat(cs.height)) };
    });
    expect('white-space is pre — a wrapped line breaks every column', css.ws === 'pre', `got ${css.ws}`);
    expect('the pane is monospace', css.mono === true, 'the face is not monospace');
    expect('the component stylesheet loaded (its border)', css.border === '1px', `got ${css.border}`);
    expect('the log scrolls rather than growing the page', css.overflow === 'auto', `got ${css.overflow}`);
    expect('and it is sized by its rows opt, not by content',
      css.rows > 120 && css.rows < 400, `height was ${css.rows}px`);

    /* ⭐ AND IT FOLLOWS THE LOG LIVE. */
    server.set('shared/tui/log/00002', { v: 1, kind: 'say', seat: 'pilot', to: null, text: 'thrust 2' });
    await wait(800);
    expect('a line appended after mount reaches the pane',
      /pilot> thrust 2/.test(await f.evaluate(
        () => document.querySelector('.ap-tui-log').textContent)), 'live diffs are not arriving');

    /* ⛔⛔ THE HALF THAT WAS SILENTLY BROKEN, AND ITS CONTRACT HAS CHANGED. The pane used to `op()`
       into `shared/tui/in/<id>`, which the DEMO polls at 250 ms because a demo owns its own store.
       The engine plugin does not: a line is now a MESSAGE (`tui-line`), which is how every other
       panel in that plugin talks to it — no timer, no inbox, and no participant-writable path left
       standing open. This asserts the SERVER received it, never the local echo. */
    const got = [];
    server.on('result', (r) => got.push(r));
    await f.evaluate(() => {
      const i = document.querySelector('.ap-tui-input');
      i.value = 'fire mount=mount-1';
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await wait(800);
    const line = got.find((r) => r && r.type === 'tui-line');
    expect('what was typed reaches the SERVER as a tui-line',
      !!line, `results seen: ${JSON.stringify(got.map((r) => r && r.type))}`);

    /* ⭐ VERBATIM. A client that rewrites a line before sending becomes a second dispatcher. */
    expect('the line arrives exactly as typed',
      line && line.value && line.value.text === 'fire mount=mount-1',
      `got ${JSON.stringify(line && line.value)}`);
    expect('and it names the board it was typed at',
      line && line.value && line.value.seat === 'gunner', `seat was ${line && line.value && line.value.seat}`);

    /* ⛔⛔ IDENTITY IS THE ENVELOPE'S, NEVER THE PAYLOAD'S. A client that could name its own user
       could speak as anyone, so core stamps it one level up and the payload must not carry it. */
    expect('identity is stamped by core, not sent by the client',
      line && line.userId === 'ann' && !(line.value && line.value.userId),
      `envelope userId=${line && line.userId}, payload userId=${line && line.value && line.value.userId}`);

  } finally {
    await browser.close();
    server.close?.();
  }
});

test('tui — a refusal reaches the seat that earned it and NO other seat sees it', async () => {
  /* ⛔⛔ THE MESH CLAUSE, AND ITS LIMIT. The crew must see each other's orders — that is what makes
     a round playable — and must NOT see each other's refusals, which are deliberately instructive
     and therefore exactly what a player least wants published. `trafficFor` puts a `to` on every
     entry for this; before this test nothing ever read it, so every refusal went to the shared log
     and the whole crew watched each other mistype. */
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const gunner = await connectUser(browser, server, { userId: 'g1', userName: 'Gunner' });
    const pilot = await connectUser(browser, server, { userId: 'p1', userName: 'Pilot' });
    await wait(500);
    server.pushPage('all', PAGE, { mounts: MOUNTS, requires: ['tui'], contentId: 'tui-test' });
    await wait(1500);
    const gf = await waitContentFrame(gunner);
    const pf = await waitContentFrame(pilot);

    /* An ORDER: the room's business. */
    server.set('shared/tui/log/00001',
      { v: 1, kind: 'order', seat: 'gunner', to: null, text: 'gunner: A1 fire' });
    /* A REFUSAL: the gunner's alone, on the gunner's own branch. */
    server.set('private/g1/tui/log/00002',
      { v: 1, kind: 'refusal', seat: 'gunner', to: 'gunner', text: '⛔ this ship mounts no weapons' });
    await wait(900);

    const read = (f) => f.evaluate(() => document.querySelector('.ap-tui-log').textContent);
    const seenByGunner = await read(gf);
    const seenByPilot = await read(pf);
    console.log('   DIAG pilot  frame:', await pf.evaluate(() => (window.Argus||{}).state ? JSON.stringify({u:Object.keys(((window.Argus._state||{}).private)||{})}) : 'no-argus'));
    console.log('   DIAG gunner text:', JSON.stringify(seenByGunner));

    expect('the gunner sees the order', /A1 fire/.test(seenByGunner), 'the order never drew');
    expect('the pilot sees it too — the crew coordinate off it', /A1 fire/.test(seenByPilot), 'the mesh is broken');
    expect('the gunner sees their own refusal', /mounts no weapons/.test(seenByGunner), 'a private line never reached its owner');
    /* ⛔ THE ONE THAT MATTERS. Not hidden in the UI — the bytes never reach the other client. */
    expect('the PILOT never sees the gunner refused',
      !/mounts no weapons/.test(seenByPilot), `pilot pane held: ${JSON.stringify(seenByPilot)}`);
  } finally {
    await browser.close();
    server.close?.();
  }
});
