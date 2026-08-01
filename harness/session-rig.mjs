/*
 * session-rig.mjs — A WHOLE SESSION, IN REAL BROWSERS. Plan 0524.
 *
 * One control page and N participant displays, in real headless Chrome pages, driven through a
 * caller-supplied SCRIPT: seat everyone, load a module, stage, send, target, project, reload — and
 * screenshot every surface at every scene while RECORDING WHAT IT SAW.
 *
 * ⚠ THIS FILE IS DOMAIN-NEUTRAL AND MUST STAY THAT WAY. `harness/` is CORE, and core carries no
 * domain vocabulary (docs/naming-canon.md; enforced by t0514-28, which greps app/ harness/ mcp/
 * lib/ components/). The first draft of this rig hard-coded one campaign's module, seats and
 * narrative and BROKE THAT TEST — correctly. Everything specific to a deployment now arrives as a
 * `spec`, and the caller owns it. That is the same separation the invariant exists to protect, and
 * it is also why this rig can drive any module rather than one.
 *
 * ⚠ IT OBSERVES; IT DOES NOT ASSERT. Every observation lands in the returned report and the caller's
 * test file is where failure lives. `node harness/session-rig.mjs <specPath>` runs a spec standalone
 * to WATCH a session and collect screenshots — one implementation, two entry points.
 *
 * ── HAZARDS THIS FILE IS SHAPED AROUND ──────────────────────────────────────────────────────
 * 1. ⛔ THE REAL `modules/` DIRECTORY IS NEVER WRITTEN. It is gitignored with no undo, so the spec's
 *    module is COPIED to a mkdtemp dir and the source is checksummed before and after.
 * 2. ⚠ ONE BROWSER, MANY PAGES, and EVERY wait polls from this process via until()+evaluate —
 *    NEVER page.waitForFunction, which polls on requestAnimationFrame, WHICH CHROME PAUSES IN A
 *    BACKGROUNDED TAB. With five pages four are always backgrounded.
 * 3. ⚠ EPHEMERAL PORT ONLY. The deployment default is 3000 (plan 0522 P16.1) and a run must never
 *    collide with a live session.
 * 4. ⚠ EVERY browser call is BOUNDED. puppeteer's `evaluate` and `screenshot` have no default
 *    timeout, and one wedged call turns a run into a killed process that tells you nothing.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, until, wait } from './multi.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

export const SHOT_DIR = join(ROOT, 'test', 'screenshots', '0524');

/** Generous but finite. A hang must FAIL, not wedge the suite (plan 0524 §8.6). */
export const DEADLINE_MS = 8 * 60 * 1000;
const PATIENT = 20000;
/*
 * ⚠ FINDING, AND ITS CORRECTION — `captureBeyondViewport` IS THE WHOLE STORY.
 *
 * Runs 5 and 6 saw `page.screenshot()` stop settling partway through the session: the first four
 * player captures after a station projection blew a 25 s bound, and so did everything after them,
 * at 60 s too. The first diagnosis written here was "accumulated session state wedges capture on
 * this box" — plausible, and WRONG.
 *
 * The cause is puppeteer's default `captureBeyondViewport: true`, which captures the full
 * SCROLLABLE area rather than the viewport. With several 140–170 KB inline-SVG documents live
 * across five pages that never completes. Passing `captureBeyondViewport: false` fixes it outright:
 * full-screen capture went from ≥60 000 ms to **207 ms**, and the run from 515 s to 65 s.
 *
 * ⇒ Always pass it. And keep the bound short anyway — a capture that misses should cost seconds
 *   and a warning, never the run.
 */
const SHOT_BOUND_MS = 12000;


const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/**
 * ⚠ EVERY browser call in this rig is bounded. Run 4 hung with no error and no report: puppeteer's
 * `evaluate` and `screenshot` have NO default timeout, so one wedged call turns a 70-second rig
 * into a killed process that tells you nothing. A hang must FAIL, and it must fail SAYING WHERE.
 */
export function bounded(promise, ms, what) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`bounded: ${what} did not settle in ${ms}ms`)), ms); }),
  ]);
}
/** Bounded page.evaluate. Use this, never page.evaluate directly. */
export const ev = (page, fn, arg, what = 'evaluate') => bounded(page.evaluate(fn, arg), 15000, what);

// ── primitives ────────────────────────────────────────────────────────────────────────────────

/** Copy the campaign module into a throwaway dir. Returns {dir, sourceSha}. NEVER writes to modules/. */
export function stageModuleDir(moduleId) {
  const src = join(ROOT, 'modules', `${moduleId}.json`);
  if (!existsSync(src)) throw new Error(`module ${src} not found — this rig needs Bruce's working tree (modules/ is gitignored)`);
  const bytes = readFileSync(src);
  const dir = mkdtempSync(join(tmpdir(), 'ap-0524-modules-'));
  copyFileSync(src, join(dir, `${moduleId}.json`));
  return { dir, sourceSha: sha(bytes), sourceBytes: bytes.length, src };
}

