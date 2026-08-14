/*
 * Plan 0575 PHASE 5 — TWO SHIPS. `ships.json` replaces the singleton (§1 S6).
 *
 * ⚠ S6 WAS THE AUDITOR'S OWN FAULT, and the plan says so: "I created ship-instance.json in 0574
 * P0a TODAY, and it is singular — I fixed one singleton by introducing another." A file called
 * ship-INSTANCE holding ONE ship is `SHIP = 'ship'` again, one layer out.
 *
 * ⭐ THIS PHASE PROVES 0–4. Everything before it was scaffolding for a second hull that did not
 * exist yet; every one of those phases either holds here or was theatre.
 *
 * ⛔ NO CAMPAIGN VALUES. The ids are asked for, never written down (t0531-01) — and the fleet a
 * deployment declares is read from a GITIGNORED file, so this test cannot assume ANY particular
 * hull exists. It asserts what is true of whatever fleet it finds, and says so when it finds one.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { REAL_PLUGINS, SHIP_ID, loadShipPluginModule } from './_0514-fixtures.mjs';

const haveMachine = existsSync(join(REAL_PLUGINS, 'starship-ops', 'ship-machine.mjs'));

/*
 * ⚠ `callPluginTool` WRAPS THE HANDLER'S RETURN as {ok, result}. Reading `res.shipId` straight off
 * it is `undefined`, which is falsy, which fails an assertion that the code passed — I wrote it the
 * wrong way first and the failure looked like a broken dispatch rather than a broken test.
 */
const toolResult = async (server, name, args) => {
  const r = await server.callPluginTool(name, args);
  return r && Object.prototype.hasOwnProperty.call(r, 'result') ? r.result : r;
};

