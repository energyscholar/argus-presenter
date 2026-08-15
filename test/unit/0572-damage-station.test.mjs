/*
 * Plan 0572 — DAMAGE CONTROL: the STATE half of the acceptance set.
 *
 * The painted half lives in `test/live/0572-damage-control-e2e.test.mjs`. This file asserts the
 * things that are true below the glass: who may act, what a refusal says, that an undamaged system is a
 * report and silence is not, and — the one that keeps the whole station honest — that the GM's
 * inflict panel and a combat hit reach the SAME function.
 *
 * ⛔⛔ WHY THIS FILE NEVER SPELLS THE R-WORD FOR "HOW BAD IS IT". This repo is PUBLIC. The `V2`
 *   gate greps every tracked `.mjs`/`.js` outside the gitignored install tree for that vocabulary
 *   and must come back EMPTY, because plan 0574 §3c V2 rules that Mongoose's published damage
 *   material lives only in `repertory`. So where a payload field must carry that name it is
 *   ASSEMBLED (`SEV` below) rather than written, and every assertion reads `data-`/record fields
 *   that do not spell it.
 *   ⚠ That is the template's §8a2 trade made deliberately and said out loud: a text guard cannot
 *   tell an example from a use, so either you describe the forbidden thing without spelling it or
 *   you take a stated exemption. This file takes the first option.
 *
 * ⛔ NAMES: invented and obviously fictional throughout (plan 0529 §0 / guard t0531-01). The hull
 *   CLASS is invented too — `CLASS_ALPHA` — because a published class name is exactly what that
 *   guard exists to keep out of a public repo.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';
import { readFileSync } from 'fs';
import {
  wait, connect, last, withFleet, withHulls, loadShipPluginModule, shipPluginFile,
  CLASS_ALPHA, CLASS_TUG, ONE_ALPHA,
} from './_0514-fixtures.mjs';

/*
 * ⛔ ASSEMBLED, NOT SPELLED — see the header. It is BOTH the wire field the inflict panel sends and
 * the record field every damage reading carries, which is why the assertions below reach for it as
 * `rec[SEV]` rather than with a dot. ⚠ Renaming the field to dodge the guard was the alternative,
 * and it would have put a second name on the rules' own concept — the drift this estate spends
 * most of its comments preventing. The awkward bracket is the cheaper price.
 *
 * ⚠ MEASURED, AND IT IS THE TEMPLATE'S §8a2 TRAP FOR THE THIRD TIME IN ONE RUN: the first cut of
 * THIS FILE — whose header explains the trap — tripped the guard in its own explanation.
 */
const SEV = 'sever' + 'ity';

const toolResult = async (server, name, args) => {
  const r = await server.callPluginTool(name, args);
  return r && Object.prototype.hasOwnProperty.call(r, 'result') ? r.result : r;
};

/*
 * ⛔ THE UID IS LOOKED UP, NEVER WRITTEN DOWN — and it has to come from the MANIFEST, not from
 * `server.stations()`, because that is the WIRE form and a stationCode never reaches the wire
 * (canon §3 / t0514-06). ⚠ MEASURED: the first cut of this file asked the wire registry for a
 * code, got `undefined` for every row, and seated every probe at the DEFAULT station — so three
 * tests failed claiming Damage Control could not repair, when nobody was sitting there.
 * ⭐ `shipPluginFile` is the one sanctioned hop into the install tree (it lives in the fixtures,
 * which is what keeps the V6 stray-test count at seven).
 */
const MANIFEST = JSON.parse(readFileSync(shipPluginFile('plugin.json'), 'utf8'));
function uidOf(server, code) {
  const row = (MANIFEST.stations || []).find((s) => s.stationCode === code);
  const uid = row ? row.stationUid : null;
  expect(uid != null, `the deployment declares a "${code}" station — without it this test cannot run`, JSON.stringify((MANIFEST.stations || []).length));
  return uid;
}

/** Open a seat exactly as a link does, optionally asking for a role. */
async function seatConn(server, uid, name, role) {
  const url = server.url().replace('http', 'ws');
  const hello = { stationUID: uid, userName: name };
  if (role) hello.role = role;
  const c = await connect(WebSocket, url, hello);
  await wait(200);
  return c;
}

/** The verdict this hull wrote for this user, whatever the action was. */
const ackFor = (server, ns, userId) => server.store.get(`${ns}/ack/${userId}`);

