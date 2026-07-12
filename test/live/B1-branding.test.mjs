/*
 * B1 — default idle branding. The presenter idle state renders the self-contained
 * branding SVG (served by the node http server at /branding/argus-presenter.svg),
 * and the route returns a valid, domain-clean SVG.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, wait } from '../../harness/multi.mjs';

test('B1 — idle shows the branding SVG; /branding route serves it', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const p = await connectUser(browser, server, { userId: 'u1', userName: 'Alice' });
    await wait(300);

    // Idle stage renders the branding image (no content pushed).
    const brand = await p.$eval('#stage #idle img.ap-idle-brand', (el) => el.getAttribute('src')).catch(() => null);
    expect('idle renders branding img', brand === '/branding/argus-presenter.svg', String(brand));

    // The route returns a valid SVG (same-origin fetch from the page).
    const svg = await p.evaluate(async () => {
      const res = await fetch('/branding/argus-presenter.svg');
      return { ok: res.ok, type: res.headers.get('content-type'), body: await res.text() };
    });
    expect('branding route 200 + svg content-type', svg.ok && /image\/svg\+xml/.test(svg.type || ''), svg.type);
    expect('svg has a viewBox', /viewBox="0 0 800 600"/.test(svg.body));
    expect('svg carries ARGUS branding', /ARGUS/.test(svg.body));
    expect('branding svg has no HTML comment block (paths stripped)', !/<!--/.test(svg.body), 'comment block stripped');
  } finally { await browser.close(); await server.close(); }
});
