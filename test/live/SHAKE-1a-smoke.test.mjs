/*
 * SHAKE-1a — stabilization cascade smoke (capstone of Plan 0442 Wave 1).
 *
 * Proves the WHOLE default-page cascade end-to-end with a REAL user (participant)
 * page as the viewer, driving delivery through the SERVER control API as the
 * presenter would (deterministic): setModule → showBeat → showDefault → clear.
 *
 * CI-safe: uses ONLY the neutral, tracked `demo-welcome` module (read from disk) —
 * never any local/gitignored content. Ungated createServer (the password gate is
 * covered by P5_5's test); this smoke stays simple and asserts the cascade + reversal.
 *
 * States walked + screenshot each (incl. the STOP takedown) → test/screenshots/:
 *   1. branding   (no module)                      → SHAKE-branding.png
 *   2. title page (Load demo-welcome, defaultBeatId)→ SHAKE-title.png
 *   3. a beat     (b-welcome)                       → SHAKE-beat.png
 *   4. Home       (showDefault → title)             (assert only)
 *   5. STOP       (clear('all') → branding)         → SHAKE-stopped.png
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, until, wait } from '../../harness/multi.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(HERE, '..', 'screenshots');
const DEMO = path.resolve(HERE, '..', '..', 'modules', 'demo-welcome.json');

/**
 * Robust content-frame lookup: the display renders pushed content into a sandboxed
 * srcdoc <iframe> (url 'about:srcdoc'), created fresh per beat. Find it by URL/parent
 * — NOT "first non-main frame" — and re-find every poll (the frame is replaced each push).
 */
function contentFrame(page) {
  const main = page.mainFrame();
  const kids = page.frames().filter((f) => f !== main && f.parentFrame() === main);
  return kids.find((f) => f.url().includes('srcdoc'))
    || kids.find((f) => { const u = f.url(); return u && u !== 'about:blank'; })
    || null;
}

async function frameText(page) {
  const f = contentFrame(page);
  if (!f) return null;
  try { return await f.evaluate(() => (document.body ? document.body.textContent : '')); }
  catch (e) { return null; }   // frame can detach mid-swap; caller re-polls
}

/** True when the display is on idle/branding: the branding art is present and NO content frame. */
async function isBranding(page) {
  const hasBrand = await page.$('.ap-idle-brand');
  return !!hasBrand && contentFrame(page) === null;
}

test('SHAKE-1a — default-page cascade: branding → title → beat → Home → STOP→branding', async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const module = JSON.parse(fs.readFileSync(DEMO, 'utf8'));   // NEUTRAL tracked module only

  const server = await createServer({ port: 0 });   // ungated — gate covered by P5_5
  const browser = await launch();
  let page = null;
  try {
    // A real USER (participant) page is the viewer.
    page = await connectUser(browser, server, { userId: 'u1', userName: 'U1' });
    await page.waitForSelector('#led.on', { timeout: 8000 });
    await until(() => server.presence().some((u) => u.userId === 'u1'), { label: 'server sees u1' });

    // ---- 1. BRANDING (no module) ----
    await until(() => isBranding(page), { label: 'idle branding at start' });
    expect(await isBranding(page), '(1) display shows idle branding, no content frame');
    await page.screenshot({ path: path.join(SHOTS, 'SHAKE-branding.png') });

    // ---- 2. TITLE PAGE (Load demo-welcome; manifest.defaultBeatId = b-title) ----
    expect(module.manifest && module.manifest.defaultBeatId === 'b-title', 'demo-welcome declares defaultBeatId b-title');
    server.setModule(module);   // auto-shows the title beat via the defaultBeatId cascade
    await until(async () => { const t = await frameText(page); return !!t && /This is a module title page/.test(t); },
      { timeout: 8000, label: 'title beat rendered on the user display' });
    const titleText = await frameText(page);
    expect(/This is a module title page/.test(titleText || ''), '(2) user sees the module TITLE page (not branding)', (titleText || '').slice(0, 80));
    await page.screenshot({ path: path.join(SHOTS, 'SHAKE-title.png') });

    // ---- 3. A BEAT (Start → beat 0 = b-welcome, narration) ----
    server.showBeat('b-welcome');
    await until(async () => { const t = await frameText(page); return !!t && /this deck is a content module/i.test(t); },
      { timeout: 8000, label: 'b-welcome beat rendered' });
    const beatText = await frameText(page);
    expect(/this deck is a content module/i.test(beatText || ''), '(3) user sees the welcome BEAT', (beatText || '').slice(0, 80));
    await page.screenshot({ path: path.join(SHOTS, 'SHAKE-beat.png') });

    // ---- 4. HOME (showDefault → back to the title beat) ----
    server.showDefault();
    await until(async () => { const t = await frameText(page); return !!t && /This is a module title page/.test(t); },
      { timeout: 8000, label: 'Home returns to the title beat' });
    const homeText = await frameText(page);
    expect(/This is a module title page/.test(homeText || ''), '(4) Home returns the user to the title page', (homeText || '').slice(0, 80));

    // ---- 5. STOP → BRANDING (takedown / reversal) ----
    server.clear('all');
    await until(() => isBranding(page), { timeout: 8000, label: 'STOP reverts the user to branding' });
    expect(await isBranding(page), '(5) STOP returns the user to idle branding (content frame gone)');
    await page.screenshot({ path: path.join(SHOTS, 'SHAKE-stopped.png') });
  } finally {
    if (page) { try { await page.close(); } catch (e) {} }
    await browser.close();
    await server.close();
  }
});
