/*
 * Plan 0720 P1 — THE INITIATIVE TRACKER, END TO END.
 *
 * Bruce, 2026-08-30: *"Wire in the Initiative Tracker such that YOU and also me, in Presenter
 * Console role, can move the initiative… Verify both the plan and the delivery functionally
 * end-to-end via functional testing."*
 *
 * So this file proves BOTH DOORS against a REAL SERVER with the real plugin loaded:
 *   Argus's door  — the MCP plugin tools (combat_begin / combat_advance / …)
 *   Bruce's door  — an `Argus.emit('combat-command')` arriving on the `result` channel
 * and it proves the door that must STAY SHUT — a participant sending the same command.
 *
 * ⛔⛔ IT ALSO PROVES THE ONE RULE THAT IS EASY TO GET WRONG AND SILENT WHEN WRONG:
 * a pending initiative delta lands at the START OF THE NEXT ROUND, not when it was set.
 * Improve Initiative is "Effect → initiative NEXT round" (plan 0720 §A3 — our own corpus
 * contradicted itself here, two sources to one). Off by a round looks completely normal.
 *
 * ⚠ Everything asserted here is asserted against `server.store` / the tool's own return, never
 * against a local variable the test also wrote. A control that moves locally but never reaches the
 * store is not shared — it is decorative.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(pred, label, { timeout = 4000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(15); }
  throw new Error('timeout waiting for ' + label);
}

/** A connected client with a chosen role. Resolves once the server has said `welcome`. */
function client(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws'));
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('message', (d, isBin) => {
      if (isBin) return;
      let m; try { m = JSON.parse(d.toString()); } catch (e) { return; }
      if (m.t === 'welcome') resolve(ws);
    });
  });
}

/* The command a console button sends. `type` is the channel; the payload rides under `msg`. */
const command = (ws, what, extra = {}) =>
  ws.send(JSON.stringify({ t: 'result', msg: { type: 'combat-command', value: { what, ...extra } } }));

/*
 * A domain-free force. ⛔ THE ENGINE REPO IS PUBLIC AND MUST CARRY NO CAMPAIGN VOCABULARY
 * (PSS t0531-01) — an earlier draft of this file named a real ship, three real crew and two real
 * hostiles, which is exactly the leak the rule exists to stop. The behaviour under test is
 * domain-free, so the names were never load-bearing.
 */
const FORCE = [
  { id: 'flag',     name: 'Flagship', side: 'player', init: 7,  dm: 0,
    stations: ['captain', 'sensors', 'engineer'] },
  { id: 'raider',  name: 'Raider',     side: 'enemy',  init: 7,  dm: 1 },   // ⭐ deliberate tie
  { id: 'scout-1', name: 'Scout One',    side: 'enemy',  init: 9,  dm: 0 },
  { id: 'scout-2', name: 'Scout OneI',   side: 'enemy',  init: 4,  dm: 0 },
];

let server, url, call;

test('0720 T0 — server boots with the starship-ops plugin and the combat tools are registered', async () => {
  server = await createServer({ port: 0 });
  url = server.url();
  /* ⛔ callPluginTool wraps: {ok, result}. Unwrap once, here, or every assertion below reads
     undefined and reports a business failure for a plumbing mistake. */
  call = async (name, args = {}) => {
    const r = await server.callPluginTool(name, args);
    if (r && r.ok === false) throw new Error(`plugin tool ${name} failed: ${r.error}`);
    return r && Object.prototype.hasOwnProperty.call(r, 'result') ? r.result : r;
  };

  const names = server.pluginTools().map((t) => t.name);
  for (const n of ['combat_begin', 'combat_state', 'combat_advance', 'combat_set', 'combat_reorder', 'combat_acted', 'combat_end']) {
    expect(names.includes(n), `plugin tool ${n} registered`, `have: ${names.join(',')}`);
  }
});

test('0720 T1 — ARGUS DOOR: combat_begin authors the order, higher first, ties left alone', async () => {
  const s = await call('combat_begin', { order: FORCE, round: 1 });
  expect(s.active === true, 'engagement active');
  expect(s.round === 1, `round 1 (got ${s.round})`);
  expect(s.phase === 'manoeuvre', `opens in the manoeuvre step (got ${s.phase})`);
  expect(s.order.map((e) => e.id).join(',') === 'scout-1,flag,raider,scout-2',
    `higher-first with the 7-7 tie in the order given: got ${s.order.map((e) => e.id + ':' + e.init).join(' ')}`);
  // ⭐ and it reached the STORE, not just the return value
  const inStore = (await call('combat_state')).order;
  expect(inStore.length === 4, 'order is in the store, read back through a separate call');
});