/** The one representative content frame on a player page (the sandboxed iframe), or null. */
function frameOf(page) { return page.frames().find((f) => f !== page.mainFrame()) || null; }

/**
 * A stable signature of what a player is ACTUALLY LOOKING AT.
 * Used for "changed" and — more importantly — for "UNCHANGED": the staging assertion (t63) is only
 * as good as this, so it hashes the frame's whole rendered body rather than a title string that a
 * different beat might share.
 */
export async function frameSig(page) {
  const f = frameOf(page);
  if (!f) return { present: false, sha: null, len: 0, text: '' };
  try {
    const r = await bounded(f.evaluate(() => ({
      html: document.body ? document.body.innerHTML : '',
      text: (document.body ? (document.body.innerText || '') : '').replace(/\s+/g, ' ').trim().slice(0, 160),
    })), 10000, 'frameSig');
    return { present: true, sha: sha(r.html), len: r.html.length, text: r.text };
  } catch { return { present: false, sha: null, len: 0, text: '' }; }   // frame swapped mid-read
}

export async function allSigs(players) {
  const out = {};
  for (const p of players) out[p.seat.userId] = await frameSig(p.page);
  return out;
}

/** Open the GM control page on a GATED server — a control role MUST present the credential. */
export async function openControl(browser, server, token) {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`GM: ${e.message}`));
  await page.goto(`${server.url()}/control?userId=gm&name=GM&role=presenter&token=${encodeURIComponent(token)}`,
    { waitUntil: 'domcontentloaded', timeout: PATIENT });
  await until(async () => page.evaluate(() => !!(window.__gm && typeof window.__control === 'function')),
    { label: 'the control panel booted', timeout: PATIENT });
  return { page, errs };
}

/**
 * Open a player display, seated by SEAT LINK (`?stationUID=`).
 * ⚠ Participants present NO credential even on a gated server — that is the point of the role
 * split, and plan 0524 §7.4 flags gated+seat-link as a combination nothing else tests.
 */
export async function openPlayer(browser, server, seat) {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`${seat.userId}: ${e.message}`));
  await page.goto(`${server.url()}/?userId=${seat.userId}&name=${encodeURIComponent(seat.userName)}&stationUID=${seat.stationUid}`,
    { waitUntil: 'domcontentloaded', timeout: PATIENT });
  return { page, errs, seat };
}

/** Load the module the way a human does: pick it, let it validate, press Validate & Load. */
export async function loadModule(ctl, moduleId) {
  await until(async () => ctl.page.evaluate((id) => {
    const s = document.getElementById('mod-select');
    return !!(s && [...s.options].some((o) => o.value === id));
  }, moduleId), { label: `the picker lists ${moduleId}`, timeout: PATIENT });

  await ctl.page.evaluate((id) => {
    const s = document.getElementById('mod-select');
    s.value = id;
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }, moduleId);

  await until(async () => ctl.page.evaluate(() => {
    const b = document.getElementById('mod-load');
    return !!(b && !b.disabled);
  }), { label: 'the module validated and Load is enabled', timeout: PATIENT });

  await ctl.page.evaluate(() => document.getElementById('mod-load').click());
  await until(async () => ctl.page.evaluate(() => {
    const m = window.__gm.module();
    return !!(m && (m.beats || []).length > 0);
  }), { label: 'the module is loaded into the panel', timeout: PATIENT });

  return ctl.page.evaluate(() => {
    const m = window.__gm.module();
    return {
      beats: (m.beats || []).length,
      sections: (m.sections || []).length,
      title: (m.manifest && m.manifest.title) || null,
      valid: (document.getElementById('mod-valid') || {}).textContent || '',
      current: (document.getElementById('mod-current') || {}).textContent || '',
      outlineRows: document.querySelectorAll('#outline .beat').length,
      outlineSections: document.querySelectorAll('#outline details.sec').length,
    };
  });
}

/** Click a beat ROW — which STAGES it (P6/R4). It does not ship. */
export async function stageBeat(ctl, beatId) {
  const ok = await ctl.page.evaluate((id) => {
    const m = window.__gm.module();
    const i = (m.beats || []).findIndex((b) => b.id === id);
    if (i < 0) return false;
    const el = document.querySelector(`#outline .beat[data-i="${i}"]`);
    if (!el) return false;
    el.click();
    return true;
  }, beatId);
  if (!ok) throw new Error(`no beat row for ${beatId}`);
  await until(async () => ctl.page.evaluate(() => !!window.__gm.staged()),
    { label: `${beatId} is staged`, timeout: PATIENT });
  return stageState(ctl);
}

