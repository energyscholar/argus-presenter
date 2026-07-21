/*
 * SHAPE-A4 — a duplicate userId must not silently steal content delivery. CORRECTNESS.
 * RED TODAY: byUser.set(c.userId, ws) (app/server.mjs:559) OVERWRITES, so every targeted
 * push and `layers` variant goes to the newcomer while the incumbent SILENTLY stops
 * receiving. No attacker needed: one player opening phone AND laptop does this.
 * END STATE: the collision is handled deliberately and loudly; the incumbent keeps
 * receiving. (Refuse vs multi-socket fan-out is a product decision; silence is not.)
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';

const MARK = 'TARGETED-PAYLOAD-4c1d';
const frameText = async (page) => {
  const f = contentFrame(page);
  if (!f) return '';
  try { return await f.evaluate(() => document.body.textContent || ''); } catch { return ''; }
};

test('SHAPE-A4 — a second socket claiming a live userId does not orphan the first', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const first = await connectUser(browser, server, { userId: 'dup', userName: 'First' });
    await until(() => server.presence().some((u) => u.userId === 'dup'), { label: 'first connected' });

    // BASELINE: prove the incumbent receives targeted content BEFORE any collision.
    server.pushComponent('dup', 'card', { title: 'BASELINE-OK' });
    await waitContentFrame(first);
    await until(async () => (await frameText(first)).includes('BASELINE-OK'),
      { timeout: 6000, label: 'baseline: incumbent receives targeted content' });

    // Now a second socket claims the SAME userId (phone + laptop, or a reconnect race).
    await connectUser(browser, server, { userId: 'dup', userName: 'Second' });
    await new Promise((r) => setTimeout(r, 800));

    server.pushComponent('dup', 'card', { title: MARK });
    let got = false;
    try {
      await until(async () => (await frameText(first)).includes(MARK),
        { timeout: 5000, label: 'incumbent still receives after collision' });
      got = true;
    } catch { got = false; }

    expect('the incumbent connection still receives its targeted content', got,
      got ? 'ok' : 'ORPHANED: after a duplicate userId joined, the first socket stopped receiving');
  } finally { await browser.close(); await server.close(); }
});
