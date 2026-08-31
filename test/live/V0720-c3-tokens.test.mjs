/*
 * Plan 0720 C3 — N DRAGGABLE TOKENS, IN REAL BROWSERS, AGAINST A REAL STORE.
 *
 * `navmap` drags one token. This is the general case, and the reason it needed its own phase is
 * the reason B3 was measured first: N tokens means N SIMULTANEOUS DRAGGERS, and the failure mode
 * of getting that wrong is silent — every op accepted, acknowledged, and one of them kept.
 *
 *   C3.1  the roster renders, and it is CONTENT-ANCHORED — position and apparent size hold when
 *         the map's scale changes underneath it
 *   C3.2  ⭐ THE HEADLINE: two browsers drag two DIFFERENT tokens at the same instant, four times
 *         over, and every one of the eight drops survives in `server.store`
 *   C3.3  a DROP writes exactly one key, and a DRAG of 12 pointer moves writes NOTHING
 *   C3.4  one viewer's drop moves the token on the OTHER viewer's board
 *   C3.5  `map` unavailable ⇒ a visible sentence, not a throw
 *   C3.6  a path with an ephemeral segment refuses the drop and says so on the board
 *   C3.7  the screenshot
 *
 * ⚠ EVERY POSITION CLAIM IS READ OUT OF `server.store` OR OUT OF A REAL `getBoundingClientRect()`.
 * A token that moves in one page's DOM and never reaches the store is not shared — it is decorative,
 * and that is exactly what a local-variable assertion would have called a pass.
 *
 * ⚠ AND NOTHING HERE CLAIMS OWNERSHIP. B3 measured that per-key buys CONCURRENCY only: `shared/**`
 * lets any participant write any key, so two people on the SAME token remains last-write-wins. The
 * gate is "two different tokens", because that is the claim the design can actually support.
 *
 * ⛔ DOMAIN-FREE FIXTURES (PSS t0531-01): this repo is public. `side` and `kind` are opaque strings
 * to the component, so the fixture names were never load-bearing.
 *
 * ⚠ SANDBOXED-IFRAME MECHANICS, each of which has cost someone an afternoon: `contentDocument` is
 * always null (use `page.frames()`), `page.click()` HANGS on a backgrounded page (use
 * `$eval(el => el.click())`), a backgrounded page composites a stale frame (bringToFront first),
 * and a screenshot needs `captureBeyondViewport:false`.
 */
import { test, expect, check } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until, wait } from '../../harness/multi.mjs';
import { connect, poll } from './_0720-band-b-client.mjs';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = join(ROOT, 'test', 'screenshots');
const PATH = 'shared/tactical/tokens';

/* A domain-free force. `side` and `kind` are opaque to the component — it tints by hash and
   publishes them as data- hooks, and never learns what either word means. */
const ROSTER = [
  { id: 'alpha', label: 'Alpha', side: 'blue', kind: 'heavy', px: 0.25, py: 0.25, status: 'ok' },
  { id: 'bravo', label: 'Bravo', side: 'blue', kind: 'light', px: 0.35, py: 0.65 },
  { id: 'charlie', label: 'Charlie', side: 'red', kind: 'heavy', px: 0.75, py: 0.30,
    status: { colour: '#e0b040', word: 'degraded' } },
  { id: 'delta', label: 'Delta', side: 'red', kind: 'light', px: 0.80, py: 0.72,
    status: { colour: '#d04545', word: 'out', emphasis: true } },
  { id: 'echo', label: 'Echo', side: 'neutral', kind: 'scenery', px: 0.55, py: 0.50 },
];

/*
 * ONE drag, dispatched entirely INSIDE the frame in a single synchronous evaluate.
 *
 * ⛔ It has to be one call. A drag split across several `evaluate`s is several CDP round trips, and
 * two of those interleaved across two pages is not a race — it is a queue. One call per page means
 * the two drops genuinely contend.
 *
 * The events are PointerEvents on `window` because that is where the component listens: with
 * pointer capture the browser retargets to the token and they bubble to window anyway, and a
 * synthetic pointerId has no capture to take, so window is the one place that is right both ways.
 */
