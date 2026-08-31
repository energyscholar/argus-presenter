/*
 * Plan 0720 RUN A / F4 — THE PEER-PING TOGGLE IS PER PLAYER, LOCAL, AND DEFAULTS OFF.
 *
 * A click on the map paints a named radar ping on EVERYONE's board, and it was unconditional:
 * `opts.cursors:'off'` gated only the pointer trail. On a board five people are prodding at, that
 * is a carpet of pings and nobody can see the pieces.
 *
 * ⛔ THE DIRECTION IT GATES IS THE WHOLE THING, AND IT IS THE PART A READER GUESSES WRONG.
 * It controls whether YOUR taps ping. It says NOTHING about whether you SEE other people's —
 * someone who deliberately turns theirs on to point at a target must be visible to everyone, or
 * the feature is pointless. So this file asserts BOTH directions, with two real browsers:
 *
 *   F4.1  A's toggle is OFF by default   ⇒ A taps, and B sees NOTHING
 *   F4.2  A turns A's own toggle ON      ⇒ A taps, and B SEES IT — with B's toggle still off,
 *                                          which is the assertion that proves B's setting gates
 *                                          B's taps and not B's eyes
 *   F4.3  it is not a mount opt, not a store key, and the control is on the board
 *
 * ⚠ The store is the witness, not the DOM: `map/markers` either has a key or it does not, and a
 * component that emitted and merely failed to paint would still be a component that pinged.
 */
import { test, expect, check } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until, wait } from '../../harness/multi.mjs';

let server, browser, A, B;

/** Click the plot at a fixed spot, the way E2 does — mousedown then click, no movement between. */
const tapMap = (page, dx = 140, dy = 100) => contentFrame(page).$eval('.ap-map-viewport', (el, x, y) => {
  const r = el.getBoundingClientRect();
  const o = { clientX: r.left + x, clientY: r.top + y, bubbles: true };
  el.dispatchEvent(new MouseEvent('mousedown', o));
  el.dispatchEvent(new MouseEvent('click', o));
}, dx, dy);

const markers = () => Object.values(server.store.get('map/markers') || {});
const pingsFrom = (name) => markers().filter((m) => m.name === name);
const pingUi = (page) => contentFrame(page).$eval('.ap-map-ping-toggle', (el) => ({
  text: (el.innerText || el.textContent || '').trim(),
  pressed: el.getAttribute('aria-pressed'),
  on: el.classList.contains('is-on'),
  inViewport: !!(el.closest && el.closest('.ap-map-viewport')),
}));

test('0720 F4.0 — two browsers on one map', async () => {
  server = await createServer({ port: 0 });
  browser = await launch();
  A = await connectUser(browser, server, { userId: 'ua', userName: 'Ava', role: 'participant' });
  B = await connectUser(browser, server, { userId: 'ub', userName: 'Bo', role: 'participant' });
  for (const p of [A, B]) await p.setViewport({ width: 1000, height: 700 });
  await until(() => server.presence().length === 2, { label: '2 connected' });
  server.pushComponent('all', 'map', { controllable: false, label: 'Plot' });
  for (const p of [A, B]) await waitContentFrame(p);
  await wait(300);
  expect(true, 'both viewers have the plot');
});

test('0720 F4.1 — ⭐⭐ DEFAULT OFF: A taps and B sees NOTHING', async () => {
  const ui = await pingUi(A);
  check(`the control is on the board and reads its CURRENT state: "${ui.text}"`,
    /off/i.test(ui.text) && ui.pressed === 'false' && ui.on === false, JSON.stringify(ui));
  /* ⛔ It must sit OUTSIDE `.ap-map-viewport`. Inside, its own click falls through to the very
     handler it gates, and turning pinging on would fire a ping on the same frame. */
  check('…and it is outside the click surface it gates', ui.inViewport === false, String(ui.inViewport));

  await tapMap(A);
  await wait(500);                                   // give a wrong ping every chance to arrive
  check(`⭐ A tapped with the toggle off and wrote NO marker (${markers().length} in the store)`,
    pingsFrom('Ava').length === 0, JSON.stringify(markers()));

  const seen = await contentFrame(B).$$eval('.ap-map-click', (e) => e.length);
  check("⭐ …and B's board painted nothing", seen === 0, String(seen));
});

