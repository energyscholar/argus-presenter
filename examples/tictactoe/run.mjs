/*
 * TicTacToe — two players plus observers, over the shared store.
 * Entirely scripted and standalone: no model is involved at runtime.
 *
 * Run: node examples/tictactoe/run.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, launch, connectUser, waitContentFrame, wait, until,
         shot, act, readAll, reporter } from '../_lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(HERE, 'page.html'), 'utf8');
const ok = reporter();

const server = await createServer({ port: 0 });
const browser = await launch();
try {
  const P = {};
  for (const [id, nm] of [['ann', 'Ann'], ['ben', 'Ben'], ['cal', 'Cal'], ['dot', 'Dot']])
    P[id] = await connectUser(browser, server, { userId: id, userName: nm });
  await wait(400);

  server.set('shared/ttt/turn', 'X');
  server.pushPage('all', PAGE);
  await wait(1200);

  const F = {};
  for (const k of Object.keys(P)) F[k] = await waitContentFrame(P[k]);
  const probe = () => ({
    status: document.getElementById('status')?.textContent,
    board: [].slice.call(document.querySelectorAll('.cell')).map((c) => c.textContent || '.').join(''),
    enabled: [].slice.call(document.querySelectorAll('.cell')).filter((c) => !c.disabled).length,
  });
  const snap = () => readAll(F, probe);
  await wait(600);

  /* Seating is DERIVED from per-user claims — see the note in page.html. Derive it here with the
     same rule; if these two ever disagree, THAT is the bug worth finding. */
  const claims = server.store.get('shared/ttt/claims') || {};
  const order = Object.keys(claims).filter((k) => claims[k])
    .map((k) => ({ id: k, ts: claims[k].ts || 0 }))
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seats = { X: order[0] && order[0].id, O: order[1] && order[1].id };
  const observers = Object.keys(P).filter((k) => k !== seats.X && k !== seats.O);
  console.log(`seats ${JSON.stringify(seats)}  observers ${observers.join(',')}`);

  const seated = await snap();
  ok('exactly two seats are taken', !!seats.X && !!seats.O && seats.X !== seats.O, JSON.stringify(seats));
  ok('an observer has no enabled cell', seated[observers[0]].enabled === 0, 'enabled=' + seated[observers[0]].enabled);
  ok('X may move, O may not', seated[seats.X].enabled === 9 && seated[seats.O].enabled === 0);
  for (const k of Object.keys(P)) await shot(P[k], `ttt-1-seated-${k}.png`);

  for (const [who, i] of [[seats.X, 0], [seats.O, 4], [seats.X, 1], [seats.O, 5], [seats.X, 2]]) {
    await act(F[who], `.cell[data-i="${i}"]`, (el) => el.click());
    await until(async () => (server.store.get('shared/ttt/cells') || {})[i] != null,
                { label: `cell ${i} reaches the server`, timeout: 4000 }).catch(() => {});
    await wait(300);
  }
  await wait(700);

  const c = server.store.get('shared/ttt/cells') || {};
  const board = [...Array(9)].map((_, j) => c[j] || '.').join('');
  ok('the server board is XXX.OO...', board === 'XXX.OO...', board);
  const w = server.store.get('shared/ttt/winner');
  ok('the server recorded X as the winner', w && w.mark === 'X', JSON.stringify(w));

  const after = await snap();
  const boards = Object.keys(P).map((k) => after[k].board);
  ok('all four viewers show the identical board', new Set(boards).size === 1, boards.join(' | '));
  ok('every viewer, players and observers, sees the result',
     Object.keys(P).every((k) => /X wins/.test(after[k].status)));
  for (const k of Object.keys(P)) await shot(P[k], `ttt-2-xwins-${k}.png`);

  /* The board is server-authoritative: forcing the button past `disabled` changes nothing. */
  await act(F[observers[0]], '.cell[data-i="8"]', (el) => { el.disabled = false; el.click(); });
  await wait(600);
  ok('an observer cannot write a cell even with the control forced open',
     ((server.store.get('shared/ttt/cells') || {})[8]) == null);

  await act(F[seats.X], '#reset', (el) => el.click());
  await wait(800);
  const post = await snap();
  ok('reset clears the board for everyone',
     Object.keys(P).every((k) => post[k].board === '.........'));
} finally {
  await browser.close(); await server.close();
}
process.exit(ok.done());