async function drag(page, id, toPx, toPy, { moves = 6 } = {}) {
  const f = contentFrame(page);
  return f.evaluate((tokenId, px, py, n) => {
    const content = document.querySelector('.ap-map-content');
    const tok = document.querySelector('.ap-token[data-token-id="' + tokenId + '"]');
    if (!content || !tok) throw new Error('no token ' + tokenId);
    const cr = content.getBoundingClientRect();
    const opts = (fx, fy) => ({
      clientX: cr.left + fx * cr.width, clientY: cr.top + fy * cr.height,
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    });
    const start = tok.getBoundingClientRect();
    tok.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: start.left + start.width / 2, clientY: start.top + start.height / 2,
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    }));
    const from = {
      px: (start.left + start.width / 2 - cr.left) / cr.width,
      py: (start.top + start.height / 2 - cr.top) / cr.height,
    };
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      window.dispatchEvent(new PointerEvent('pointermove',
        opts(from.px + (px - from.px) * t, from.py + (py - from.py) * t)));
    }
    window.dispatchEvent(new PointerEvent('pointerup', opts(px, py)));
    return n + 2;                       // events dispatched, so a silent no-op cannot read as a pass
  }, id, toPx, toPy, moves);
}

const boxOf = (page, sel) => contentFrame(page).$eval(sel, (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, left: el.style.left, top: el.style.top, tf: el.style.transform };
});
const near = (a, b, tol) => Math.abs(a - b) <= tol;

let server, browser, A, B, observer;

test('0720 C3.0 — two browsers mount the tokens component over a real map', async () => {
  try { mkdirSync(SHOTS, { recursive: true }); } catch { /* already there */ }
  server = await createServer({ port: 0 });
  browser = await launch();
  A = await connectUser(browser, server, { userId: 'ua', userName: 'Ava', role: 'participant' });
  B = await connectUser(browser, server, { userId: 'ub', userName: 'Bo', role: 'participant' });
  for (const p of [A, B]) await p.setViewport({ width: 1100, height: 760 });
  await until(() => server.presence().length === 2, { label: '2 connected' });

  /* ⭐ A THIRD, HEADLESS client. It writes nothing; it is the wire's own witness, so C3.3 can count
     what actually crossed the socket instead of what one page believes it sent. */
  observer = await connect(server.url(), { userId: 'obs', userName: 'Observer', role: 'participant' });

  server.pushComponent('all', 'tokens', { label: 'Tactical', tokens: ROSTER, path: PATH });
  for (const p of [A, B]) {
    const f = await waitContentFrame(p);
    await f.waitForSelector('.ap-token', { timeout: 8000 });
  }
  const counts = await Promise.all([A, B].map((p) => contentFrame(p).$$eval('.ap-token', (e) => e.length)));
  check(`both viewers render all ${ROSTER.length} tokens (${counts.join(' / ')})`,
    counts.every((c) => c === ROSTER.length), counts.join(','));

  /* Finding 6: the snapshot is complete and separate, so a mount is never blank — proven here by
     the fact that the roster is on screen before anybody has written a single store key. */
  check('…and the store is still EMPTY, so what is on screen came from the mount, not from a write',
    server.store.get(PATH) === undefined || Object.keys(server.store.get(PATH)).length === 0,
    JSON.stringify(server.store.get(PATH)));
});

