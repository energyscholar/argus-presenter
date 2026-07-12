/*
 * I1 — content-module display: a presenter steps a 3-beat module (via MCP/present_
 * module + next_beat); a viewer follows in lockstep and the module/current advances.
 */
import { test, expect } from '../../harness/test.mjs';
import { toolMap, _server } from '../../mcp/tools.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';

const beatText = async (server, page) => { const f = contentFrame(page); if (!f) return null; return f.evaluate(() => document.body.textContent).catch(() => null); };

test('I1 — step a 3-beat module; viewer advances in lockstep', async () => {
  const T = toolMap();
  await T.presenter_start.handler({ port: 0 });
  const server = _server();
  const browser = await launch();
  try {
    const viewer = await connectUser(browser, server, { userId: 'v1', userName: 'V' });
    await until(() => server.presence().length === 1, { label: '1 connected' });

    const beats = [
      { component: 'card', opts: { title: 'Beat One' } },
      { component: 'card', opts: { title: 'Beat Two' } },
      { component: 'card', opts: { title: 'Beat Three' } },
    ];
    await T.present_module.handler({ title: 'Deck', beats });
    await waitContentFrame(viewer);
    await until(async () => /Beat One/.test((await beatText(server, viewer)) || ''), { label: 'beat 1 shown', timeout: 5000 });
    expect(server.store.get('module/current') === 0, 'module/current = 0');

    await T.next_beat.handler({});
    await until(async () => /Beat Two/.test((await beatText(server, viewer)) || ''), { label: 'beat 2 shown', timeout: 5000 });
    expect(server.store.get('module/current') === 1, 'module/current = 1');

    await T.next_beat.handler({});
    await until(async () => /Beat Three/.test((await beatText(server, viewer)) || ''), { label: 'beat 3 shown', timeout: 5000 });
    expect(server.store.get('module/current') === 2, 'module/current = 2');
    expect(server.store.get('module/len') === 3, 'module length recorded');
  } finally { await browser.close(); await T.presenter_stop.handler({}); }
});
