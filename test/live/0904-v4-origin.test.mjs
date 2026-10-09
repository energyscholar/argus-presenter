/*
 * Plan 0904 V4 — the WebSocket upgrade checks Origin.
 *
 *   T0904-08  an unlisted Origin is refused at the upgrade; AP's own origin, a listed voice-client
 *             origin and a MISSING Origin (CLI/MCP clients send none) are accepted.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

function tryUpgrade(url, headers) {
  return new Promise((res) => {
    const ws = new WebSocket(url.replace('http', 'ws'), { headers });
    ws.on('open', () => { ws.close(); res({ ok: true }); });
    ws.on('unexpected-response', (_req, resp) => res({ ok: false, status: resp.statusCode }));
    ws.on('error', (e) => res({ ok: false, err: String(e && e.message || e) }));
  });
}

test('T0904-08 — Origin allowlist at the upgrade', async () => {
  const listed = 'https://vtt.example.invalid';
  const s = await createServer({ port: 0, voiceClientOrigins: [listed] });
  try {
    const self = 'http://' + new URL(s.url()).host;
    const none = await tryUpgrade(s.url(), {});
    expect(none.ok, 'a missing Origin is accepted (CLI/MCP clients)', JSON.stringify(none));
    const own = await tryUpgrade(s.url(), { origin: self });
    expect(own.ok, "AP's own origin is accepted", JSON.stringify(own));
    const fwd = await tryUpgrade(s.url(), { origin: 'https://public.example.invalid', 'x-forwarded-host': 'public.example.invalid' });
    expect(fwd.ok, 'the forwarded public host counts as AP\'s own origin', JSON.stringify(fwd));
    const lst = await tryUpgrade(s.url(), { origin: listed });
    expect(lst.ok, 'a listed voice-client origin is accepted', JSON.stringify(lst));
    const bad = await tryUpgrade(s.url(), { origin: 'https://evil.example.invalid' });
    expect(!bad.ok && bad.status === 403, 'an unlisted origin is refused at the upgrade', JSON.stringify(bad));
  } finally { await s.close(); }
});