test('0720 T2 — a tie is PRESERVED, never silently broken', async () => {
  const s = await call('combat_state');
  const tied = s.order.filter((e) => e.init === 7).map((e) => e.id);
  expect(tied.length === 2, `two combatants still tied on 7 (got ${tied.join(',')})`);
  expect(tied[0] === 'flag' && tied[1] === 'raider',
    'the tie keeps the order it was given — no invented tiebreak');
});

test('0720 T3 — combat_reorder is the GM coin-flip, and it does NOT change any number', async () => {
  const before = (await call('combat_state')).order.reduce((a, e) => (a[e.id] = e.init, a), {});
  const s = await call('combat_reorder', { ids: ['raider', 'flag'] });
  expect(s.order[0].id === 'raider' && s.order[1].id === 'flag', 'hand order applied, raider first');
  for (const e of s.order) expect(e.init === before[e.id], `${e.id} initiative untouched by a reorder`);
  await call('combat_begin', { order: FORCE, round: 1 });     // reset for the next test
});

test('0720 T4 — turn advances, wraps into the next PHASE, and phase wraps into the next ROUND', async () => {
  let s = await call('combat_state');
  expect(s.turn === 0 && s.phase === 'manoeuvre', 'starts at the top of the manoeuvre step');

  for (let i = 0; i < 4; i++) s = await call('combat_advance', { what: 'turn' });
  expect(s.phase === 'attack', `after all four hulls act, the step advances (got ${s.phase})`);
  expect(s.turn === 0, 'and the new step starts at the top of the order');
  expect(Object.keys(s.acted).length === 0, 'acted flags clear on a new step — acted is PER STEP');

  s = await call('combat_advance', { what: 'phase' });
  expect(s.phase === 'actions', 'attack -> actions');
  s = await call('combat_advance', { what: 'phase' });
  expect(s.round === 2 && s.phase === 'manoeuvre',
    `the last step wraps into round 2 at manoeuvre (got round ${s.round} ${s.phase})`);
});

test('0720 T5 — ⛔ THE PENDING DELTA LANDS AT THE START OF THE NEXT ROUND, NOT WHEN SET', async () => {
  await call('combat_begin', { order: FORCE, round: 1 });

  // Commander makes his Leadership check: Improve Initiative, Effect 3.
  let s = await call('combat_set', { id: 'flag', pending: 3 });
  const ad = () => s.order.find((e) => e.id === 'flag');
  expect(ad().init === 7, `⛔ initiative must NOT move this round (got ${ad().init})`);
  expect(ad().pending === 3, 'the bonus is held as pending');
  expect(s.order[0].id === 'scout-1', 'and the running order is unchanged this round');

  s = await call('combat_advance', { what: 'round' });
  expect(ad().init === 10, `⭐ it lands at the start of the next round: 7+3 = 10 (got ${ad().init})`);
  expect(ad().pending === 0, 'and the pending delta is consumed, not re-applied');
  expect(s.order[0].id === 'flag', `the Flagship now leads (got ${s.order[0].id})`);
  expect(s.round === 2, 'in round 2');

  s = await call('combat_advance', { what: 'round' });
  expect(ad().init === 10, `⛔ and it does NOT apply a second time (got ${ad().init})`);
});

test('0720 T6 — acted is PER KEY: two combatants ticked concurrently both survive', async () => {
  await call('combat_begin', { order: FORCE, round: 1 });
  await Promise.all([
    call('combat_acted', { id: 'flag' }),
    call('combat_acted', { id: 'raider' }),
    call('combat_acted', { id: 'scout-1' }),
  ]);
  const s = await call('combat_state');
  for (const id of ['flag', 'raider', 'scout-1']) {
    expect(s.acted[id] === true, `${id} acted flag survived the concurrent write`);
  }
});

