/*
 * multi.mjs — robust helpers for multi-user (server-backed) practice/tests.
 * Deterministic interaction with sandboxed content iframes: use DOM el.click()
 * via $eval, NOT frame.click() (which hangs on opaque-origin sandboxed frames).
 */
import puppeteer from 'puppeteer';
import { launchOpts } from './browser.mjs';

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch() {
  return puppeteer.launch(launchOpts());
}

/*
 * Open a browser page as one user.
 *
 * ⚠ ADDITIVE, Plan 0522 P12 (R15): the optional `token`. presenter_start now mints a control
 * token when the caller passes none, so a CONTROL role (presenter/ai) on an MCP-started server
 * must present a credential or be downgraded to participant — silently, which is exactly how a
 * test starts asserting something it is no longer exercising. app/presenter.html has forwarded
 * `?token=` to its hello since AUTH-1; this only lets a caller supply one. Omitted ⇒ the URL is
 * byte-identical to before, so every existing call site is unaffected.
 */
export async function connectUser(browser, server, { userId, userName, role = 'participant', token = null }) {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('PAGEERR', userId, e.message));
  await p.goto(`${server.url()}/?userId=${userId}&name=${encodeURIComponent(userName)}&role=${role}`
    + (token ? `&token=${encodeURIComponent(token)}` : ''),
    { waitUntil: 'domcontentloaded' });
  return p;
}

/** The sandboxed content frame on a participant page (null if none yet). */
export function contentFrame(page) {
  return page.frames().find((f) => f !== page.mainFrame()) || null;
}

/** Wait for the content frame to appear (pushed content renders async). */
export async function waitContentFrame(page, { timeout = 5000 } = {}) {
  const t0 = Date.now();
  let f;
  while (!(f = contentFrame(page))) {
    if (Date.now() - t0 > timeout) throw new Error('no content frame appeared');
    await wait(50);
  }
  return f;
}

/** Deterministic click inside the content frame. Waits for frame AND selector. */
export async function frameClick(page, sel, { timeout = 5000 } = {}) {
  const f = await waitContentFrame(page, { timeout });
  await f.waitForSelector(sel, { timeout });
  await f.$eval(sel, (el) => el.click());
}

/** Read text/value inside the content frame. */
export async function frameEval(page, sel, fn) {
  const f = contentFrame(page);
  if (!f) throw new Error('no content frame on page');
  return f.$eval(sel, fn);
}

/** Wait until a predicate over the server is true, or throw (stability guard). */
export async function until(pred, { timeout = 5000, every = 100, label = 'condition' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(every); }
  throw new Error('timeout waiting for ' + label);
}
