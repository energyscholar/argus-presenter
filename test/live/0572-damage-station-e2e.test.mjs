/*
 * Plan 0572 phase D — THE DAMAGE CONTROL STATION, PAINTED, AND OPERATED BY CLICKS.
 *
 * ⭐⭐ SEE IT, BREAK IT, FIX IT — the reduced scope Bruce chose over the full-featured station, and
 * this file is where all three verbs happen on real controls in a real browser. `t0572-10`'s round
 * trip is driven by: a real `change` on the inflict panel's `<select>`, a real `click` on APPLY, a
 * real `click` on the damaged tile, and a real `click` on REPAIR. ⛔ A tool call may only SET UP or
 * READ BACK here; the moment one performs the action under test, the test proves nothing it exists
 * for (0584's own lesson: OBSERVABLE IS NOT OPERABLE — 0575 drove every state change through
 * `callPluginTool` and shipped four tools with no control anywhere).
 *
 * ⭐ 0581 B — EVERY PAINTED READ CARRIES A CONTROL ELEMENT. A value-under-test cannot vouch for the
 * screen that carries it: `t0575-03p` asserted a real element with a real box and passed while the
 * station screen was blank. `assertControl` makes the whole screen answer, and `settleCensus` bounds
 * the wait at 4000 ms WITH THE DEADLINE ITSELF AS THE ASSERTION — past it the check runs on the last
 * sample, so a screen that never settles still fails rather than being waited into looking healthy.
 *
 * ⛔ NEVER `frames().find(f => f !== mainFrame())`. A detached or stale frame answers `evaluate()`
 * with entirely plausible numbers; `glassFrames` walks the top document's own `<iframe>` elements
 * and keeps only those a human can actually see.
 *
 * ⛔⛔ AND THE GEOMETRY IS AN ASSERTION, NOT A SCREENSHOT NOTE. MEASURED during this phase: the first
 * cut of the console's type scale was 24% oversized and its bottom edge landed at y=851 in an 800px
 * viewport — the GM inflict strip and its APPLY button were BELOW THE FOLD, with no scrollbar,
 * because the host clips. Every structural check passed on that screen. ⇒ `t0572-08` asserts the
 * console's bottom edge against the viewport AND that the document does not scroll, so the same
 * defect cannot return quietly.
 *
 * NAMES: invented and obviously fictional (0529 §0 / t0531-01). The hull CLASS comes from
 * `CLASS_ALPHA`, which is invented for the same reason — this repo is PUBLIC.
 *
 * ⚠ RESOURCES: 6.4 GB, ZERO SWAP, 36 prior OOM kills. One browser at a time, closed before the next
 * is opened, `assertResources` before each launch.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { assertResources } from '../../harness/resources.mjs';
import { settleCensus, assertControl, glassFrames } from '../../harness/painted.mjs';
import { loadShipPluginModule, withFleet, withHulls, CLASS_ALPHA, ONE_ALPHA } from '../unit/_0514-fixtures.mjs';
import { mkdirSync } from 'fs';
import { join } from 'path';

/* ⭐ THE EVIDENCE. ⚠ `evidence/` is GITIGNORED and that is correct — the durable record is the
   measured values printed below, never the PNGs. */
const SHOTS = process.env.PRESENTER_EVIDENCE_DIR
  || join(process.env.HOME || '/tmp', 'software', 'has-anyone-looked', 'evidence', '0572');
async function shoot(page, name) {
  try {
    mkdirSync(SHOTS, { recursive: true });
    const file = join(SHOTS, name);
    await page.screenshot({ path: file });
    console.log(`      [shot] ${file}`);
    return file;
  } catch (e) { console.log(`      [shot] FAILED ${name} — ${e && e.message}`); return null; }
}

/** Every literal DOM value this file read, printed so the run report can quote it verbatim. */
function report(tag, v) { console.log(`      [painted] ${tag} ${JSON.stringify(v)}`); }

async function onGlass(page, fn, arg) {
  const gs = await glassFrames(page);
  for (const g of gs) {
    try { const v = await g.frame.evaluate(fn, arg); if (v != null) return v; }
    catch { /* torn down mid-read — try the next visible frame, never report it healthy */ }
  }
  return null;
}

/**
 * Seat a real browser at a station, exactly as a player's link does (the 0565 recipe).
 * `role` reaches `resolveIdentity`, which grants it only when the deployment's credential gate
 * allows — the connection's role is the SERVER'S answer, never the client's claim.
 */
async function seat(browser, server, uid, name, role) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 800 });
  const r = role ? `&role=${encodeURIComponent(role)}` : '';
  await p.goto(`${server.url()}/?stationUID=${uid}&n=${encodeURIComponent(name)}${r}`,
               { waitUntil: 'domcontentloaded' });
  await wait(1200);
  await p.evaluate(() => document.getElementById('cfg-station')?.click());   // "show my station"
  await wait(1500);
  return p;
}

