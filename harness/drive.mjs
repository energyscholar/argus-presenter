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

/*
 * ⭐ Plan 0689 R5 — `page` DRIVES THE COMPOSED FORM. Pass {page:{html, mounts}} instead of a
 * component and the rig assembles an AUTHORED page hosting components, waits on `#ap-page` rather
 * than `#ap-mount`, and collects bridge messages exactly as before. Same rig, same assertions —
 * which is the point: if composition needed a different harness it would not be one render path.
 */
export async function drive({ component, opts = {}, theme = 'argus', actions = [], viewport = { width: 1280, height: 720 }, shot = null, settle = 400, probe = null, requires = [], page: pageSpec = null }) {
  const composed = !!(pageSpec && typeof pageSpec.html === 'string');
  const html = composed
    ? assemble({ html: pageSpec.html, mounts: pageSpec.mounts || [], opts, theme, requires })
    : assemble({ component, opts, theme, requires });
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
  const tmp = join(SHOTS, `_tmp-${composed ? 'page' : component}-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(tmp, html);
  try {
    await page.goto('file://' + tmp, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(composed ? '#ap-page *' : '#ap-mount *', { timeout: 5000 }).catch(() => {});
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

/* Plan 0667 phase A3 — safe one-line rendering of a wrong-typed value for a guard message.
 * try/catch because JSON.stringify throws on a circular object and returns undefined on some
 * primitives (Symbol, function) that String() renders fine instead. */
function describeForError(v) {
  try {
    const s = JSON.stringify(v);
    if (s !== undefined) return s;
  } catch { /* fall through to String() */ }
  return String(v);
}

/*
 * Tiny assertion helper for practice scripts. Name-first: expect(name, cond, detail).
 *
 * Plan 0667 phase A3 — the NAME slot is unambiguous: a real call always passes a string here, so
 * a non-string is always an argument-order mistake (EX-1's whole defect shape). Thrown rather
 * than silently coerced. The CONDITION slot is deliberately left unguarded — see the matching
 * comment on harness/test.mjs's check(); the reasoning is identical and was confirmed by redteam.
 */
export function expect(name, cond, detail) {
  if (typeof name !== 'string') {
    throw new TypeError(
      `expect(name, cond, detail): "name" must be a string, got ${typeof name} ` +
      `(${describeForError(name)}). This is usually the arguments swapped — ` +
      `expect(cond, name) instead of expect(name, cond).`
    );
  }
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
  return ok;
}
