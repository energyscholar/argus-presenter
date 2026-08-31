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

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * A2 — THE PER-TOKEN PIN
 * ──────────────────────────────────────────────────────────────────────────────────────────────*/

test('0720 RUN-A.2 — ⭐⭐ A PINNED TOKEN REFUSES THE DRAG, AND THE PROOF IS THE STORE', async () => {
  /*
   * ⛔ ASSERT ON THE STORE, NOT ON THE DOM. A component that let the piece slide under the finger
   * and merely declined to WRITE would look identical in a DOM assertion taken mid-drag — and it
   * would be wrong in the way that matters, because the next diff would snap the piece back and
   * every viewer would see a different board for as long as the hand was down.
   *
   * The control is the whole test: an UNPINNED token on the same board, dragged by the same helper
   * in the same call, MUST move. Without it this passes on a component that has stopped dragging
   * anything at all.
   */
  await mountProbe(A, { path: PATH + '2', draggable: 'all', tokens: [
    { id: 'origin', label: 'Origin', px: 0.5, py: 0.5, pin: true },
    { id: 'raider', label: 'Raider', px: 0.2, py: 0.2 },
  ] });

  const cls = await contentFrame(A).evaluate(() => {
    const q = (id) => document.querySelector('#runa-host .ap-token[data-token-id="' + id + '"]');
    return {
      pinned: q('origin').className, pinnedAttr: q('origin').getAttribute('data-pin'),
      free: q('raider').className, freeAttr: q('raider').getAttribute('data-pin'),
    };
  });
  check(`the pinned token is marked on screen: "${cls.pinned}"`,
    /is-pinned/.test(cls.pinned) && /is-static/.test(cls.pinned) && cls.pinnedAttr === '1', JSON.stringify(cls));
  check(`…and the free one is not: "${cls.free}"`,
    !/is-pinned|is-static/.test(cls.free) && cls.freeAttr === null, JSON.stringify(cls));

  await dragIn(A, 'origin', 0.85, 0.85);
  await dragIn(A, 'raider', 0.7, 0.75);
  await poll(() => { const t = server.store.get(PATH + '2/raider'); return t && near(t.px, 0.7, 0.03); },
    'the CONTROL drag reached the store');
  await wait(300);                                    // give a wrong write time to arrive

  const coll = server.store.get(PATH + '2') || {};
  check('⭐ THE PINNED TOKEN WROTE NOTHING — no key of its own exists at all',
    coll.origin === undefined, JSON.stringify(coll.origin));
  check('⭐ CONTROL: the unpinned token on the same board moved, so the refusal is not a dead surface',
    !!coll.raider && near(coll.raider.px, 0.7, 0.03) && near(coll.raider.py, 0.75, 0.03),
    JSON.stringify(coll.raider));
  check(`…and exactly one key exists: ${Object.keys(coll).join(', ') || '(none)'}`,
    Object.keys(coll).join(',') === 'raider', Object.keys(coll).join(','));

  const still = await modelOf(A);
  check('…and the pinned token is still exactly where it was declared',
    near(still.origin.px, 0.5, 1e-6) && near(still.origin.py, 0.5, 1e-6),
    `${still.origin.px} / ${still.origin.py}`);
});

test('0720 RUN-A.2b — ⛔ a pin that arrives LATER pins a token that is already on the board', async () => {
  /* The origin may be declared after the board is up — that is exactly the shape the board document
     takes when a tool writes it. An element created before the pin arrived must not stay draggable
     for the rest of the session, so the guard reads the LIVE record rather than the mount. */
  server.apply({ path: PATH + '2/raider', verb: 'set', value: {
    id: 'raider', label: 'Raider', px: 0.7, py: 0.75, pin: true,
  } }, gm);
  await poll(async () => (await modelOf(A)).raider.pin === true, 'the pin diff landed');

  const marked = await contentFrame(A).$eval('#runa-host .ap-token[data-token-id="raider"]', (el) => el.className);
  check(`the already-rendered element picked the pin up: "${marked}"`, /is-pinned/.test(marked), marked);

  await dragIn(A, 'raider', 0.1, 0.1);
  await wait(300);
  const t = server.store.get(PATH + '2/raider');
  check('⭐ …and it now refuses the drag too', near(t.px, 0.7, 0.01) && near(t.py, 0.75, 0.01),
    `${t.px} / ${t.py}`);
  await unmountProbe(A);
});


