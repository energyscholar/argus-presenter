/*
 * E3 — map pointer/laser is a store-native ephemeral op: a presenter's
 * map/pointer/{self} set shows on a viewer's map (coalesced, not logged).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';
import { WebSocket } from 'ws';

test('E3 — presenter pointer op shows on a viewer; pointer op is not logged', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const viewer = await connectUser(browser, server, { userId: 'v1', userName: 'Viewer' });
    await until(() => server.presence().length === 1, { label: '1 connected' });
    server.pushComponent('all', 'map', { controllable: false, label: 'Map' });
    const f = await waitContentFrame(viewer);
    await new Promise((r) => setTimeout(r, 300));

    const beforeVer = server.store.version();
    const pres = new WebSocket(server.url().replace('http', 'ws'));
    await new Promise((res) => pres.on('open', () => { pres.send(JSON.stringify({ t: 'hello', userId: 'gm', role: 'presenter' })); res(); }));
    await new Promise((r) => setTimeout(r, 120));
    pres.send(JSON.stringify({ t: 'op', path: 'map/pointer/gm', verb: 'set', value: { px: 0.5, py: 0.4 } }));

    await until(async () => (await f.$eval('.ap-map-pointer', (el) => el.style.display)) === 'block', { label: 'pointer visible', timeout: 5000 });
    const disp = await f.$eval('.ap-map-pointer', (el) => el.style.display);
    expect('viewer shows the presenter pointer', disp === 'block', disp);
    expect('pointer op did not grow the durable version (ephemeral)', server.store.version() === beforeVer, String(server.store.version()));
    pres.close();
  } finally { await browser.close(); await server.close(); }
});