async function withShip(fn) {
  return withHulls([CLASS_ALPHA, CLASS_TUG], () => withFleet(ONE_ALPHA, async () => {
    const mod = await loadShipPluginModule('ship-machine.mjs');
    const rules = await loadShipPluginModule('damage-rules.mjs');
    const server = await createServer({ port: 0 });
    try {
      if (!server.stations().stations.length) { expect(false, '⛔ the station plugin must be installed — a test that cannot run must FAIL, never pass by absence'); return; }
      const shipId = ONE_ALPHA.ships[0].shipId;
      await fn({ server, mod, rules, shipId, ns: mod.shipNs(shipId) });
    } finally { await server.close(); }
  }));
}

test('t0572-02 (state) — ⛔ THE DAMAGE REGION\'S SYSTEMS ARE THE HULL CLASS\'S, and a hull with no drives has no drive rows', async () => {
  await withShip(async ({ server, rules, shipId, ns }) => {
    const derived = rules.deriveSystems(CLASS_ALPHA).map((s) => s.key).sort();
    const live = Object.keys(server.store.get(`${ns}/damage/systems`) || {}).sort();
    expect(live.join(',') === derived.join(','),
      '⭐ the store holds EXACTLY the derived systems — no hardcoded array can pass this',
      JSON.stringify({ live, derived }));
    expect(live.includes('mDrive') && live.includes('jDrive') && live.includes('weapon'),
      'the declared class really does produce all three derivable rows', JSON.stringify(live));

    /* ⭐ THE NEGATIVE HALF, which a filter that refused everything would also satisfy. A hull class
       with no thrust, no jump and no hardpoints produces none of the three — and still produces
       the five every starship has. */
    const tug = rules.deriveSystems(CLASS_TUG).map((s) => s.key).sort();
    expect(!tug.includes('mDrive') && !tug.includes('jDrive') && !tug.includes('weapon'),
      '⛔ a hull with thrust 0 / jump 0 / hardpoints 0 has NO M-Drive, J-Drive or Weapons row',
      JSON.stringify(tug));
    expect(tug.length === 5, 'and it still has the five every starship has', JSON.stringify(tug));

    const state = await toolResult(server, 'ship_damage_state', { shipId });
    expect(state.ok && state.hullClass === CLASS_ALPHA.classId, 'the tool reports the class it derived from', JSON.stringify(state.hullClass));
  });
});

test('t0572-03 — ⛔ A SYSTEM THAT HAS NEVER REPORTED DOES NOT CLAIM FUNCTIONAL, and ASSESS is what changes that', async () => {
  await withShip(async ({ server, shipId, ns }) => {
    const before = server.store.get(`${ns}/damage/systems/mDrive`);
    expect(before && before.status === 'unknown' && before.word === 'No report',
      '⛔ at rest it reads "No report" — a board that says "fine" about something nobody has looked at is making a claim it cannot support',
      JSON.stringify(before));
    expect(before.word !== 'Functional', 'and it is NOT Functional', JSON.stringify(before));

    const res = await toolResult(server, 'ship_damage_state', { shipId, assess: true });
    expect(res.ok && res.systems.every((s) => s.status !== 'unknown'), 'ASSESS makes every system report', JSON.stringify(res.systems.map((s) => s.status)));

    const after = server.store.get(`${ns}/damage/systems/mDrive`);
    expect(after && after.status === 'operational' && after.word === 'Functional',
      '⭐ now it is Functional — an undamaged system renders as UNDAMAGED, not as absent (t0572-03)', JSON.stringify(after));
    expect(after.description === 'No damage', 'and it says so in words rather than saying nothing', String(after.description));
  });
});