/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * A3 — THE MOVEMENT THRESHOLD
 * ──────────────────────────────────────────────────────────────────────────────────────────────*/

test('0720 RUN-A.3 — ⭐⭐ A TAP WITH NO MOVEMENT WRITES NOTHING AT ALL', async () => {
  /*
   * ⛔ "NOTHING", NOT "THE SAME VALUE". A `set` of an identical record still converts an AUTHORED
   * token into a STORED one, and `recompute()` lets the store win from then on — so re-authoring
   * the roster can never change that piece again. The board goes quietly un-authorable one tap at a
   * time, with every value on screen still perfectly correct. The assertion is therefore about the
   * EXISTENCE of the key, not about its contents.
   *
   * ⚠ And this is a phone defect above all: a tap IS a pointerdown/pointerup pair with nothing in
   * between, so on a touch screen simply touching a piece to see it did this.
   */
  await mountProbe(A, { path: PATH + '3', tokens: [
    { id: 'flag', label: 'Flag', px: 0.4, py: 0.4 },
    { id: 'scout-2', label: 'Scout Two', px: 0.6, py: 0.6 },
  ] });
  check('the collection starts empty', server.store.get(PATH + '3') === undefined,
    JSON.stringify(server.store.get(PATH + '3')));

  const n = await dragIn(A, 'flag', 0, 0, { moves: 0 });
  check(`a bare down/up pair was dispatched (${n} events)`, n === 2, String(n));
  await wait(400);                                    // give a wrong write every chance to land

  check('⭐ THE TAP CREATED NO KEY — the token is still purely authored',
    server.store.get(PATH + '3') === undefined || server.store.get(PATH + '3').flag === undefined,
    JSON.stringify(server.store.get(PATH + '3')));

  /* CONTROL. Without this the check above passes just as well on a component that has stopped
     writing altogether — which is the failure this threshold is most likely to introduce. */
  await dragIn(A, 'scout-2', 0.25, 0.8);
  await poll(() => { const t = server.store.get(PATH + '3/scout-2'); return t && near(t.px, 0.25, 0.03); },
    'CONTROL: a real drag on the same board still writes');
  check('⭐ CONTROL: a real drag on the same board still writes',
    near(server.store.get(PATH + '3/scout-2').px, 0.25, 0.03), JSON.stringify(server.store.get(PATH + '3/scout-2')));
});

test('0720 RUN-A.3b — a 3px tremor is a tap; a 40px pull is a drag', async () => {
  /* The threshold is in VIEWPORT pixels, not content fractions, because the question is "did the
     hand move" and the hand does not know the map's zoom. So the fixture moves the pointer by an
     exact pixel count rather than by a fraction of the board. */
  const jitter = (id, dx) => contentFrame(A).evaluate((tokenId, d) => {
    const tok = document.querySelector('#runa-host .ap-token[data-token-id="' + tokenId + '"]');
    const r = tok.getBoundingClientRect();
    const base = { clientY: r.top + r.height / 2, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const x0 = r.left + r.width / 2;
    tok.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x0 }));
    for (let i = 1; i <= 6; i++) window.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x0 + (d * i) / 6 }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x0 + d }));
    return d;
  }, id, dx);

  const before = { ...(await modelOf(A)).flag };
  await jitter('flag', 3);
  await wait(350);
  const afterTremor = (await modelOf(A)).flag;
  check('a 3px tremor left the record untouched, on the board as well as in the store',
    near(afterTremor.px, before.px, 1e-9) && (server.store.get(PATH + '3') || {}).flag === undefined,
    `${before.px} -> ${afterTremor.px} · store=${JSON.stringify((server.store.get(PATH + '3') || {}).flag)}`);

  await jitter('flag', 40);
  await poll(() => (server.store.get(PATH + '3') || {}).flag !== undefined, 'a 40px pull did write');
  const wrote = server.store.get(PATH + '3/flag');
  check('⭐ …and a 40px pull wrote, so the threshold is a threshold and not an off switch',
    !!wrote && wrote.px > before.px, JSON.stringify(wrote));
  await unmountProbe(A);
});


test('0720 RUN-A.9 — teardown', async () => {
  if (browser) await browser.close();
  if (server) await server.close();
  expect(true, 'server closed');
});
