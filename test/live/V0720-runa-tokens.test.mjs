/*
 * Plan 0720 RUN A — the `tokens` component, six defects, in a real browser against a real store.
 *
 * Every one of these was found by an audit reading the source, and every one of them is the kind
 * that a passing suite does not notice: the component keeps working, the board keeps rendering,
 * and something the caller published is quietly not there any more.
 *
 *   A1  ⛔ THE FIELD WHITELIST ERASED ON READ. Four places rebuilt a record out of seven named
 *          fields, so an eighth field could never work AT ALL — not "was lost on the first drag".
 *   A2  ⛔ EVERY TOKEN WAS DRAGGABLE OR NONE WERE. A piece that stands for the board's own origin
 *          could be shoved off centre by one stray finger, and re-authoring does not put it back.
 *   A3  ⛔ A ZERO-MOVEMENT TAP WROTE. On a touch screen a tap IS a pointerdown/up pair, so merely
 *          touching a piece converted it to a stored record.
 *   A5  ⛔ AN EMPTY BOARD RENDERED NOTHING AND SAID NOTHING — indistinguishable from a broken one.
 *   A6  ⛔ RE-MOUNTING LEAKED. The handle carries a working teardown that no caller ever kept.
 *
 * ⚠ EVERY CLAIM IS READ OUT OF `server.store` OR OUT OF THE COMPONENT'S OWN HANDLE. A field that
 * is present in a page's local variable and absent from the store is not shared — and "it is in the
 * store" is the only form of this claim that a second viewer can act on.
 *
 * ⛔ DOMAIN-FREE FIXTURES (PSS t0531-01): this repo is public. `side` and `kind` are opaque strings
 * to the component; the extra fields below are invented for the test and mean nothing to anybody.
 *
 * ⚠ SANDBOXED-IFRAME MECHANICS: `contentDocument` is always null (use `page.frames()`), a
 * backgrounded page composites a stale frame (bringToFront first), a screenshot needs
 * `captureBeyondViewport:false`.
 */
import { test, expect, check } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until, wait } from '../../harness/multi.mjs';
import { poll } from './_0720-band-b-client.mjs';

/* Its OWN collection, mounted on its OWN host. The pushed component below exists only to give the
   frame a registry and a live socket; every assertion here is about a second instance that shares
   nothing with it. */
const PATH = 'shared/tactical/runa';

let server, browser, A;

/**
 * Mount a second `tokens` instance on a host of our own inside the content frame and keep the
 * handle where the test can reach it. `ApComponents.mount` throws the handle away (that IS A6), so
 * the factory is called directly — the same door C3.5 and C3.6 use.
 */
async function mountProbe(page, opts) {
  return contentFrame(page).evaluate((o) => {
    const host = document.createElement('div');
    host.id = 'runa-host';
    host.style.cssText = 'position:relative;width:600px;height:400px';
    document.body.appendChild(host);
    window.__runa = window.ApComponents.get('tokens')(host, o);
    return host.querySelectorAll('.ap-token').length;
  }, opts);
}
const modelOf = (page) => contentFrame(page).evaluate(() => window.__runa.tokens());
const unmountProbe = (page) => contentFrame(page).evaluate(() => {
  if (window.__runa && window.__runa.destroy) window.__runa.destroy();
  const h = document.getElementById('runa-host'); if (h) h.remove();
  window.__runa = null;
});

/**
 * ONE drag, dispatched entirely INSIDE the frame in a single synchronous evaluate, SCOPED to our
 * own host so the pushed component's identically-classed tokens cannot be picked up by accident.
 *
 * `moves:0` is the whole of A3: a pointerdown and a pointerup at the same coordinate, which is what
 * a finger tapping a piece actually produces.
 */
async function dragIn(page, id, toPx, toPy, { moves = 6 } = {}) {
  return contentFrame(page).evaluate((tokenId, px, py, n) => {
    const host = document.getElementById('runa-host');
    const content = host.querySelector('.ap-map-content');
    const tok = host.querySelector('.ap-token[data-token-id="' + tokenId + '"]');
    if (!content || !tok) throw new Error('no token ' + tokenId);
    const cr = content.getBoundingClientRect();
    const at = (fx, fy) => ({
      clientX: cr.left + fx * cr.width, clientY: cr.top + fy * cr.height,
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    });
    const start = tok.getBoundingClientRect();
    const down = { clientX: start.left + start.width / 2, clientY: start.top + start.height / 2 };
    tok.dispatchEvent(new PointerEvent('pointerdown', {
      ...down, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    }));
    const from = { px: (down.clientX - cr.left) / cr.width, py: (down.clientY - cr.top) / cr.height };
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      window.dispatchEvent(new PointerEvent('pointermove', at(from.px + (px - from.px) * t, from.py + (py - from.py) * t)));
    }
    /* ⛔ A ZERO-MOVE TAP RELEASES WHERE IT PRESSED, not at some target fraction. Releasing
       elsewhere would be a jump, not a tap, and the threshold would rightly fire. */
    window.dispatchEvent(new PointerEvent('pointerup', n === 0
      ? { ...down, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }
      : at(px, py)));
    return n + 2;
  }, id, toPx, toPy, moves);
}

