/**
 * resources.mjs — pre-flight resource guard for the headless test rigs.
 *
 * WHY THIS EXISTS
 * ---------------
 * This box (Crostini LXC VM) has ~6.4 GB RAM and ZERO SWAP. With no swap there
 * is no graceful degradation: a process that asks for one page too many is not
 * slowed down, it is SIGKILLed by the OOM reaper. The kernel here has done that
 * 54 times. The rigs (test.mjs, drive.mjs, multi.mjs, session-rig.mjs) launch
 * puppeteer Chrome with no resource awareness at all, so the first symptom of
 * overshoot is a dead run with no diagnostic.
 *
 * This module answers one question before a rig starts: "is there enough room?"
 * It never fixes anything and never frees anything. It only refuses early, with
 * a message that says what to close.
 *
 * MEASURED ON THIS BOX (2026-08-13, puppeteer 24.43.1 / Chrome 149, headless:'new',
 * args ['--no-sandbox','--use-gl=swiftshader'] — i.e. harness/browser.mjs launchOpts):
 *
 *   one browser + one blank page, cold file cache ....... 243 MB of MemAvailable
 *   one browser + one blank page, warm file cache ....... 102 MB of MemAvailable
 *   each additional page in the same browser ............  10 MB
 *   each additional browser (own zygote) ...............  144 MB
 *   summed RSS of that same 9-process tree .............. 843 MB
 *   summed RSS of a live full-suite Chrome tree ........ ~1040 MB
 *
 * The gap between "843 MB of summed RSS" and "243 MB of real memory consumed" is
 * Chrome's zygote: the renderers are forked and share most of their pages, so
 * adding up RSS across the tree double-counts heavily. That is why the verdict
 * below is driven by MemAvailable and the summed-RSS figure is reported only as
 * context (and labelled as an over-count wherever it is printed).
 *
 * Dependency-free: node builtins only. Linux and macOS. The detection path is
 * wrapped so that it degrades to a permissive verdict rather than throwing —
 * a broken guard must never be the reason a test run fails.
 */

import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Default headroom for a full rig, in MB.
 *
 * Derivation from the measurements above, not a round number picked by feel:
 *   session-rig.mjs runs ONE browser with 5 real pages (1 GM + 4 players).
 *   Cold-cache browser+page             243 MB
 *   4 more pages, but REAL presenter    ~4 x 50 MB = 200 MB   (measured 10 MB/page
 *                                       for a bare <h1>; the real station screens
 *                                       carry SVG components and a live socket, so
 *                                       5x that per page is the honest estimate)
 *   node server + assemble step         ~150 MB
 *                                       ------
 *                                       ~600 MB steady
 * Zero swap means the peak, not the mean, is what kills. A 33% margin over the
 * steady estimate gives 800 MB, which also comfortably covers the ~1040 MB summed
 * RSS actually observed for a live suite tree once its over-count is discounted.
 */
export const DEFAULT_NEED_MB = 800;

/** Rough per-scenario needs, same derivation. Callers may pass their own needMB. */
export const NEED_MB = {
  browser: 300, // a single puppeteer browser with a page or two
  multi: 600, // multi.mjs, a handful of browsers
  suite: 800, // test.mjs full run
  sessionRig: 900, // session-rig.mjs, 1 GM + 4 players on real screens
};

/**
 * Extra room the kernel should still have AFTER the run's need is met.
 * With zero swap the kernel cannot page anything out to make room for its own
 * allocations, so a verdict of "exactly enough" is a verdict of "about to die".
 */
export const SAFETY_FLOOR_MB = 250;

const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const MB = (bytes) => Math.round(bytes / 1024 / 1024);

/** Run a command, returning '' on any failure. Never throws. */
function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

