/*
 * MON-2 — the GM "view-as" thumbnail shows a selected user's ACTUAL current
 * display (via the PRIM-mirror control op), and gracefully degrades: under tab
 * starvation (or a manual toggle) the live iframe is replaced by a same-size
 * "⚠ preview paused" box — the thumbnail is the FIRST thing sacrificed.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, until, wait } from '../../harness/multi.mjs';

test('MON2 — view-as thumbnail renders the target user\'s live display', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    // Give alice a distinct per-user display, then connect her so byUser has the conn.
    server.pushContent('alice', '<b id="who">ALICE-VIEW</b>', 'a1');
    const alice = await connectUser(browser, server, { userId: 'alice', userName: 'Alice' });

    // Open the GM control panel as a presenter.
    const ctl = await browser.newPage();
    await ctl.goto(`${server.url()}/control?userId=gm&name=GM&role=presenter`, { waitUntil: 'domcontentloaded' });
    await ctl.waitForFunction(() => typeof window.__control === 'function');
    await until(() => server.presence().some((u) => u.role === 'presenter'), { label: 'presenter connected' });

    // The panel's user list must carry alice (presence pushed to control roles).
    await until(async () => ctl.evaluate(() => (window.__gm.users() || []).some((u) => u.userId === 'alice')),
      { label: 'gm sees alice in presence', timeout: 6000 });
    await until(async () => ctl.evaluate(() => [...document.querySelectorAll('#users .user')].some((r) => /Alice/.test(r.textContent))),
      { label: 'alice row rendered', timeout: 6000 });

    // Click alice's row → selectView → control(mirror) → thumbnail shows her actual view.
    await ctl.evaluate(() => {
      const row = [...document.querySelectorAll('#users .user')].find((r) => /Alice/.test(r.textContent));
      row.click();
    });
    await until(async () => {
      const s = await ctl.$eval('#pvframe', (el) => el.getAttribute('srcdoc') || '');
      return s.includes('ALICE-VIEW');
    }, { label: 'thumbnail shows ALICE-VIEW', timeout: 6000 });
    const srcdoc = await ctl.$eval('#pvframe', (el) => el.getAttribute('srcdoc') || '');
    expect(srcdoc.includes('ALICE-VIEW'), 'view-as thumbnail carries the target user\'s live display html', srcdoc);

    // --- Graceful degradation: force starved state -> warning box replaces the iframe ---
    await ctl.evaluate(() => window.__gm.degrade(true));
    await wait(50);
    const degraded = await ctl.evaluate(() => {
      const w = document.getElementById('pvwarn');
      const f = document.getElementById('pvframe');
      return {
        warnShown: getComputedStyle(w).display !== 'none',
        warnText: w.textContent,
        frameHidden: getComputedStyle(f).visibility === 'hidden',
      };
    });
    expect(degraded.warnShown && degraded.warnText.includes('preview paused') && degraded.frameHidden,
      'degraded → same-size ⚠ preview paused box replaces the live iframe', JSON.stringify(degraded));

    // Restore -> iframe live again.
    await ctl.evaluate(() => window.__gm.degrade(false));
    await wait(50);
    const restored = await ctl.evaluate(() => ({
      warnHidden: getComputedStyle(document.getElementById('pvwarn')).display === 'none',
      frameShown: getComputedStyle(document.getElementById('pvframe')).visibility !== 'hidden',
    }));
    expect(restored.warnHidden && restored.frameShown, 'clearing degraded restores the live thumbnail', JSON.stringify(restored));

    await ctl.close();
    await alice.close();
  } finally { await browser.close(); await server.close(); }
});