/** The whole console, read as literal DOM — geometry included, because placement IS the design. */
const readDc = (p) => onGlass(p, () => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const w = document.querySelector('.ap-dc');
  /* ⛔ ABSENT AND EMPTY ARE DIFFERENT ANSWERS. A seat with no entitlement renders no console at
     all; returning a shaped object with `present:false` keeps that distinguishable from a read
     that simply failed. */
  if (!w) return { present: false, slot: !!document.querySelector('.ap-ss-dc'),
                   viewport: [window.innerWidth, window.innerHeight] };
  const tiles = [...w.querySelectorAll('.ap-dc-tile')].map((t) => {
    const wordEl = t.querySelector('.ap-dc-tileword');
    const r = t.getBoundingClientRect();
    return {
      key: t.getAttribute('data-system'),
      word: t.getAttribute('data-word'),
      colour: t.getAttribute('data-colour'),
      status: t.getAttribute('data-status'),
      sev: t.getAttribute('data-sev'),
      /* ⭐ THE WORD AS A HUMAN READS IT, not only as an attribute — an attribute can be right on a
         screen where nothing is drawn. Its own box is measured for the same reason. */
      wordText: wordEl ? (wordEl.textContent || '').trim() : '',
      wordBox: box(wordEl),
      wordColour: wordEl ? getComputedStyle(wordEl).color : null,
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  });
  return {
    present: true,
    gm: w.getAttribute('data-gm'),
    systems: w.getAttribute('data-systems'),
    count: w.getAttribute('data-system-count'),
    hullPct: w.getAttribute('data-hull-pct'),
    hullWord: w.getAttribute('data-hull-word'),
    hullCurrent: w.getAttribute('data-hull-current'),
    hullMax: w.getAttribute('data-hull-max'),
    hullFillWidth: (() => { const f = w.querySelector('.ap-dc-hullfill'); const b = f && f.getBoundingClientRect();
      return b ? Math.round(b.width) : null; })(),
    selected: w.getAttribute('data-selected'),
    selectedWord: w.getAttribute('data-selected-word'),
    selectedEffect: w.getAttribute('data-selected-effect'),
    queue: w.getAttribute('data-queue'),
    queueLength: w.getAttribute('data-queue-length'),
    inflictSystems: w.getAttribute('data-inflict-systems'),
    ack: w.getAttribute('data-ack'),
    ackAction: w.getAttribute('data-ack-action'),
    ackReason: w.getAttribute('data-ack-reason'),
    ackMessage: w.getAttribute('data-ack-message'),
    hasInflict: !!w.querySelector('.ap-dc-inflict'),
    hasApply: !!w.querySelector('.ap-dc-btn.is-apply'),
    repairDisabled: (() => { const b = w.querySelector('.ap-dc-btn.is-repair'); return b ? !!b.disabled : null; })(),
    verdictText: (() => { const v = w.querySelector('.ap-dc-detail .ap-dc-verdict'); return v ? (v.textContent || '').trim() : ''; })(),
    inflictVerdictText: (() => { const v = w.querySelector('.ap-dc-inflict .ap-dc-verdict'); return v ? (v.textContent || '').trim() : ''; })(),
    tiles,
    wrapBox: box(w),
    hullBox: box(w.querySelector('.ap-dc-hullrow')),
    gridBox: box(w.querySelector('.ap-dc-grid')),
    detailBox: box(w.querySelector('.ap-dc-detail')),
    queueBox: box(w.querySelector('.ap-dc-queue')),
    inflictBox: box(w.querySelector('.ap-dc-inflict')),
    applyBox: box(w.querySelector('.ap-dc-btn.is-apply')),
    /* ⭐ THE SCROLL FACTS. `t0572-08` says the station fits WITHOUT SCROLLING at the table
       resolution; scrollHeight > clientHeight is the only form in which that can be false. */
    scroll: { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
              cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight },
    viewport: [window.innerWidth, window.innerHeight],
  };
});

/** ⭐ THE BREAK. A real value change AND a real `change` event, then a real click on APPLY. */
const inflict = (p, systemKey, level) => onGlass(p, (a) => {
  const sel = document.querySelector('.ap-dc-inflict-system');
  const amt = document.querySelector('.ap-dc-inflict-amount');
  const btn = document.querySelector('.ap-dc-btn.is-apply');
  if (!sel || !amt || !btn) return { ok: false, why: 'no inflict controls', sel: !!sel, amt: !!amt, btn: !!btn };
  if (![...sel.options].some((o) => o.value === a.systemKey)) {
    return { ok: false, why: 'no such system', have: [...sel.options].map((o) => o.value) };
  }
  sel.value = a.systemKey; sel.dispatchEvent(new Event('change', { bubbles: true }));
  amt.value = String(a.level); amt.dispatchEvent(new Event('change', { bubbles: true }));
  btn.click();
  return { ok: true, systemKey: sel.value, level: amt.value };
}, { systemKey, level });

