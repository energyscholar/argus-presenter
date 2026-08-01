/*
 * Plan 0522 P14 — SEATING SOMEONE ELSE IS A PRIVILEGE, AND THIS IS ITS GATE.
 *
 * `stationSet(userId, stationUid)` takes an ARBITRARY userId. It has been the seat-someone-else
 * capability since 0514 and it has never been gated, because it was only ever reachable from MCP
 * and MCP is a control surface by construction. P14 puts a button on the roster row, which puts a
 * second surface in front of it — and a capability gated on one surface and open on the other is
 * an I1 (surface parity) violation, not a rough edge.
 *
 * ⚠ WHERE THE GATE CANNOT LIVE, and why this file exists:
 *   - NOT in the resolver. `seatResolver.select()` has THREE call sites in core — join (§4.2a),
 *     the self-select wire handler (§8), and `stationSet` — and its signature (userId, uid) is
 *     identical at all three. A resolver-level check could not tell "seat myself" from "seat that
 *     other person", so it would either break self-seating or gate nothing.
 *   - NOT in the transport. A check in `handleControl` gates the control page and leaves the MCP
 *     surface open; a check in the MCP tool does the reverse. Two rules, two surfaces, guaranteed
 *     drift — which is exactly the failure mode this phase was written to prevent.
 *   ⇒ It lives in `stationSet`, BEFORE select(), where both surfaces meet.
 *
 * Self-selection stays UNGATED, and that is not an oversight: `station-select` changes only what
 * the caller sees, which is the zero-privilege argument 0514 §8 already settled. The distinction
 * this file defends is between "what I see" and "what somebody else sees".
 *
 *   t37  — a PARTICIPANT cannot set another seat's station: refused BY NAME, and the victim's
 *          seat is unchanged. The seat is asserted, not just the reply.
 *   t37a — the gate holds on BOTH surfaces (control page frame AND the api/MCP entry point) and
 *          admits a real controller on both, so it is a gate and not a wall. Also asserts that
 *          `select()` is never reached on a refusal — the refusal precedes the resolver.
 *   t37b — an UNOCCUPIED target is refused by name (`not-connected`) rather than answered ok:true.
 *          Found during P13: this used to report success for a userId nobody holds, which let a
 *          test "prove" a station change that no socket ever received (I5).
 *
 * Unit tier: pure server + wire, no browser. The roster row that drives all of this is asserted
 * in test/component/0522-p14-row-actions.test.mjs.
 *
 * ⛔ §ANNEAL E — PRESENTER_MODULES_DIR is pointed at a throwaway dir even though nothing here
 * loads a module. Left unset, createServer scans AND WATCHES the repo's real `modules/`, the one
 * directory with no version history.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { makePluginsDir, stationManifest, connect, last, wait, ROOT } from './_0514-fixtures.mjs';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'fs';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/*
 * A SPY seat resolver. It satisfies the {select,get,release} contract exactly as a real one does
 * (unknown uid ⇒ the deployment default, never a throw — 0514 §5) and records every select() call
 * on a process global, so a test can assert that a refusal happened BEFORE the resolver was
 * reached rather than inferring it from an unchanged seat. The plugin is ESM-imported by the
 * server in THIS process, so the global is genuinely shared.
 */
const SPY = `
export function register(ctx) {
  const seats = new Map();
  const known = new Set((ctx.stations && ctx.stations.list || []).map(function(s){ return s.stationUid; }));
  const dflt = ctx.stations && ctx.stations.defaultUid;
  globalThis.__p14 = { calls: [] };
  ctx.provideSeatResolver({
    select: function (userId, uid) {
      globalThis.__p14.calls.push([userId, uid]);
      const u = known.has(uid) ? uid : dflt;
      seats.set(userId, { uid: u });
      return { uid: u };
    },
    get: function (userId) { return seats.get(userId) || null; },
    release: function (userId) { seats.delete(userId); },
  });
}
`;

const ALPHA = 1, BETA = 2;   // stationManifest's two declared stations; BETA is the default

