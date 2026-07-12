/*
 * C5 — the client page relays a component's op UP to the server and the resulting
 * diff back DOWN into the iframe. End-to-end through the browser (bridge -> page ->
 * server -> store -> broadcast -> page -> iframe subscribeState).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';

test('C5 — component op reaches the store; diff returns into the component', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const alice = await connectUser(browser, server, { userId: 'u1', userName: 'Alice' });
    await until(() => server.presence().length === 1, { label: '1 connected' });

    // Push any assembled component (brings the bridge into the sandboxed frame).
    server.pushComponent('all', 'card', { title: 'Op test' });
    const f = await waitContentFrame(alice);
    await new Promise((r) => setTimeout(r, 300));

    // In the frame: subscribe to diffs, then dispatch a permitted op (map marker add).
    await f.evaluate(() => {
      window.__diffs = [];
      window.Argus.subscribeState('map', (p, v) => window.__diffs.push([p, v]));
      window.Argus.op('map/markers', 'add', { id: 'm1', px: 0.5, py: 0.5 });
    });

    // Server received the op and updated the store.
    await until(() => server.store.get('map/markers/m1') != null, { label: 'store has marker', timeout: 5000 });
    expect('op relayed up: store has the marker', server.store.get('map/markers/m1') != null, JSON.stringify(server.store.get('map/markers')));

    // Diff came back into the component via subscribeState.
    await until(async () => (await f.evaluate(() => window.__diffs.length)) >= 1, { label: 'diff returned', timeout: 5000 });
    const diffs = await f.evaluate(() => window.__diffs);
    expect('diff relayed down: component saw map/markers/m1', diffs.some((d) => d[0] === 'map/markers/m1'), JSON.stringify(diffs));
  } finally { await browser.close(); await server.close(); }
});