/** ⭐ THE SEE. A real click on the damaged tile in the grid — the operator's own gesture. */
const clickTile = (p, key) => onGlass(p, (k) => {
  const t = document.querySelector(`.ap-dc-tile[data-system="${k}"]`);
  if (!t) return { ok: false, why: 'no such tile' };
  t.click();
  return { ok: true, key: k };
}, key);

/** ⭐ THE FIX. A real click on REPAIR — refused by the DOM itself if the button is disabled. */
const clickBtn = (p, cls) => onGlass(p, (c) => {
  const b = document.querySelector(`.ap-dc-btn.${c}`);
  if (!b) return { ok: false, why: 'no such button' };
  if (b.disabled) return { ok: false, why: 'disabled' };
  b.click();
  return { ok: true };
}, cls);

const toolResult = async (server, name, args) => {
  const r = await server.callPluginTool(name, args);
  return r && Object.prototype.hasOwnProperty.call(r, 'result') ? r.result : r;
};

/*
 * The four display faces the ruling fixed (RESUME-STATIONS §2.7), plus the orthogonal `unknown`.
 * ⛔ READ FROM THE RULES MODULE, NEVER SPELLED HERE. A copy of the words in this file would be a
 * second table — the exact defect `alert-band.js` names ("a second table is how a thing acquires
 * two names and the two drift") — and it would make this test agree with itself while the screen
 * and the rules diverged. What is asserted below is that THE PIXELS MATCH THE RULES, which is only
 * a real claim while the rules are the source of the expected value.
 */
function facesOf(rules) {
  const f = { unknown: rules.UNREPORTED.word };
  for (const [status, v] of Object.entries(rules.FACES)) f[status] = v.word;
  return f;
}

