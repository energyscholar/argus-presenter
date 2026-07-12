/*
 * E2 — peer map clicks are store markers: a click writes map/markers/{id} with the
 * clicker's name, visible to peers (store-native, not the relay).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';

test('E2 — a click writes an attributed marker to the store; peer sees it', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const alice = await connectUser(browser, server, { userId: 'a', userName: 'Alice' });
    const bob = await connectUser(browser, server, { userId: 'b', userName: 'Bob' });
    await until(() => server.presence().length === 2, { label: '2 connected' });
    server.pushComponent('all', 'map', { controllable: false, label: 'Map' });
    await waitContentFrame(alice); await waitContentFrame(bob);
    await new Promise((r) => setTimeout(r, 300));

    await contentFrame(alice).$eval('.ap-map-viewport', (el) => {
      const r = el.getBoundingClientRect();
      const o = { clientX: r.left + 140, clientY: r.top + 100, bubbles: true };
      el.dispatchEvent(new MouseEvent('mousedown', o));
      el.dispatchEvent(new MouseEvent('click', o));
    });

    await until(() => { const m = server.store.get('map/markers'); return m && Object.keys(m).length >= 1; }, { label: 'marker in store', timeout: 5000 });
    const markers = server.store.get('map/markers');
    const vals = Object.values(markers);
    expect('marker stored with clicker name', vals.some((v) => v.name === 'Alice'), JSON.stringify(vals));

    const nameIn = async (page) => contentFrame(page).$eval('.ap-map-click-name', (el) => el.textContent).catch(() => null);
    await until(async () => (await nameIn(bob)) === 'Alice', { label: 'Bob sees Alice marker', timeout: 5000 });
    expect('peer sees the attributed marker', (await nameIn(bob)) === 'Alice', String(await nameIn(bob)));
  } finally { await browser.close(); await server.close(); }
});
