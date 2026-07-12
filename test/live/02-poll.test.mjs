// Rep 02 — POLL (multi-user aggregation, live over the greenfield server).
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, frameClick, wait, until } from '../../harness/multi.mjs';

test('rep 02 — poll: 5-user aggregation, change-of-mind LWW, close guard', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const users = [['u1', 'Alice'], ['u2', 'Bob'], ['u3', 'Cara'], ['u4', 'Dan'], ['u5', 'Eve']];
    const pages = [];
    for (const [userId, userName] of users) pages.push(await connectUser(browser, server, { userId, userName }));
    await until(() => server.presence().filter((u) => u.role === 'participant').length === 5, { label: '5 participants' });
    expect('5 participants connected', server.presence().length === 5);

    const options = [{ label: 'Yes', value: 'yes', style: 'ok' }, { label: 'No', value: 'no', style: 'danger' }];
    server.openPoll({ promptId: 'poll1', prompt: 'Ship it?', options, target: 'participant' });

    const votes = ['yes', 'yes', 'yes', 'no', 'no'];
    for (let i = 0; i < pages.length; i++) await frameClick(pages[i], `[data-value="${votes[i]}"]`);
    await until(() => server.getPoll('poll1').count === 5, { label: '5 votes' });
    let res = server.getPoll('poll1');
    expect('tally yes=3', res.tally.yes === 3, JSON.stringify(res.tally));
    expect('tally no=2', res.tally.no === 2, JSON.stringify(res.tally));

    await frameClick(pages[3], '[data-value="yes"]');
    await until(() => server.getPoll('poll1').tally.yes === 4, { label: 'flip yes=4' });
    res = server.getPoll('poll1');
    expect('after flip yes=4', res.tally.yes === 4, JSON.stringify(res.tally));
    expect('after flip no=1', res.tally.no === 1, JSON.stringify(res.tally));
    expect('count still 5', res.count === 5);

    server.closePoll('poll1');
    await frameClick(pages[0], '[data-value="no"]').catch(() => {});
    await wait(250);
    expect('vote after close ignored', server.getPoll('poll1').count === 5);
    expect('tally unchanged after close', server.getPoll('poll1').tally.yes === 4);
  } finally { await browser.close(); await server.close(); }
});