/** What the GM's own surface says about staged-vs-live, read as RENDERED TEXT, not as a variable. */
export async function stageState(ctl) {
  return ctl.page.evaluate(() => ({
    staged: !!window.__gm.staged(),
    stagedId: (window.__gm.staged() || {}).id || (window.__gm.staged() || {}).beatId || null,
    goArmed: (document.getElementById('btn-go') || {}).classList
      ? document.getElementById('btn-go').classList.contains('armed') : false,
    goText: (document.getElementById('btn-go') || {}).textContent || '',
    goDisabled: !!(document.getElementById('btn-go') || {}).disabled,
    pvstate: (document.getElementById('pvstate') || {}).textContent || '',
    gostat: (document.getElementById('gostat') || {}).textContent || '',
    target: window.__gm.target(),
  }));
}

/** Press GO. Ships the staged beat to the current target. */
export async function pressGo(ctl) {
  await ctl.page.evaluate(() => document.getElementById('btn-go').click());
  await until(async () => ctl.page.evaluate(() => !window.__gm.staged()),
    { label: 'GO cleared the staged beat', timeout: PATIENT });
  await wait(250);   // let the receipt render
  return ctl.page.evaluate(() => ({
    lastSent: window.__gm.lastSent(),
    gostat: (document.getElementById('gostat') || {}).textContent || '',
    pvstate: (document.getElementById('pvstate') || {}).textContent || '',
  }));
}

/** Stage a beat and ship it, in one gesture. Returns {staged, sent}. */
export async function showBeat(ctl, beatId) {
  const staged = await stageBeat(ctl, beatId);
  const sent = await pressGo(ctl);
  return { staged, sent };
}

export async function setTarget(ctl, t) {
  await ctl.page.evaluate((x) => window.__gm.setTarget(x), t);
  await wait(120);
  return ctl.page.evaluate(() => ({ target: window.__gm.target(), array: window.__gm.targetArray() }));
}

/** Wait until a specific player's rendered frame differs from a captured signature. */
export async function waitChanged(player, before, label) {
  let last = null;
  try {
    await until(async () => {
      last = await frameSig(player.page);
      return last.present && last.sha && last.sha !== before.sha;
    }, { label: label || `${player.seat.userId}'s screen changed`, timeout: PATIENT });
  } catch (e) {
    // A timeout here is nearly always the DETECTOR, not the app. Say what was actually seen.
    throw new Error(`${e.message} — before=${JSON.stringify(before)} last=${JSON.stringify(last)} frames=${player.page.frames().length}`);
  }
  return last;
}

// ── the rig ───────────────────────────────────────────────────────────────────────────────────