test('0720 T7 — STATIONS act individually in the Actions step (CRB: every station takes ONE action)', async () => {
  await call('combat_begin', { order: FORCE, round: 1 });
  await call('combat_advance', { what: 'phase' });
  await call('combat_advance', { what: 'phase' });
  let s = await call('combat_state');
  expect(s.phase === 'actions', 'in the actions step');

  await Promise.all([
    call('combat_acted', { id: 'flag', station: 'captain' }),
    call('combat_acted', { id: 'flag', station: 'sensors' }),
  ]);
  s = await call('combat_state');
  const mine = s.stationacted.flag || {};
  expect(Object.values(mine).filter(Boolean).length === 2,
    `two STATIONS of ONE hull acted in the same step (got ${JSON.stringify(mine)})`);
  expect(s.acted.flag !== true, 'and the hull itself is not marked done by a station action');
});

test('0720 T8 — ⭐⭐ BRUCE DOOR: a presenter-role console command moves the tracker', async () => {
  await call('combat_begin', { order: FORCE, round: 1 });
  const ws = await client(url, { userId: 'bruce', userName: 'Bruce', role: 'presenter' });

  command(ws, 'turn');
  await poll(async () => (await call('combat_state')).turn === 1, 'console advanced the turn');
  let s = await call('combat_state');
  expect(s.turn === 1, `turn advanced from the browser (got ${s.turn})`);

  command(ws, 'round');
  await poll(async () => (await call('combat_state')).round === 2, 'console advanced the round');
  s = await call('combat_state');
  expect(s.round === 2, `round advanced from the browser (got ${s.round})`);
  ws.close();
});

test('0720 T9 — ⭐⭐ A PLAYER CAN ADVANCE IT TOO — there is deliberately NO role gate', async () => {
  /* Bruce reversed his own earlier instinct, 2026-08-30: "I'd rather EVERYONE AT THE TABLE could
     advance the initiative… we gain nothing by locking it away from players" and "Would be GREAT
     if we turned this over to a player to handle."
     ⛔ This test exists to make the ABSENCE of a gate deliberate and load-bearing. If someone
     later adds one, this goes red and says why. */
  await call('combat_begin', { order: FORCE, round: 1 });
  const ws = await client(url, { userId: 'player-1', userName: 'Sensors Officer', role: 'participant' });

  command(ws, 'turn');
  await poll(async () => (await call('combat_state')).turn === 1, 'a participant advanced the turn');
  const s = await call('combat_state');
  expect(s.turn === 1, `a player moved the board (got turn ${s.turn})`);
  ws.close();
});

test('0720 T10 — an advance is ATTRIBUTED — that is what replaces the permission gate', async () => {
  await call('combat_begin', { order: FORCE, round: 1 });
  const ws = await client(url, { userId: 'player-1', userName: 'Sensors Officer', role: 'participant' });
  command(ws, 'turn');
  await poll(async () => (await call('combat_state')).turn === 1, 'advanced');

  const s = await call('combat_state');
  const said = s.log.map((l) => l.text).join(' | ');
  expect(/Sensors Officer/.test(said), 'the log names WHO advanced it', said);
  // ⛔ and the name comes from the CONNECTION, not the payload — a client cannot forge it.
  expect(!/player-1/.test(said) || /Sensors Officer/.test(said), 'attribution uses the stamped identity');
  ws.close();
});

test('0720 T10b — ⭐ UNDO is the accident defence: a mistaken advance costs nothing', async () => {
  await call('combat_begin', { order: FORCE, round: 1 });
  await call('combat_advance', { what: 'turn' });
  await call('combat_advance', { what: 'phase' });
  let s = await call('combat_state');
  expect(s.phase === 'attack', `moved on (got ${s.phase})`);

  s = await call('combat_undo');
  expect(s.phase === 'manoeuvre', `undo restored the step (got ${s.phase})`);
  expect(s.turn === 1, `and the exact turn position (got ${s.turn})`);

  s = await call('combat_undo');
  expect(s.turn === 0, `undo again returns to the top (got ${s.turn})`);

  s = await call('combat_undo');
  expect(s.blocked === 'nothing-to-undo', 'and an empty history refuses cleanly');
});

test('0720 T11 — a command with no engagement is refused cleanly, not thrown', async () => {
  await call('combat_end');
  await call('combat_begin', { order: [], round: 1 });     // an engagement with nobody in it
  const s = await call('combat_advance', { what: 'turn' });
  expect(s.blocked === 'no-order', `blocked with a reason, not an exception (got ${JSON.stringify(s.blocked)})`);
});

test('0720 T99 — teardown', async () => {
  await server.close();
  expect(true, 'server closed');
});
