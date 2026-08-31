// Rep 14 — MAP peer-to-peer click (the RAF mechanic): Alice clicks; Bob sees "Alice".
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';

test('rep 14 — map: peer-to-peer named click (user -> all)', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const alice = await connectUser(browser, server, { userId: 'a', userName: 'Alice' });
    const bob = await connectUser(browser, server, { userId: 'b', userName: 'Bob' });
    await until(() => server.presence().length === 2, { label: '2 connected' });

    server.pushComponent('all', 'map', { controllable: false, label: 'Solar System' });
    await waitContentFrame(alice); await waitContentFrame(bob);
    await new Promise((r) => setTimeout(r, 400));

    /* ⚠ SPEC CHANGE, plan 0720 RUN A / F4: a viewer's own taps no longer ping by default — the
       toggle is per viewer and starts OFF, so five people prodding a shared board do not carpet it.
       Alice turning HERS on is what a player does when they mean to point at something, and it is
       the only line added here: every assertion below is unchanged and still fails if the
       peer-to-peer mechanism breaks. Bob's toggle stays off throughout and he must still SEE it —
       the setting gates your taps, never your eyes. */
    await contentFrame(alice).evaluate(() => window.ApMapPing.set(true));

    await contentFrame(alice).$eval('.ap-map-viewport', (el) => {
      const r = el.getBoundingClientRect();
      const o = { clientX: r.left + 140, clientY: r.top + 100, bubbles: true };
      el.dispatchEvent(new MouseEvent('mousedown', o));
      el.dispatchEvent(new MouseEvent('click', o));
    });

    const nameIn = async (page) => contentFrame(page).$eval('.ap-map-click-name', (el) => el.textContent).catch(() => null);
    await until(async () => (await nameIn(bob)) === 'Alice', { label: "Bob sees Alice's click", timeout: 5000 });

    expect("Bob sees Alice's named click (peer-to-peer)", (await nameIn(bob)) === 'Alice', String(await nameIn(bob)));
    expect('Alice sees her own click echoed', (await nameIn(alice)) === 'Alice', String(await nameIn(alice)));
  } finally { await browser.close(); await server.close(); }
});
