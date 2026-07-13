/*
 * HAR — defense-in-depth HTTP headers. The three HTML routes (/, /control, /creator)
 * carry a Content-Security-Policy that admits inline scripts/styles, the ws/wss socket,
 * and the sandboxed srcdoc iframes (blob:/data:). Static assets carry a weak ETag and
 * honour if-none-match with a 304 (revalidation cache). Node-side fetch — no browser.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';

test('HAR — CSP on HTML routes; ETag/304 on static assets', async () => {
  const server = await createServer({ port: 0 });
  const base = server.url();
  try {
    // --- CSP on the three HTML routes ---
    for (const route of ['/', '/control', '/creator']) {
      const res = await fetch(base + route);
      const csp = res.headers.get('content-security-policy') || '';
      expect(res.ok, `${route} serves 200`);
      expect(csp.includes("default-src 'self'"), `${route} CSP has default-src 'self'`);
      expect(/connect-src[^;]*\bws:/.test(csp), `${route} CSP connect-src includes ws:`);
      expect(csp.includes("'unsafe-inline'"), `${route} CSP allows inline (required today)`);
      expect(/frame-src[^;]*\bblob:/.test(csp), `${route} CSP frame-src admits srcdoc blob:`);
      expect(res.headers.get('x-content-type-options') === 'nosniff', `${route} X-Content-Type-Options nosniff`);
    }

    // --- ETag + 304 on static assets ---
    for (const asset of ['/branch.mjs', '/branding/argus-presenter.svg']) {
      const r1 = await fetch(base + asset);
      expect(r1.ok, `${asset} serves 200`);
      const etag = r1.headers.get('etag');
      expect(!!etag && /^W\//.test(etag), `${asset} returns a weak ETag`);
      const r2 = await fetch(base + asset, { headers: { 'if-none-match': etag } });
      expect(r2.status === 304, `${asset} if-none-match → 304`);
    }

    // /validate.mjs likewise revalidates (single-source module served static).
    const v1 = await fetch(base + '/validate.mjs');
    const vtag = v1.headers.get('etag');
    const v2 = await fetch(base + '/validate.mjs', { headers: { 'if-none-match': vtag } });
    expect(v2.status === 304, '/validate.mjs if-none-match → 304');
  } finally { await server.close(); }
});
