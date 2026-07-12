/*
 * B2 (F1 fix) — a component mounted AFTER votes already arrived must seed from
 * CURRENT state. Sequence: open poll -> participant votes -> THEN push poll-results
 * to the presenter. The presenter's retained snapshot is kept live by merging diffs,
 * so the late-mounted poll-results shows the real tally (1), not a stale 0.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, frameClick, contentFrame, waitContentFrame, until, wait } from '../../harness/multi.mjs';

test('B2 — poll-results pushed after a vote seeds the real tally (not 0)', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const voter = await connectUser(browser, server, { userId: 'u1', userName: 'Alice' });
    const presenter = await connectUser(browser, server, { userId: 'gm', userName: 'GM', role: 'presenter' });
    await until(() => server.presence().length === 2 && server.presence().some((u) => u.role === 'presenter'), { label: '2 connected incl presenter' });

    // Open poll to the participant ONLY (presenter has no poll-results yet).
    server.openPoll({ promptId: 'lp', prompt: 'Ship it?', options: [{ label: 'Yes', value: 'yes', style: 'ok' }, { label: 'No', value: 'no', style: 'danger' }], target: 'participant' });
    await waitContentFrame(voter);
    await wait(300);

    // Vote — the vote flows to the presenter as a DIFF (not a fresh snapshot).
    await frameClick(voter, '[data-value="yes"]');
    await until(() => server.getPoll('lp').count === 1, { label: 'server recorded 1 vote' });
    await wait(200);

    // NOW push poll-results to the presenter: it mounts late and must seed the vote.
    server.pushComponent('presenter', 'poll-results', { prompt: 'Ship it?', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }], promptId: 'lp' });
    await waitContentFrame(presenter);

    const read = async () => {
      const f = contentFrame(presenter);
      if (!f) return null;
      try {
        return await f.$eval('.ap-pollresults', (el) => {
          const c = {}; el.querySelectorAll('.ap-pr-count[data-value]').forEach((x) => { c[x.getAttribute('data-value')] = x.textContent; });
          return { c, total: el.querySelector('.ap-pr-total').textContent };
        });
      } catch (e) { return null; }
    };
    await until(async () => { const r = await read(); return r && r.c.yes === '1'; }, { label: 'late poll-results shows yes=1', timeout: 5000 });
    const r = await read();
    expect('late-mounted poll-results shows yes=1 (seeded from live state)', r && r.c.yes === '1', JSON.stringify(r));
    expect('total shows 1 vote', r && /1 vote/.test(r.total), JSON.stringify(r));
  } finally { await browser.close(); await server.close(); }
});
