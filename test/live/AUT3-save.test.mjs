/*
 * AUT-3-save — Content Creator Save + Load round-trip. The creator's __creator.save(id)
 * POSTs the authored module to the write-back endpoint (AUT-1), so it enters the registry;
 * __creator.load(id) GETs it back and re-populates the editor. Proof: author → save →
 * appears in GET /api/modules → clear the editor → load → the beat body survives the trip.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch } from '../../harness/multi.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, unlinkSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = join(__dirname, '..', '..', 'modules');
const ID = '_creator_save_test';
const cleanup = () => { const f = join(MODULES_DIR, ID + '.json'); if (existsSync(f)) unlinkSync(f); };

test('AUT-3-save — creator save() writes to the registry; load() re-populates the editor (round-trip)', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('PAGEERR creator-save', e.message));
    await page.goto(`${server.url()}/creator?userId=gm&role=presenter`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__creator && typeof window.__creator.save === 'function' && typeof window.__creator.load === 'function');

    // Author a module in the editor, then Save it via the hook.
    await page.evaluate(() => window.__creator.setModule({ manifest: { title: 'Saved' }, beats: [{ id: 'x', component: 'card', opts: { title: 'SAVED-BODY' } }] }));
    const saved = await page.evaluate((id) => window.__creator.save(id), ID);
    expect(saved && saved.ok === true, 'save() resolved {ok:true}', JSON.stringify(saved));

    // The written module is now discoverable in the registry.
    const list = await (await fetch(server.url() + '/api/modules')).json();
    expect(Array.isArray(list) && list.some((m) => m.id === ID), 'registry now lists the saved id', JSON.stringify(list.map((m) => m.id)));

    // Clear the editor, then Load pulls the saved module back for editing.
    await page.evaluate(() => window.__creator.setModule({ manifest: {}, beats: [] }));
    const cleared = await page.evaluate(() => window.__creator.getModule().beats.length);
    expect(cleared === 0, 'editor cleared before load', 'beats=' + cleared);

    await page.evaluate((id) => window.__creator.load(id), ID);
    const title = await page.evaluate(() => { const m = window.__creator.getModule(); return m.beats[0] && m.beats[0].opts && m.beats[0].opts.title; });
    expect(title === 'SAVED-BODY', 'load() re-populated the beat body from the registry', 'title=' + title);
  } finally { cleanup(); await browser.close(); await server.close(); }
});