test('0720 C3.1 — ⭐ CONTENT-ANCHORED: the position and the apparent size hold when the scale changes', async () => {
  const f = contentFrame(A);
  const content0 = await boxOf(A, '.ap-map-content');
  const tok0 = await boxOf(A, '.ap-token[data-token-id="alpha"]');

  check('the token carries its px/py as percentages of the untransformed box', tok0.left === '25%' && tok0.top === '25%',
    `${tok0.left} / ${tok0.top}`);
  const wantX0 = content0.x + 0.25 * content0.w, wantY0 = content0.y + 0.25 * content0.h;
  check('…and it is drawn at that anchor on screen',
    near(tok0.x + tok0.w / 2, wantX0, 2) && near(tok0.y + tok0.h / 2, wantY0, 2),
    `centre ${(tok0.x + tok0.w / 2).toFixed(1)},${(tok0.y + tok0.h / 2).toFixed(1)} want ${wantX0.toFixed(1)},${wantY0.toFixed(1)}`);

  // Change the map's scale from OUTSIDE the component — a stored view, exactly as a remote pan/zoom
  // arrives. Nothing tells the tokens layer directly; it observes the transform the map applies.
  const view0 = await f.evaluate(() => {
    const m = /translate\(([-0-9.]+)px, ([-0-9.]+)px\) scale\(([-0-9.]+)\)/.exec(
      document.querySelector('.ap-map-content').style.transform);
    return m ? { x: +m[1], y: +m[2], scale: +m[3] } : null;
  });
  expect(view0 && view0.scale > 0, 'the map applied a transform we can read back', JSON.stringify(view0));
  const scale1 = +(view0.scale * 1.8).toFixed(4);
  /* ⛔ `server.apply`, NOT `server.store.apply`. The bare store applies the op and returns the
     diff; only the API surface's `apply` BROADCASTS it (app/api-surface.mjs: "store.apply writes
     silently — no diff is broadcast, so no connected client ever hears"). A test that writes
     through the store and then waits for a browser to react waits forever — and one that writes
     through the store and asserts "nothing changed" passes for the wrong reason, which is worse. */
  server.apply({ path: 'map/view', verb: 'set', value: { x: 40, y: 25, scale: scale1 } },
    { userId: 'gm', role: 'presenter' });
  await until(async () => (await f.$eval('.ap-map-content', (el) => el.style.transform)).includes('scale(' + scale1 + ')'),
    { label: 'the map re-scaled', timeout: 6000 });
  await wait(80);

  const content1 = await boxOf(A, '.ap-map-content');
  const tok1 = await boxOf(A, '.ap-token[data-token-id="alpha"]');
  check(`the content box really did change size (${content0.w.toFixed(0)}px -> ${content1.w.toFixed(0)}px)`,
    Math.abs(content1.w - content0.w) > 20, `${content0.w} -> ${content1.w}`);
  check('⭐ the token is STILL at 25%/25% of the untransformed box', tok1.left === '25%' && tok1.top === '25%',
    `${tok1.left} / ${tok1.top}`);
  const wantX1 = content1.x + 0.25 * content1.w, wantY1 = content1.y + 0.25 * content1.h;
  check('⭐ …and it MOVED WITH THE CONTENT, landing on the same anchor at the new scale',
    near(tok1.x + tok1.w / 2, wantX1, 2) && near(tok1.y + tok1.h / 2, wantY1, 2),
    `centre ${(tok1.x + tok1.w / 2).toFixed(1)},${(tok1.y + tok1.h / 2).toFixed(1)} want ${wantX1.toFixed(1)},${wantY1.toFixed(1)}`);
  check('⭐ COUNTER-SCALED: its apparent size did not change with the zoom',
    near(tok1.w, tok0.w, 1.5) && near(tok1.h, tok0.h, 1.5),
    `${tok0.w.toFixed(1)}x${tok0.h.toFixed(1)} -> ${tok1.w.toFixed(1)}x${tok1.h.toFixed(1)}`);
  const inverse = (tf) => { const m = /scale\(([-0-9.e]+)\)/.exec(tf || ''); return m ? +m[1] : NaN; };
  /* ⚠ 1e-5, not exact: `el.style.transform` is re-serialised by the browser to six significant
     figures, so `scale(1.1049723756906078)` reads back as `scale(1.10497)`. An equality test here
     fails on a component that is doing exactly the right thing. */
  check('…because the transform carries the INVERSE of the map scale, read back as a number',
    near(inverse(tok1.tf), 1 / scale1, 1e-5) && near(inverse(tok0.tf), 1 / view0.scale, 1e-5),
    `${inverse(tok0.tf)} (want ${1 / view0.scale}) -> ${inverse(tok1.tf)} (want ${1 / scale1})`);

  // Put the view back so the drags below run on a plain, centred board.
  server.apply({ path: 'map/view', verb: 'set', value: view0 }, { userId: 'gm', role: 'presenter' });
  await until(async () => (await f.$eval('.ap-map-content', (el) => el.style.transform)).includes('scale(' + view0.scale),
    { label: 'view restored', timeout: 6000 });
});

