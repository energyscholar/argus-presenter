// Rep 07 — MCP TOOL SURFACE: drive the whole presenter through mcp/tools handlers.
import { test, check as expect } from '../../harness/test.mjs';
import { toolMap, _server } from '../../mcp/tools.mjs';
import { launch, connectUser, frameClick, until } from '../../harness/multi.mjs';

test('rep 07 — mcp surface drives a full poll + push + reload + close', async () => {
  const T = toolMap();
  const started = await T.presenter_start.handler({ port: 0 });
  expect('presenter_start returns url', /^http:\/\//.test(started.url), started.url);
  const server = _server();
  const browser = await launch();
  try {
    const p1 = await connectUser(browser, server, { userId: 'u1', userName: 'Alice' });
    const p2 = await connectUser(browser, server, { userId: 'u2', userName: 'Bob' });
    await connectUser(browser, server, { userId: 'gm', userName: 'GM', role: 'presenter' });
    await until(() => server.presence().length === 3 && server.presence().some((u) => u.role === 'presenter'),
      { label: '3 connected incl presenter role' });

    const st = await T.presenter_status.handler({});
    expect('presenter_status shows 3 users', st.presence.length === 3, JSON.stringify(st.presence));

    await T.open_poll.handler({
      promptId: 'mp', prompt: 'MCP poll?',
      options: [{ label: 'A', value: 'a', style: 'ok' }, { label: 'B', value: 'b', style: 'danger' }],
      target: 'participant', resultsTarget: 'presenter'
    });
    await frameClick(p1, '[data-value="a"]');
    await frameClick(p2, '[data-value="a"]');
    await until(async () => (await T.get_poll.handler({ promptId: 'mp' })).count === 2, { label: '2 votes via MCP' });
    const poll = await T.get_poll.handler({ promptId: 'mp' });
    expect('MCP get_poll tally a=2', poll.tally.a === 2, JSON.stringify(poll.tally));

    const pushed = await T.push_component.handler({ component: 'text-input', opts: { prompt: 'Name?', promptId: 'nm' }, target: 'u1' });
    expect('push_component reached 1 channel', pushed.pushed === 1, JSON.stringify(pushed));

    const rel = await T.reload_clients.handler({ target: 'all', delay: 99999 });
    expect('reload_clients reached 3', rel.reloaded === 3, JSON.stringify(rel));
    const closed = await T.close_poll.handler({ promptId: 'mp' });
    expect('close_poll returns final tally a=2', closed.tally.a === 2, JSON.stringify(closed.tally));
  } finally { await browser.close(); await T.presenter_stop.handler({}); }
});
