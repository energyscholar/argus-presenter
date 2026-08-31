/*
 * Plan 0720 RUN B — ⛔⛔ A LOCK IS NOT A PIECE, AND THE BOARD WAS RENDERING TWO OF THEM.
 *
 * The serialiser (T1) drops host bookkeeping on the way into a document. That closes the CAPTURE
 * half of the finding and leaves the RENDER half wide open — and the render half is the one the
 * table looks at. Any participant may `lock` anything under `shared/**` (app/permissions.mjs), so
 * both of these are reachable by an ordinary client, today:
 *
 *   1. ⛔ A LOCK ON THE COLLECTION lands at `<board>/lock` as a plain string. `applyCollection`
 *      iterates every key of the collection, so that string is normalised as a TOKEN and a piece
 *      labelled "lock" appears at dead centre of the board — the exact shape the batch brief
 *      predicted for a generic sweep, arriving through the component instead.
 *
 *   2. ⛔⛔ A LOCK ON A RECORD lands at `<board>/<id>/lock`, INSIDE the record — and since RUN A
 *      correctly made a token record OPEN rather than seven fixed fields, `lock` became ordinary
 *      token data that every client mirrors and that `emit` writes back on the next drop.
 *      ⭐ DEMONSTRATED, L.2: after a GM's `unlock`, the next drag by an unrelated participant wrote
 *      `lock:null` straight back into the record, where it stays and is delivered to every client.
 *      ⚠ THE HAZARD THAT FOLLOWS, stated as a hazard because it is not deterministic here: a client
 *      that has not seen the unlock diff still holds the OWNER in its model, and its next drop
 *      re-asserts the lock — a GM's recovery undone by somebody moving a piece, silently.
 *      This is the cost of the whitelist inversion, invisible because nothing locks a token yet.
 *
 * ⚠ EVERY CLAIM IS READ FROM THE RENDERED FRAME OR FROM `server.store`.
 * ⛔ DOMAIN-FREE FIXTURES (PSS t0531-01): this repo is public.
 */
import { test, expect, check } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, waitContentFrame, until } from '../../harness/multi.mjs';
import { setTokenOp } from '../../app/board-document.mjs';

const PATH = 'shared/tactical/runb-locks';
const SYS = { userId: 'server', role: 'system' };
const ANN = { userId: 'ann', role: 'participant' };

let server, browser, A;

const idsOn = async (page) => (await waitContentFrame(page)).evaluate(() =>
  Array.from(document.querySelectorAll('.ap-token')).map((e) => e.getAttribute('data-token-id')).sort());
const labelsOn = async (page) => (await waitContentFrame(page)).evaluate(() =>
  Array.from(document.querySelectorAll('.ap-token .ap-token-label')).map((e) => e.textContent).sort());

async function dragTo(page, id, px, py) {
  await (await waitContentFrame(page)).evaluate((tokenId, tx, ty) => {
    const content = document.querySelector('.ap-map-content');
    const tok = document.querySelector('.ap-token[data-token-id="' + tokenId + '"]');
    const cr = content.getBoundingClientRect();
    const s = tok.getBoundingClientRect();
    const ev = (t, x, y) => new PointerEvent(t, {
      clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true });
    tok.dispatchEvent(ev('pointerdown', s.left + s.width / 2, s.top + s.height / 2));
    for (let i = 1; i <= 6; i++) window.dispatchEvent(ev('pointermove', cr.left + tx * cr.width, cr.top + ty * cr.height));
    window.dispatchEvent(ev('pointerup', cr.left + tx * cr.width, cr.top + ty * cr.height));
  }, id, px, py);
}

test('0720 RUN-B L.0 — a board with two pieces on it', async () => {
  server = await createServer({ port: 0 });
  browser = await launch();
  server.apply(setTokenOp(PATH, 'flag', { id: 'flag', label: 'Flag', px: 0.5, py: 0.5 }), SYS);
  server.apply(setTokenOp(PATH, 'raider', { id: 'raider', label: 'Raider', px: 0.2, py: 0.2 }), SYS);

  A = await connectUser(browser, server, { userId: 'ua', userName: 'Ava', role: 'participant' });
  await until(() => server.presence().length === 1, { label: '1 connected' });
  server.pushComponent('all', 'tokens', { label: 'Board', path: PATH });
  await until(async () => (await idsOn(A)).length === 2, { label: 'the board to render' });
  check('two pieces', (await idsOn(A)).join(',') === 'flag,raider', (await idsOn(A)).join(','));
});

