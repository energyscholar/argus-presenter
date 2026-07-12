/*
 * A7 — server/MCP push_component honors the content's `requires`: a core push
 * loads no plugin; an example push loads the example plugin (city-grid preset).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { toolMap, _server } from '../../mcp/tools.mjs';
import { launch, connectUser, waitContentFrame, contentFrame, until } from '../../harness/multi.mjs';

test('A7 — core push = no plugin; example push = city-grid preset', async () => {
  const T = toolMap();
  await T.presenter_start.handler({ port: 0 });
  const server = _server();
  const browser = await launch();
  try {
    const p = await connectUser(browser, server, { userId: 'u1', userName: 'Alice' });
    await until(() => server.presence().length === 1, { label: '1 connected' });

    // Core push: no requires -> neutral grid, zero blocks.
    await T.push_component.handler({ component: 'map', opts: { controllable: false, label: 'grid' }, target: 'all' });
    await waitContentFrame(p);
    await new Promise((r) => setTimeout(r, 300));
    const coreBlocks = await contentFrame(p).$$eval('.ap-map-block', (els) => els.length).catch(() => -1);
    expect('core push loads NO plugin (0 blocks)', coreBlocks === 0, String(coreBlocks));

    // Plugin push: requires example -> city-grid preset with blocks.
    await T.push_component.handler({ component: 'map', opts: { controllable: false, preset: 'city-grid' }, target: 'all', requires: ['example'] });
    await new Promise((r) => setTimeout(r, 400));
    await until(async () => (await contentFrame(p).$$eval('.ap-map-block', (e) => e.length).catch(() => 0)) === 8, { label: '8 blocks after plugin push', timeout: 5000 });
    const blocks = await contentFrame(p).$$eval('.ap-map-block', (els) => els.length);
    expect('example push loads city-grid preset (8 blocks)', blocks === 8, String(blocks));
  } finally { await browser.close(); await T.presenter_stop.handler({}); }
});