test('0720 C3.2 — ⭐⭐ TWO BROWSERS, TWO DIFFERENT TOKENS, SAME INSTANT. Run 4×', async () => {
  const survived = [];
  for (let round = 1; round <= 4; round++) {
    const aTo = { px: 0.18 + round * 0.03, py: 0.20 + round * 0.05 };
    const bTo = { px: 0.86 - round * 0.03, py: 0.78 - round * 0.05 };

    /* ⛔ NO `await` BETWEEN THE TWO. Awaiting the first drag before starting the second serialises
       the very race this test exists to run — and it would pass on a design that loses one of
       every two writes. */
    const both = [drag(A, 'alpha', aTo.px, aTo.py), drag(B, 'delta', bTo.px, bTo.py)];
    const dispatched = await Promise.all(both);
    check(`round ${round}: both pages dispatched a full drag (${dispatched.join(' / ')} events each)`,
      dispatched.every((n) => n >= 8), dispatched.join(','));

    /* ⚠ WAIT ON *EITHER* DROP, THEN SETTLE. Waiting on BOTH turns a genuine lost write into a
       timeout, and a timeout says "the wire is slow" where the truth is "one of two writes was
       eaten" — the exact failure this file exists to name. Waiting on either and then settling
       lets the round REPORT 1/2 instead of dying with the wrong diagnosis. */
    await poll(() => {
      const coll = server.store.get(PATH) || {};
      return (coll.alpha && near(coll.alpha.px, aTo.px, 0.02))
        || (coll.delta && near(coll.delta.px, bTo.px, 0.02));
    }, `round ${round}: at least one drop reached the store`);
    await wait(250);

    const coll = server.store.get(PATH) || {};
    const aOk = !!coll.alpha && near(coll.alpha.px, aTo.px, 0.02) && near(coll.alpha.py, aTo.py, 0.02);
    const bOk = !!coll.delta && near(coll.delta.px, bTo.px, 0.02) && near(coll.delta.py, bTo.py, 0.02);
    survived.push((aOk ? 1 : 0) + (bOk ? 1 : 0));
    check(`round ${round}: ${(aOk ? 1 : 0) + (bOk ? 1 : 0)}/2 simultaneous drops survived intact in server.store`,
      aOk && bOk,
      `alpha=${JSON.stringify(coll.alpha && { px: coll.alpha.px, py: coll.alpha.py })} ` +
      `delta=${JSON.stringify(coll.delta && { px: coll.delta.px, py: coll.delta.py })}`);
    // The record is whole, not a bare pair of numbers: a drop must not amputate the token.
    check(`round ${round}: the written record kept its identity fields`,
      !!coll.alpha && coll.alpha.id === 'alpha' && coll.alpha.label === 'Alpha' && coll.alpha.side === 'blue'
      && !!coll.delta && !!coll.delta.status && coll.delta.status.emphasis === true,
      JSON.stringify(coll.alpha) + ' ' + JSON.stringify(coll.delta && coll.delta.status));
  }

  const coll = server.store.get(PATH) || {};
  check(`⭐ ONE KEY PER TOKEN: the collection holds ${Object.keys(coll).length} keys, one per token dropped`,
    Object.keys(coll).sort().join(',') === 'alpha,delta', Object.keys(coll).sort().join(','));
  expect(survived.every((s) => s === 2),
    '⭐⭐ all 4 concurrent rounds were lossless — 8 of 8 drops kept, not one favourable resolution',
    `per-round survivors: ${survived.join(',')}`);
});

test('0720 C3.3 — a DROP writes exactly one key; the drag itself writes NOTHING', async () => {
  const seen = () => observer.diffPaths.filter((d) => d.path.indexOf(PATH) === 0);
  const before = seen().length;

  // 12 pointer moves and one drop. If the component streamed, this is 13 writes and a carpet of
  // radar pings; navmap paid for that lesson and this is the assertion that keeps it paid.
  await drag(A, 'bravo', 0.44, 0.44, { moves: 12 });
  await poll(() => seen().length > before, 'the drop reached the wire');
  await wait(250);                                     // give any stragglers time to be wrong

  const added = seen().slice(before);
  check(`a 12-move drag + 1 drop produced ${added.length} store write(s) on the wire`,
    added.length === 1, added.map((d) => d.path).join(', '));
  check('…and it named exactly the one token key',
    added.length === 1 && added[0].path === PATH + '/bravo', added.map((d) => d.path).join(', '));
  check('…written by the dragger, attributed by the connection',
    added.length === 1 && added[0].by === 'ua', added.map((d) => d.by).join(','));
  check('…and no sibling token key was touched',
    Object.keys(server.store.get(PATH) || {}).sort().join(',') === 'alpha,bravo,delta',
    Object.keys(server.store.get(PATH) || {}).sort().join(','));
});