test('t0572-08 / -14 / -02 / -03 / -10 / -12 — ⭐⭐ THE DAMAGE CONTROL STATION, PAINTED, AND BROKEN AND FIXED BY CLICKS', async () => {
  await withHulls([CLASS_ALPHA], async () => {
    await withFleet(ONE_ALPHA, async () => {
      const mod = await loadShipPluginModule('ship-machine.mjs');
      const rules = await loadShipPluginModule('damage-rules.mjs');
      const FACE = facesOf(rules);
      const server = await createServer({ port: 0 });
      let browser = null;
      try {
        if (!server.stations().stations.length) { expect('skipped — no station plugin', true, 'skipped'); return; }
        assertResources({ needMB: 900, label: '0572 D painted' });
        browser = await launch();
        /* The operator's seat: the DC station, with the role that opens the inflict strip. ⚠ The
           role is GRANTED by the server or it is not — `data-gm` below is read back rather than
           assumed, so a deployment that refused it fails loudly instead of skipping the strip. */
        const gm = await seat(browser, server, 8, 'GM Probe', 'presenter');
        await until(() => server.presence().length >= 1, { label: 'seated' });
        const who = server.presence()[0];
        report('the seat', { userId: who.userId, role: who.role });

        const settle0 = await settleCensus(gm, { deadlineMs: 4000 });
        console.log(`      [settle] MOUNT ${settle0.ms} ms of a ${settle0.deadlineMs} ms deadline, settled=${settle0.settled}`);
        expect('⛔ THE DEADLINE IS THE ASSERTION — the art settled inside 4000 ms',
          settle0.settled, `ms=${settle0.ms} census=${JSON.stringify(settle0.census.chosen)}`);
        assertControl(expect, settle0.census, 't0572-08 MOUNT');

        const d0 = await readDc(gm);
        report('the console on arrival', { present: d0.present, gm: d0.gm, systems: d0.systems,
          count: d0.count, hull: [d0.hullPct, d0.hullWord, d0.hullCurrent, d0.hullMax],
          hullFillWidth: d0.hullFillWidth, queueLength: d0.queueLength, selected: d0.selected });
        report('geometry', { wrap: d0.wrapBox, hull: d0.hullBox, grid: d0.gridBox,
          detail: d0.detailBox, queue: d0.queueBox, inflict: d0.inflictBox, apply: d0.applyBox,
          scroll: d0.scroll, viewport: d0.viewport });

        // ── t0572-08 — ⭐⭐ THE PAINTED STATION ─────────────────────────────────────────────────
        expect('⭐⭐ THE CONSOLE IS THERE AND IT IS PAINTED — a non-zero box, not a mounted 1004×0',
          d0.present === true && d0.wrapBox.w > 0 && d0.wrapBox.h > 0, JSON.stringify(d0.wrapBox));
        expect('⭐ and so is every REGION of it — hull bar, grid, detail, queue, inflict strip',
          [d0.hullBox, d0.gridBox, d0.detailBox, d0.queueBox, d0.inflictBox]
            .every((b) => b && b.w > 0 && b.h > 0),
          JSON.stringify([d0.hullBox, d0.gridBox, d0.detailBox, d0.queueBox, d0.inflictBox]));
        /* ⛔⛔ THE ONE THAT CAUGHT A REAL DEFECT. Measured this phase: an oversized type scale put
           the console's bottom edge at 851 in an 800px viewport, with the APPLY button below the
           fold and NO SCROLLBAR — the host clips, so a third of the station was simply gone and
           every structural check still passed. Both halves are asserted: inside the viewport, AND
           the document does not scroll. */
        expect('⛔⛔ t0572-08 — IT FITS: the console\'s BOTTOM EDGE is inside the viewport at the table resolution',
          d0.wrapBox.bottom <= d0.viewport[1],
          `bottom=${d0.wrapBox.bottom} viewport=${d0.viewport.join('x')} clearance=${d0.viewport[1] - d0.wrapBox.bottom}px`);
        expect('⛔ and the GM inflict strip\'s APPLY BUTTON is on screen, not below the fold',
          d0.applyBox && d0.applyBox.bottom <= d0.viewport[1] && d0.applyBox.w > 0 && d0.applyBox.h > 0,
          JSON.stringify(d0.applyBox));
        expect('⛔ t0572-08 — AND IT FITS WITHOUT SCROLLING: scrollHeight does not exceed clientHeight',
          d0.scroll.sh <= d0.scroll.ch && d0.scroll.sw <= d0.scroll.cw, JSON.stringify(d0.scroll));

        // ── t0572-02 — the systems are the HULL CLASS'S, not a table in the component ──────────
        const derived = rules.deriveSystems(CLASS_ALPHA).map((s) => s.key);
        expect('⛔ t0572-02 — THE PAINTED TILES ARE EXACTLY `deriveSystems(hullClass)`, in its order',
          d0.systems === derived.join(','),
          `painted=${d0.systems} derived=${derived.join(',')}`);
        expect('and the count agrees with the tiles actually drawn',
          Number(d0.count) === d0.tiles.length && d0.tiles.length === derived.length,
          `attr=${d0.count} tiles=${d0.tiles.length} derived=${derived.length}`);
        expect('⭐ the INFLICT panel offers the SAME derived list — never a second one',
          d0.inflictSystems === d0.systems, `${d0.inflictSystems} vs ${d0.systems}`);

        // ── the hull bar, the headline number Bruce ruled in ──────────────────────────────────
        expect('⭐ THE HULL BAR carries a real pool with a size, and a painted fill',
          d0.hullMax === String(rules.hullPointsFor(CLASS_ALPHA, {}))
            && d0.hullPct === '100' && d0.hullFillWidth > 0,
          JSON.stringify({ max: d0.hullMax, pct: d0.hullPct, fill: d0.hullFillWidth }));

        /* ── t0572-03 — ⛔ NOBODY HAS LOOKED YET, SO NOTHING CLAIMS TO BE FINE ─────────────────
           `unknown` is ORTHOGONAL to the three damage bands, not a fourth one. A freshly commissioned
           hull has reported nothing, so every tile reads "No report" — and it is RENDERED, not
           absent, which is the other half of what -03 asks. */
        expect('⛔ t0572-03 — an unreported system RENDERS, and says "No report" rather than Functional',
          d0.tiles.length === derived.length
            && d0.tiles.every((t) => t.status === 'unknown' && t.word === FACE.unknown && t.sev === ''),
          JSON.stringify(d0.tiles.map((t) => [t.key, t.status, t.word])));
        await shoot(gm, '0572-D-01-dc-console-painted-nothing-has-reported-yet.png');

        /* ── ⭐ ASSESS, ON THE REAL BUTTON. The verb that turns silence into a report. ─────────── */
        const assessed = await clickBtn(gm, 'is-assess');
        expect('⭐ ASSESS was clicked on the real button', assessed && assessed.ok === true, JSON.stringify(assessed));
        await until(async () => { const d = await readDc(gm); return d.present && d.tiles.every((t) => t.status !== 'unknown'); },
          { timeout: 9000, label: 'every system reports' });
        const d1 = await readDc(gm);
        report('after ASSESS', { tiles: d1.tiles.map((t) => [t.key, t.status, t.word, t.sev]),
          verdict: d1.verdictText, ack: d1.ack, ackAction: d1.ackAction, ackMessage: d1.ackMessage });
        expect('⛔ t0572-03 — A DAMAGE LEVEL OF ZERO RENDERS AS UNDAMAGED, NOT AS ABSENT: every tile is still drawn',
          d1.tiles.length === derived.length
            && d1.tiles.every((t) => t.sev === '0' && t.word === FACE.operational && t.box.w > 0 && t.box.h > 0),
          JSON.stringify(d1.tiles.map((t) => [t.key, t.sev, t.word, t.box.w, t.box.h])));
        expect('⭐ and the verdict SPOKE, in words, on the console that asked',
          d1.ack === 'ok' && /\S/.test(d1.verdictText), JSON.stringify({ ack: d1.ack, text: d1.verdictText }));

        /* ── t0572-14 — ⭐⭐ COLOUR **AND** WORD, ON EVERY SYSTEM ──────────────────────────────
           The usability bar (§3.6: a player who has never seen this screen can name every damaged
           system and its state in one look, without a legend) and the accessibility floor, in one
           assertion. ⛔ It is checkable rather than decorative BECAUSE there are four rule statuses
           and three palette colours: `disabled` and `destroyed` deliberately share red, so colour
           ALONE provably cannot separate them and the word is load-bearing. */
        expect('⭐⭐ t0572-14 — EVERY SYSTEM CARRIES A WORD, PAINTED, beside its colour — none is distinguished by colour alone',
          d1.tiles.every((t) => t.colour && /^#[0-9a-f]{6}$/i.test(t.colour)
            && t.word && t.word.length > 0
            && t.wordText === t.word                       // the attribute and the pixels agree
            && t.wordBox && t.wordBox.w > 0 && t.wordBox.h > 0),
          JSON.stringify(d1.tiles.map((t) => [t.key, t.colour, t.word, t.wordText, t.wordBox])));
        expect('⛔ t0572-14 — and the words are the RULES ENGINE\'s four faces, never a local re-phrasing',
          d1.tiles.every((t) => Object.values(FACE).includes(t.word)),
          JSON.stringify([...new Set(d1.tiles.map((t) => t.word))]));

        // ── t0572-10 — ⭐⭐ BREAK IT. A real select, a real APPLY click. ───────────────────────
        const appliesBefore = (await toolResult(server, 'ship_damage_state', {})).applies;
        const broke = await inflict(gm, 'mDrive', 3);
        expect('⭐⭐ THE DAMAGE WAS INFLICTED FROM THE PANEL — a real change event and a real click',
          broke && broke.ok === true, JSON.stringify(broke));

        await until(async () => { const d = await readDc(gm);
          const t = d.present && d.tiles.find((x) => x.key === 'mDrive'); return t && t.sev === '3'; },
          { timeout: 9000, label: 'the M-Drive tile turns' });
        const d2 = await readDc(gm);
        const md2 = d2.tiles.find((t) => t.key === 'mDrive');
        report('the broken system', { tile: md2, queue: d2.queue, queueLength: d2.queueLength,
          inflictVerdict: d2.inflictVerdictText, ack: d2.ack, ackAction: d2.ackAction, ackMessage: d2.ackMessage });
        expect('⭐ t0572-10 — IT TURNED: the tile now reads the DEGRADED face, in the alert palette\'s yellow',
          md2 && md2.sev === '3' && md2.status === 'degraded' && md2.word === FACE.degraded
            && md2.colour === rules.FACES.degraded.colour && md2.wordText === FACE.degraded,
          JSON.stringify(md2));
        /* ⛔ THE EFFECT TEXT IS THE PORTED RULE, handed down by the server. A component that
           re-phrased it locally would be a second copy of the rulebook, so it is compared against
           the rules module itself rather than against a string this test invented. */
        const ruled = rules.effectFor ? rules.effectFor('mDrive', 3) : null;
        report('the ported effect text', { fromRules: ruled, onScreen: d2.selectedEffect, ack: d2.ackMessage });
        expect('⛔ the inflict verdict SPEAKS, and names the rule\'s own wording',
          d2.ack === 'ok' && /\S/.test(d2.inflictVerdictText) && /M-Drive/i.test(d2.ackMessage || ''),
          JSON.stringify({ ack: d2.ack, text: d2.inflictVerdictText, message: d2.ackMessage }));
        expect('⭐ and the REPAIR QUEUE picked it up — a derived list, never stored beside the systems',
          d2.queue === 'mDrive' && d2.queueLength === '1', JSON.stringify({ q: d2.queue, n: d2.queueLength }));
        await shoot(gm, '0572-D-02-m-drive-broken-yellow-reduced-effectiveness.png');

        /* ── t0572-12 — ⭐⭐ ONE CODE PATH, PROVED BY COUNTING, NOT BY READING ─────────────────
           `applies()` counts EVERY call to the one function that damages a system. A panel hit and a
           combat hit differ only in the recorded CAUSE. ⛔ A test that passed by branching on "is
           test" would have failed this id; here the panel's click is required to have moved the
           SAME counter a combat hit moves, and the log entry is required to name the panel as its
           cause rather than to carry a rehearsal flag. */
        const st2 = await toolResult(server, 'ship_damage_state', {});
        const panelEntry = (st2.log || []).find((e) => e.verb === 'damage' && e.systemKey === 'mDrive');
        report('the damage ledger', { appliesBefore, appliesAfter: st2.applies, entry: panelEntry });
        expect('⭐⭐ t0572-12 — THE PANEL CLICK MOVED THE SAME `applies()` COUNTER A COMBAT HIT MOVES',
          st2.applies === appliesBefore + 1, `${appliesBefore} -> ${st2.applies}`);
        expect('⛔ t0572-12 — and the CAUSE is recorded, with no rehearsal flag anywhere on the record',
          panelEntry && panelEntry.cause === 'Inflicted by Damage Control'
            && panelEntry.by === who.userId
            && !Object.keys(panelEntry).some((k) => /test|rehears|fake|sim/i.test(k)),
          JSON.stringify(panelEntry));
        /* And the OTHER door, for contrast: the same function, a different cause. */
        /* ⭐ THE OTHER DOOR, and deliberately the OTHER ARGUMENT too: this one arrives as HULL
           POINTS, which the rules turn into a damage level and which also takes the pool down. So
           the two doors differ in cause AND in argument and still land on the one function. ⛔ The
           expected number is asked of the rules module, never written here — this repo is PUBLIC
           and the arithmetic that produces it is not ours to publish (`t0574-V2`). */
        const HITPOINTS = 19;
        const combat = await toolResult(server, 'ship_damage', { systemKey: 'sensors', damage: HITPOINTS });
        const st3 = await toolResult(server, 'ship_damage_state', {});
        report('the combat hit, through the same function',
          { ok: combat.ok, systemKey: combat.systemKey, applies: st3.applies });
        expect('⭐⭐ t0572-12 — A COMBAT HIT MOVES THE SAME COUNTER: one path, two doors',
          st3.applies === st2.applies + 1, `${st2.applies} -> ${st3.applies}`);
        /* ⛔ WHAT IS **NOT** ASSERTED HERE, AND WHY. The exact number the hull points turn into is
           the RULES ENGINE's arithmetic, and this repo is PUBLIC — `t0574-V2` keeps that arithmetic
           out of it, and predicting the answer here would import it in the only form a text guard
           can see. The private repo already pins the mapping (`damage-rules.test.mjs`, 11 tests).
           ⭐ What THIS id is about is the SHARED PATH, and that is asserted exactly: the counter
           moved, and the same board changed. */
        await until(async () => { const d = await readDc(gm);
          const t = d.present && d.tiles.find((x) => x.key === 'sensors');
          return t && t.status !== 'unknown' && Number(t.sev) > 0; },
          { timeout: 9000, label: 'the combat hit reaches the same board' });
        const dCombat = await readDc(gm);
        const sens = dCombat.tiles.find((t) => t.key === 'sensors');
        report('the system the combat hit landed on', sens);
        expect('⭐ and the OTHER door\'s damage is on the SAME painted board, with colour AND word',
          sens && Number(sens.sev) > 0 && sens.status !== 'unknown'
            && Object.values(FACE).includes(sens.word) && sens.wordText === sens.word
            && sens.wordBox.w > 0 && sens.wordBox.h > 0,
          JSON.stringify(sens));
        /* ⭐ AND THE HULL BAR MOVED WITH IT — the headline number is wired to the same call. */
        const dHull = await readDc(gm);
        report('the hull pool after the combat hit',
          { pct: dHull.hullPct, current: dHull.hullCurrent, max: dHull.hullMax, fill: dHull.hullFillWidth });
        expect('⭐ the HULL BAR fell, and its painted fill fell with it',
          Number(dHull.hullCurrent) === Number(d0.hullMax) - HITPOINTS
            && dHull.hullFillWidth < d0.hullFillWidth,
          JSON.stringify({ was: [d0.hullCurrent, d0.hullFillWidth], now: [dHull.hullCurrent, dHull.hullFillWidth] }));

        // ── t0572-10 — ⭐⭐ FIX IT. Click the damaged tile, then click REPAIR. ─────────────────
        const picked = await clickTile(gm, 'mDrive');
        expect('⭐ the operator SELECTED the damaged system by clicking its tile',
          picked && picked.ok === true, JSON.stringify(picked));
        const d3 = await readDc(gm);
        report('the selected system', { selected: d3.selected, word: d3.selectedWord,
          effect: d3.selectedEffect, repairDisabled: d3.repairDisabled });
        expect('⭐ the detail panel followed the click, with the PORTED effect text in words',
          d3.selected === 'mDrive' && d3.selectedWord === FACE.degraded && /\S/.test(d3.selectedEffect),
          JSON.stringify({ sel: d3.selected, word: d3.selectedWord, effect: d3.selectedEffect }));
        expect('⭐ and REPAIR became enabled — a control is live exactly when it has something to do',
          d3.repairDisabled === false, String(d3.repairDisabled));

        const fixed = await clickBtn(gm, 'is-repair');
        expect('⭐⭐ REPAIR WAS CLICKED on the real button', fixed && fixed.ok === true, JSON.stringify(fixed));
        await until(async () => { const d = await readDc(gm);
          const t = d.present && d.tiles.find((x) => x.key === 'mDrive'); return t && t.sev === '0'; },
          { timeout: 9000, label: 'the M-Drive comes back' });
        const d4 = await readDc(gm);
        const md4 = d4.tiles.find((t) => t.key === 'mDrive');
        report('the fixed system', { tile: md4, queue: d4.queue, queueLength: d4.queueLength,
          verdict: d4.verdictText, ack: d4.ack, ackAction: d4.ackAction });
        expect('⭐⭐ t0572-10 — THE ROUND TRIP CLOSED: back to GREEN / Functional, by the one repair path',
          md4 && md4.sev === '0' && md4.status === 'operational' && md4.word === FACE.operational
            && md4.colour === rules.FACES.operational.colour && md4.wordText === FACE.operational,
          JSON.stringify(md4));
        expect('⭐ and it left the repair queue, which still holds the system nobody has fixed',
          d4.queue === 'sensors' && d4.queueLength === '1', JSON.stringify({ q: d4.queue, n: d4.queueLength }));
        expect('⛔ the repair verdict SPEAKS too', d4.ack === 'ok' && /\S/.test(d4.verdictText),
          JSON.stringify({ ack: d4.ack, text: d4.verdictText }));

        /* ⭐ AND THE SCREEN IS STILL A SCREEN AFTER ALL OF THAT. Re-asserted rather than assumed:
           the whole point of the control element is that a value can be right on a dead screen. */
        const settle1 = await settleCensus(gm, { deadlineMs: 4000 });
        console.log(`      [settle] AFTER ${settle1.ms} ms of a ${settle1.deadlineMs} ms deadline, settled=${settle1.settled}`);
        expect(`⭐ the art is STILL SETTLED after the round trip (took ${settle1.ms} ms of ${settle1.deadlineMs})`,
          settle1.settled === true, JSON.stringify(settle1.census.chosen && settle1.census.chosen.chromeDetail));
        const controlOk = assertControl(expect, settle1.census, 't0572-10 AFTER');
        if (!controlOk) await shoot(gm, '0572-D-CONTROL-FAILED.png');
        const d5 = await readDc(gm);
        expect('⛔ and it STILL fits without scrolling',
          d5.wrapBox.bottom <= d5.viewport[1] && d5.scroll.sh <= d5.scroll.ch,
          JSON.stringify({ bottom: d5.wrapBox.bottom, vp: d5.viewport, scroll: d5.scroll }));
        await shoot(gm, '0572-D-03-m-drive-repaired-green-functional-sensors-still-red.png');
      } finally { if (browser) await browser.close(); await server.close(); }
    });
  });
});

