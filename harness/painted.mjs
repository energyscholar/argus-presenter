/*
 * painted.mjs — 0581 PHASE B. THE CONTROL ELEMENT FOR A PAINTED ASSERTION.
 *
 * ⛔⛔ WHY THIS FILE EXISTS. `t0575-03p` asserted a real element, with real text, and a real
 * NON-ZERO BOUNDING BOX — and passed while the station screen was blank. The screenshot it took in
 * the same run shows a hex background, a role chip and an alert band, and nothing else: no station
 * title, no station line, no console. Every value it read was true. The screen was not there.
 *
 * ⭐ THE MISSING IDEA: A VALUE-UNDER-TEST CANNOT VOUCH FOR THE SCREEN THAT CARRIES IT. An assertion
 * that reads only the thing it is interested in cannot distinguish "the value is right" from "the
 * value is right and everything around it has vanished". So every painted assertion must ALSO
 * assert a CONTROL ELEMENT — something the whole screen must carry, which the assertion does not
 * care about, and which a blank screen therefore cannot supply.
 *
 * ⛔ THIS DOES NOT REPLACE THE BOUNDING-BOX CHECK. 1004×0 is a real and different failure mode
 * (0559: mounted, correct, and INVISIBLE because the host resolved to zero height). Keep both.
 *
 * ── AND THE SECOND HALF, WHICH IS WHERE 03p ACTUALLY WENT WRONG ────────────────────────────────
 * `p.frames().find(f => f !== p.mainFrame())` takes THE FIRST FRAME THAT IS NOT THE TOP ONE. That
 * is not a claim about the glass: a frame can be detached, hidden, stale, or simply one of several,
 * and it still answers `evaluate()` with plausible numbers. ⇒ frames are selected here by walking
 * the top document's own `<iframe>` ELEMENTS and keeping those with a non-zero box, so the frame
 * that answers is the frame a human is looking at. `hitTest` then closes the last gap: an element
 * can have a box and still be behind something, so the centre of the control element is asked
 * what is actually at that point.
 */

/**
 * Every frame that the TOP document is really showing, with the geometry the human sees.
 * @returns {Promise<Array<{ frame, box:{x,y,width,height}, index:number }>>}
 */
export async function glassFrames(page) {
  const out = [];
  let handles = [];
  try { handles = await page.$$('iframe'); } catch { return out; }
  for (let i = 0; i < handles.length; i++) {
    try {
      const box = await handles[i].boundingBox();        // null when display:none / detached
      if (!box || box.width <= 0 || box.height <= 0) continue;
      const frame = await handles[i].contentFrame();
      if (!frame) continue;
      out.push({ frame, box, index: i });
    } catch { /* the frame went away mid-read — see the note on `stationCensus` */ }
  }
  return out;
}

/**
 * The station screen's CENSUS — what is there, in numbers, whether or not anyone asked for it.
 *
 * `chrome` is the count of non-empty text nodes in the art SVG. A dressed station carries its
 * title, its group/number line and its console legend; a blank one carries none. It is deliberately
 * a COUNT rather than a string match: the words are L3 campaign content and this repo is public,
 * so the control element must be structural, never vocabulary. (t0531-01 would fail on the words.)
 *
 * ⚠ MEASURED, 2026-08-14, and it is the mechanism behind the original defect: re-resolving the
 * seat TEARS THE FRAME DOWN AND BUILDS A NEW ONE. Reading across that boundary throws
 * `Execution context was destroyed, most likely because of a navigation`. ⇒ a read that happens to
 * land on the OLD frame gets a stale but entirely plausible answer, which is exactly what
 * `frames().find(f => f !== mainFrame())` was handing `t0575-03p`. Here a torn-down frame is
 * skipped and the census comes back SHORT, so the caller's `until(...)` retries — a missing frame
 * must never read as a healthy one.
 */
