/*
 * I4 — save/load: a content module is portable — save it, load it in a FRESH
 * session, and display it.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, waitContentFrame, until } from '../../harness/multi.mjs';

test('I4 — save a module, reload it in a fresh session, display it', async () => {
  // Session 1: build + save (a portable JSON snapshot).
  const s1 = await createServer({ port: 0 });
  s1.setModule({ title: 'Onboarding', beats: [{ component: 'card', opts: { title: 'Saved & reloaded' } }, { component: 'narration', opts: { text: 'second beat' } }] });
  const saved = JSON.parse(JSON.stringify(s1.getModule()));   // serialise (portable)
  await s1.close();
  expect(saved.beats.length === 2 && saved.title === 'Onboarding', 'module saved as portable JSON', JSON.stringify(saved).slice(0, 60));

  // Session 2: fresh server, load, display.
  const s2 = await createServer({ port: 0 });
  const browser = await launch();
  try {
    s2.loadModule(saved);
    expect(s2.getModule().beats.length === 2, 'module reloaded in a fresh session');
    s2.showBeat(0);
    const viewer = await connectUser(browser, s2, { userId: 'v', userName: 'V' });
    const f = await waitContentFrame(viewer);
    await until(async () => /Saved & reloaded/.test(await f.evaluate(() => document.body.textContent)), { label: 'reloaded module displays', timeout: 5000 });
    expect(/Saved & reloaded/.test(await f.evaluate(() => document.body.textContent)), 'the reloaded module displays');
  } finally { await browser.close(); await s2.close(); }
});