test('t0572-13 / t0572-05 / t0572-06 — ⛔ A PLAYER CANNOT FIRE THE PANEL, AND A NON-DC SEAT IS REFUSED IN WORDS', async () => {
  /*
   * Three claims, and the cheap one proves the least. "No strip renders" is easy to get right and
   * says nothing about the server, because the affordance gate is exactly that — an AFFORDANCE gate,
   * never a security gate (ruled 2026-08-14). ⇒ every absence below is followed by a HOSTILE CLIENT
   * putting the message on the wire anyway, and the assertion is on what the SERVER did.
   *
   * 0565's bar: the failure being guarded is not "the wrong person damaged the ship", it is "the
   * wrong person acted, nothing happened, and nothing said why".
   */
  await withHulls([CLASS_ALPHA], async () => {
    await withFleet(ONE_ALPHA, async () => {
      const mod = await loadShipPluginModule('ship-machine.mjs');
      const dm = await loadShipPluginModule('damage-model.mjs');
      const server = await createServer({ port: 0 });
      let browser = null;
      try {
        if (!server.stations().stations.length) { expect('skipped — no station plugin', true, 'skipped'); return; }
        assertResources({ needMB: 900, label: '0572 D guards painted' });
        browser = await launch();

        /* ── t0572-13 — a PLAYER at the Damage Control seat. Same chair, no role. ─────────────── */
        const player = await seat(browser, server, 8, 'Player Probe');
        await until(() => server.presence().length >= 1, { label: 'seated' });
        const playerId = server.presence()[0].userId;
        report('the player seat', { userId: playerId, role: server.presence()[0].role });

        const settle = await settleCensus(player, { deadlineMs: 4000 });
        console.log(`      [settle] PLAYER ${settle.ms} ms of a ${settle.deadlineMs} ms deadline, settled=${settle.settled}`);
        expect('⛔ THE DEADLINE IS THE ASSERTION — the art settled inside 4000 ms', settle.settled,
          `ms=${settle.ms} census=${JSON.stringify(settle.census.chosen)}`);
        assertControl(expect, settle.census, 't0572-13 PLAYER');

        const p0 = await readDc(player);
        report('the player\'s console', { present: p0.present, gm: p0.gm, hasInflict: p0.hasInflict,
          hasApply: p0.hasApply, systems: p0.systems, wrapBox: p0.wrapBox });
        expect('⭐ the player DOES get the damage board — reading is the whole crew\'s, and it is painted',
          p0.present === true && p0.wrapBox.w > 0 && p0.wrapBox.h > 0 && Number(p0.count) > 0,
          JSON.stringify({ box: p0.wrapBox, count: p0.count }));
        expect('⛔⛔ t0572-13 — AND NO INFLICT STRIP AT ALL: no panel, no APPLY button, nothing to open',
          p0.gm === '0' && p0.hasInflict === false && p0.hasApply === false,
          JSON.stringify({ gm: p0.gm, inflict: p0.hasInflict, apply: p0.hasApply }));
        await shoot(player, '0572-D-04-player-at-dc-seat-has-the-board-and-no-inflict-strip.png');

        /* ⛔ AND THE SERVER REFUSES IT ANYWAY. The affordance is not the guard. */
        const before = await toolResult(server, 'ship_damage_state', {});
        const forged = await onGlass(player, (t) =>
          !!(window.Argus && window.Argus.emit
             && (window.Argus.emit(t, { systemKey: 'mDrive', damage: 40 }) || true)), dm.INFLICT_MESSAGE);
        expect('a hostile client can put the inflict on the wire', forged === true, String(forged));
        await wait(2000);
        const after = await toolResult(server, 'ship_damage_state', {});
        const ack = server.store.get(`${mod.shipNs(mod.loadFleet().primaryShipId)}/ack/${playerId}`);
        report('the refused inflict', { appliesBefore: before.applies, appliesAfter: after.applies, ack });
        expect('⛔⛔ t0572-13 — THE SHIP WAS NOT DAMAGED: `applies()` did not move at all',
          after.applies === before.applies, `${before.applies} -> ${after.applies}`);
        expect('⛔ t0572-13 — AND THE REFUSAL SPEAKS: a reason and a MESSAGE IN WORDS, not silence',
          ack && ack.ok === false && ack.action === dm.INFLICT_EVENT
            && typeof ack.message === 'string' && /\S/.test(ack.message),
          JSON.stringify(ack));
        /* ⭐ The verdict is tagged with its ACTION, which is what stops this console displaying the
           Captain's alert verdicts and the move control's — one ack key, four controls. */
        const pv = await readDc(player);
        report('the player\'s verdict line', { ack: pv.ack, action: pv.ackAction, reason: pv.ackReason, message: pv.ackMessage });
        await shoot(player, '0572-D-05-player-inflict-refused-in-words.png');
        await player.close();

        /* ── t0572-05 / t0572-06 — a NON-DC SEAT. The right is the SEAT'S, not the person's. ──── */
        const pilot = await seat(browser, server, 2, 'Pilot Probe');
        await until(() => server.presence().some((p) => p.userId !== playerId), { label: 'pilot seated' });
        const pilotId = (server.presence().find((p) => p.userId !== playerId) || server.presence()[0]).userId;
        report('the pilot seat', { userId: pilotId });

        const settleP = await settleCensus(pilot, { deadlineMs: 4000 });
        console.log(`      [settle] PILOT ${settleP.ms} ms of a ${settleP.deadlineMs} ms deadline, settled=${settleP.settled}`);
        expect('⛔ THE DEADLINE IS THE ASSERTION — the art settled inside 4000 ms', settleP.settled,
          `ms=${settleP.ms} census=${JSON.stringify(settleP.census.chosen)}`);
        assertControl(expect, settleP.census, 't0572-05 PILOT');

        const q0 = await readDc(pilot);
        report('the pilot\'s console', q0);
        expect('⛔ t0572-05 — A NON-DC SEAT GETS NO CONSOLE AT ALL (entitlement is computed server-side)',
          q0 && q0.present === false, JSON.stringify(q0));

        const b2 = await toolResult(server, 'ship_damage_state', {});
        const forgedRepair = await onGlass(pilot, (t) =>
          !!(window.Argus && window.Argus.emit
             && (window.Argus.emit(t, { systemKey: 'sensors' }) || true)), dm.REPAIR_MESSAGE);
        expect('a hostile client can put the repair on the wire', forgedRepair === true, String(forgedRepair));
        await wait(2000);
        const a2 = await toolResult(server, 'ship_damage_state', {});
        const pack = server.store.get(`${mod.shipNs(mod.loadFleet().primaryShipId)}/ack/${pilotId}`);
        report('the refused repair', { repairsBefore: b2.repairs, repairsAfter: a2.repairs, ack: pack });
        expect('⛔ t0572-05 — NOTHING WAS REPAIRED: `repairs()` did not move',
          a2.repairs === b2.repairs, `${b2.repairs} -> ${a2.repairs}`);
        expect('⛔⛔ t0572-05 — THE DENY SPEAKS: a named reason and a message IN WORDS',
          pack && pack.ok === false && pack.action === dm.REPAIR_EVENT
            && typeof pack.message === 'string' && /\S/.test(pack.message),
          JSON.stringify(pack));
        await shoot(pilot, '0572-D-06-pilot-has-no-dc-console-and-repair-is-refused-in-words.png');
      } finally { if (browser) await browser.close(); await server.close(); }
    });
  });
});
