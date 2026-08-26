/*
 * Shared rig for the examples. Small on purpose — each hazard here cost a real debugging run,
 * and the comment is the point.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export { createServer } from '../app/server.mjs';
export { launch, connectUser, waitContentFrame, wait, until } from '../harness/multi.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SHOT_DIR = join(ROOT, 'test', 'screenshots', 'examples');
mkdirSync(SHOT_DIR, { recursive: true });

/**
 * Screenshot, safely. Three hazards in one call:
 *  1. `captureBeyondViewport` defaults to TRUE — it captures the whole scrollable area and can
 *     take >60 s (plan 0524 measured 60 000 ms -> 207 ms with it off).
 *  2. A BACKGROUNDED tab throttles; with N pages, N-1 are always backgrounded, so shot 2..N hangs
 *     where shot 1 was fine. bringToFront() first.
 *  3. Neither call has a default timeout. Bound them: a missed capture must cost a warning, never
 *     the run.
 */
export async function shot(page, name, { bound = 15000 } = {}) {
  const file = join(SHOT_DIR, name);
  const cap = (p, ms, what) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(what + ' timeout')), ms))]);
  try { await cap(page.bringToFront(), 5000, 'bringToFront'); } catch { /* not fatal */ }
  try { await cap(page.screenshot({ path: file, captureBeyondViewport: false }), bound, 'screenshot'); return file; }
  catch (e) { return `SHOT FAILED (${name}): ${e.message}`; }
}

/**
 * Act on an element INSIDE the sandboxed content frame.
 * ⛔ page.click() / frame.click() HANG on an opaque-origin sandboxed iframe — they resolve
 *   coordinates through the host, which cannot see into it. No error, just a dead run.
 *   $eval + a dispatched event is the path that works.
 */
export async function act(frame, sel, mutate) {
  await frame.waitForSelector(sel, { timeout: 5000 });
  await frame.$eval(sel, mutate);
}

/** Read the same probe out of every viewer's content frame. */
export async function readAll(frames, fn) {
  const out = {};
  for (const k of Object.keys(frames)) {
    try { out[k] = await frames[k].evaluate(fn); } catch (e) { out[k] = 'ERR ' + e.message; }
  }
  return out;
}

/** Tiny pass/fail reporter, so an example is also a test. */
export function reporter() {
  const state = { fails: 0 };
  const ok = (label, cond, detail) => {
    console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${detail ? ' — ' + detail : ''}`);
    if (!cond) state.fails++;
  };
  ok.done = () => {
    console.log(state.fails === 0 ? '\nALL CHECKS PASSED' : `\n${state.fails} CHECK(S) FAILED`);
    return state.fails;
  };
  return ok;
}