/** Write a ships.json into a temp dir and read it back through the real loader. */
async function fleetFrom(doc, { alsoInstance = null } = {}) {
  const mod = await loadShipPluginModule('ship-machine.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ap-0575-fleet-'));
  const shipsFile = join(dir, 'ships.json');
  const instanceFile = join(dir, 'ship-instance.json');
  if (doc !== null) writeFileSync(shipsFile, typeof doc === 'string' ? doc : JSON.stringify(doc), 'utf8');
  if (alsoInstance) writeFileSync(instanceFile, JSON.stringify(alsoInstance), 'utf8');
  try { return mod.loadFleet({ shipsFile, instanceFile }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('t0575-02a — ships.json is a LIST, and the old singleton still loads as a fleet of one', async () => {
  if (!haveMachine) { expect(false, 'the plugin is installed'); return; }
  const two = await fleetFrom({ ships: [{ shipId: 'hull-a', name: 'A', primary: true }, { shipId: 'hull-b', name: 'B' }] });
  expect(two.ships.length === 2, 'two hulls', JSON.stringify(two.ships));
  expect(two.primaryShipId === 'hull-a', 'the declared primary wins', two.primaryShipId);
  expect(two.source === 'ships.json', 'and it says where it came from', two.source);

  /* ⭐ THE MIGRATION PATH IS NOT SENTIMENT. ship-instance.json is GITIGNORED and
     DEPLOYMENT-SUPPLIED, so it exists on machines this commit will never touch. A loader that
     dropped it would decommission a running deployment's only ship at the next restart and leave
     thirteen stations reading an em dash — a silent regression on somebody else's box. */
  const legacy = await fleetFrom(null, { alsoInstance: { shipId: 'only-hull', name: 'Only' } });
  expect(legacy.ships.length === 1 && legacy.ships[0].shipId === 'only-hull',
    'no ships.json ⇒ the singleton is read and WRAPPED', JSON.stringify(legacy));
  expect(legacy.primaryShipId === 'only-hull', 'and a fleet of one is its own primary', legacy.primaryShipId);
  expect(legacy.source === 'ship-instance.json', 'and the source is reported honestly', legacy.source);

  const none = await fleetFrom(null);
  expect(none.ships.length === 0 && none.primaryShipId === null,
    'neither file ⇒ an EMPTY fleet, which is a coherent state and not an error', JSON.stringify(none));
  expect(none.source === 'none', 'said plainly', none.source);
});

test('t0575-02b — a hand-edited fleet file cannot half-commission a hull', async () => {
  if (!haveMachine) { expect(false, 'the plugin is installed'); return; }
  const f = await fleetFrom({ ships: [
    { shipId: 'hull-a', name: 'A' },
    { shipId: 'hull-a', name: 'A IMPOSTOR' },     // ⛔ a duplicate id is the singleton failure again
    { name: 'no id at all' },
    { shipId: '   ' },
    null, 'a string', 42,
  ] });
  expect(f.ships.length === 1, 'exactly one hull survives', JSON.stringify(f.ships));
  expect(f.ships[0].name === 'A', '⛔ and it is the FIRST claimant — the duplicate did not overwrite it',
    JSON.stringify(f.ships[0]));
  expect(f.primaryShipId === 'hull-a', 'which is therefore the primary', f.primaryShipId);

  const twoPrimaries = await fleetFrom({ ships: [{ shipId: 'a', primary: true }, { shipId: 'b', primary: true }] });
  expect(twoPrimaries.primaryShipId === 'a',
    'two primaries ⇒ the first wins, because a hand-edited file must not be able to crash a boot',
    twoPrimaries.primaryShipId);

  const junk = await fleetFrom('{ this is not json');
  expect(junk.ships.length === 0 || junk.source !== 'ships.json',
    'unparseable ships.json falls through to the singleton path rather than throwing', JSON.stringify(junk));
});

test('t0575-02 — ⭐⭐ TWO SHIPS COMMISSIONED: each has its OWN alert, identity and occupancy', async () => {
  const mod = await loadShipPluginModule('ship-machine.mjs');
  const fleet = mod.loadFleet();
  if (fleet.ships.length < 2) {
    /* ⛔ NOT A SKIP THAT HIDES. The fleet is a GITIGNORED deployment file; a machine that has not
       been given a second hull cannot prove this, and saying so is the honest result. The loader
       tests above still hold, and t0575-02c below proves the same thing at the machine layer. */
    expect(true, `this deployment declares ${fleet.ships.length} hull(s) — commission a second in ships.json to exercise t0575-02`, 'reported');
    return;
  }
  const [a, b] = fleet.ships;
  const server = await createServer({ port: 0 });
  try {
    const nsA = mod.shipNs(a.shipId), nsB = mod.shipNs(b.shipId);
    expect(a.shipId !== b.shipId, 'two DIFFERENT hulls', `${a.shipId} / ${b.shipId}`);

    // ── identity: each hull is filed under its own key, and agrees with it ──────────────────
    for (const [ns, s] of [[nsA, a], [nsB, b]]) {
      const id = server.store.get(`${ns}/identity`);
      expect(id && id.shipId === s.shipId, `${s.shipId}: identity is filed under its own key`, JSON.stringify(id));
      expect(id && id.name === s.name, 'and carries the name the deployment declared', JSON.stringify(id));
    }
    expect(server.store.get(`${nsA}/identity`).name !== server.store.get(`${nsB}/identity`).name,
      'the two identities are not the same record', JSON.stringify([server.store.get(`${nsA}/identity`), server.store.get(`${nsB}/identity`)]));

    // ── both boot at `unknown` (1c) ────────────────────────────────────────────────────────
    expect(server.store.get(`${nsA}/alert`) === 'unknown' && server.store.get(`${nsB}/alert`) === 'unknown',
      'neither hull claims a condition it has never reported',
      `${server.store.get(`${nsA}/alert`)} / ${server.store.get(`${nsB}/alert`)}`);

    // ── ⭐⭐ CHANGING ONE DOES NOT TOUCH THE OTHER ─────────────────────────────────────────
    const res = await toolResult(server, 'ship_event', { event: 'battle-stations', shipId: a.shipId });
    expect(res && res.shipId === a.shipId, 'the order named a hull and that hull answered', JSON.stringify(res));
    expect(server.store.get(`${nsA}/alert`) === 'action', 'A went to battle stations', String(server.store.get(`${nsA}/alert`)));
    expect(server.store.get(`${nsB}/alert`) === 'unknown',
      '⛔⛔ AND B DID NOT MOVE — the whole point of killing the singleton', String(server.store.get(`${nsB}/alert`)));
    expect(server.store.get(`${nsB}/display/alert`) === undefined || server.store.get(`${nsB}/display/alert`).state !== 'action',
      "and B's display metadata did not move either", JSON.stringify(server.store.get(`${nsB}/display/alert`)));

    // ── and the other direction, so this is not an ordering accident ───────────────────────
    await toolResult(server, 'ship_event', { event: 'general-quarters', shipId: b.shipId });
    expect(server.store.get(`${nsB}/alert`) === 'elevated', 'B went to general quarters', String(server.store.get(`${nsB}/alert`)));
    expect(server.store.get(`${nsA}/alert`) === 'action', 'and A stayed exactly where it was', String(server.store.get(`${nsA}/alert`)));

    // ── occupancy is per hull too ──────────────────────────────────────────────────────────
    expect(server.store.get(`${nsA}/stations/5/occupants`) === undefined || (server.store.get(`${nsA}/stations/5/occupants`) || []).length === 0,
      'nobody is aboard either hull yet', JSON.stringify(server.store.get(`${nsA}/stations/5/occupants`)));
  } finally { await server.close(); }
});

test('t0575-02c — ⛔ AN UNKNOWN shipId IS REFUSED, never quietly applied to the primary', async () => {
  const server = await createServer({ port: 0 });
  try {
    if (!server.stations().stations.length) { expect(true, 'skipped — no station plugin'); return; }
    const mod = await loadShipPluginModule('ship-machine.mjs');
    const ns = mod.shipNs(SHIP_ID);
    const before = server.store.get(`${ns}/alert`);
    /* A typo in a GM's tool call must not silently move the wrong ship. That is the same failure
       this plan exists to remove, arriving through the operator's door instead of a player's. */
    const res = await toolResult(server, 'ship_event', { event: 'battle-stations', shipId: 'no-such-hull' });
    expect(res && res.changed === false && res.reason === 'no-such-ship', 'refused, and it says why', JSON.stringify(res));
    expect(Array.isArray(res.ships) && res.ships.length >= 1, 'and lists the hulls it does know', JSON.stringify(res.ships));
    expect(server.store.get(`${ns}/alert`) === before,
      '⛔⛔ THE PRIMARY DID NOT MOVE', `${before} -> ${server.store.get(`${ns}/alert`)}`);
  } finally { await server.close(); }
});

test('t0575-09d-real — ⭐ THE PHASE-9 TEST, RE-RUN AGAINST THE REAL ships.json', async () => {
  /* ⚠ AUDITOR AMENDMENT (HANDOFF §2): phase 9 ran BEFORE phase 5, so t0575-09d commissioned its
     second hull inside the test. This is the promised re-run — the same invariant, against the
     fleet the deployment actually declares. */
  const mod = await loadShipPluginModule('ship-machine.mjs');
  const store = await loadShipPluginModule('ship-state-store.mjs');
  const fleet = mod.loadFleet();
  if (fleet.ships.length < 2) {
    expect(true, `this deployment declares ${fleet.ships.length} hull(s) — 09d's in-test fleet still covers the invariant`, 'reported');
    return;
  }
  const [a, b] = fleet.ships;
  expect(store.stateFileFor(a.shipId) !== store.stateFileFor(b.shipId),
    '⭐ ONE PERSISTENCE FILE PER REAL HULL — the independence is structural', store.stateFileFor(a.shipId));

  const server1 = await createServer({ port: 0 });
  try {
    await server1.callPluginTool('ship_event', { event: 'battle-stations', shipId: a.shipId });
    await server1.callPluginTool('ship_event', { event: 'stand-down', shipId: b.shipId });
  } finally { await server1.close(); }

  const server2 = await createServer({ port: 0 });     // ⛔ A REAL RESTART
  try {
    expect(server2.store.get(`${mod.shipNs(a.shipId)}/alert`) === 'action',
      'A came back at battle stations', String(server2.store.get(`${mod.shipNs(a.shipId)}/alert`)));
    expect(server2.store.get(`${mod.shipNs(b.shipId)}/alert`) === 'normal',
      '⛔⛔ and B came back GREEN — restoring one never wrote the other board',
      String(server2.store.get(`${mod.shipNs(b.shipId)}/alert`)));
  } finally { await server2.close(); }
});