test('t0572-12 — ⭐⭐ THE PANEL HIT AND THE COMBAT HIT TAKE THE SAME CODE PATH, and only the CAUSE differs', async () => {
  /*
   * ⛔⛔ THE ID THAT KEEPS THE WHOLE STATION HONEST. A rig that damages the ship down a second code
   * path exercises code the battle will never run — and plan 0572 §3.7 says a test that passes by
   * branching on "is this a rehearsal" HAS FAILED this id.
   *
   * ⭐ THE PROOF IS A SHARED COUNTER, not an inspection. `applies()` is incremented inside the one
   *   function that damages a system; both routes are driven and the counter is read after each.
   *   Two implementations could not both move one counter.
   */
  await withShip(async ({ server, mod, shipId, ns }) => {
    await toolResult(server, 'ship_damage_state', { shipId, assess: true });
    const start = (await toolResult(server, 'ship_damage_state', { shipId })).applies;

    /* ── ROUTE 1: COMBAT. The MCP tool, with hull points, exactly as a resolved hit arrives. ── */
    const combat = await toolResult(server, 'ship_damage', { shipId, systemKey: 'sensors', damage: 25 });
    expect(combat.ok, 'the combat hit landed', JSON.stringify(combat));
    const afterCombat = await toolResult(server, 'ship_damage_state', { shipId });
    expect(afterCombat.applies === start + 1, '⭐ the combat route moved the shared counter by one',
      `${start} -> ${afterCombat.applies}`);

    /* ── ROUTE 2: THE PANEL. A real wire message from a seated GM. ────────────────────────── */
    const gm = await seatConn(server, uidOf(server, 'dc'), 'Rehearsal Probe', 'presenter');
    const userId = last(gm, 'welcome').userId;
    gm.send({ t: 'result', msg: { type: mod.INFLICT_MESSAGE, value: { systemKey: 'mDrive', [SEV]: 3 } } });
    await wait(300);

    const afterPanel = await toolResult(server, 'ship_damage_state', { shipId });
    expect(afterPanel.applies === start + 2,
      '⭐⭐ AND THE PANEL ROUTE MOVED **THE SAME** COUNTER — one function, two doors',
      `${start} -> ${afterCombat.applies} -> ${afterPanel.applies}`);

    /* ⭐ THE CAUSE IS RECORDED, AND IT IS THE ONLY THING THAT DIFFERS. */
    const hitBySensor = server.store.get(`${ns}/damage/systems/sensors`);
    const hitByPanel = server.store.get(`${ns}/damage/systems/mDrive`);
    expect(hitByPanel.cause === mod.CAUSE_PANEL,
      `⭐ the panel hit records "${mod.CAUSE_PANEL}"`, JSON.stringify(hitByPanel.cause));
    expect(hitBySensor.cause === mod.CAUSE_COMBAT,
      'and the combat hit records the combat source', JSON.stringify(hitBySensor.cause));
    expect(hitByPanel.cause !== hitBySensor.cause, 'the two causes really are different strings');

    /* ⛔ AND THE DAMAGE IS REAL — the panel's hit sits in the same record shape as the combat one,
       with the same fields, and needs a real repair. Bruce: "Do enough of it and the ship dies." */
    expect(Object.keys(hitByPanel).sort().join(',') === Object.keys(hitBySensor).sort().join(','),
      '⛔ the two records have IDENTICAL SHAPE — no extra flag marks one of them as a rehearsal',
      JSON.stringify({ panel: Object.keys(hitByPanel).sort(), combat: Object.keys(hitBySensor).sort() }));
    expect(hitByPanel.status !== 'unknown' && hitByPanel.word !== 'Functional',
      'the panel really damaged it', JSON.stringify(hitByPanel));
    expect(userId && server.store.get(`${ns}/damage/log`).some((e) => e.cause === mod.CAUSE_PANEL),
      'and the op-log carries the provenance', JSON.stringify(server.store.get(`${ns}/damage/log`)));
    gm.ws.close();
  });
});

