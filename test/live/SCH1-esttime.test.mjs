/*
 * SCH-1 — estimated time rollup in the GM panel outline. When beats carry an integer
 * `durationSec`, renderOutline sums them: a module TOTAL line ("est. ~N min") near the top
 * of #outline, plus a per-section "~N min" appended to each section summary. A module with
 * NO durations shows no "~…min" text at all (unchanged behaviour).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until } from '../../harness/multi.mjs';

// Section with two beats: 90s + 150s = 240s = "~4 min".
const TIMED_MODULE = {
  title: 'Timed demo',
  sections: [{ id: 's', title: 'S', beatIds: ['a', 'b'] }],
  beats: [
    { id: 'a', component: 'card', opts: { title: 'A' }, durationSec: 90 },
    { id: 'b', component: 'card', opts: { title: 'B' }, durationSec: 150 },
  ],
};

const UNTIMED_MODULE = {
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

test('SCH1 — timed beats roll up a module total and a per-section estimate', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const ctl = await openPanel(browser, server);
    await ctl.evaluate((m) => window.__gm.setModule(m), TIMED_MODULE);

    const outText = await ctl.$eval('#outline', (el) => el.textContent);
    expect('module total line present ("est. ~4 min")', /est\.\s*~4 min/.test(outText), outText);
    // The section summary carries a "~4 min" estimate too.
    expect('section summary shows "~4 min"', outText.includes('~4 min'), outText);

    const estLine = await ctl.$eval('#outline', (el) => {
      const e = el.querySelector('.outline-est'); return e ? e.textContent : null;
    });
    expect('a dedicated .outline-est total line exists', estLine != null && /~4 min/.test(estLine), String(estLine));

    await ctl.close();
  } finally { await browser.close(); await server.close(); }
});

test('SCH1 — a module with no durations shows no "~…min" estimate text', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const ctl = await openPanel(browser, server);
    await ctl.evaluate((m) => window.__gm.setModule(m), UNTIMED_MODULE);

    const outText = await ctl.$eval('#outline', (el) => el.textContent);
    expect('no "~" estimate text without durations', !/~\d/.test(outText), outText);
    const estCount = await ctl.$eval('#outline', (el) => el.querySelectorAll('.outline-est').length);
    expect('no .outline-est total line', estCount === 0, String(estCount));

    await ctl.close();
  } finally { await browser.close(); await server.close(); }
});
