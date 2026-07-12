// Rep 13 — CONTENT VISIBILITY (OPSEC tag+guard): GM-only scene item stripped from player.
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';

test('rep 13 — visibility: GM-only content stripped from player channel', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const player = await connectUser(browser, server, { userId: 'p1', userName: 'Player' });
    const gm = await connectUser(browser, server, { userId: 'gm', userName: 'GM', role: 'presenter' });
    // Wait for BOTH hellos to register their ROLES (not just TCP connect) — the push
    // must see role=presenter, else the gm-only item is stripped from the GM too.
    await until(() => server.presence().length === 2 && server.presence().some((u) => u.role === 'presenter'),
      { label: '2 connected incl presenter role' });

    const scene = {
      layout: 'stack',
      items: [
        { component: 'narration', opts: { text: 'Public intel: the bay is quiet.', promptId: 'pub' } },
        { component: 'card', visibility: 'gm', opts: { title: 'GM secret', body: 'The dockhand is an informant.', promptId: 'sec' } }
      ]
    };
    server.pushComponent('all', 'scene', scene);
    await waitContentFrame(player); await waitContentFrame(gm);
    await new Promise((r) => setTimeout(r, 400));

    const playerText = await contentFrame(player).evaluate(() => document.body.textContent);
    const gmText = await contentFrame(gm).evaluate(() => document.body.textContent);

    expect('player sees public intel', /Public intel/.test(playerText), playerText.slice(0, 80));
    expect('player does NOT see GM secret', !/GM secret/.test(playerText), 'LEAK: ' + playerText.slice(0, 140));
    expect('GM sees public intel', /Public intel/.test(gmText));
    expect('GM sees GM secret', /GM secret/.test(gmText), gmText.slice(0, 140));
  } finally { await browser.close(); await server.close(); }
});
