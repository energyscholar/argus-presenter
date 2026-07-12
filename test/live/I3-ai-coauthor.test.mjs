/*
 * I3 — AI co-author: the AI appends a beat to the SAME module a human is editing;
 * the human displays the merged module.
 */
import { test, expect } from '../../harness/test.mjs';
import { toolMap, _server } from '../../mcp/tools.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';

test('I3 — AI appends a beat; human displays the merged module', async () => {
  const T = toolMap();
  await T.presenter_start.handler({ port: 0 });
  const server = _server();
  const browser = await launch();
  try {
    server.appendBeat({ component: 'narration', opts: { text: 'Human-authored intro' } });   // human
    await T.append_beat.handler({ beat: { component: 'card', opts: { title: 'AI-added beat' } } });   // AI co-author
    expect(server.getModule().beats.length === 2, 'human + AI beats merged', String(server.getModule().beats.length));

    server.showBeat(1);   // human displays the AI's beat
    const viewer = await connectUser(browser, server, { userId: 'v', userName: 'V' });
    const f = await waitContentFrame(viewer);
    await until(async () => /AI-added beat/.test(await f.evaluate(() => document.body.textContent)), { label: 'AI beat displays', timeout: 5000 });
    expect(/AI-added beat/.test(await f.evaluate(() => document.body.textContent)), 'the AI-added beat displays in the merged module');
  } finally { await browser.close(); await T.presenter_stop.handler({}); }
});