const gm = { userId: 'gm', role: 'presenter' };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('0720 RUN-A.0 — a browser, a real store, and a second tokens instance of our own', async () => {
  server = await createServer({ port: 0 });
  browser = await launch();
  A = await connectUser(browser, server, { userId: 'ua', userName: 'Ava', role: 'participant' });
  await A.setViewport({ width: 1100, height: 760 });
  await until(() => server.presence().length === 1, { label: '1 connected' });
  /* The pushed component is scaffolding: it gives the frame the registry and the socket. It writes
     to the default collection and this file never looks at it again. */
  server.pushComponent('all', 'tokens', { label: 'Board', tokens: [{ id: 'seed', label: 'Seed' }] });
  const f = await waitContentFrame(A);
  await f.waitForSelector('.ap-token', { timeout: 8000 });
  expect(true, 'frame is live and the registry is loaded');
});

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * A1 — THE FIELD WHITELIST
 * ──────────────────────────────────────────────────────────────────────────────────────────────*/

test('0720 RUN-A.1 — ⭐⭐ AN EXTRA FIELD SURVIVES THE READ, AND THEN SURVIVES THE DRAG', async () => {
  /*
   * ⛔ THE ORDER IS THE TEST. The audit's own phrasing — "a new field is erased by the first drag" —
   * understates it: `applyCollection` runs `normalise` over everything the store hands back, so the
   * field was gone the moment the record was READ. A test that only dragged and then looked at the
   * store would report the same failure and blame the wrong function.
   */
  const n = await mountProbe(A, { path: PATH, tokens: [{ id: 'scout-1', label: 'Scout', px: 0.3, py: 0.3 }] });
  check('the probe instance mounted its own single token', n === 1, String(n));

  // A record arrives from the store carrying two fields this component has never heard of.
  server.apply({ path: PATH + '/scout-1', verb: 'set', value: {
    id: 'scout-1', label: 'Scout', side: 'blue', kind: 'light', px: 0.3, py: 0.3, status: null,
    note: 'kept', weight: 7,
  } }, gm);
  await poll(async () => (await modelOf(A))['scout-1'].note === 'kept', 'the extra field reached the model');

  const read = (await modelOf(A))['scout-1'];
  check(`⭐ READ: the component is holding note=${JSON.stringify(read.note)} weight=${JSON.stringify(read.weight)}`,
    read.note === 'kept' && read.weight === 7, JSON.stringify(read));
  check('…and it did not lose the fields it DOES understand while carrying the ones it does not',
    read.label === 'Scout' && read.side === 'blue' && near(read.px, 0.3, 1e-6), JSON.stringify(read));

  await dragIn(A, 'scout-1', 0.7, 0.6);
  await poll(() => { const t = server.store.get(PATH + '/scout-1'); return t && near(t.px, 0.7, 0.03); },
    'the drop reached the store');

  const wrote = server.store.get(PATH + '/scout-1');
  check(`⭐ DRAG: the store record still carries note=${JSON.stringify(wrote.note)} weight=${JSON.stringify(wrote.weight)}`,
    wrote.note === 'kept' && wrote.weight === 7, JSON.stringify(wrote));
  check('…and the drag did what a drag is for', near(wrote.px, 0.7, 0.03) && near(wrote.py, 0.6, 0.03),
    `${wrote.px} / ${wrote.py}`);
});

test('0720 RUN-A.1b — a SINGLE-LEAF diff must not amputate the rest of the record', async () => {
  /* `applyField` rebuilt the record from seven names, so one op naming one field deleted every
     other field the record had — including the fields the component itself understands, if a caller
     had ever added an eighth. This is the same defect wearing its quietest face. */
  server.apply({ path: PATH + '/scout-1/status', verb: 'set', value: 'hot' }, gm);
  await poll(async () => (await modelOf(A))['scout-1'].status === 'hot', 'the leaf diff landed');

  const m = (await modelOf(A))['scout-1'];
  check('the leaf that was written changed', m.status === 'hot', JSON.stringify(m.status));
  check('⭐ …and NOTHING ELSE DID', m.note === 'kept' && m.weight === 7 && m.label === 'Scout' && near(m.px, 0.7, 0.03),
    JSON.stringify(m));
});

test('0720 RUN-A.1c — ⛔ the ONE exclusion: host bookkeeping is not token data', async () => {
  /* `_`-prefixed keys belong to the store, not to the piece. Carrying them would round-trip the
     host's own internals back through a participant write on the next drop — and the audit's F8
     found exactly that shape being scooped up and rendered as a piece. */
  server.apply({ path: PATH + '/scout-1', verb: 'set', value: {
    id: 'scout-1', label: 'Scout', px: 0.7, py: 0.6, note: 'kept', _lock: { by: 'someone' },
  } }, gm);
  await poll(async () => (await modelOf(A))['scout-1']._lock === undefined && (await modelOf(A))['scout-1'].note === 'kept',
    'the record was re-read');
  const m = (await modelOf(A))['scout-1'];
  check('a `_`-prefixed key is dropped', m._lock === undefined, JSON.stringify(m._lock));
  check('…while an ordinary extra field beside it is still carried', m.note === 'kept', JSON.stringify(m));
  await unmountProbe(A);
});

test('0720 RUN-A.9 — teardown', async () => {
  if (browser) await browser.close();
  if (server) await server.close();
  expect(true, 'server closed');
});