async function boot() {
  const dir = makePluginsDir({ p14spy: { 'plugin.json': stationManifest({ name: 'p14spy', server: 'spy.mjs' }), 'spy.mjs': SPY } });
  const mods = mkdtempSync(join(tmpdir(), 'ap-0522-p14-mod-'));
  const prevP = process.env.PRESENTER_PLUGINS_DIR;
  const prevM = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_PLUGINS_DIR = dir;
  process.env.PRESENTER_MODULES_DIR = mods;
  let server;
  try { server = await createServer({ port: 0 }); }
  finally {
    if (prevP === undefined) delete process.env.PRESENTER_PLUGINS_DIR; else process.env.PRESENTER_PLUGINS_DIR = prevP;
    if (prevM === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prevM;
  }
  return server;
}

const calls = () => (globalThis.__p14 ? globalThis.__p14.calls : []);
/** What the RESOLVER says this seat holds — the durable answer, not the reply the caller got. */
const seatOf = (server, userId) => {
  const s = server.stations().seats.find((x) => x.userId === userId);
  return s ? s.stationUid : null;
};

test('0522 t37 — a PARTICIPANT cannot set another seat\'s station: refused by name, and the seat is unchanged', async () => {
  const server = await boot();
  const url = server.url().replace('http', 'ws');
  let victim = null, attacker = null;
  try {
    victim = await connect(WebSocket, url, { userId: 'victim', userName: 'Victim' });
    attacker = await connect(WebSocket, url, { userId: 'attacker', userName: 'Attacker' });
    // The victim seats THEMSELF at ALPHA — the ungated, zero-privilege path, which must keep working.
    victim.send({ t: 'station-select', stationUid: ALPHA }); await wait(160);
    expect('precondition: the victim is seated at ALPHA by their own (ungated) self-selection',
      seatOf(server, 'victim') === ALPHA, String(seatOf(server, 'victim')));
    expect('precondition: the attacker holds the participant role',
      last(attacker, 'welcome') && last(attacker, 'welcome').role === 'participant',
      JSON.stringify(last(attacker, 'welcome') && last(attacker, 'welcome').role));

    const before = calls().length;
    attacker.clear();
    attacker.send({ t: 'control', action: 'set_station', args: { userId: 'victim', stationUid: BETA } });
    await wait(200);

    const reply = last(attacker, 'station-set');
    expect('the refusal ANSWERS — silence is indistinguishable from a request that never arrived (I5)',
      !!reply, JSON.stringify(attacker.frames));
    expect('it is a refusal', reply && reply.ok === false, JSON.stringify(reply));
    expect('and it carries a REASON, by name', reply && reply.reason === 'not-controller', JSON.stringify(reply));

    // The claim that actually matters. A reply is cheap; the seat is the thing.
    expect('the victim\'s seat is UNCHANGED — still ALPHA, not BETA',
      seatOf(server, 'victim') === ALPHA, String(seatOf(server, 'victim')));
    expect('and the resolver was never reached: the gate precedes select(), it does not undo it',
      calls().length === before, JSON.stringify(calls().slice(before)));

    // The victim must not have been told anything either — a "refused" that still re-rendered the
    // target would move the room while reporting that it had not.
    expect('the victim received no station frame from the attempt',
      !victim.frames.some((f) => f.t === 'station' && f.stationUid === BETA), JSON.stringify(victim.frames.filter((f) => f.t === 'station')));
  } finally { if (victim) victim.ws.close(); if (attacker) attacker.ws.close(); await server.close(); }
});

test('0522 t37a — the gate holds on BOTH surfaces (control page AND api/MCP), and admits a controller on both', async () => {
  const server = await boot();
  const url = server.url().replace('http', 'ws');
  let victim = null, attacker = null, gm = null;
  try {
    victim = await connect(WebSocket, url, { userId: 'victim', userName: 'Victim' });
    attacker = await connect(WebSocket, url, { userId: 'attacker', userName: 'Attacker' });
    gm = await connect(WebSocket, url, { userId: 'gm1', userName: 'GM', role: 'presenter' });
    victim.send({ t: 'station-select', stationUid: ALPHA }); await wait(160);
    expect('precondition: the victim starts at ALPHA', seatOf(server, 'victim') === ALPHA, String(seatOf(server, 'victim')));

    // ── SURFACE 1 — THE CONTROL PAGE (a `control` frame over the websocket) ──────────────────
    let before = calls().length;
    attacker.clear();
    attacker.send({ t: 'control', action: 'set_station', args: { userId: 'victim', stationUid: BETA } });
    await wait(200);
    const wsRefusal = last(attacker, 'station-set');
    expect('WIRE SURFACE — a participant is refused, by name',
      wsRefusal && wsRefusal.ok === false && wsRefusal.reason === 'not-controller', JSON.stringify(wsRefusal));
    expect('WIRE SURFACE — select() was not reached', calls().length === before, JSON.stringify(calls().slice(before)));
    expect('WIRE SURFACE — the seat is unchanged', seatOf(server, 'victim') === ALPHA, String(seatOf(server, 'victim')));

    // ── SURFACE 2 — THE API/MCP ENTRY POINT (api.stationSet, what mcp/tools.mjs calls) ───────
    // Same function, same gate, attributed to the same participant. If the gate had been written
    // into `handleControl` instead of into `stationSet`, THIS is the call that would go through —
    // and the escalation would still be open on the surface an agent drives.
    before = calls().length;
    const apiRefusal = server.stationSet('victim', BETA, { userId: 'attacker', role: 'participant' });
    expect('API SURFACE — the same participant is refused, by the same name',
      apiRefusal && apiRefusal.ok === false && apiRefusal.reason === 'not-controller', JSON.stringify(apiRefusal));
    expect('API SURFACE — select() was not reached', calls().length === before, JSON.stringify(calls().slice(before)));
    expect('API SURFACE — the seat is unchanged', seatOf(server, 'victim') === ALPHA, String(seatOf(server, 'victim')));

    // A `gm` role is deliberately NOT a controller here (neutral-role.test.mjs settled that it
    // gets no presence feed and is not counted as one), so it must be refused too.
    const gmRoleRefusal = server.stationSet('victim', BETA, { userId: 'x', role: 'gm' });
    expect('a NON-control role is refused whatever it is called',
      gmRoleRefusal && gmRoleRefusal.ok === false && gmRoleRefusal.reason === 'not-controller', JSON.stringify(gmRoleRefusal));
    const nullRefusal = server.stationSet('victim', BETA, null);
    expect('an ABSENT actor is refused too — the gate is default-deny, not default-open',
      nullRefusal && nullRefusal.ok === false && nullRefusal.reason === 'not-controller', JSON.stringify(nullRefusal));
    expect('after every refusal the seat is STILL ALPHA', seatOf(server, 'victim') === ALPHA, String(seatOf(server, 'victim')));

    // ── AND IT IS A GATE, NOT A WALL — a real controller gets through on BOTH surfaces ───────
    gm.clear();
    gm.send({ t: 'control', action: 'set_station', args: { userId: 'victim', stationUid: BETA } });
    await wait(200);
    const gmOk = last(gm, 'station-set');
    expect('WIRE SURFACE — a presenter succeeds', gmOk && gmOk.ok === true && gmOk.stationUid === BETA, JSON.stringify(gmOk));
    expect('WIRE SURFACE — and the seat actually moved', seatOf(server, 'victim') === BETA, String(seatOf(server, 'victim')));
    expect('the reply reports how many of that identity\'s clients were re-rendered (I5)',
      gmOk && gmOk.delivered === 1, JSON.stringify(gmOk));

    const apiOk = server.stationSet('victim', ALPHA);   // the MCP call shape: no actor ⇒ the in-process control principal
    expect('API SURFACE — the MCP call shape (no actor) succeeds',
      apiOk && apiOk.ok === true && apiOk.stationUid === ALPHA, JSON.stringify(apiOk));
    expect('API SURFACE — and the seat moved back', seatOf(server, 'victim') === ALPHA, String(seatOf(server, 'victim')));

    // ⚠ The MCP tool must go on using that call shape. If it ever started forwarding a caller-
    // supplied actor, the AI surface would be gating itself on a value the caller controls.
    const tools = readFileSync(join(ROOT, 'mcp/tools.mjs'), 'utf8');
    expect('mcp/tools.mjs reaches stationSet with NO caller-supplied actor',
      /need\(\)\.stationSet\(\s*userId\s*,\s*stationUid\s*\)/.test(tools),
      (tools.match(/need\(\)\.stationSet\([^)]*\)/) || ['<no call found>'])[0]);

    // Self-selection is UNGATED and must stay that way — the whole distinction rests on it.
    victim.clear();
    victim.send({ t: 'station-select', stationUid: BETA }); await wait(180);
    const selfOk = last(victim, 'station');
    expect('SELF-selection is still ungated for a participant (it changes only what they see)',
      selfOk && selfOk.ok === true && selfOk.stationUid === BETA, JSON.stringify(selfOk));
    expect('and it really moved their own seat', seatOf(server, 'victim') === BETA, String(seatOf(server, 'victim')));
  } finally { if (victim) victim.ws.close(); if (attacker) attacker.ws.close(); if (gm) gm.ws.close(); await server.close(); }
});