export async function stationCensus(page) {
  const frames = await glassFrames(page);
  const seen = [];
  for (const g of frames) {
    let c;
    try {
      c = await g.frame.evaluate(() => {
      const box = (el) => {
        if (!el) return [0, 0];
        const r = el.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      };
      const screen = document.querySelector('.ap-stationscreen');
      const art = document.querySelector('.ap-ss-art');
      const svg = art ? art.querySelector('svg') : null;
      const texts = svg ? Array.from(svg.querySelectorAll('text')).filter((t) => (t.textContent || '').trim().length) : [];
      const band = document.querySelector('.ap-alertband');
      const nameEl = document.querySelector('#apShipName');

      // ⭐ HIT TEST. A box is a promise about layout; this is a question about the glass. Ask the
      // document what is actually at the centre of the control element and require the answer to
      // be inside it — an element covered by an overlay, or in a frame nobody can see, fails.
      let hit = null;
      if (svg) {
        const r = svg.getBoundingClientRect();
        const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        hit = el ? (art.contains(el) || el === art) : false;
      }

      /*
       * ⭐⭐ EFFECTIVE OPACITY, and this is the assertion that would have caught D1.
       * MEASURED 2026-08-14: the "blank" AFTER-move screen is not blank. Every structural check
       * above passes on it — the screen element is there, the SVG is there with a full-viewport
       * box, six dressed text elements, hit-testable at its centre — and the screenshot shows a
       * station you can barely see, because the art is mid-fade at ~0 opacity. ⇒ PRESENCE IS NOT
       * VISIBILITY, and neither is a bounding box. Opacity multiplies down the ancestor chain, so
       * an invisible parent makes an "opaque" child invisible; the whole chain is walked.
       */
      const effOpacity = (el) => {
        let o = 1;
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
          const v = parseFloat(cs.opacity);
          if (!Number.isNaN(v)) o *= v;
        }
        return Math.round(o * 1000) / 1000;
      };
      /*
       * ⭐⭐ AND THIS IS THE ONE THAT ACTUALLY CATCHES IT. `getComputedStyle('.ap-ss-art').opacity`
       * is 1 on the "blank" screen — MEASURED, the first guess was wrong. The art fades in from
       * INSIDE the SVG: stations.py emits `<g opacity="0"><animate attributeName="opacity"
       * values="0;1" dur="1.4s" begin="0.15s" fill="freeze"/>`, one per band, out to begin+dur ≈
       * 2.1 s. So the container is opaque and its CONTENTS are not. ⇒ measure the text elements
       * themselves, each through its own ancestor chain, and count how many a human could read.
       */
      const visible = texts.filter((t) => effOpacity(t) >= 0.25).length;
      const opacities = texts.map((t) => effOpacity(t));
      const chromeDetail = texts.map((t) => effOpacity(t) + ':' + (t.textContent || '').trim().slice(0, 3));
      return {
        opacity: art ? effOpacity(art) : 0,
        visibleChrome: visible,
        chromeDetail,
        textOpacity: opacities.length ? [Math.min(...opacities), Math.max(...opacities)] : null,
        url: location.href,
        hasScreen: !!screen, screenBox: box(screen),
        hasArt: !!art, artBox: box(art),
        hasSvg: !!svg, svgBox: box(svg),
        chrome: texts.length,
        hit,
        hasBand: !!band, bandBox: box(band),
        shipName: nameEl ? (nameEl.textContent || '').trim() : null,
        nameBox: box(nameEl),
        alert: band ? band.getAttribute('data-alert') : null,
        alertLabel: band ? band.getAttribute('data-alert-label') : null,
      };
      });
    } catch { continue; }   // torn down mid-read: come back short, never come back healthy
    seen.push(Object.assign({ frameBox: [Math.round(g.box.width), Math.round(g.box.height)], frameIndex: g.index }, c));
  }
  // The station screen's frame, if any is showing one; otherwise the first visible frame, so a
  // caller always gets SOMETHING to print rather than a null it has to special-case.
  const chosen = seen.find((s) => s.hasScreen) || seen[0] || null;
  return { frames: seen, chosen };
}

/** True when a census answers the control bar — the same predicate `assertControl` asserts. */
export function controlMet(census, { minChrome = 3, minPeakOpacity = 0.9 } = {}) {
  const c = census && census.chosen;
  return !!(c && c.hasScreen && c.hasSvg && c.svgBox[0] > 0 && c.svgBox[1] > 0 && c.hit === true
    && c.chrome >= minChrome && c.visibleChrome >= minChrome
    && c.textOpacity && c.textOpacity[1] >= minPeakOpacity);
}

