/*
 * browser.mjs — resolve a Chromium executable for headless tests WITHOUT relying
 * on puppeteer's browser auto-download (which needs network + can pull a build not
 * cached here). Keeps the repo self-contained/extraction-ready: tests run against
 * whatever complete Chrome is already cached in ~/.cache/puppeteer (or an explicit
 * PUPPETEER_EXECUTABLE_PATH). One choke-point for launch options.
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Newest complete cached chrome-linux64/chrome under ~/.cache/puppeteer, or null. */
export function resolveChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && existsSync(process.env.PUPPETEER_EXECUTABLE_PATH))
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  const base = join(homedir(), '.cache', 'puppeteer', 'chrome');
  if (!existsSync(base)) return null;
  const builds = readdirSync(base)
    .map((d) => join(base, d, 'chrome-linux64', 'chrome'))
    .filter((p) => { try { return existsSync(p) && statSync(p).size > 0; } catch { return false; } })
    .sort();                 // linux-147 < linux-148 < linux-149 (string sort ok for zero-padded majors)
  return builds.length ? builds[builds.length - 1] : null;
}

/** Standard launch options for all headless rigs. */
export function launchOpts(extra = {}) {
  const exe = resolveChrome();
  return Object.assign(
    { headless: 'new', args: ['--no-sandbox', '--use-gl=swiftshader'] },
    exe ? { executablePath: exe } : {},
    extra
  );
}
