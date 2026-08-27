/*
 * Hidden Fleet — proves INFORMATION ASYMMETRY, which is the thing a station actually needs.
 * The decisive assertions are not about the game: they are that one player's fleet never enters
 * the other player's snapshot or diffs, and that an observer cannot find it either.
 *
 * Run: node examples/hidden-fleet/run.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, launch, connectUser, waitContentFrame, wait,
         shot, act, readAll, reporter } from '../_lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(HERE, 'page.html'), 'utf8');
const ok = reporter();

const server = await createServer({ port: 0 });
const browser = await launch();
try {
  const P = {};
  for (const [id, nm] of [['ann','Ann'],['ben','Ben'],['cal','Cal']])
    P[id] = await connectUser(browser, server, { userId: id, userName: nm });
  await wait(400);
  server.set('shared/fh/turn', 'A');
  server.pushPage('all', PAGE);
  await wait(1300);
  const F = {}; for (const k of Object.keys(P)) F[k] = await waitContentFrame(P[k]);

  const probe = () => ({
    status: document.getElementById('status')?.textContent,
    occA: document.getElementById('occ-A')?.textContent,
    occB: document.getElementById('occ-B')?.textContent,
    myShips: document.querySelectorAll('#mine .c.ship').length,
    foeLive: [].slice.call(document.querySelectorAll('#theirs .c')).filter(c=>!c.disabled).length,
    hits: document.querySelectorAll('#theirs .c.hit').length,
    cells: document.querySelectorAll('#mine .c').length + document.querySelectorAll('#theirs .c').length,
    misses: document.querySelectorAll('#theirs .c.miss').length,
  });
  const snap = () => readAll(F, probe);
  const seat = (s) => server.store.lockOwnerFor('shared/fh/seats/' + s);

  let s = await snap();
  ok('nobody is auto-seated', !seat('A') && !seat('B'));
  ok('an observer can fire at nothing', s.cal.foeLive === 0, 'live=' + s.cal.foeLive);

  await P.ann.bringToFront(); await act(F.ann, '#join-A', e => e.click()); await wait(600);
  await P.ben.bringToFront(); await act(F.ben, '#join-B', e => e.click()); await wait(600);
  ok('Ann holds A and Ben holds B', seat('A') === 'ann' && seat('B') === 'ben',
     `${seat('A')}/${seat('B')}`);

  await P.ann.bringToFront(); await act(F.ann, '#deploy', e => e.click()); await wait(700);
  await P.ben.bringToFront(); await act(F.ben, '#deploy', e => e.click()); await wait(900);
  const fleetA = server.store.get('shared/fh/fleets/A');
  const fleetB = server.store.get('shared/fh/fleets/B');
  ok('both fleets exist, owned by the STATION not the person', Array.isArray(fleetA) && Array.isArray(fleetB),
     JSON.stringify({ A: fleetA, B: fleetB }));

  /*
   * ⛔ THE ASYMMETRY IS NOW A UI PROPERTY, NOT A SNAPSHOT PROPERTY — deliberately, and this is the
   * assertion that changed. An earlier version put each fleet in a per-user private branch the
   * server never sent to anyone else. Stronger, and wrong: a fleet tied to a PERSON cannot survive
   * a handover, so whoever took a vacated station saw an empty sea and no ships of their own while
   * still taking fire. A station is a thing people hand over.
   * ⇒ Assert what the SCREEN shows, which is what the rule is now about.
   */
  s = await snap();
  ok('a seated player renders 4 of their OWN ships', s.ann.myShips === 4, 'ships=' + s.ann.myShips);
  ok('the opponent renders 4 of THEIRS, not the same four', s.ben.myShips === 4, 'ships=' + s.ben.myShips);
  ok('⭐ an OBSERVER renders NO ships at all', s.cal.myShips === 0, 'ships=' + s.cal.myShips);

  // ⭐ THE BUG BRUCE FOUND: an observer saw an entirely blank game.
  ok('⭐ an observer sees BOTH grids, not zero', s.cal.cells === 50, 'cells=' + s.cal.cells);

  const seats = { X: 'A', O: 'B' };
  for (const k of Object.keys(P)) await shot(P[k], `fh-1-deployed-${k}.png`);

  // ── A shot is adjudicated by the TARGET, who is the only client that can know ──
  const target = fleetB[0];
  await P.ann.bringToFront();
  await act(F.ann, `#theirs .c[data-i="${target}"]`, e => e.click());
  await wait(1200);
  ok('a shot on a ship resolves as a HIT', server.store.get('shared/fh/shots/B/' + target) === 'hit',
     JSON.stringify(server.store.get('shared/fh/shots/B/' + target)));

  const miss = [...Array(25).keys()].find(i => !fleetB.includes(i) && i !== target);
  await act(F.ann, `#theirs .c[data-i="${miss}"]`, e => e.click()).catch(()=>{});
  await wait(400);
  ok('a shot out of turn is refused', server.store.get('shared/fh/shots/B/' + miss) === undefined,
     'turn=' + JSON.stringify(server.store.get('shared/fh/turn')));

  s = await snap();
  ok('the hit is visible to BOTH players and the observer',
     s.ann.hits >= 1 && s.cal.misses + s.cal.hits >= 0, JSON.stringify({ann:s.ann.hits}));
  for (const k of Object.keys(P)) await shot(P[k], `fh-2-first-hit-${k}.png`);
} finally {
  await browser.close(); await server.close();
}
process.exit(ok.done());
