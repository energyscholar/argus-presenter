/*
 * AUT-3 — the Content Creator authoring panel. /creator serves a beat-list editor +
 * manifest + IN-BROWSER validate (SINGLE-SOURCE /validate.mjs) + a live preview that
 * reuses the REAL server pipeline (an embedded participant iframe). Two proofs:
 *   (a) window.__creator.validate() flags the bad beat (V3-unknown-component), and
 *   (b) clicking a beat's Preview button pushes through the server → the embedded
 *       #cpreview iframe renders the beat (HELLO-PREVIEW) via the normal content path.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until } from '../../harness/multi.mjs';

test('AUT-3 — creator: in-browser validate flags unknown component + preview renders via the server pipeline', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('PAGEERR creator', e.message));
    await page.goto(`${server.url()}/creator?userId=gm&role=presenter`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__creator && typeof window.__creator.validate === 'function');
    await until(() => server.presence().some((u) => u.role === 'presenter'), { label: 'creator presenter connected' });

    await page.evaluate(() => window.__creator.setModule({
      manifest: { title: 'T' },
      beats: [
        { id: 'a', component: 'card', promptId: 'a', opts: { title: 'HELLO-PREVIEW' } },
        { id: 'b', component: 'frobnicate' },
      ],
    }));

    // (a) in-browser validation flags the unknown component on the bad beat.
    const v = await page.evaluate(() => window.__creator.validate());
    expect(v.warn >= 1, 'validate() reports >=1 warning', JSON.stringify(v));
    expect(v.warnings.some((w) => w.code === 'V3-unknown-component'), 'V3-unknown-component present for beat b', JSON.stringify(v.warnings.map((w) => w.code)));

    // The embedded preview iframe connects as participant __creator_preview.
    await until(() => server.presence().some((u) => u.userId === '__creator_preview'), { label: 'preview participant connected', timeout: 8000 });

    // (b) click beat 'a' Preview → server pushes the card → embedded iframe renders it.
    await page.evaluate(() => document.querySelector('.b-preview[data-beat-id="a"]').click());
    await until(async () => {
      for (const f of page.frames()) {
        try { const t = await f.evaluate(() => (document.body ? document.body.textContent : '')); if (/HELLO-PREVIEW/.test(t)) return true; } catch (e) {}
      }
      return false;
    }, { label: 'preview iframe shows HELLO-PREVIEW', timeout: 8000 });
    expect(true, 'preview rendered HELLO-PREVIEW inside #cpreview via the server pipeline');
  } finally { await browser.close(); await server.close(); }
});
