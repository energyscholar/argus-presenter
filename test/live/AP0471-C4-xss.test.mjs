/*
 * Plan 0471 C4 — stored XSS in control.html. A hostile participant userName
 * (`<img src=x onerror=...>`) reaches the control page's user-list via pushPresence.
 * The fixed esc() must render it as INERT TEXT: the escaped string contains `&lt;img`
 * and NO live <img> element is created in the control DOM.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, until } from '../../harness/multi.mjs';

const PAYLOAD = '<img src=x onerror="window.__pwned=1">';

test('C4 — hostile userName renders inert in the control user-list (no live img)', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    // Control page (presenter) open FIRST so pushPresence has a listener.
    const ctl = await browser.newPage();
    await ctl.goto(`${server.url()}/control?userId=gm&name=GM`, { waitUntil: 'domcontentloaded' });
    await ctl.waitForFunction(() => typeof window.__control === 'function');
    await until(() => server.presence().some((u) => u.role === 'presenter'), { label: 'presenter connected' });

    // Hostile participant joins → its userName is pushed to the control user-list.
    await connectUser(browser, server, { userId: 'evil', userName: PAYLOAD });
    await until(() => server.presence().some((u) => u.userId === 'evil'), { label: 'evil connected' });

    // Wait for the user-list to render the evil row.
    await until(async () => (await ctl.$eval('#users', (e) => e.innerHTML)).includes('evil'), { label: 'user-list rendered' });

    const imgCount = await ctl.$$eval('#users img', (els) => els.length);
    const pwned = await ctl.evaluate(() => !!window.__pwned);
    const html = await ctl.$eval('#users', (e) => e.innerHTML);

    expect(imgCount === 0, 'no live <img> injected into control DOM', 'imgCount=' + imgCount);
    expect(pwned === false, 'onerror payload did NOT execute', 'pwned=' + pwned);
    expect(html.includes('&lt;img'), 'userName is escaped as inert text (&lt;img)', html.slice(0, 200));

    // Direct escaper unit check via the page's own esc() semantics (rendered form).
    await ctl.close();
  } finally { await browser.close(); await server.close(); }
});