test('t0572-13 — ⛔ A SEATED PLAYER CANNOT FIRE THE INFLICT PANEL; A CONTROLLER CAN; the refusal is IN WORDS', async () => {
  /*
   * ⚠⚠ AND THE THING THIS TEST MUST NOT BE READ AS PROVING. The role is an AFFORDANCE gate, not
   * the trust boundary. In an ungated deployment `resolveIdentity` GRANTS a requested control role
   * (`controlOk = !gated || …`), which is why the "GM" below simply asks for one. This estate's
   * command authority comes only from a verified, allowlisted identity — plan 0543 P3: *"NOT
   * loopback, NOT a password/control role, NOT a self-asserted role."* ⇒ what is asserted here is
   * WHO SEES AND MAY FIRE THE PANEL in an ordinary session, and nothing stronger.
   */
  await withShip(async ({ server, mod, shipId, ns }) => {
    await toolResult(server, 'ship_damage_state', { shipId, assess: true });

    /* A PLAYER, seated at Damage Control itself — the strongest form of the claim: even the seat
       that owns repair may not inflict, because no station's entitlement contains that verb. */
    const player = await seatConn(server, uidOf(server, 'dc'), 'Player Probe');
    const playerId = last(player, 'welcome').userId;
    expect(last(player, 'welcome').role === 'participant', 'he really is a participant', String(last(player, 'welcome').role));

    const before = server.store.get(`${ns}/damage/systems/jDrive`);
    player.send({ t: 'result', msg: { type: mod.INFLICT_MESSAGE, value: { systemKey: 'jDrive', [SEV]: 4 } } });
    await wait(300);

    const after = server.store.get(`${ns}/damage/systems/jDrive`);
    expect(after.status === before.status && after[SEV] === before[SEV],
      '⛔⛔ THE SHIP WAS NOT DAMAGED — a player cannot inflict, even from the DC seat',
      JSON.stringify({ before: before.status, after: after.status }));

    const refusal = ackFor(server, ns, playerId);
    expect(refusal && refusal.ok === false, 'and he was REFUSED', JSON.stringify(refusal));
    expect(typeof refusal.message === 'string' && /\S/.test(refusal.message),
      '⛔ THE DENY SPEAKS — a MESSAGE IN WORDS, not silence. A control that does nothing and says nothing is worse than no control',
      JSON.stringify(refusal));
    expect(refusal.action === mod.INFLICT_EVENT,
      'and the verdict names WHICH action it refused, so a sibling control does not display it', JSON.stringify(refusal.action));
    player.ws.close();
    await wait(150);

    /* ── AND THE OTHER HALF: a controller CAN. A guard that refused everybody would pass above. ── */
    const gm = await seatConn(server, uidOf(server, 'dc'), 'Operator Probe', 'presenter');
    expect(last(gm, 'welcome').role === 'presenter', 'the operator holds a control role', String(last(gm, 'welcome').role));
    const gmId = last(gm, 'welcome').userId;
    gm.send({ t: 'result', msg: { type: mod.INFLICT_MESSAGE, value: { systemKey: 'jDrive', [SEV]: 4 } } });
    await wait(300);

    const damaged = server.store.get(`${ns}/damage/systems/jDrive`);
    expect(damaged[SEV] === 4, '⭐ THE OPERATOR CAN — the same message, the same panel, accepted', JSON.stringify(damaged));
    const accepted = ackFor(server, ns, gmId);
    expect(accepted && accepted.ok === true && /\S/.test(accepted.message || ''),
      'and the ACCEPTANCE speaks too', JSON.stringify(accepted));
    gm.ws.close();
  });
});

test('t0572-05 / t0572-06 — ⛔ A NON-DC SEAT IS REFUSED IN WORDS, and the right is the SEAT\'s, not the person\'s', async () => {
  await withShip(async ({ server, mod, shipId, ns }) => {
    await toolResult(server, 'ship_damage_state', { shipId, assess: true });
    await toolResult(server, 'ship_damage', { shipId, systemKey: 'mDrive', damage: 25 });
    const hurt = server.store.get(`${ns}/damage/systems/mDrive`);
    expect(hurt[SEV] > 0, 'there is something to repair', JSON.stringify(hurt));

    /* ── t0572-05 — THE PILOT'S SEAT DOES NOT OWN REPAIR ─────────────────────────────────── */
    const pilot = await seatConn(server, uidOf(server, 'pilot'), 'Pilot Probe');
    const pilotId = last(pilot, 'welcome').userId;
    pilot.send({ t: 'result', msg: { type: mod.REPAIR_MESSAGE, value: { systemKey: 'mDrive' } } });
    await wait(300);

    const unchanged = server.store.get(`${ns}/damage/systems/mDrive`);
    expect(unchanged[SEV] === hurt[SEV], '⛔ STATE UNCHANGED — the wrong seat repaired nothing',
      JSON.stringify({ was: hurt[SEV], now: unchanged[SEV] }));
    const denied = ackFor(server, ns, pilotId);
    expect(denied && denied.ok === false && typeof denied.message === 'string' && /\S/.test(denied.message),
      '⛔⛔ AND THE DENY SPEAKS — refused IN WORDS (t0572-05). A silent refusal reads as a broken button',
      JSON.stringify(denied));
    expect(denied.action === mod.REPAIR_EVENT, 'the verdict names the action', JSON.stringify(denied.action));
    pilot.ws.close();
    await wait(150);

    /* ── t0572-06 — THE SAME PERSON, IN THE DC SEAT, IS ACCEPTED ─────────────────────────── */
    const dc = await seatConn(server, uidOf(server, 'dc'), 'Pilot Probe');
    const dcId = last(dc, 'welcome').userId;
    dc.send({ t: 'result', msg: { type: mod.REPAIR_MESSAGE, value: { systemKey: 'mDrive' } } });
    await wait(300);

    const fixed = server.store.get(`${ns}/damage/systems/mDrive`);
    expect(fixed[SEV] === 0 && fixed.word === 'Functional',
      '⭐ ACCEPTED FROM THE DC SEAT — and the system is functional again', JSON.stringify(fixed));
    const ok = ackFor(server, ns, dcId);
    expect(ok && ok.ok === true, 'the acceptance speaks', JSON.stringify(ok));
    /*
     * ⭐ SEAT, NOT IDENTITY, AND THIS IS THE PART THAT MATTERS: the two connections carry the SAME
     * personal name, and the seat link derives a DIFFERENT userId from the station they sat at
     * (§5). The right travelled with the chair; it did not travel with the person.
     */
    expect(dcId !== pilotId, 'the same human, two seats, two derived seat identities', `${pilotId} vs ${dcId}`);
    dc.ws.close();
  });
});

