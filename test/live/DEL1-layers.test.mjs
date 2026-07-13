/*
 * DEL-1 — per-user layer delivery. A beat may carry `layers:[{target, opts}]`; when the
 * beat is shown, each targeted layer OVERRIDES the base opts for its user (layer opts win).
 * Base pushes to 'all'; the layered target additionally receives the merged override.
 * Here: alice sees the ALICE-LAYER title, bob sees the BASE title.
 *
 * NB: the layer push REPLACES alice's content iframe, so we never hold a Frame handle —
 * we re-query contentFrame(page) on every read and swallow detach/navigation errors.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';

const MODULE = {
  title: 't',
  beats: [
    { id: 'b', component: 'card', target: 'all', promptId: 'b',
      opts: { title: 'BASE' },
      layers: [{ target: 'alice', opts: { title: 'ALICE-LAYER' } }] },
  ],
};

// Fresh frame + text each call; survive a frame swap mid-read.
const frameText = async (page) => {
  const f = contentFrame(page);
  if (!f) return '';
  try { return await f.evaluate(() => document.body.textContent); } catch { return ''; }
};

test('DEL1 — a targeted layer overrides base opts for its user only', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    server.setModule(MODULE);

    const alice = await connectUser(browser, server, { userId: 'alice', userName: 'Alice' });
    const bob = await connectUser(browser, server, { userId: 'bob', userName: 'Bob' });
    await until(() => {
      const ids = server.presence().map((u) => u.userId);
      return ids.includes('alice') && ids.includes('bob');
    }, { label: 'alice and bob registered (hello received)' });

    server.showBeat(0);
    await waitContentFrame(alice); await waitContentFrame(bob);

    // Alice: layer wins — ALICE-LAYER present (and, once settled, BASE absent).
    await until(async () => /ALICE-LAYER/.test(await frameText(alice)), { label: 'alice sees ALICE-LAYER' });
    // Bob: base only.
    await until(async () => /BASE/.test(await frameText(bob)), { label: 'bob sees BASE' });

    await new Promise((r) => setTimeout(r, 300));   // let alice's final (layer) render settle

    const aText = await frameText(alice);
    expect('alice content contains ALICE-LAYER', /ALICE-LAYER/.test(aText), aText.slice(0, 80));
    expect('alice content does NOT contain BASE', !/BASE/.test(aText), aText.slice(0, 80));

    const bText = await frameText(bob);
    expect('bob content contains BASE', /BASE/.test(bText), bText.slice(0, 80));
    expect('bob content does NOT contain ALICE-LAYER', !/ALICE-LAYER/.test(bText), bText.slice(0, 80));
  } finally { await browser.close(); await server.close(); }
});
