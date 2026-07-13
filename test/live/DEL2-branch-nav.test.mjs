/*
 * DEL-2 — branch-table navigation in the GM panel. When a player answers the CURRENT
 * beat, the panel uses the shared resolveNext (served /branch.mjs, imported by the
 * control page) to recommend/auto-advance to the next beat. With auto-follow ON, a
 * 'right' answer on the choice beat 'q' advances the panel to beat 'b' (index 2).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, frameClick, until, wait } from '../../harness/multi.mjs';

const MODULE = {
  title: 'Branch demo',
  beats: [
    { id: 'q', component: 'choice', promptId: 'q',
      opts: { prompt: '?', options: [{ label: 'L', value: 'left' }, { label: 'R', value: 'right' }] },
      branch: { left: 'a', right: 'b' } },
    { id: 'a', component: 'card', opts: { title: 'A' } },
    { id: 'b', component: 'card', opts: { title: 'B' } },
  ],
};

test('DEL2 — auto-follow advances the panel via the branch table (right → beat b)', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    // Server-side module (so showBeat by id resolves 'b' -> index 2).
    server.setModule(MODULE);

    // Participant page (answers the choice) + GM control page.
    const part = await connectUser(browser, server, { userId: 'u1', userName: 'U1' });
    const ctl = await browser.newPage();
    await ctl.goto(`${server.url()}/control?userId=gm&role=presenter`, { waitUntil: 'domcontentloaded' });
    await ctl.waitForFunction(() => typeof window.__control === 'function' && window.__gm && typeof window.__gm.setModule === 'function');
    await until(() => server.presence().some((u) => u.role === 'presenter'), { label: 'presenter connected' });

    // Load the SAME module into the panel (so it holds the branch table) + arm auto-follow.
    await ctl.evaluate((m) => window.__gm.setModule(m), MODULE);
    await ctl.click('#autofollow');
    expect('auto-follow checkbox is ON', await ctl.$eval('#autofollow', (el) => el.checked));

    // Show beat 0 (the choice); wait for the panel to register curBeat=0 via the module/current diff.
    server.showBeat(0);
    await until(async () => (await ctl.evaluate(() => window.__gm.cur())) === 0, { label: 'panel curBeat=0' });

    // Participant answers 'right' -> resolveNext -> branch.right='b'.
    await frameClick(part, '[data-value="right"]');

    // Panel auto-advanced to beat 'b' (index 2): server module/current AND panel curBeat.
    await until(() => server.store.get('module/current') === 2, { label: 'server advanced to beat b (index 2)', timeout: 6000 });
    expect('server module/current === 2 (beat b)', server.store.get('module/current') === 2, String(server.store.get('module/current')));
    await until(async () => (await ctl.evaluate(() => window.__gm.cur())) === 2, { label: 'panel curBeat=2' });
    expect('panel curBeat === 2 (beat b)', (await ctl.evaluate(() => window.__gm.cur())) === 2);

    await ctl.close();
  } finally { await browser.close(); await server.close(); }
});