/** Parse /proc/meminfo into { KEY: kB }. Returns null off Linux or on any failure. */
function readMeminfo() {
  if (!isLinux) return null;
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const out = {};
    for (const line of raw.split('\n')) {
      const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
      if (m) out[m[1]] = Number(m[2]);
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/**
 * Available memory in MB, plus how we learned it.
 *
 * os.freemem() is the wrong number on Linux: it reports MemFree, which excludes
 * the page cache the kernel would happily reclaim under pressure. On this box it
 * understates availability by roughly a gigabyte. MemAvailable is the kernel's
 * own estimate of what a new allocation could actually get, so prefer it.
 */
function readAvailableMB() {
  const info = readMeminfo();
  if (info && typeof info.MemAvailable === 'number') {
    return { availableMB: Math.round(info.MemAvailable / 1024), source: '/proc/meminfo MemAvailable' };
  }
  if (info && typeof info.MemFree === 'number') {
    const reclaimable = (info.Cached || 0) + (info.SReclaimable || 0) - (info.Shmem || 0);
    return {
      availableMB: Math.round((info.MemFree + Math.max(0, reclaimable)) / 1024),
      source: '/proc/meminfo MemFree+Cached (no MemAvailable)',
    };
  }
  if (isMac) {
    // macOS has no MemAvailable. vm_stat exposes the inactive+purgeable pages the
    // kernel can hand back, which is the closest analogue; fall back to freemem.
    const raw = tryExec('vm_stat', []);
    const pageSize = Number(/page size of (\d+) bytes/.exec(raw)?.[1] || 4096);
    const pages = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(raw)?.[1] || 0);
    const free = pages('Pages free') + pages('Pages inactive') + pages('Pages purgeable') + pages('File-backed pages');
    if (free > 0) return { availableMB: MB(free * pageSize), source: 'vm_stat free+inactive+purgeable+file-backed' };
  }
  return { availableMB: MB(os.freemem()), source: 'os.freemem() (understates availability)' };
}

/** Swap total in MB, or 0. Linux reads /proc/meminfo; macOS asks sysctl. */
function readSwapMB() {
  const info = readMeminfo();
  if (info && typeof info.SwapTotal === 'number') return Math.round(info.SwapTotal / 1024);
  if (isMac) {
    // e.g. "vm.swapusage: total = 2048.00M  used = 512.00M  free = 1536.00M"
    const raw = tryExec('sysctl', ['-n', 'vm.swapusage']);
    const m = /total\s*=\s*([\d.]+)([MG])/i.exec(raw);
    if (m) return Math.round(Number(m[1]) * (m[2].toUpperCase() === 'G' ? 1024 : 1));
  }
  return 0;
}

/**
 * Inventory the Chrome and node processes already running.
 *
 * NOTE ON RSS: summing RSS across a Chrome tree double-counts, because the
 * renderers are zygote forks sharing most of their pages. Measured on this box,
 * a tree whose summed RSS was 843 MB had consumed only 243 MB of real
 * availability — an over-count of ~3.5x. The number is still worth reporting
 * ("15 chrome processes are already using 900 MB" is the shape of the problem)
 * but every message that prints it must label it as an upper bound.
 *
 * Never throws; returns zeroes if ps is unavailable.
 */
export function inventoryProcesses() {
  const empty = { chromeProcs: 0, chromeBrowsers: 0, chromeRssMB: 0, nodeProcs: 0, nodeRssMB: 0, ok: false };
  const raw = tryExec('ps', ['-A', '-o', 'pid=,rss=,args=']);
  if (!raw.trim()) return empty;

  const self = process.pid;
  let chromeProcs = 0;
  let chromeBrowsers = 0;
  let chromeRssKB = 0;
  let nodeProcs = 0;
  let nodeRssKB = 0;

  for (const line of raw.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const rssKB = Number(m[2]);
    const args = m[3];
    if (pid === self) continue;

    // Match the executable, not the whole command line: a `node foo-chrome.mjs`
    // must not be counted as a browser, and `grep chrome` must not either.
    const exe = args.split(/\s+/)[0] || '';
    const base = exe.slice(exe.lastIndexOf('/') + 1).toLowerCase();

    if (/^(chrome|chromium|chromium-browser|google chrome|chrome_crashpad_handler)/.test(base) || / Helper/.test(exe)) {
      chromeProcs++;
      chromeRssKB += rssKB;
      // Child processes carry --type=renderer/gpu-process/utility/zygote.
      // The ones without it are the browser processes, i.e. distinct instances.
      if (!/--type=/.test(args)) chromeBrowsers++;
    } else if (/^node$/.test(base) || /^node[\d.]*$/.test(base)) {
      nodeProcs++;
      nodeRssKB += rssKB;
    }
  }

  return {
    chromeProcs,
    chromeBrowsers,
    chromeRssMB: Math.round(chromeRssKB / 1024),
    nodeProcs,
    nodeRssMB: Math.round(nodeRssKB / 1024),
    ok: true,
  };
}

/**
 * Pre-flight verdict.
 *
 * @param {{ needMB?: number }} [opts]
 * @returns {{
 *   ok: boolean, tight: boolean, availableMB: number, totalMB: number,
 *   swapMB: number, needMB: number, shortfallMB: number, zeroSwap: boolean,
 *   source: string, processes: object, reason: string
 * }}
 *
 * Never throws. If detection fails entirely it returns ok:true with a reason
 * saying so — refusing to run because the guard is broken would be worse than
 * the problem the guard exists to prevent.
 */
export function checkResources(opts = {}) {
  const needMB = Number.isFinite(opts.needMB) ? Math.max(0, opts.needMB) : DEFAULT_NEED_MB;

  let availableMB = 0;
  let totalMB = 0;
  let swapMB = 0;
  let source = 'unavailable';
  let processes = { chromeProcs: 0, chromeBrowsers: 0, chromeRssMB: 0, nodeProcs: 0, nodeRssMB: 0, ok: false };
  let detectionFailed = false;

  try {
    const avail = readAvailableMB();
    availableMB = avail.availableMB;
    source = avail.source;
    totalMB = MB(os.totalmem());
    swapMB = readSwapMB();
    processes = inventoryProcesses();
    if (!Number.isFinite(availableMB) || availableMB <= 0) detectionFailed = true;
  } catch {
    detectionFailed = true;
  }

  if (detectionFailed) {
    return {
      ok: true,
      tight: false,
      availableMB: 0,
      totalMB,
      swapMB,
      needMB,
      shortfallMB: 0,
      zeroSwap: false,
      source,
      processes,
      reason: 'Resource detection failed; proceeding unguarded rather than blocking the run.',
    };
  }

  const zeroSwap = swapMB === 0;
  const ok = availableMB >= needMB;
  const tight = ok && availableMB < needMB + SAFETY_FLOOR_MB;
  const shortfallMB = ok ? 0 : needMB - availableMB;

  const parts = [];
  parts.push(`${availableMB} MB available of ${totalMB} MB total (via ${source}); this run needs ~${needMB} MB.`);

  if (zeroSwap) {
    parts.push(
      'SWAP IS ZERO. There is no overflow of any kind: a process that overshoots is ' +
        'SIGKILLed by the OOM reaper immediately, not slowed down. Treat the headroom ' +
        'figure above as a hard ceiling, not a soft one.',
    );
  } else {
    parts.push(`Swap: ${swapMB} MB (some overflow available, but swapping a Chrome tree will crawl).`);
  }

  if (processes.ok && processes.chromeProcs > 0) {
    parts.push(
      `${processes.chromeProcs} chrome processes (${processes.chromeBrowsers} browser instance` +
        `${processes.chromeBrowsers === 1 ? '' : 's'}) are already resident, summing to ${processes.chromeRssMB} MB RSS ` +
        '— an upper bound, since zygote-forked renderers share most of their pages.',
    );
  }
  if (processes.ok && processes.nodeProcs > 0) {
    parts.push(`${processes.nodeProcs} node processes summing to ${processes.nodeRssMB} MB RSS.`);
  }

  if (!ok) {
    parts.push(`SHORT BY ${shortfallMB} MB.`);
  } else if (tight) {
    parts.push(
      `Only ${availableMB - needMB} MB would remain after this run's estimated need, below the ` +
        `${SAFETY_FLOOR_MB} MB floor the kernel wants for itself. Expect to be close to the edge.`,
    );
  }

  return { ok, tight, availableMB, totalMB, swapMB, needMB, shortfallMB, zeroSwap, source, processes, reason: parts.join(' ') };
}

/** What a human should actually go and close, given what is resident right now. */
function remedies(v) {
  const out = [];
  const p = v.processes;
  if (p.ok && p.chromeBrowsers > 0) {
    out.push(
      `Close the ${p.chromeBrowsers} running Chrome instance${p.chromeBrowsers === 1 ? '' : 's'} ` +
        '(including any left behind by a crashed rig: `pkill -f "chrome.*--headless"` reclaims orphans safely).',
    );
  }
  if (p.ok && p.nodeProcs > 2) {
    out.push(`Stop idle node servers — ${p.nodeProcs} are running (\`ps -A -o pid,rss,args | grep node\`).`);
  }
  out.push('Check whether another agent or shell is already running the suite; two concurrent rigs will not fit.');
  if (v.zeroSwap) {
    out.push('There is no swap to fall back on, so waiting for memory to free up is the only option — it will not page out.');
  }
  return out;
}

/**
 * Throw unless there is room to run. Use at the top of a rig, before launching
 * anything. The error names the numbers and the fix; it is never a bare
 * "out of memory".
 *
 * @param {{ needMB?: number, label?: string }} [opts]
 * @returns the verdict, when it passes.
 */
export function assertResources(opts = {}) {
  const label = opts.label || 'this run';
  const verdict = checkResources({ needMB: opts.needMB });

  if (!verdict.ok) {
    const lines = [
      `Not enough memory to start ${label} safely.`,
      '',
      `  available : ${verdict.availableMB} MB   (${verdict.source})`,
      `  needed    : ${verdict.needMB} MB`,
      `  short by  : ${verdict.shortfallMB} MB`,
      `  total RAM : ${verdict.totalMB} MB`,
      `  swap      : ${verdict.swapMB} MB${verdict.zeroSwap ? '   <-- ZERO SWAP: overshoot is an instant SIGKILL, not a slowdown' : ''}`,
    ];
    if (verdict.processes.ok) {
      lines.push(
        `  resident  : ${verdict.processes.chromeProcs} chrome processes ` +
          `(${verdict.processes.chromeBrowsers} browser instances) ~${verdict.processes.chromeRssMB} MB summed RSS, ` +
          `${verdict.processes.nodeProcs} node ~${verdict.processes.nodeRssMB} MB ` +
          '[summed RSS over-counts shared pages ~3x]',
      );
    }
    lines.push('', 'To free room:');
    for (const r of remedies(verdict)) lines.push(`  - ${r}`);
    lines.push('', `To override (at your own risk): assertResources({ needMB: <lower>, label: '${label}' })`);

    const err = new Error(lines.join('\n'));
    err.name = 'InsufficientResourcesError';
    err.verdict = verdict;
    throw err;
  }

  return verdict;
}

/** One-line summary for logs. Never throws. */
export function resourceSummary(opts = {}) {
  const v = checkResources(opts);
  const swap = v.zeroSwap ? 'NO SWAP' : `${v.swapMB} MB swap`;
  const state = v.ok ? (v.tight ? 'TIGHT' : 'ok') : 'INSUFFICIENT';
  return `[resources] ${state}: ${v.availableMB}/${v.totalMB} MB available, need ~${v.needMB} MB, ${swap}, ${v.processes.chromeProcs} chrome procs (~${v.processes.chromeRssMB} MB RSS upper bound)`;
}
