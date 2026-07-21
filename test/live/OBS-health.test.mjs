/*
 * OBS-B3 — health() must tell the truth.
 * RED TODAY: health() (app/server.mjs:2004-2020) derives status from connection staleness
 * and denial ratio ONLY. It ignores renderErrors, opApplyFailures, throttled and frame
 * errors - so every content frame can be DEAD while health reads green. That is exactly
 * the "form shipped dead for months" failure this whole plan exists to prevent.
 * Conversely, legitimate denials must NOT drive it to a false 'degraded'.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';

test('OBS-B3 — health surfaces render/apply faults, and benign denials do not degrade it', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const p = await connectUser(browser, server, { userId: 'h1', userName: 'H' });
    await until(() => server.presence().some((u) => u.userId === 'h1'), { label: 'connected' });
    server.pushComponent('all', 'card', { title: 'health probe' });
    await waitContentFrame(p);

    const h = server.health();
    // (a) the signals that indicate a dead surface must participate in the verdict.
    const considered = JSON.stringify(h);
    expect('health reports renderErrors', /renderErrors/.test(considered), considered.slice(0, 200));
    expect('health reports opApplyFailures', /opApplyFailures/.test(considered), considered.slice(0, 200));
    expect('health reports frame errors', /frame/i.test(considered), considered.slice(0, 200));

    // (b) benign denials must not create a false 'degraded'.
    const f = contentFrame(p);
    for (let i = 0; i < 5; i++) {
      await f.evaluate(() => window.Argus.op('gm/forbidden', 'set', { x: 1 }));
    }
    await new Promise((r) => setTimeout(r, 400));
    const h2 = server.health();
    expect('benign denials do not degrade health', h2.status === 'green', JSON.stringify(h2).slice(0, 200));
  } finally { await browser.close(); await server.close(); }
});
