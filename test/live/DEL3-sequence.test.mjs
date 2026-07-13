/*
 * DEL-3 — sequence-level navigation in the GM panel outline. A section may carry a
 * `sequences:[{id,title,beatIds:[...]}]` array (the Sequence tier between Section and Beat).
 * renderOutline renders it as a nested .seq accordion under the section .sec, with the
 * section's beats split across sequences. Sections WITHOUT sequences render beats directly.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until } from '../../harness/multi.mjs';

const SEQ_MODULE = {
  title: 'Seq demo',
  sections: [{ id: 's', title: 'S', sequences: [
    { id: 'q1', title: 'Seq1', beatIds: ['a', 'b'] },
    { id: 'q2', title: 'Seq2', beatIds: ['c'] },
  ] }],
  beats: [
    { id: 'a', component: 'card', opts: { title: 'A' } },
    { id: 'b', component: 'card', opts: { title: 'B' } },
    { id: 'c', component: 'card', opts: { title: 'C' } },
  ],
};

const PLAIN_MODULE = {
  title: 'Plain demo',
  sections: [{ id: 's', title: 'S', beatIds: ['a', 'b'] }],
  beats: [
    { id: 'a', component: 'card', opts: { title: 'A' } },
    { id: 'b', component: 'card', opts: { title: 'B' } },
  ],
};

async function openPanel(browser, server) {
  const ctl = await browser.newPage();
  await ctl.goto(`${server.url()}/control?userId=gm&role=presenter`, { waitUntil: 'domcontentloaded' });
  await ctl.waitForFunction(() => window.__gm && typeof window.__gm.setModule === 'function');
  await until(() => server.presence().some((u) => u.role === 'presenter'), { label: 'presenter connected' });
  return ctl;
}

test('DEL3 — a section with sequences renders a nested .seq tier with all beats split across sequences', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const ctl = await openPanel(browser, server);
    await ctl.evaluate((m) => window.__gm.setModule(m), SEQ_MODULE);

    const seqCount = await ctl.$eval('#outline', (el) => el.querySelectorAll('.seq').length);
    expect('two nested .seq elements under the section', seqCount === 2, String(seqCount));

    const seqBeats = await ctl.$eval('#outline', (el) => el.querySelectorAll('.seq .beat').length);
    expect('three .beat rows total across the sequences', seqBeats === 3, String(seqBeats));

    // Each sequence holds the right beat count (Seq1=2, Seq2=1).
    const perSeq = await ctl.$eval('#outline', (el) =>
      [...el.querySelectorAll('.seq')].map((q) => q.querySelectorAll('.beat').length));
    expect('sequence beat split is [2,1]', JSON.stringify(perSeq) === JSON.stringify([2, 1]), JSON.stringify(perSeq));

    await ctl.close();
  } finally { await browser.close(); await server.close(); }
});

test('DEL3 — a plain section (no sequences) still renders beats directly (no .seq)', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const ctl = await openPanel(browser, server);
    await ctl.evaluate((m) => window.__gm.setModule(m), PLAIN_MODULE);

    const seqCount = await ctl.$eval('#outline', (el) => el.querySelectorAll('.seq').length);
    expect('no .seq elements for a plain section', seqCount === 0, String(seqCount));

    const directBeats = await ctl.$eval('#outline', (el) => el.querySelectorAll('.sec > .beat').length);
    expect('two .beat rows directly under the section', directBeats === 2, String(directBeats));

    await ctl.close();
  } finally { await browser.close(); await server.close(); }
});
