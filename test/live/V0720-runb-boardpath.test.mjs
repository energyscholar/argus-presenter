/*
 * Plan 0720 RUN B / B3 — RE-POINT THE BOARD MID-SESSION, WITH ONE WRITE.
 *
 * ⛔⛔ WHY THIS IS THE ONLY ESCAPE HATCH THERE IS. During a session the deploy poller is stopped,
 * because a push restarts the service and the store is in memory: token positions, round, turn,
 * acted flags and ship damage all go with it. So the reflex for correcting a mistake — push a fix —
 * is the one act that destroys the session. Everything that must be correctable while people are
 * playing has to be correctable THROUGH THE STORE, and a board authored at the wrong collection, or
 * one littered with keys from a rehearsal, is exactly that kind of mistake. It was hit live on
 * 2026-08-31 and the only lever available was to re-point the board by hand.
 *
 * ⭐ The store key beats `opts.path` DELIBERATELY. A mount's options are frozen at push time; the
 * whole point is to change the board without re-pushing anything.
 *
 * ⚠ EVERY CLAIM IS READ FROM THE RENDERED FRAME OR FROM `server.store` — never from a local
 * variable this file also wrote.
 *
 * ⛔ DOMAIN-FREE FIXTURES (PSS t0531-01): this repo is public.
 */
import { test, expect, check } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';
import { setTokenOp, setBoardPathOp, BOARD_PATH_KEY } from '../../app/board-document.mjs';

const MOUNTED = 'shared/tactical/runb-mounted';      // what the mount was pushed with
const REPOINTED = 'shared/tactical/runb-repointed';  // where one write sends it
const SYS = { userId: 'server', role: 'system' };

let server, browser, A, B;

/* ⚠ The content frame appears ASYNCHRONOUSLY after a push; `contentFrame` returns null until it
   does, and a helper that dereferences it immediately fails with a null read rather than waiting. */
const idsOn = async (page) => (await waitContentFrame(page)).evaluate(() =>
  Array.from(document.querySelectorAll('.ap-token')).map((e) => e.getAttribute('data-token-id')).sort());
const layerPath = async (page) => (await waitContentFrame(page)).evaluate(() => {
  const l = document.querySelector('.ap-tokens-layer');
  return l ? l.getAttribute('data-ap-path') : null;
});

test('0720 RUN-B B3.1 — a mounted board renders the collection its OPTS name', async () => {
  server = await createServer({ port: 0 });
  browser = await launch();
  server.apply(setTokenOp(MOUNTED, 'flag', { id: 'flag', label: 'Flag', px: 0.5, py: 0.5 }), SYS);
  server.apply(setTokenOp(MOUNTED, 'scout-1', { id: 'scout-1', label: 'Scout 1', px: 0.2, py: 0.2 }), SYS);
  server.apply(setTokenOp(REPOINTED, 'raider', { id: 'raider', label: 'Raider', px: 0.8, py: 0.8 }), SYS);

  A = await connectUser(browser, server, { userId: 'ua', userName: 'Ava', role: 'participant' });
  await until(() => server.presence().length === 1, { label: '1 connected' });
  server.pushComponent('all', 'tokens', { label: 'Board', path: MOUNTED });
  await until(async () => (await idsOn(A)).length === 2, { label: 'the mounted board to render' });

  check('the mount is showing its own collection', (await idsOn(A)).join(',') === 'flag,scout-1',
    (await idsOn(A)).join(','));
  check('and says so on the layer', (await layerPath(A)) === MOUNTED, await layerPath(A));
  check('⛔ the key is genuinely unset — the default path is not doing this',
    server.store.get(BOARD_PATH_KEY) === undefined);
});

test('0720 RUN-B B3.2 — ⭐ ONE WRITE RE-POINTS IT, with the mount untouched', async () => {
  server.apply(setBoardPathOp(REPOINTED), SYS);
  await until(async () => (await layerPath(A)) === REPOINTED, { label: 'the board to re-point' });

  check('⭐ the board is now showing the OTHER collection', (await idsOn(A)).join(',') === 'raider',
    (await idsOn(A)).join(','));
  check('⛔ and the pieces of the abandoned board are gone from the screen',
    !(await idsOn(A)).includes('flag'));
  check('⛔ …but NOT from the store — re-pointing abandons a collection, it does not delete one',
    !!server.store.get(MOUNTED + '/flag'));
});

test('0720 RUN-B B3.3 — a drop lands on the NEW collection, not the abandoned one', async () => {
  const before = JSON.stringify(server.store.get(MOUNTED));
  await (await waitContentFrame(A)).evaluate(() => {
    const content = document.querySelector('.ap-map-content');
    const tok = document.querySelector('.ap-token[data-token-id="raider"]');
    const cr = content.getBoundingClientRect();
    const s = tok.getBoundingClientRect();
    const ev = (type, x, y) => new PointerEvent(type, {
      clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true });
    tok.dispatchEvent(ev('pointerdown', s.left + s.width / 2, s.top + s.height / 2));
    for (let i = 1; i <= 6; i++) window.dispatchEvent(ev('pointermove', cr.left + 0.3 * cr.width, cr.top + 0.3 * cr.height));
    window.dispatchEvent(ev('pointerup', cr.left + 0.3 * cr.width, cr.top + 0.3 * cr.height));
  });
  await until(() => Math.abs(server.store.get(REPOINTED + '/raider').px - 0.3) < 0.05,
    { label: 'the drop to reach the new collection' });

  check('⭐ the write landed on the collection now in view', Math.abs(server.store.get(REPOINTED + '/raider').px - 0.3) < 0.05,
    JSON.stringify(server.store.get(REPOINTED + '/raider')));
  check('⛔ and the abandoned collection was not touched at all',
    JSON.stringify(server.store.get(MOUNTED)) === before);
});

test('0720 RUN-B B3.4 — ⛔ A LATE JOINER GETS THE RE-POINT FROM THE SNAPSHOT, NOT FROM A DIFF', async () => {
  /* The write happened before this viewer connected, so there is no diff coming. A component that
     only SUBSCRIBED to the key would sit on the abandoned board for the whole session while
     everyone else looked at the new one, and nothing on either screen would say why. */
  B = await connectUser(browser, server, { userId: 'ub', userName: 'Bo', role: 'participant' });
  await until(() => server.presence().length === 2, { label: '2 connected' });
  await until(async () => (await idsOn(B)).length > 0, { label: "the joiner's board to render" });

  check('⭐ the joiner came up on the CURRENT board', (await layerPath(B)) === REPOINTED, await layerPath(B));
  check('…showing the same piece the first viewer sees', (await idsOn(B)).join(',') === 'raider',
    (await idsOn(B)).join(','));
});

test('0720 RUN-B B3.5 — junk in the key falls back to the mount, rather than breaking the board', async () => {
  server.apply({ path: BOARD_PATH_KEY, verb: 'set', value: '../../etc' }, SYS);
  await until(async () => (await layerPath(A)) === MOUNTED, { label: 'the fallback to the mount path' });
  check('an unusable path falls back to the mount', (await layerPath(A)) === MOUNTED, await layerPath(A));
  check('and the board renders again rather than staying blank', (await idsOn(A)).length === 2,
    (await idsOn(A)).join(','));
});

test('0720 RUN-B B3.9 — teardown', async () => {
  await browser.close();
  await server.close();
  expect(true, 'closed');
});
