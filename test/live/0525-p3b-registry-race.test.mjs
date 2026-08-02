/*
 * Plan 0525 P3b — t81: THE NEGATIVE CHECK FOR A WAIT.
 *
 * `harness/session-rig.mjs` `openControl()` used to return the moment `window.__gm` and
 * `window.__control` EXISTED. Both are assigned at the bottom of the control page's own script, so
 * that is true as soon as the document finishes evaluating — before the socket has opened and long
 * before the server's `welcome` frame comes back. The DECLARED STATION REGISTRY rides that frame
 * (0514 §8), so until it lands the page truthfully holds `stations = []` and the literal default
 * word `'Stations'`. Every read taken straight after `openControl` was therefore sampling a page
 * that had booted and not yet connected, and under full-suite load t78's `boot.stations === 6`
 * lost the race often enough to look like a flaky test. It was not one: the INSTRUMENT was asking
 * before the answer existed.
 *
 * ⛓ A WAIT THAT WAS NEVER OBSERVED TO BE LOAD-BEARING IS A COMMENT. So this test does not hope for
 * the race and it does not depend on how busy the box is — IT FORCES IT, and would force it on an
 * idle machine just as hard:
 *
 *   `evaluateOnNewDocument` installs a shim over the `WebSocket.prototype.onmessage` SETTER before
 *   the control page's script runs. Every inbound frame is QUEUED — in order, none dropped — and
 *   the queue is not flushed to the page's real handler until HOLD_MS after the first frame
 *   arrives. That is a slow network, exactly: the page boots, `__gm` appears, and `welcome` is
 *   demonstrably still in flight. The shim records when it held and when it flushed, and this test
 *   asserts the INTERVAL between them — a shim that silently failed to engage would otherwise turn
 *   this proof into a coincidence.
 *
 * ⚠ AND NOTHING HERE IS ASSERTED AGAINST WALL-CLOCK SPEED. The claim is that the un-waited read
 * happened BEFORE the welcome, never that it happened quickly. A first draft also demanded that a
 * frame had already been queued by then; under full-suite load the old condition can go true before
 * the socket has delivered anything at all — the same race, further from the answer — and that
 * draft failed in the full suite while passing alone. It was asserting HOW EARLY the read was when
 * the claim is only that it was TOO early.
 *
 * Then, ON ONE PAGE, in this order:
 *   (1) the OLD condition — `__gm` exists — and a bare read: `stations().length` is **0** and the
 *       word is the hard-coded default. The un-waited read is wrong, and provably so.
 *   (2) the NEW condition on that SAME page: 6 posts and the deployment's own word. Same page,
 *       same server, same registry — so (1) was prematurity, not absence.
 *   (3) and the shipped `openControl` itself, unmodified, on a second page under the same hold:
 *       it returns already-correct. This is the half that regresses if the wait is removed.
 *
 * ⚠ `openControl` is called through a duck-typed `browser` whose `newPage()` installs the shim.
 * The function under test is the REAL one, byte for byte — not a copy of it with a wait bolted on.
 * ⚠ Waits are until()+evaluate, never page.waitForFunction: Chrome pauses rAF in a backgrounded
 * tab and this test always has one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, check as expect } from '../../harness/test.mjs';
import { launch, until } from '../../harness/multi.mjs';
import { openControl } from '../../harness/session-rig.mjs';
import { fixturePluginsDir, STATION_WORD } from './0525-fixture-spec.mjs';

/** Long enough that no boot can outrun it, short enough to stay well inside the rig's 20 s waits. */
const HOLD_MS = 3000;
/** What the control page holds before any welcome — control.html: `stations=[], stationWord='Stations'`. */
const UNCONNECTED_WORD = 'Stations';

/**
 * Hold every inbound socket frame for `ms` after the first one, then release them IN ORDER.
 * Installed as an `evaluateOnNewDocument` initialiser, so it is in place before the page's script
 * assigns `ws.onmessage` — which is the setter this wraps.
 */
function holdSocketFrames(ms) {
  const proto = window.WebSocket.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'onmessage');
  window.__rigHold = { installed: true, queued: 0, heldAt: null, flushedAt: null, open: false };
  Object.defineProperty(proto, 'onmessage', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(fn) {
      const sock = this;
      desc.set.call(this, function (evt) {
        const H = window.__rigHold;
        if (H.open) return fn.call(sock, evt);
        H.q = H.q || [];
        H.q.push(evt);
        H.queued = H.q.length;
        if (H.q.length === 1) {
          H.heldAt = Date.now();
          setTimeout(function () {
            H.open = true;
            H.flushedAt = Date.now();
            const batch = H.q.splice(0);
            for (const e of batch) fn.call(sock, e);
          }, ms);
        }
      });
    },
  });
}

/** Everything the page knows about the registry, in ONE read. */
const registryState = (page) => page.evaluate(() => ({
  stations: (window.__gm.stations() || []).length,
  word: window.__gm.stationWord(),
  role: window.__ctlAuth ? window.__ctlAuth.role() : undefined,
  hold: window.__rigHold
    ? { installed: true, queued: window.__rigHold.queued, held: window.__rigHold.heldAt != null, flushed: window.__rigHold.flushedAt != null,
        withheldMs: (window.__rigHold.heldAt != null && window.__rigHold.flushedAt != null) ? window.__rigHold.flushedAt - window.__rigHold.heldAt : null }
    : { installed: false },
}));