export async function runSession(spec, { shotDir = SHOT_DIR, keepOpen = false } = {}) {
  const { moduleId, seats: SEATS, emptyStationUid: EMPTY_STATION_UID, beats: B, notes: N = {} } = spec;
  const t0 = Date.now();
  const report = {
    startedAt: new Date(t0).toISOString(), moduleId, specName: spec.name || moduleId,
    scenes: [], shots: [], warnings: [], pageErrors: [], timings: {}, findings: {},
  };
  const scene = (name, note, data) => {
    const s = { n: report.scenes.length, name, note, at: Date.now() - t0, ...data };
    report.scenes.push(s);
    return s;
  };
  mkdirSync(shotDir, { recursive: true });

  const staged = stageModuleDir(moduleId);
  const prevModulesDir = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_MODULES_DIR = staged.dir;
  report.module = { id: moduleId, sourceSha: staged.sourceSha, sourceBytes: staged.sourceBytes, tempDir: staged.dir };

  const CONTROL_TOKEN = 'rig-0524-' + Math.random().toString(36).slice(2, 10);
  const { createServer } = await import('../app/server.mjs');
  /*
   * ⚠ FOUND ON THE FIRST RUN: `sessionLogDir` must be passed EXPLICITLY or the log comes back
   * DISABLED and t71 asserts over an empty set that looks like a pass. That is P16.2's deliberate
   * asymmetry — a bare createServer() (i.e. every test in the suite) writes nothing, and only the
   * DEPLOYMENT paths (the CLI self-run and presenter_start) resolve a directory and pass it in.
   * A rig that wants to exercise the durable log is a deployment, so it must say so.
   */
  const logDir = mkdtempSync(join(tmpdir(), 'ap-0524-sessionlog-'));
  const server = await createServer({ port: 0, controlToken: CONTROL_TOKEN, sessionLogDir: logDir });
  report.sessionLogDir = logDir;

  let browser = null;
  const players = [];
  let ctl = null;
  const shot = async (page, name) => {
    const file = join(shotDir, `${String(report.shots.length).padStart(2, '0')}-${name}.png`);
    try { await bounded(page.screenshot({ path: file, captureBeyondViewport: false }), SHOT_BOUND_MS, `screenshot ${name}`); report.shots.push(file); }
    catch (e) { report.warnings.push(`screenshot ${name}: ${e.message}`); }
    return file;
  };
  const shootAll = async (tag) => {
    await shot(ctl.page, `${tag}__gm`);
    for (const p of players) await shot(p.page, `${tag}__${p.seat.userId}`);
  };
  const deadline = () => { if (Date.now() - t0 > DEADLINE_MS) throw new Error(`rig exceeded ${DEADLINE_MS}ms — failing rather than hanging`); };

  try {
    browser = await launch();

    // ── S0 boot — the GM alone ────────────────────────────────────────────────────────────────
    ctl = await openControl(browser, server, CONTROL_TOKEN);
    const logBaseline = await readSessionLog(server, CONTROL_TOKEN);
    scene('boot', N['boot'] || '', {
      stations: await ctl.page.evaluate(() => (window.__gm.stations() || []).length),
      stationWord: await ctl.page.evaluate(() => window.__gm.stationWord()),
      presence: server.presence().length,
      logBaselineEntries: logBaseline.entries.length,
      logEnabled: logBaseline.enabled,
    });
    report.findings.logBaseline = logBaseline;
    await shot(ctl.page, 'boot__gm');
    deadline();

    // ── S1 seated — four players arrive on seat links ────────────────────────────────────────
    for (const seat of SEATS) players.push(await openPlayer(browser, server, seat));
    await until(() => server.presence().length >= 5, { label: 'all five identities on the roster', timeout: PATIENT });
    await wait(500);
    const seatedNow = server.stations().seats.map((s) => ({ userId: s.userId, stationUid: s.stationUid }));
    /*
     * ⚠ FOUND ON THE FIRST RUN — A SEAT LINK REWRITES THE USER ID.
     * We ask for `?userId=participant-a`; the server reports `sensors-participant-a`. That is 0514 §5.1
     * working as designed (a seat link RE-DERIVES identity from the seat on hello), but it means
     * a caller-supplied userId is NOT the id the server holds, and anything keyed on it silently
     * addresses nobody. Recorded per-seat so every server-side lookup uses the DERIVED id.
     */
    for (const p of players) {
      const row = server.presence().find((u) => (u.stationUid === p.seat.stationUid));
      p.serverUserId = row ? row.userId : null;
    }
    report.findings.seatLinkIdentity = players.map((p) => ({
      asked: p.seat.userId, derived: p.serverUserId, stationUid: p.seat.stationUid,
      rewritten: p.serverUserId !== p.seat.userId,
    }));
    const seatLabels = {};
    for (const p of players) {
      seatLabels[p.seat.userId] = await p.page.evaluate(() => {
        const el = document.getElementById('ap-seat');
        const vis = el && typeof el.checkVisibility === 'function' ? el.checkVisibility() : null;
        return { text: el ? (el.textContent || '').trim() : null, title: el ? el.title : null, visible: vis, hasApi: typeof Element.prototype.checkVisibility === 'function' };
      });
    }
    scene('seated', N['seated'] || '', {
      presence: server.presence().length,
      rosterRows: await ctl.page.evaluate(() => document.querySelectorAll('#users .user').length),
      seats: seatedNow, seatLabels,
    });
    await shootAll('seated');
    deadline();

    // ── S2 module loaded ─────────────────────────────────────────────────────────────────────
    const loaded = await loadModule(ctl, moduleId);
    scene('module-loaded', N['module-loaded'] || '', loaded);
    await shot(ctl.page, 'module-loaded__gm');
    deadline();

    // ── S3 arrival — ⚠ NOBODY SENT THIS. The DEFAULT-BEAT CASCADE did. ───────────────────────
    // Found the hard way on the rig's first run: `manifest.defaultBeatId` is `n1-viewscreen`, so
    // loading the module puts the viewscreen on every player's screen BEFORE the GM sends
    // anything. An earlier draft of this rig "sent" n1-viewscreen here and then waited for the
    // screens to change — they never did, because they were already showing it. That was a defect
    // in the SCRIPT, not in the app, and it is exactly the class of thing this rig exists to find.
    // So this scene ASSERTS THE CASCADE instead of sending, and the first true send is S5.
    await setTarget(ctl, 'all');
    await until(async () => {
      const sigs = await allSigs(players);
      return players.every((p) => sigs[p.seat.userId].present && sigs[p.seat.userId].len > 1000);
    }, { label: 'the default beat cascaded to every player', timeout: PATIENT });
    const afterArrival = await allSigs(players);
    report.findings.defaultBeatCascade = {
      defaultBeatId: await ctl.page.evaluate(() => {
        const m = window.__gm.module(); return (m && m.manifest && m.manifest.defaultBeatId) || null;
      }),
      lensBeforeAnySend: await ctl.page.evaluate(() => window.__gm.lastSent()),
      lens: Object.fromEntries(Object.entries(afterArrival).map(([k, v]) => [k, v.len])),
      allPresent: players.every((p) => afterArrival[p.seat.userId].present),
    };
    scene('arrival', N['arrival'] || '', {
      cascade: report.findings.defaultBeatCascade, sigs: afterArrival,
    });
    await shootAll('arrival');
    deadline();

    // ── S4 ⏸ STAGED, NOT SENT — the core assertion ───────────────────────────────────────────
    const beforeStage = await allSigs(players);
    const stagedState = await stageBeat(ctl, B.staged);
    await wait(900);   // deliberately generous: give a leak time to appear rather than racing it
    const duringStage = await allSigs(players);
    const leaked = players.filter((p) => duringStage[p.seat.userId].sha !== beforeStage[p.seat.userId].sha)
      .map((p) => p.seat.userId);
    scene('staged-not-sent', N['staged-not-sent'] || '', {
      ...stagedState, leaked, before: beforeStage, during: duringStage,
    });
    report.findings.stagingLeak = leaked;
    await shootAll('staged-not-sent');
    deadline();

    // ── S5 GO ────────────────────────────────────────────────────────────────────────────────
    const sentSweep = await pressGo(ctl);
    for (const p of players) await waitChanged(p, beforeStage[p.seat.userId], `${p.seat.userId} sees the first sent beat`);
    scene('go', N['go'] || '', { ...sentSweep, sigs: await allSigs(players) });
    await shootAll('go');
    deadline();

    // ── S6 the survey ────────────────────────────────────────────────────────────────────────
    const surveyBeats = B.survey;
    const surveyTimings = [];
    for (const id of surveyBeats) {
      const before = await frameSig(players[0].page);
      const tb = Date.now();
      await showBeat(ctl, id);
      await waitChanged(players[0], before, `${id} reached the first seat`);
      surveyTimings.push({ id, ms: Date.now() - tb });
      deadline();
    }
    report.timings.perBeatMs = surveyTimings;
    scene('survey', N['survey'] || '', {
      beats: surveyBeats, timings: surveyTimings, sigs: await allSigs(players),
    });
    await shootAll('survey');

    // ── S7 site alpha fails — TO SENSORS ONLY ────────────────────────────────────────────────
    const beforeAlpha = await allSigs(players);
    const tgtSensors = await setTarget(ctl, `station:${SEATS[0].stationUid}`);
    await showBeat(ctl, B.perSeat[0]);
    await showBeat(ctl, B.perSeat[1]);
    await waitChanged(players[0], beforeAlpha[players[0].seat.userId], 'the targeted seat changed');
    await wait(700);
    const afterAlpha = await allSigs(players);
    const alphaMoved = players.filter((p) => afterAlpha[p.seat.userId].sha !== beforeAlpha[p.seat.userId].sha)
      .map((p) => p.seat.userId);
    scene('site-alpha-fails', N['site-alpha-fails'] || '', {
      target: tgtSensors, moved: alphaMoved, before: beforeAlpha, after: afterAlpha,
    });
    report.findings.perSeatMoved = alphaMoved;
    await shootAll('site-alpha-fails');
    deadline();

    // ── S8 site beta passes ──────────────────────────────────────────────────────────────────
    await setTarget(ctl, 'all');
    const beforeBeta = await allSigs(players);
    await showBeat(ctl, B.broadcast[0]);
    const betaSent = await showBeat(ctl, B.broadcast[1]);
    for (const p of players) await waitChanged(p, beforeBeta[p.seat.userId], `${p.seat.userId} sees the broadcast`);
    scene('site-beta-passes', N['site-beta-passes'] || '', {
      ...betaSent, sigs: await allSigs(players),
    });
    await shootAll('site-beta-passes');
    deadline();

    // ── S9 ⚠ THE EMPTY STATION — the one that used to succeed silently ───────────────────────
    const beforeEmpty = await allSigs(players);
    const tgtEmpty = await setTarget(ctl, `station:${EMPTY_STATION_UID}`);
    const emptyStaged = await stageBeat(ctl, B.broadcast[0]);
    const emptySent = await pressGo(ctl);
    await wait(900);
    const afterEmpty = await allSigs(players);
    const emptyMoved = players.filter((p) => afterEmpty[p.seat.userId].sha !== beforeEmpty[p.seat.userId].sha)
      .map((p) => p.seat.userId);
    scene('empty-station', N['empty-station'] || '', {
      target: tgtEmpty, staged: emptyStaged, sent: emptySent, moved: emptyMoved,
      gostat: emptySent.gostat,
    });
    report.findings.emptyStation = { receipt: emptySent.gostat, lastSent: emptySent.lastSent, moved: emptyMoved };
    await shootAll('empty-station');
    deadline();

    // ── S10 the plant ────────────────────────────────────────────────────────────────────────
    await setTarget(ctl, 'all');
    const beforePlant = await allSigs(players);
    await showBeat(ctl, B.mid[0]);
    await showBeat(ctl, B.mid[1]);
    for (const p of players) await waitChanged(p, beforePlant[p.seat.userId], `${p.seat.userId} sees the mid-deck beats`);
    scene('plant-online', N['plant-online'] || '', {
      sigs: await allSigs(players),
    });
    await shootAll('plant-online');
    deadline();

    // ── S11 the pulse, and an ON-DEMAND beat ─────────────────────────────────────────────────
    const beforePulse = await allSigs(players);
    await showBeat(ctl, B.beforeArrow);
    for (const p of players) await waitChanged(p, beforePulse[p.seat.userId], `${p.seat.userId} sees the pre-arrow beat`);
    // R4: the arrow SHIPS immediately. From n4-anomaly the linear next must NOT be the on-demand beat.
    const beforeArrow = await allSigs(players);
    const arrowState = await ctl.page.evaluate(() => {
      const before = window.__gm.cur();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      return { before };
    });
    await wait(900);
    const afterArrow = await allSigs(players);
    const arrowShipped = players.some((p) => afterArrow[p.seat.userId].sha !== beforeArrow[p.seat.userId].sha);
    const arrowStaged = await ctl.page.evaluate(() => !!window.__gm.staged());
    const arrowLanded = await ctl.page.evaluate(() => {
      const m = window.__gm.module(); const i = window.__gm.cur();
      return { index: i, id: (m.beats[i] || {}).id || null, onDemand: !!(m.beats[i] || {}).onDemand };
    });
    /*
     * ⚠⚠ RECORDED BEFORE THE NEXT AWAIT, DELIBERATELY. Run 3 lost this finding because the scene
     * threw further down and the record was written after. A finding you only keep when the run
     * succeeds is a finding you will lose exactly when it matters.
     *
     * ⚠⚠ AND THIS IS THE FINDING: `n4-coherent` and `n4-drivers` are declared `onDemand: true`,
     * and ArrowRight from `n4-anomaly` (index 14) walks straight onto index 15 — an on-demand beat
     * — AND SHIPS IT. "On demand" is honoured by the picker's authoring intent and by nothing in
     * the navigation. The rig's own script tripped over it: it asked to show `n4-coherent` and the
     * screens never changed, because the arrow had already put it there.
     */
    report.findings.arrow = {
      shipped: arrowShipped, stagedAfter: arrowStaged, landed: arrowLanded,
      linearWalkIncludesOnDemand: !!(arrowLanded && arrowLanded.onDemand),
    };

    // Reach an on-demand beat by EXPLICIT CLICK — the only thing "on demand" can mean.
    // ⚠ Deliberately `n4-drivers`, not `n4-coherent`: the arrow may already have shipped the
    // latter, and a test that asserts "the screen changed" against a beat already on the screen
    // proves nothing and fails for the wrong reason.
    const beforeOnDemand = await allSigs(players);
    const onDemand = await showBeat(ctl, B.onDemand);
    for (const p of players) await waitChanged(p, beforeOnDemand[p.seat.userId], `${p.seat.userId} sees the on-demand beat`);
    report.findings.onDemandReachable = { beatId: B.onDemand, sent: onDemand.sent };
    scene('the-pulse', N['the-pulse'] || '', {
      arrow: { ...arrowState, ...report.findings.arrow }, onDemand, sigs: await allSigs(players),
    });
    await shootAll('the-pulse');
    deadline();

    // ── S12 the station tier, the roster actions, full screen ────────────────────────────────
    const tier = await ctl.page.evaluate(() => {
      const wrap = document.getElementById('st-tier-wrap');
      const det = document.getElementById('st-tier');
      return {
        present: !!wrap,
        visible: wrap && typeof wrap.checkVisibility === 'function' ? wrap.checkVisibility() : null,
        openBefore: !!(det && det.open),
        title: (document.getElementById('st-tier-title') || {}).textContent || '',
        count: (document.getElementById('st-tier-count') || {}).textContent || '',
      };
    });
    const seatsBeforeProjection = server.stations().seats.map((s) => ({ userId: s.userId, stationUid: s.stationUid }));
    const beforeProjection = await allSigs(players);
    const projected = await ctl.page.evaluate((uid) => {
      document.getElementById('st-tier').open = true;
      const btn = document.querySelector(`#st-tier-list [data-project="${uid}"]`);
      if (!btn) return { pressed: false };
      btn.click();
      return { pressed: true };
    }, SEATS[0].stationUid);
    await wait(1200);
    const seatsAfterProjection = server.stations().seats.map((s) => ({ userId: s.userId, stationUid: s.stationUid }));
    const projectionReceipt = await ctl.page.evaluate(() => (document.getElementById('st-stat') || {}).textContent || '');
    const afterProjection = await allSigs(players);
    report.findings.projection = {
      tier, projected, receipt: projectionReceipt,
      seatsBefore: seatsBeforeProjection, seatsAfter: seatsAfterProjection,
      seatsUnchanged: JSON.stringify(seatsBeforeProjection) === JSON.stringify(seatsAfterProjection),
      roomChanged: players.filter((p) => afterProjection[p.seat.userId].sha !== beforeProjection[p.seat.userId].sha).map((p) => p.seat.userId),
    };
    await shootAll('station-tier');


    // ── S12b a player RELOADS — does the roster double-count? ────────────────────────────────
    const rosterBefore = await ev(ctl.page, () => document.querySelectorAll('#users .user').length, undefined, 'rosterBefore');
    await bounded(players[1].page.reload({ waitUntil: 'domcontentloaded', timeout: PATIENT }), PATIENT + 5000, 'player reload');
    await wait(2000);
    const rosterAfter = await ev(ctl.page, () => document.querySelectorAll('#users .user').length, undefined, 'rosterAfter');
    const presenceAfter = server.presence().length;
    const contested = await ev(ctl.page, () => [...document.querySelectorAll('#users .user')].map((el) => (el.textContent || '')).filter((t) => /\u00d7\d/.test(t)), undefined, 'contested rows');
    report.findings.reload = { rosterBefore, rosterAfter, presenceAfter, contested };
    await shootAll('after-reload');
    deadline();

    // ── S12c the last beat ───────────────────────────────────────────────────────────────────
    await setTarget(ctl, 'all');
    const beforeSuccess = await allSigs(players);
    await showBeat(ctl, B.finale);
    for (const p of players) {
      try { await waitChanged(p, beforeSuccess[p.seat.userId], `${p.seat.userId} sees the finale`); }
      catch (e) { report.warnings.push(`n5-success did not reach ${p.seat.userId}: ${e.message}`); }
    }
    scene('station-tier-and-close', N['station-tier-and-close'] || '', {
      tier, projection: report.findings.projection,
      reload: report.findings.reload, sigs: await allSigs(players),
    });
    await shootAll('in-production');

    /*
     * ── FULL SCREEN LAST, AND TIMED. ⚠ FINDING, run 5 ────────────────────────────────────────
     * Entering the full-screen preview LATE in a long session wedges `page.screenshot()` on the
     * GM page: every capture after it — including after ESC — blew a 25 s bound, which is where
     * 175 of that run's 318 seconds went. A short isolated probe does NOT reproduce it (normal
     * 237 ms, full screen 1.5 s, after exit 1.5 s), so it is a property of the accumulated
     * session, not of the feature.
     *
     * So this block is LAST — no other screenshot can be poisoned by it — and it is TIMED against
     * a long bound, because "slow" and "wedged" are different defects and the number tells them
     * apart. The functional half (does ESC exit?) is asserted from the page state either way.
     */
    await ev(ctl.page, () => window.__gm.setFullscreen(true), undefined, 'setFullscreen(true)');
    await wait(400);
    const fsOn = await ev(ctl.page, () => window.__gm.fullscreen(), undefined, 'fullscreen() on');
    const fsShotT0 = Date.now();
    let fsShotMs = null, fsShotOk = false;
    try {
      await bounded(ctl.page.screenshot({ path: join(shotDir, '99-full-screen__gm.png') }), 15000, 'full-screen screenshot');
      fsShotOk = true; report.shots.push(join(shotDir, '99-full-screen__gm.png'));
    } catch (e) { report.warnings.push(`full-screen screenshot: ${e.message}`); }
    fsShotMs = Date.now() - fsShotT0;
    await ev(ctl.page, () => window.__gm.setFullscreen(false), undefined, 'setFullscreen(false)');
    await wait(300);
    const fsOff = await ev(ctl.page, () => window.__gm.fullscreen(), undefined, 'fullscreen() off');
    const afterT0 = Date.now();
    let afterShotOk = false;
    try {
      await bounded(ctl.page.screenshot({ path: join(shotDir, '99-after-esc__gm.png') }), 15000, 'post-exit screenshot');
      afterShotOk = true; report.shots.push(join(shotDir, '99-after-esc__gm.png'));
    } catch (e) { report.warnings.push(`post-exit screenshot: ${e.message}`); }
    report.findings.fullscreen = {
      on: fsOn, offAfterExit: fsOff,
      captureWhileFullScreen: { ok: fsShotOk, ms: fsShotMs },
      captureAfterExit: { ok: afterShotOk, ms: Date.now() - afterT0 },
      note: 'ESC/exit is asserted from page state; the capture timings are the separate screenshot-wedge finding',
    };

    // ── the durable log — the first real session it has ever seen ────────────────────────────
    const logAfter = await readSessionLog(server, CONTROL_TOKEN);
    const logAnon = await readSessionLog(server, null);
    report.findings.sessionLog = {
      baselineEntries: logBaseline.entries.length,
      afterEntries: logAfter.entries.length,
      appended: logAfter.entries.length - logBaseline.entries.length,
      enabled: logAfter.enabled,
      dir: logAfter.sessionLogDir,
      stats: logAfter.stats,
      anonStatus: logAnon.status,
      anonRefused: logAnon.status !== 200,
    };

    // ⛔ the campaign module must be byte-identical to how we found it
    const nowSha = sha(readFileSync(staged.src));
    report.module.sourceShaAfter = nowSha;
    report.module.untouched = nowSha === staged.sourceSha;

    report.pageErrors = [...ctl.errs, ...players.flatMap((p) => p.errs)];
    report.durationMs = Date.now() - t0;
    report.ok = true;
  } catch (e) {
    report.ok = false;
    report.error = String((e && e.stack) || e);
    try { if (ctl) await shot(ctl.page, 'FAILURE__gm'); } catch {}
    try { for (const p of players) await shot(p.page, `FAILURE__${p.seat.userId}`); } catch {}
    report.durationMs = Date.now() - t0;
  } finally {
    if (!keepOpen) {
      try { if (browser) await browser.close(); } catch {}
    }
    try { await server.close(); } catch {}
    if (prevModulesDir === undefined) delete process.env.PRESENTER_MODULES_DIR;
    else process.env.PRESENTER_MODULES_DIR = prevModulesDir;
    try { rmSync(staged.dir, { recursive: true, force: true }); } catch {}
  }
  return report;
}