test('0720 F4.2 — ⭐⭐ A TURNS THEIR OWN ON: B SEES IT, with B\'s toggle still off', async () => {
  /*
   * ⛔ THIS IS THE ASSERTION THAT PROVES THE DIRECTION. B never touches their toggle — it stays at
   * the default OFF for the whole file — and B must still see A's deliberate ping. A component that
   * had gated the RECEIVE side would pass F4.1 perfectly and fail here, which is exactly why F4.1
   * on its own would not have been a gate.
   */
  await contentFrame(A).evaluate(() => window.ApMapPing.set(true));
  const on = await pingUi(A);
  check(`A's control now reads: "${on.text}"`, /on/i.test(on.text) && on.pressed === 'true' && on.on === true,
    JSON.stringify(on));
  const bStill = await pingUi(B);
  check(`…while B's is untouched and still off: "${bStill.text}"`, bStill.pressed === 'false', JSON.stringify(bStill));

  await tapMap(A, 180, 140);
  await until(() => pingsFrom('Ava').length === 1, { label: "A's ping reached the store", timeout: 5000 });
  check('⭐ A tapped with the toggle on and the marker is in the store, attributed',
    pingsFrom('Ava').length === 1, JSON.stringify(markers()));

  await until(async () => (await contentFrame(B).$eval('.ap-map-click-name', (el) => el.textContent).catch(() => null)) === 'Ava',
    { label: "B sees A's ping", timeout: 5000 });
  const nameOnB = await contentFrame(B).$eval('.ap-map-click-name', (el) => el.textContent);
  check("⭐⭐ …and B SEES IT, name and all, with B's OWN toggle still off — the setting gates YOUR taps, not YOUR EYES",
    nameOnB === 'Ava', String(nameOnB));

  /* And B still cannot ping, because B never turned theirs on. Same page, same component, opposite
     setting — which is what "per player" means and what a single global switch could not do. */
  await tapMap(B, 220, 180);
  await wait(500);
  check('⭐ B taps and writes nothing: two viewers, one board, two independent settings',
    pingsFrom('Bo').length === 0, JSON.stringify(markers()));

  // The toggle turns back off, or it is a one-way door pretending to be a switch.
  await contentFrame(A).evaluate(() => window.ApMapPing.set(false));
  await tapMap(A, 240, 200);
  await wait(500);
  check('…and A turning it back off stops the pings again', pingsFrom('Ava').length === 1,
    JSON.stringify(markers()));
});

test('0720 F4.3 — ⛔ it is NOT a mount opt, NOT a presenter control, and NOT a store key', async () => {
  /*
   * The design constraint is as load-bearing as the behaviour: a mount opt would let whoever
   * authored the page decide on the reader's behalf, which is the thing being fixed; a store key
   * would need a permission rule, a sync and a race, for a preference nobody else can observe.
   */
  const shared = server.store.get('shared') || {};
  const keys = JSON.stringify(shared) + JSON.stringify(server.store.get('map') || {});
  check('nothing about pinging was written to shared state', !/ping/i.test(keys), keys.slice(0, 200));

  /* A mount opt asking for it is IGNORED — the proof that the page cannot decide for the reader. */
  const ignored = await contentFrame(B).evaluate(() => {
    const host = document.createElement('div');
    host.style.cssText = 'position:relative;width:300px;height:200px';
    document.body.appendChild(host);
    const h = window.ApComponents.get('map')(host, { ping: 'on', pings: true, markers: 'all' });
    const btn = host.querySelector('.ap-map-ping-toggle');
    const res = { pressed: btn && btn.getAttribute('aria-pressed'), viewerSetting: window.ApMapPing.get() };
    h.destroy(); host.remove();
    return res;
  });
  check("an opt asking for pings on does NOT turn this viewer's pings on",
    ignored.pressed === 'false' && ignored.viewerSetting === false, JSON.stringify(ignored));
});

test('0720 F4.9 — teardown', async () => {
  if (browser) await browser.close();
  if (server) await server.close();
  expect(true, 'server closed');
});
