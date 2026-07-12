/*
 * T3 (overlay) — ?debug=1 presenter overlay shows live connection state, socketId,
 * and the stream of inbound messages (proof it "shows live ops": a pushed content
 * message appears in the overlay's captured message log).
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch } from '../../harness/multi.mjs';

test('T3 overlay: conn open + socketId + captured content message; state inspector present', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${server.url()}/?userId=gm&name=GM&role=presenter&debug=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ap-debug', { timeout: 5000 });

    server.pushContent('all', '<!doctype html><html><body>hi</body></html>', 'c-test');
    await new Promise((r) => setTimeout(r, 400));

    const info = await page.evaluate(() => {
      const d = window.__apDebug.dump();
      return {
        open: d.open,
        socketId: d.socketId,
        msgTypes: d.msgs.map((m) => m.t),
        overlayText: document.querySelector('#ap-debug').textContent,
        getMissing: window.__apDebug.get('nope/path'),
        getFn: typeof window.__apDebug.get,
      };
    });

    expect(info.open === true, 'overlay reports connection open');
    expect(/^c\d+$/.test(info.socketId || ''), 'socketId assigned (cN)', String(info.socketId));
    expect(info.msgTypes.includes('welcome'), 'welcome captured');
    expect(info.msgTypes.includes('content'), 'content message captured in overlay', JSON.stringify(info.msgTypes));
    expect(/conn\s*open/i.test(info.overlayText), 'overlay text shows conn open');
    expect(info.getFn === 'function' && info.getMissing === undefined, 'state inspector get(path) works');
  } finally { await browser.close(); await server.close(); }
});