test('0720 C3.4 — one viewer\'s drop moves the token on the OTHER viewer\'s board', async () => {
  await drag(A, 'charlie', 0.62, 0.18);
  await poll(() => {
    const t = (server.store.get(PATH) || {}).charlie;
    return t && near(t.px, 0.62, 0.02);
  }, 'the drop landed in the store');

  await until(async () => (await boxOf(B, '.ap-token[data-token-id="charlie"]')).left === '62%',
    { label: "B sees A's token move", timeout: 6000 });
  const onB = await boxOf(B, '.ap-token[data-token-id="charlie"]');
  check("⭐ B's board shows the token where A dropped it", onB.left === '62%' && onB.top === '18%',
    `${onB.left} / ${onB.top}`);

  /* Idempotence (B6 finding 5): a diff nobody caused must change nothing. Re-writing the identical
     value is the cheapest honest version of that, and it is the one that catches a render which
     appends instead of reconciling. */
  const t = server.store.get(PATH + '/charlie');
  const countBefore = await contentFrame(B).$$eval('.ap-token', (e) => e.length);
  server.apply({ path: PATH + '/charlie', verb: 'set', value: t }, { userId: 'gm', role: 'presenter' });
  await wait(200);
  const countAfter = await contentFrame(B).$$eval('.ap-token', (e) => e.length);
  const stillThere = await boxOf(B, '.ap-token[data-token-id="charlie"]');
  check(`re-delivering the SAME value is a no-op: ${countBefore} tokens before, ${countAfter} after`,
    countAfter === countBefore && stillThere.left === '62%', `${countBefore}/${countAfter} ${stillThere.left}`);
});

test('0720 C3.4b — ⭐ THE LATE JOINER: seeded from the snapshot alone, and the roster is WHOLE', async () => {
  /*
   * B6 finding 6: the snapshot is separate and complete, so a viewer arriving mid-fight is seeded
   * with ZERO diffs. That makes the mount path the only thing standing between them and a blank —
   * or worse, a HALF — board.
   *
   * ⛔ This is the assertion that caught the real defect in the first cut. Seeding by replacing the
   * authored roster with the store collection gave a late joiner only the tokens somebody had
   * already dragged: four of five, with `echo` — never touched, still sitting where it was authored
   * — simply gone. Everyone already in the room saw a complete board, so nothing inside the session
   * that caused it could see the loss. The store is an OVERLAY on the roster, and this proves it.
   */
  const C = await connectUser(browser, server, { userId: 'uc', userName: 'Cy', role: 'participant' });
  await C.setViewport({ width: 1100, height: 760 });
  const f = await waitContentFrame(C);
  await f.waitForSelector('.ap-token', { timeout: 8000 });

  const ids = await f.$$eval('.ap-token', (els) => els.map((e) => e.getAttribute('data-token-id')).sort());
  check(`the late joiner sees the WHOLE roster: ${ids.join(', ')}`,
    ids.join(',') === 'alpha,bravo,charlie,delta,echo', ids.join(','));

  const moved = await boxOf(C, '.ap-token[data-token-id="charlie"]');
  check('…a token that HAS been dragged shows the store\'s position', moved.left === '62%', moved.left);
  const untouched = await boxOf(C, '.ap-token[data-token-id="echo"]');
  check('…and a token nobody has touched shows its AUTHORED position',
    untouched.left === '55%' && untouched.top === '50%', `${untouched.left} / ${untouched.top}`);
  check('…with no store key of its own, which is why replacing the roster lost it',
    (server.store.get(PATH) || {}).echo === undefined, JSON.stringify(Object.keys(server.store.get(PATH) || {})));
  await C.close();
});

