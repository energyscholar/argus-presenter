/*
 * C6 — content-on-(re)connect: a client joining mid-session RENDERS the currently
 * displayed content module (not just receives state). Covers a pushed component and
 * an open poll's choice.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';

test('C6 — a late client renders the currently pushed component', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    // Push BEFORE anyone is connected — it must still reach a later joiner.
    server.pushComponent('all', 'card', { title: 'Welcome aboard' });
    const late = await connectUser(browser, server, { userId: 'late', userName: 'Late' });
    const f = await waitContentFrame(late);
    await new Promise((r) => setTimeout(r, 300));
    const text = await f.evaluate(() => document.body.textContent);
    expect('late joiner sees the current component', /Welcome aboard/.test(text), text.slice(0, 80));
  } finally { await browser.close(); await server.close(); }
});

test('C6 — a late participant renders the open poll choice', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    server.openPoll({ promptId: 'lp', prompt: 'Ship it?', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }], target: 'participant' });
    const late = await connectUser(browser, server, { userId: 'p9', userName: 'Nine' });
    const f = await waitContentFrame(late);
    await new Promise((r) => setTimeout(r, 300));
    const hasChoice = await f.$$eval('[data-value]', (els) => els.map((e) => e.getAttribute('data-value')));
    expect('late participant sees the poll choice options', hasChoice.includes('yes') && hasChoice.includes('no'), JSON.stringify(hasChoice));
  } finally { await browser.close(); await server.close(); }
});