test('0525 t81 — openControl waits for the welcome frame: held on purpose, the un-waited read is 0 and the waited read is the whole registry', async () => {
  const pluginsDir = fixturePluginsDir();
  const manifest = JSON.parse(readFileSync(join(pluginsDir, 'rigfixture', 'plugin.json'), 'utf8'));
  const EXPECT_STATIONS = manifest.stations.length;
  expect('the fixture deployment declares six posts (the count t78 asserts at boot)', EXPECT_STATIONS === 6, String(EXPECT_STATIONS));

  const prevPlugins = process.env.PRESENTER_PLUGINS_DIR;
  process.env.PRESENTER_PLUGINS_DIR = pluginsDir;
  const { createServer } = await import('../../app/server.mjs');
  const TOKEN = 't79-' + Math.random().toString(36).slice(2, 10);
  let server;
  try { server = await createServer({ port: 0, controlToken: TOKEN }); }
  finally {
    if (prevPlugins === undefined) delete process.env.PRESENTER_PLUGINS_DIR;
    else process.env.PRESENTER_PLUGINS_DIR = prevPlugins;
  }

  // A duck-typed browser: `openControl` takes only `newPage()` from it, so the shim reaches the
  // page the REAL function opens without that function knowing anything about this test.
  const browser = await launch();
  const held = {
    newPage: async () => {
      const p = await browser.newPage();
      await p.evaluateOnNewDocument(holdSocketFrames, HOLD_MS);
      return p;
    },
  };

  try {
    // ── (1) the OLD condition, and the read it licensed ──────────────────────────────────────
    const page = await held.newPage();
    const t0 = Date.now();
    await page.goto(`${server.url()}/control?userId=gm&name=GM&role=presenter&token=${encodeURIComponent(TOKEN)}`,
      { waitUntil: 'domcontentloaded', timeout: 20000 });
    await until(async () => page.evaluate(() => !!(window.__gm && typeof window.__control === 'function')),
      { label: 'the control panel booted (the OLD condition, verbatim)', timeout: 20000 });
    const bootedAt = Date.now() - t0;
    const unwaited = await registryState(page);

    /*
     * ⚠ ASSERTED AS `flushed === false`, DELIBERATELY NOT `held === true`. Under full-suite load
     * the old condition can go true before the socket has delivered ANY frame at all — queue
     * empty, nothing yet held — which is the same race, further from the answer, not a different
     * one. A first draft demanded a queued frame here and failed in the full suite for exactly
     * that reason: it was asserting HOW EARLY the read was, when the claim is only that it was
     * too early. The hold's own engagement is proved below, from the withheld interval.
     */
    expect('the frame hold is installed on this page — this proof is not a coincidence',
      unwaited.hold.installed === true, JSON.stringify(unwaited.hold));
    expect('…and the welcome had NOT been delivered when the old condition went true',
      unwaited.hold.flushed === false && unwaited.role == null, JSON.stringify(unwaited));
    expect(`⛔ the un-waited read returns 0 posts, not ${EXPECT_STATIONS}`,
      unwaited.stations === 0, String(unwaited.stations));
    expect(`⛔ …and the un-waited word is the page's hard-coded default "${UNCONNECTED_WORD}", not the deployment's "${STATION_WORD}"`,
      unwaited.word === UNCONNECTED_WORD, `${unwaited.word} (old condition went true ${bootedAt}ms after goto)`);

    // ── (2) the NEW condition, SAME page — prematurity, not absence ──────────────────────────
    await until(async () => page.evaluate(() => !!(window.__ctlAuth && window.__ctlAuth.role() != null)),
      { label: 'the welcome frame arrived (the NEW condition, verbatim)', timeout: 20000 });
    const waited = await registryState(page);
    expect('the hold flushed — the same frames, just later', waited.hold.flushed === true, JSON.stringify(waited.hold));
    expect(`…and it really did withhold them for the full ${HOLD_MS}ms — the race was FORCED, not awaited`,
      waited.hold.withheldMs >= HOLD_MS, String(waited.hold.withheldMs));
    expect(`✅ the waited read on the SAME page returns all ${EXPECT_STATIONS} posts`,
      waited.stations === EXPECT_STATIONS, String(waited.stations));
    expect(`✅ …and the deployment's own word for a post, "${STATION_WORD}"`,
      waited.word === STATION_WORD, String(waited.word));

    // ── (3) the shipped openControl, unmodified, under the same hold ─────────────────────────
    const ctl = await openControl(held, server, TOKEN);
    const atReturn = await registryState(ctl.page);
    expect(`✅ openControl returns with the registry ALREADY THERE — ${EXPECT_STATIONS} posts, read with no wait of its own`,
      atReturn.stations === EXPECT_STATIONS, String(atReturn.stations));
    expect(`✅ …and with the deployment's word already in place`, atReturn.word === STATION_WORD, String(atReturn.word));
    expect(`…and it did so under the SAME deliberate hold — ${HOLD_MS}ms of withheld frames, not a quiet second try`,
      atReturn.hold.installed === true && atReturn.hold.flushed === true && atReturn.hold.withheldMs >= HOLD_MS,
      JSON.stringify(atReturn.hold));
    expect('no page error while the welcome was held', ctl.errs.length === 0, JSON.stringify(ctl.errs));
  } finally {
    try { await browser.close(); } catch (e) {}
    try { await server.close(); } catch (e) {}
  }
});
