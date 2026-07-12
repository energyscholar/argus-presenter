/*
 * drive.mjs — headless practice/test rig.
 * Renders an assembled component, drives interactions, captures bridge messages,
 * screenshots. Reusable across every practice rep so iteration is fast.
 *
 * Usage:
 *   import { drive, closeBrowser } from './drive.mjs';
 *   const r = await drive({ component:'choice', opts:{...}, actions:[{click:'[data-value=yes]'}] });
 *   // r.messages  -> array of bridge messages received
 *   // r.shot      -> screenshot path
 */
import puppeteer from 'puppeteer';
import { assemble } from './assemble.mjs';
import { launchOpts } from './browser.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(__dirname, '_shots');
// _shots is gitignored, so a fresh clone won't have it — create it on demand so
// the temp-html write + screenshots work out of the box.
mkdirSync(SHOTS, { recursive: true });

let _browser = null;
export async function getBrowser() {
  if (!_browser) _browser = await puppeteer.launch(launchOpts());
  return _browser;
}
export async function closeBrowser() { if (_browser) { await _browser.close(); _browser = null; } }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function drive({ component, opts = {}, theme = 'argus', actions = [], viewport = { width: 1280, height: 720 }, shot = null, settle = 400, probe = null, requires = [] }) {
  const html = assemble({ component, opts, theme, requires });
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setViewport(viewport);

  // Collect bridge messages BEFORE any content loads.
  await page.evaluateOnNewDocument(() => {
    window.__apMsgs = [];
    window.addEventListener('argus-presenter:message', (e) => window.__apMsgs.push(e.detail));
    window.addEventListener('message', (e) => { if (e.data && e.data.source === 'argus-presenter') window.__apMsgs.push(e.data); });
  });

  // Load via a real file:// navigation so evaluateOnNewDocument fires reliably
  // (setContent uses document.write and can skip the on-new-document hook).
  const tmp = join(SHOTS, `_tmp-${component}-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(tmp, html);
  try {
    await page.goto('file://' + tmp, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ap-mount *', { timeout: 5000 }).catch(() => {});
    await wait(settle);

    for (const a of actions) {
      if (a.click) { await page.click(a.click); }
      else if (a.type) { await page.click(a.type.sel); await page.type(a.type.sel, a.type.text, { delay: 8 }); }
      else if (a.press) { if (a.press.sel) await page.focus(a.press.sel); await page.keyboard.press(a.press.key); }
      else if (a.key) { await page.keyboard.press(a.key); }
      else if (a.host) { await page.evaluate((m) => window.postMessage(m, '*'), Object.assign({ source: 'argus-host' }, a.host)); }
      else if (a.wait) { await wait(a.wait); }
      if (a.after) await wait(a.after); else await wait(120);
    }

    const messages = await page.evaluate(() => window.__apMsgs || []);
    const probed = probe ? await page.evaluate(probe) : null;
    let shotPath = null;
    if (shot) { shotPath = join(SHOTS, shot); await page.screenshot({ path: shotPath }); }
    return { messages, probe: probed, shot: shotPath, html };
  } finally {
    await page.close();
    try { unlinkSync(tmp); } catch (e) {}
  }
}

/* Tiny assertion helper for practice scripts. */
export function expect(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
  return ok;
}
