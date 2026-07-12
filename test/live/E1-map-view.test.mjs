/*
 * E1 — map view is store-native: a presenter's map/view op mirrors to all viewers.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';
import { WebSocket } from 'ws';

test('E1 — map/view op mirrors the presenter pan/zoom to a viewer', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const viewer = await connectUser(browser, server, { userId: 'v1', userName: 'Viewer' });
    await until(() => server.presence().length === 1, { label: '1 connected' });
    server.pushComponent('all', 'map', { controllable: false, label: 'Map' });
    const f = await waitContentFrame(viewer);
    await new Promise((r) => setTimeout(r, 300));

    // A presenter (raw ws, controller) sets the view via the op protocol.
    const pres = new WebSocket(server.url().replace('http', 'ws'));
    await new Promise((res) => pres.on('open', () => { pres.send(JSON.stringify({ t: 'hello', userId: 'gm', role: 'presenter' })); res(); }));
    await new Promise((r) => setTimeout(r, 120));
    pres.send(JSON.stringify({ t: 'op', path: 'map/view', verb: 'set', value: { x: 120, y: 40, scale: 1 }, opId: 'e1' }));

    await until(async () => (await f.$eval('.ap-map-content', (el) => el.style.transform)) === 'translate(120px, 40px) scale(1)', { label: 'viewer mirrors view', timeout: 5000 });
    const t = await f.$eval('.ap-map-content', (el) => el.style.transform);
    expect('viewer content transform mirrors presenter view', t === 'translate(120px, 40px) scale(1)', t);
    pres.close();
  } finally { await browser.close(); await server.close(); }
});
