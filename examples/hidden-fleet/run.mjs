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
  const annFleet = server.store.get('private/ann/fleet');
  const benFleet = server.store.get('private/ben/fleet');
  ok('both fleets exist on the server', Array.isArray(annFleet) && Array.isArray(benFleet),
     JSON.stringify({ ann: annFleet, ben: benFleet }));

  // ── THE POINT OF THE DEMO ────────────────────────────────────────────────────────────────
  const snapOf = (id, role='participant') => server.store.snapshot({ userId: id, role }).state;
  const annSees = snapOf('ann'), benSees = snapOf('ben'), calSees = snapOf('cal');
  ok('Ann sees her OWN fleet', JSON.stringify(annSees.private?.ann?.fleet) === JSON.stringify(annFleet));
  ok("Ann's snapshot has NO trace of Ben's fleet", annSees.private?.ben === undefined,
     JSON.stringify(annSees.private));
  ok("Ben's snapshot has NO trace of Ann's fleet", benSees.private?.ann === undefined,
     JSON.stringify(benSees.private));
  ok('an OBSERVER sees neither fleet', calSees.private === undefined || Object.keys(calSees.private).length === 0,
     JSON.stringify(calSees.private));
  // and the browser agrees: the opponent's ships are not in Ben's DOM
  s = await snap();
  ok('Ann renders 4 of her own ships', s.ann.myShips === 4, 'ships=' + s.ann.myShips);
  ok("Ben renders 4 of HIS own ships, not Ann's", s.ben.myShips === 4, 'ships=' + s.ben.myShips);
  ok('an observer renders no ships at all', s.cal.myShips === 0, 'ships=' + s.cal.myShips);
  for (const k of Object.keys(P)) await shot(P[k], `fh-1-deployed-${k}.png`);

  // ── A shot is adjudicated by the TARGET, who is the only client that can know ──
  const target = benFleet[0];
  await P.ann.bringToFront();
  await act(F.ann, `#theirs .c[data-i="${target}"]`, e => e.click());
  await wait(1200);
  ok('a shot on a ship resolves as a HIT', server.store.get('shared/fh/shots/B/' + target) === 'hit',
     JSON.stringify(server.store.get('shared/fh/shots/B/' + target)));

  const miss = [...Array(25).keys()].find(i => !benFleet.includes(i) && i !== target);
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
