/*
 * I2 — compose from the pick-list: a human picks components from the manifest
 * catalog, fills fields, appends beats, and displays the module — no code, no AI.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { generateManifest } from '../../harness/gen-manifest.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';

test('I2 — a human builds a 2-beat module from the pick-list and displays it', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    // The pick-list = the component manifest (catalog + field schemas).
    const manifest = generateManifest();
    const catalog = manifest.components.map((c) => c.name);
    expect(catalog.includes('narration') && catalog.includes('choice'), 'pick-list offers the components', catalog.join(','));
    const narrFields = manifest.components.find((c) => c.name === 'narration').fields.map((f) => f.name);
    expect(narrFields.includes('text'), 'narration field schema available (schema-driven form)', narrFields.join(','));

    // Human composes two beats from the pick-list (append_beat = what /control sends).
    server.appendBeat({ component: 'narration', opts: { text: 'Welcome aboard' } });
    server.appendBeat({ component: 'choice', opts: { prompt: 'Ready?', options: [{ label: 'Yes', value: 'yes' }] } });
    const mod = server.getModule();
    expect(mod.beats.length === 2, 'two beats composed', String(mod.beats.length));
    expect(mod.beats.every((b) => catalog.includes(b.component)), 'both beats are pick-list components');

    // Display the composed module.
    server.showBeat(0);
    const viewer = await connectUser(browser, server, { userId: 'v', userName: 'V' });
    const f = await waitContentFrame(viewer);
    await until(async () => /Welcome aboard/.test(await f.evaluate(() => document.body.textContent)), { label: 'composed beat displays', timeout: 5000 });
    expect(/Welcome aboard/.test(await f.evaluate(() => document.body.textContent)), 'composed beat displays to a viewer');
  } finally { await browser.close(); await server.close(); }
});