test('0720 C3.5 — ⛔ `map` unavailable ⇒ a visible sentence, not a throw', async () => {
  const out = await contentFrame(A).evaluate(() => {
    const reg = window.ApComponents;
    const real = reg.get;
    reg.get = function (n) { return n === 'map' ? undefined : real.call(reg, n); };
    const host = document.createElement('div');
    host.id = 'c3-degraded';
    document.body.appendChild(host);
    let threw = null, handle = null;
    try { handle = reg.get('tokens')(host, { path: 'shared/tactical/c3-control', tokens: [{ id: 'x', label: 'X' }] }); }
    catch (e) { threw = String(e && e.message || e); }
    const text = host.textContent;
    const hasDestroy = !!(handle && typeof handle.destroy === 'function');
    try { if (handle) handle.destroy(); } catch (e) { threw = threw || 'destroy: ' + e.message; }
    host.remove();
    reg.get = real;
    return { threw, text, hasDestroy };
  });
  check('mounting with no `map` did not throw', out.threw === null, String(out.threw));
  check(`it degraded VISIBLY: "${out.text}"`, /map/i.test(out.text) && out.text.length > 10, out.text);
  check('…and still returned a handle a host can destroy', out.hasDestroy === true, String(out.hasDestroy));

  // The control: with `map` restored, the same call renders a board. Without this the check above
  // passes just as well on a component that can never mount at all.
  const ok = await contentFrame(A).evaluate(() => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    /* Its OWN path: the default collection already holds four dropped tokens, and this component
       overlays the store onto the authored roster by design — so a control mounted on the live path
       would legitimately render five and read as a failure. */
    const h = window.ApComponents.get('tokens')(host, {
      path: 'shared/tactical/c3-control', tokens: [{ id: 'x', label: 'X' }],
    });
    const n = host.querySelectorAll('.ap-token').length, map = !!host.querySelector('.ap-map-content');
    h.destroy(); host.remove();
    return { n, map };
  });
  check('control — with `map` present the same call renders a map and a token', ok.map && ok.n === 1,
    JSON.stringify(ok));
});

test('0720 C3.6 — ⛔ an ephemeral path segment is refused, on the board, not in a console', async () => {
  /* B6 measured it: any path with a `pointer` or `laser` SEGMENT is coalesced — 12 ops became 1
     delivered diff with version:null. A drag may ride that deliberately; a DROP may not, and a
     board that quietly discards drops is worse than one that says it cannot take them. */
  const out = await contentFrame(A).evaluate(() => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const h = window.ApComponents.get('tokens')(host, {
      path: 'shared/tactical/pointer/tokens', tokens: [{ id: 'x', label: 'X', px: 0.5, py: 0.5 }],
    });
    const layer = host.querySelector('.ap-tokens-layer');
    const res = {
      flagged: layer.getAttribute('data-ap-ephemeral') === '1',
      warning: (host.querySelector('.ap-tokens-warning') || {}).textContent || '',
      static: !!host.querySelector('.ap-token.is-static'),
      rendered: host.querySelectorAll('.ap-token').length,
    };
    h.destroy(); host.remove();
    return res;
  });
  check('the coalescing path is flagged on the layer', out.flagged === true, String(out.flagged));
  check(`…and says so where a human will read it: "${out.warning}"`, /ephemeral/.test(out.warning), out.warning);
  check('…and the tokens are frozen rather than accepting a drop that will not persist',
    out.static === true && out.rendered === 1, JSON.stringify(out));
});

test('0720 C3.7 — the screenshot, and the store\'s last word', async () => {
  await A.bringToFront();
  await wait(350);
  await A.screenshot({ path: join(SHOTS, '0720-c3-tokens.png'), captureBeyondViewport: false });
  await B.bringToFront();
  await wait(350);
  await B.screenshot({ path: join(SHOTS, '0720-c3-tokens-viewer2.png'), captureBeyondViewport: false });

  const coll = server.store.get(PATH) || {};
  check(`${Object.keys(coll).length} token keys in the store: ${Object.keys(coll).sort().join(', ')}`,
    Object.keys(coll).length === 4);
  const counts = await Promise.all([A, B].map((p) => contentFrame(p).$$eval('.ap-token', (e) => e.length)));
  check(`both boards still show all ${ROSTER.length} tokens after everything (${counts.join(' / ')})`,
    counts.every((c) => c === ROSTER.length), counts.join(','));
  expect(true, 'screenshots written to test/screenshots/0720-c3-tokens*.png');
});

test('0720 C3.9 — teardown', async () => {
  if (observer) observer.close();
  if (browser) await browser.close();
  if (server) await server.close();
  expect(true, 'server closed');
});
