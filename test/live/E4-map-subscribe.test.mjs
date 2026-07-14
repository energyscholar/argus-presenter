/*
 * E4 — the map applies map/* from the store: a late viewer seeds the current view
 * from the snapshot, and peer markers auto-expire client-side.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';
import { WebSocket } from 'ws';

test('E4 — a late viewer seeds the current map view from the snapshot', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    // Presenter action recorded in the store BEFORE the viewer connects.
    server.store.apply({ path: 'map/view', verb: 'set', value: { x: 88, y: 22, scale: 1 } }, { userId: 'gm', role: 'presenter' });
    const viewer = await connectUser(browser, server, { userId: 'v9', userName: 'Late' });
    await until(() => server.presence().length === 1, { label: '1 connected' });
    server.pushComponent('all', 'map', { controllable: false, label: 'Map' });
    const f = await waitContentFrame(viewer);
    await until(async () => (await f.$eval('.ap-map-content', (el) => el.style.transform)) === 'translate(88px, 22px) scale(1)', { label: 'late viewer seeded view', timeout: 5000 });
    const t = await f.$eval('.ap-map-content', (el) => el.style.transform);
    expect('late viewer mirrors the stored view from the snapshot', t === 'translate(88px, 22px) scale(1)', t);
  } finally { await browser.close(); await server.close(); }
});

test('E4 — a peer marker auto-expires client-side (is-fading)', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const viewer = await connectUser(browser, server, { userId: 'w1', userName: 'W' });
    await until(() => server.presence().length === 1, { label: '1 connected' });
    server.pushComponent('all', 'map', { controllable: false });
    const f = await waitContentFrame(viewer);
    await new Promise((r) => setTimeout(r, 300));
    // Inject a marker via an op (broadcasts a diff to the viewer).
    const pres = new WebSocket(server.url().replace('http', 'ws'));
    await new Promise((res) => pres.on('open', () => { pres.send(JSON.stringify({ t: 'hello', userId: 'gm', role: 'presenter' })); res(); }));
    await new Promise((r) => setTimeout(r, 120));
    pres.send(JSON.stringify({ t: 'op', path: 'map/markers', verb: 'add', value: { id: 'x1', px: 0.5, py: 0.5, name: 'X' }, opId: 'e4m' }));
    await until(async () => (await f.$$eval('.ap-map-click', (e) => e.length)) >= 1, { label: 'marker shown', timeout: 5000 });
    // Auto-expire: the marker gains 'is-fading' after ~4s (T5 radar-ping lifetime).
    await until(async () => (await f.$$eval('.ap-map-click.is-fading', (e) => e.length)) >= 1, { label: 'marker fading', timeout: 6500 });
    expect('marker auto-expires (is-fading applied)', true);
  } finally { await browser.close(); await server.close(); }
});