test('0720 RUN-B L.1 — ⛔ A LOCK ON THE COLLECTION MUST NOT APPEAR AS A PIECE', async () => {
  /* An ordinary participant, through the ordinary permission. Nothing exotic. */
  const res = server.apply({ path: PATH, verb: 'lock', value: {} }, ANN);
  check('precondition: the lock really landed in the store', server.store.get(PATH + '/lock') === 'ann',
    JSON.stringify(res && res.diff));

  await new Promise((r) => setTimeout(r, 250));
  const ids = await idsOn(A);
  check('⛔ NO piece is named `lock`', !ids.includes('lock'), ids.join(','));
  check('⛔ …and none is LABELLED "lock" either', !(await labelsOn(A)).includes('lock'),
    (await labelsOn(A)).join(','));
  check('the real pieces are untouched', ids.join(',') === 'flag,raider', ids.join(','));

  server.apply({ path: PATH, verb: 'unlock', value: { force: true } }, { userId: 'server', role: 'system' });
});

test('0720 RUN-B L.2 — ⛔⛔ A DRAG DOES NOT WRITE HOST BOOKKEEPING BACK INTO THE RECORD', async () => {
  server.apply({ path: PATH + '/raider', verb: 'lock', value: {} }, ANN);
  check('precondition: the record lock is held', server.store.lockOwnerFor(PATH + '/raider') === 'ann');
  await new Promise((r) => setTimeout(r, 250));

  /* The GM breaks it — a piece abandoned mid-edit has to be recoverable. */
  server.apply({ path: PATH + '/raider', verb: 'unlock', value: { force: true } }, { userId: 'server', role: 'system' });
  await new Promise((r) => setTimeout(r, 250));
  check('the unlock took', server.store.lockOwnerFor(PATH + '/raider') === null,
    String(server.store.lockOwnerFor(PATH + '/raider')));

  /* …and now somebody who is NOT ann moves it. If the component mirrored `lock` as token data,
     this drop writes it straight back and the piece is locked to ann again, silently. */
  await dragTo(A, 'raider', 0.7, 0.7);
  await until(() => Math.abs(server.store.get(PATH + '/raider').px - 0.7) < 0.05,
    { label: 'the drop to land' });

  check('⭐ the drag landed', Math.abs(server.store.get(PATH + '/raider').px - 0.7) < 0.05,
    JSON.stringify(server.store.get(PATH + '/raider')));
  /* ⚠ HONEST ABOUT WHICH ASSERTION BITES. This first one passed on the BROKEN component too: the
     unlock's own diff had already overwritten the mirrored owner with null, so the drop wrote back
     `lock:null` rather than `lock:"ann"`. It is kept because it is the hazard the second one closes
     structurally — a client that has NOT seen the unlock diff still holds the owner and re-asserts
     it on its next drop, which is not deterministically reproducible here. */
  check('the piece is not locked to anyone', server.store.lockOwnerFor(PATH + '/raider') === null,
    'lock owner is now ' + server.store.lockOwnerFor(PATH + '/raider'));
  /* ⭐ THIS is the one that went red on the unfixed component: `{"lock":null, …}`. The record had
     absorbed the store's own bookkeeping as ordinary token data, written there by a participant's
     drag, and delivered to every client from then on. */
  check('⛔⛔ `lock` IS NOT SITTING IN THE RECORD AS ORDINARY DATA',
    !('lock' in server.store.get(PATH + '/raider')), JSON.stringify(server.store.get(PATH + '/raider')));
});

test('0720 RUN-B L.9 — teardown', async () => {
  await browser.close();
  await server.close();
  expect(true, 'closed');
});
