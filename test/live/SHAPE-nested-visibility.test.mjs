/*
 * SHAPE-A3 — visibility strips RECURSIVELY. A LIVE LEAK today.
 * RED TODAY: stampFor (app/server.mjs:839-843) filters o.items only when the TOP-LEVEL
 * component is `scene`, at depth 1. A nested scene's items live at items[i].opts.items and
 * are never inspected; components/scene/scene.js:22-23 then defaults role=null so sees()
 * passes everything. visibility:'gm' at depth 2 is serialised into a player's srcdoc.
 * Asserted on the WIRE PAYLOAD (srcdoc), not the DOM — the DOM would hide a leak that is
 * still present in the bytes we sent.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, waitContentFrame, until } from '../../harness/multi.mjs';

const SECRET = 'GM-ONLY-CANARY-9f3a';

const NESTED = {
  title: 'Outer', layout: 'stack',
  items: [
    { component: 'card', opts: { title: 'Visible to all' } },
    { component: 'scene', opts: { title: 'Inner', items: [
      { component: 'card', opts: { title: SECRET }, visibility: 'gm' },
      { component: 'card', opts: { title: 'inner-public' } },
    ] } },
  ],
};

const srcdocOf = (page) =>
  page.evaluate(() => { const i = document.querySelector('iframe'); return i ? (i.getAttribute('srcdoc') || '') : ''; });

test('SHAPE-A3 — gm-only content at depth 2 never reaches a participant payload', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const player = await connectUser(browser, server, { userId: 'player', userName: 'Player' });
    await until(() => server.presence().some((u) => u.userId === 'player'), { label: 'player connected' });

    server.pushComponent('all', 'scene', NESTED);
    await waitContentFrame(player);
    await until(async () => (await srcdocOf(player)).length > 0, { label: 'srcdoc present' });

    const doc = await srcdocOf(player);
    expect('depth-1 public content IS delivered', /Visible to all/.test(doc), doc.slice(0, 120));
    expect('depth-2 gm-only content is NOT in the participant payload',
      !doc.includes(SECRET), 'LEAK: canary found in participant srcdoc');
  } finally { await browser.close(); await server.close(); }
});