/** GET /api/session-log, with or without the control credential. Never throws. */
async function readSessionLog(server, token) {
  const url = `${server.url()}/api/session-log?limit=2000` + (token ? `&token=${encodeURIComponent(token)}` : '');
  try {
    const res = await fetch(url);
    const status = res.status;
    let body = {};
    try { body = await res.json(); } catch {}
    return { status, entries: body.entries || [], enabled: !!body.enabled, sessionLogDir: body.sessionLogDir || null, stats: body.stats || null, error: body.error || null };
  } catch (e) { return { status: 0, entries: [], enabled: false, sessionLogDir: null, stats: null, error: String(e && e.message) }; }
}

// ── standalone entry point ────────────────────────────────────────────────────────────────────

export function writeReport(report, dir = SHOT_DIR) {
  const f = (o) => JSON.stringify(o, null, 2);
  const lines = [];
  lines.push(`# Plan 0524 — functional session run: ${report.specName}\n`);
  lines.push(`**${report.ok ? '✅ completed' : '❌ FAILED'}** · ${report.startedAt} · ${(report.durationMs / 1000).toFixed(1)}s · ${report.shots.length} screenshots\n`);
  if (report.error) lines.push(`\n\`\`\`\n${report.error}\n\`\`\`\n`);
  lines.push(`\n## Module\n\n- \`${report.module?.id}\` — ${report.module?.sourceBytes} bytes, sha \`${report.module?.sourceSha}\``);
  lines.push(`- **campaign source untouched: ${report.module?.untouched ? 'YES' : '⛔ NO'}** (copied to a throwaway dir; never written)\n`);
  lines.push(`\n## Scenes\n`);
  for (const s of report.scenes) {
    lines.push(`\n### S${s.n} — \`${s.name}\`  ·  +${(s.at / 1000).toFixed(1)}s\n`);
    lines.push(`> ${s.note}\n`);
    const { n, name, note, at, sigs, before, during, after, ...rest } = s;
    if (Object.keys(rest).length) lines.push(`\n\`\`\`json\n${f(rest)}\n\`\`\`\n`);
  }
  lines.push(`\n## Findings — the §7 suspicions\n`);
  lines.push(`\n\`\`\`json\n${f(report.findings)}\n\`\`\`\n`);
  lines.push(`\n## Timings\n\n\`\`\`json\n${f(report.timings)}\n\`\`\`\n`);
  if (report.warnings.length) lines.push(`\n## Warnings\n\n${report.warnings.map((w) => `- ${w}`).join('\n')}\n`);
  if (report.pageErrors.length) lines.push(`\n## Page errors\n\n${report.pageErrors.map((w) => `- ${w}`).join('\n')}\n`);
  lines.push(`\n## Screenshots\n\n${report.shots.map((s) => `- \`${s.split('/').pop()}\``).join('\n')}\n`);
  const out = join(dir, 'REPORT.md');
  mkdirSync(dir, { recursive: true });
  writeFileSync(out, lines.join('\n'));
  writeFileSync(join(dir, 'report.json'), f(report));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const specPath = process.argv[2];
  if (!specPath) { console.log('usage: node harness/session-rig.mjs <path-to-spec.mjs>'); process.exit(2); }
  const { default: spec } = await import(specPath.startsWith('/') ? specPath : join(process.cwd(), specPath));
  const report = await runSession(spec);
  const out = writeReport(report);
  console.log(`
${report.ok ? 'OK' : 'FAILED'} — ${report.scenes.length} scenes, ${report.shots.length} shots, ${(report.durationMs / 1000).toFixed(1)}s`);
  console.log(`report: ${out}`);
  if (!report.ok) { console.log(report.error); process.exit(1); }
}
