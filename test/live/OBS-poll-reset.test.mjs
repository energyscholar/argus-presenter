/*
 * OBS-B4 — RUNTIME idempotency: re-opening a poll clears its votes.
 * RED TODAY: openPoll (app/server.mjs:1671-1676) reseeds spec/open but never clears
 * polls/<pid>/votes; tally() counts whatever is in the store. Smoke-test, then dry-run,
 * then play on one server process => every prompt starts pre-voted by simulated clients.
 * Build idempotency was covered by the plan; RUNTIME rerun was not.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';

const PID = 'reset-poll';
const OPTS = [{ label: 'Alpha', value: 'a' }, { label: 'Beta', value: 'b' }];

test('OBS-B4 — re-opening a poll starts with a clean tally', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const voter = await connectUser(browser, server, { userId: 'voter', userName: 'Voter' });
    await until(() => server.presence().some((u) => u.userId === 'voter'), { label: 'voter connected' });

    server.openPoll({ promptId: PID, prompt: 'Pick', options: OPTS, target: 'all' });
    await waitContentFrame(voter);
    await until(async () => {
      const f = contentFrame(voter);
      if (!f) return false;
      try { return await f.evaluate(() => !!document.querySelector('.ap-choice-opt')); } catch { return false; }
    }, { timeout: 8000, label: 'poll rendered' });
    await contentFrame(voter).evaluate(() => document.querySelector('.ap-choice-opt').click());
    await until(() => (server.getPoll(PID).count || 0) > 0, { timeout: 5000, label: 'vote recorded' });

    server.closePoll(PID);
    // Re-open the SAME promptId, as a rehearsal-then-live run would.
    server.openPoll({ promptId: PID, prompt: 'Pick', options: OPTS, target: 'all' });

    const after = server.getPoll(PID);
    expect('a re-opened poll has no carried-over votes', (after.count || 0) === 0,
      'count=' + after.count + ' votes=' + JSON.stringify(after.votes));
  } finally { await browser.close(); await server.close(); }
});