/**
 * ⭐⭐ WAIT FOR THE ART TO SETTLE — WITH THE DEADLINE ITSELF AS THE INVARIANT.
 *
 * ⛔ THIS IS NOT "poll until it looks right". An unbounded retry would hide a screen that NEVER
 * settles, which is a worse bug than the one it papers over. The contract is *"the art settles
 * within `deadlineMs`"*: past the deadline this returns unsettled and the caller's `assertControl`
 * fails loudly on the last census, exactly as if no wait had happened.
 *
 * `deadlineMs = 4000` is DERIVED, not chosen (Auditor's ruling, 2026-08-14): the measured
 * control-bar settle on this box is 771 ms, and the slowest freeze in stations.py is
 * `begin=1.5s` + `dur=2s` ≈ 3.5 s worst case. 4000 clears the source's own worst case with margin
 * and is ~5x the measured value, while still failing on a genuine hang. ⛔ The 11 s / 19 s / 27 s
 * animations in that file are `repeatCount="indefinite"` ambient effects, NOT fade-ins — nothing
 * should ever wait on them.
 *
 * ⭐ ALWAYS RETURNS `ms`, AND CALLERS SHOULD PRINT IT. A bare pass/fail throws away the early
 * warning: a settle time creeping toward the deadline is the signal that something has regressed
 * long before the gate goes red.
 */
export async function settleCensus(page, { deadlineMs = 4000, every = 150, bar = {} } = {}) {
  const t0 = Date.now();
  let census = await stationCensus(page);
  while (!controlMet(census, bar) && Date.now() - t0 < deadlineMs) {
    await new Promise((r) => setTimeout(r, every));
    census = await stationCensus(page);
  }
  const ms = Date.now() - t0;
  return { census, ms, settled: controlMet(census, bar), deadlineMs };
}

/**
 * t0581-B1 — THE CONTROL ASSERTION. Call it in every painted check, alongside (never instead of)
 * whatever that check is really about.
 *
 * `minChrome` is the number of dressed text elements the whole screen must carry. It is 3 by
 * default because the smallest dressed station shows a title, a group/number line and a console
 * legend; a screen showing only the separately-subscribed alert band carries ZERO.
 */
export function assertControl(check, census, label, { minChrome = 3, minOpacity = 0.9, minPeakOpacity = 0.9 } = {}) {
  const c = census && census.chosen;
  const where = `frames=${census ? census.frames.length : 0} chosen=${JSON.stringify(c)}`;
  check(`${label}: a frame the TOP DOCUMENT is actually showing answered (not merely a non-main frame)`,
    !!c, where);
  if (!c) return false;
  const ok = [];
  ok.push(check(`${label}: CONTROL — the station screen element is present`, c.hasScreen, where));
  ok.push(check(`${label}: CONTROL — its art has a non-zero box`, c.artBox[0] > 0 && c.artBox[1] > 0, where));
  ok.push(check(`${label}: CONTROL — the art carries a rendered SVG with a non-zero box`,
    c.hasSvg && c.svgBox[0] > 0 && c.svgBox[1] > 0, where));
  ok.push(check(`${label}: CONTROL — the screen is DRESSED (>= ${minChrome} text elements, not just the alert band)`,
    c.chrome >= minChrome, `chrome=${c.chrome} ${where}`));
  /*
   * ⭐ THE BAR, AND IT IS MEASURED RATHER THAN CHOSEN. On this station a SETTLED screen reads
   * [1, 0.823, 0.823, 0.655, 0.655, 0.369] — the spread is the ART'S OWN design, dim text is
   * meant to be dim. The same screen mid-fade reads [0.31, 0.052, 0.052, 0, 0, 0]. The two
   * separate cleanly on two independent facts: a settled screen has SOMETHING at full opacity,
   * and it has several elements above the floor. Neither alone is safe — an art with no
   * full-opacity text would break the first, and a fade caught late would pass the second.
   */
  ok.push(check(`${label}: CONTROL — >= ${minChrome} of those elements are above the legibility floor (0.25)`,
    c.visibleChrome >= minChrome, `visibleChrome=${c.visibleChrome} of ${c.chrome}, detail=${JSON.stringify(c.chromeDetail)} ${where}`));
  ok.push(check(`${label}: CONTROL — the art has SETTLED (peak text opacity >= ${minPeakOpacity}; a fade-in is not a painted screen)`,
    c.textOpacity && c.textOpacity[1] >= minPeakOpacity,
    `peak=${c.textOpacity && c.textOpacity[1]}, detail=${JSON.stringify(c.chromeDetail)} ${where}`));
  ok.push(check(`${label}: CONTROL — the art is hit-testable at its own centre (on the glass, not behind it)`,
    c.hit === true, where));
  ok.push(check(`${label}: CONTROL — the art is VISIBLE, effective opacity >= ${minOpacity} (present is not visible)`,
    typeof c.opacity === 'number' && c.opacity >= minOpacity, `opacity=${c.opacity} ${where}`));
  return ok.every(Boolean);
}
