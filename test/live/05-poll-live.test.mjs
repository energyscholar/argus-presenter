// Rep 05 — END-TO-END LIVE POLL: participants vote; presenter watches tally update.
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, frameClick, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';

test('rep 05 — live poll: presenter results update as participants vote', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const parts = [];
    for (const [id, name] of [['u1', 'Alice'], ['u2', 'Bob'], ['u3', 'Cara']]) parts.push(await connectUser(browser, server, { userId: id, userName: name }));
    const presenter = await connectUser(browser, server, { userId: 'gm', userName: 'GM', role: 'presenter' });
    await until(() => server.presence().length === 4 && server.presence().some((u) => u.role === 'presenter'),
      { label: '4 connected incl presenter role' });

    server.openPoll({
      promptId: 'p', prompt: 'Ship it?',
      options: [{ label: 'Yes', value: 'yes', style: 'ok' }, { label: 'No', value: 'no', style: 'danger' }],
      target: 'participant', resultsTarget: 'presenter'
    });
    await waitContentFrame(presenter);
    await new Promise((r) => setTimeout(r, 400));

    await frameClick(parts[0], '[data-value="yes"]');
    await frameClick(parts[1], '[data-value="yes"]');
    await frameClick(parts[2], '[data-value="no"]');

    const readCounts = async () => {
      const f = contentFrame(presenter);
      if (!f) return null;
      try {
        return await f.$eval('.ap-pollresults', (el) => {
          const c = {}; el.querySelectorAll('.ap-pr-count[data-value]').forEach((x) => { c[x.getAttribute('data-value')] = x.textContent; });
          return { c, total: el.querySelector('.ap-pr-total').textContent };
        });
      } catch (e) { return null; }
    };
    await until(async () => { const r = await readCounts(); return r && r.c.yes === '2' && r.c.no === '1'; }, { label: 'presenter shows 2/1', timeout: 6000 });
    const r = await readCounts();
    expect('presenter results yes=2', r.c.yes === '2', JSON.stringify(r));
    expect('presenter results no=1', r.c.no === '1', JSON.stringify(r));
    expect('presenter total 3 votes', /3 votes/.test(r.total), r.total);
  } finally { await browser.close(); await server.close(); }
});