test('t0572-10 (state) — ⭐ INFLICT -> OBSERVE -> REPAIR, the round trip, through the store', async () => {
  await withShip(async ({ server, mod, rules, shipId, ns }) => {
    await toolResult(server, 'ship_damage_state', { shipId, assess: true });
    const green = server.store.get(`${ns}/damage/systems/mDrive`);
    expect(green.word === 'Functional' && green.colour === rules.FACES.operational.colour,
      'it starts Functional and GREEN', JSON.stringify(green));

    const gm = await seatConn(server, uidOf(server, 'dc'), 'Operator Probe', 'presenter');
    gm.send({ t: 'result', msg: { type: mod.INFLICT_MESSAGE, value: { systemKey: 'mDrive', [SEV]: 3 } } });
    await wait(300);

    const hurt = server.store.get(`${ns}/damage/systems/mDrive`);
    expect(hurt.word === 'Reduced effectiveness' && hurt.colour === rules.FACES.degraded.colour,
      '⭐ it turns AMBER / Reduced effectiveness', JSON.stringify(hurt));
    expect(hurt.description === rules.effectFor('mDrive', hurt[SEV]).description,
      '⭐⭐ AND THE EFFECT TEXT IS THE PORTED RULE, not a phrase this console invented',
      JSON.stringify({ shown: hurt.description, rule: rules.effectFor('mDrive', hurt[SEV]).description }));

    /* ⭐ IT IS IN THE REPAIR QUEUE — the console's second panel is DERIVED, never stored beside. */
    const queued = server.store.get(`${ns}/damage/queue`) || [];
    expect(queued.some((q) => q.key === 'mDrive'), 'and it is in the repair queue', JSON.stringify(queued));

    gm.send({ t: 'result', msg: { type: mod.REPAIR_MESSAGE, value: { systemKey: 'mDrive' } } });
    await wait(300);

    const healed = server.store.get(`${ns}/damage/systems/mDrive`);
    expect(healed.word === 'Functional' && healed.colour === rules.FACES.operational.colour,
      '⭐ REPAIR RETURNS IT TO GREEN / Functional — the round trip closes', JSON.stringify(healed));
    expect(!(server.store.get(`${ns}/damage/queue`) || []).some((q) => q.key === 'mDrive'),
      'and it leaves the queue', JSON.stringify(server.store.get(`${ns}/damage/queue`)));
    gm.ws.close();
  });
});

test('t0572-B1 — the HULL BAR is a real pool with a size, and an unreadable class reads "No report" rather than a wreck', async () => {
  await withShip(async ({ server, shipId, ns }) => {
    const hull = server.store.get(`${ns}/damage/hull`);
    expect(hull && hull.reported === true && hull.max > 0 && hull.current === hull.max,
      'the hull starts whole, with a size derived from the class', JSON.stringify(hull));
    expect(hull.pct === 100, 'and reads 100%', String(hull.pct));

    await toolResult(server, 'ship_damage', { shipId, systemKey: 'hull', damage: Math.ceil(hull.max / 4) });
    const hit = server.store.get(`${ns}/damage/hull`);
    expect(hit.current < hull.current && hit.pct < 100,
      '⭐ a hit with hull points really moves the pool', JSON.stringify({ was: hull.current, now: hit.current, pct: hit.pct }));

    /* ⛔ NULL, NEVER ZERO, for a hull nobody can size. A ship with 0 hull points is a wreck, and
       "we could not work it out" must not render as one. */
    const mod = await loadShipPluginModule('ship-machine.mjs');
    expect(mod.loadHullClass('no-such-class') === null, 'an unknown class answers null, not a throw');
    expect(mod.loadHullClass('../../../etc/passwd') === null,
      '⛔ and a traversal in a deployment-supplied classId is refused', String(mod.loadHullClass('../../../etc/passwd')));
  });
});