test('0522 t37b — an UNOCCUPIED target is refused by name, not answered ok:true', async () => {
  const server = await boot();
  const url = server.url().replace('http', 'ws');
  let live = null;
  try {
    live = await connect(WebSocket, url, { userId: 'live', userName: 'Live' });
    await wait(120);
    const before = calls().length;

    // Nobody holds this identity. Before P14 this returned {ok:true, stationUid:<default>} — it
    // wrote a resolver record no socket would ever read, and a caller could then "prove" a
    // seating that never reached a human. I5 forbids exactly that.
    const r = server.stationSet('nobody-is-here', ALPHA);
    expect('it is a refusal, not a success', r && r.ok === false, JSON.stringify(r));
    expect('and it says WHY, by name', r && r.reason === 'not-connected', JSON.stringify(r));
    expect('the reply reports zero delivery explicitly', r && r.delivered === 0, JSON.stringify(r));
    expect('nothing was written: select() was never called for the absent identity',
      calls().length === before, JSON.stringify(calls().slice(before)));
    expect('and no phantom seat appears in the room\'s occupancy',
      !server.stations().seats.some((s) => s.userId === 'nobody-is-here'), JSON.stringify(server.stations().seats));

    // The same refusal must reach the control page, or the roster row would silently do nothing.
    const viaWire = server.stationSet('nobody-is-here', ALPHA, { userId: 'gm1', role: 'presenter' });
    expect('a real CONTROLLER is refused too — the target being absent is not an authorisation question',
      viaWire && viaWire.ok === false && viaWire.reason === 'not-connected', JSON.stringify(viaWire));

    // Sanity: an occupied target on the same server still works, so the refusal is about
    // occupancy and not about the fixture being broken.
    const ok = server.stationSet('live', ALPHA);
    expect('an OCCUPIED target still succeeds and reports its delivery',
      ok && ok.ok === true && ok.stationUid === ALPHA && ok.delivered === 1, JSON.stringify(ok));
  } finally { if (live) live.ws.close(); await server.close(); }
});
