/*
 * Plan 0720 B8 — THE WRITE INVARIANT: `shared/combat/log` and `shared/combat/order` have
 * exactly ONE writer, and it is the server.
 *
 * Red-team R5: *"`note()` does `put(NS/log, [...prev, line])` — a read-modify-write on a shared
 * key, which is the exact pattern the rest of this plan avoids. Safe today ONLY because the server
 * is the sole writer and single-threaded."* B3 measured what that pattern costs when it is not
 * sole-writer: 7 of 8 concurrent appends lost, four rounds out of four, silently.
 *
 * ⛔⛔ AND HERE IS THE HONEST ANSWER TO THE QUESTION THE PLAN ASKED — "does the store REFUSE such a
 * write, or does nothing merely perform one?"
 *
 *      ⛔ THE STORE DOES NOT REFUSE IT. `shared/combat/log` sits under the `shared/**` glob, which
 *         grants every participant set/merge/add/remove/clear (app/permissions.mjs, Plan 0691).
 *         A participant write to it is ACCEPTED, APPLIED AND BROADCAST today. B8.3 does exactly
 *         that and watches the whole combat log disappear.
 *
 * ⇒ The invariant is UNVIOLATED, NOT ENFORCED. This file is the guard rail that turns "nobody has
 * done it yet" into "the suite goes red the day somebody does", by two independent checks:
 *   B8.2 — RUNTIME: no op in the server's own op-log wrote those paths as a participant;
 *   B8.5 — STATIC:  no client-delivered asset contains a write call naming those paths.
 * B8.4 proves the runtime detector actually bites, by running it over a deliberate violation.
 *
 * ⛔ DOMAIN-FREE FIXTURES (PSS t0531-01).
 */
import { test, expect, check } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, relative } from 'path';
import { connect, poll, wait } from './_0720-band-b-client.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NS = 'shared/combat';
const GUARDED = [`${NS}/log`, `${NS}/order`];
const SERVER_ROLES = new Set(['system', 'presenter', 'ai']);   // the roles a SERVER-side write carries

/* A domain-free force. The behaviour under test is domain-free, so the names are not load-bearing. */
const FORCE = [
  { id: 'alpha', name: 'Alpha', side: 'player', init: 8, dm: 0 },
  { id: 'bravo', name: 'Bravo', side: 'enemy', init: 5, dm: 0 },
];

/** Every op-log entry that WROTE one of the guarded paths (or anything under it). */
function writesToGuarded(store) {
  return store.oplogSince(0).filter((e) =>
    GUARDED.some((g) => e.path === g || String(e.path).indexOf(g + '/') === 0));
}
/** ⭐ THE INVARIANT PREDICATE, in one place so B8.2 asserts it and B8.4 proves it bites. */
function violations(store) {
  return writesToGuarded(store).filter((e) => !SERVER_ROLES.has(String(e.role)));
}

let server, url, call, player;

test('0720 B8.0 — boot with the combat plugin and open an engagement', async () => {
  server = await createServer({ port: 0 });
  url = server.url();
  call = async (name, args = {}) => {
    const r = await server.callPluginTool(name, args);         // ⛔ wraps as {ok, result} — unwrap once
    if (r && r.ok === false) throw new Error(`plugin tool ${name} failed: ${r.error}`);
    return r && Object.prototype.hasOwnProperty.call(r, 'result') ? r.result : r;
  };
  const names = server.pluginTools().map((t) => t.name);
  expect(names.includes('combat_begin'), 'the combat tools are registered', names.join(','));

  await call('combat_begin', { order: FORCE, round: 1 });
  expect(Array.isArray(server.store.get(`${NS}/order`)), 'the order is in the store as an ARRAY',
    JSON.stringify(server.store.get(`${NS}/order`)));
  expect(Array.isArray(server.store.get(`${NS}/log`)), 'the log is in the store as an ARRAY',
    JSON.stringify(server.store.get(`${NS}/log`)));
});

test('0720 B8.1 — these two paths are WHOLE-VALUE writes, which is what makes sole-writer load-bearing', () => {
  const writes = writesToGuarded(server.store);
  const verbs = [...new Set(writes.map((e) => e.verb))];
  const by = [...new Set(writes.map((e) => e.by))];
  const roles = [...new Set(writes.map((e) => String(e.role)))];

  check(`${writes.length} writes to the guarded paths so far, verbs [${verbs.join(', ')}]`,
    writes.length > 0 && verbs.length === 1 && verbs[0] === 'set', verbs.join(','));
  /* ⛔ `set` on the WHOLE ARRAY. Not `add` on a keyed collection — so two writers would be a
     lost-update race, exactly as B3.3 measured. The only thing standing between this design and
     that race is that there is one writer. */
  check('…each carrying a whole ARRAY value, not a keyed item',
    writes.every((e) => Array.isArray(e.value)), JSON.stringify(writes.map((e) => typeof e.value)));
  check(`…all authored by the server side: roles [${roles.join(', ')}], by [${by.join(', ')}]`,
    roles.every((r) => SERVER_ROLES.has(r)), roles.join(','));
});

test('0720 B8.2 — ⭐⭐ THE INVARIANT: a PARTICIPANT drives the tracker and still writes NEITHER path', async () => {
  /*
   * Plan 0720 T9 established that there is deliberately NO role gate: any player may advance the
   * initiative. So the interesting case is not "a player is blocked" — it is that a player moving
   * the tracker produces SERVER writes, never client writes, to these two paths. The console door
   * (`{t:'result'}` → `combat-command`) is the whole client-side API for this feature.
   */
  player = await connect(url, { userId: 'p1', userName: 'Player One', role: 'participant' });
  const send = (what) => player.ws.send(JSON.stringify({ t: 'result', msg: { type: 'combat-command', value: { what } } }));

  const log0 = (server.store.get(`${NS}/log`) || []).length;
  send('turn');
  await poll(async () => (await call('combat_state')).turn === 1, 'the player advanced the turn');
  send('phase'); send('round');
  await poll(async () => (await call('combat_state')).round === 2, 'the player advanced the round');
  // …and some ordinary participant traffic beside it, so the sweep is over a real session.
  player.ws.send(JSON.stringify({ t: 'chat', text: 'ready' }));
  player.op('shared/tactical/tokens/tok-a', 'set', { id: 'tok-a', x: 1 });
  await wait(120);

  const log1 = (server.store.get(`${NS}/log`) || []).length;
  check(`the player's commands appended ${log1 - log0} lines to the combat log`, log1 > log0, `${log0} -> ${log1}`);

  const writes = writesToGuarded(server.store);
  const bad = violations(server.store);
  expect(bad.length === 0,
    `⭐ INVARIANT HOLDS: ${writes.length} writes to shared/combat/{log,order}, 0 by a client`,
    JSON.stringify(bad.map((e) => ({ path: e.path, by: e.by, role: e.role, verb: e.verb }))));
  check('…and the player DID reach the store elsewhere in the same session (the sweep is not vacuous)',
    (server.store.get('shared/tactical/tokens/tok-a') || {}).x === 1);
});

test('0720 B8.3 — ⛔⛔ AND YET THE STORE DOES NOT REFUSE SUCH A WRITE. It is accepted, and it destroys the log', async () => {
  const perms = server.store.perms;
  const actor = { role: 'participant', userId: 'p1' };
  for (const g of GUARDED) {
    for (const verb of ['set', 'merge', 'clear']) {
      check(`⛔ perms.can(participant, ${verb} ${g}) === ${perms.can(actor, { path: g, verb })}`,
        perms.can(actor, { path: g, verb }) === true, 'expected TRUE — this is the gap, not a pass');
    }
  }

  /* Not theoretical. A participant writes it over the wire and the store takes it. */
  const before = (server.store.get(`${NS}/log`) || []).length;
  expect(before > 0, 'there is a combat log to lose', String(before));
  player.op(`${NS}/log`, 'set', []);
  await poll(() => (server.store.get(`${NS}/log`) || []).length === 0, 'the client write landed');
  check(`⛔ a participant erased ${before} log lines with one accepted op`,
    (server.store.get(`${NS}/log`) || []).length === 0, JSON.stringify(server.store.get(`${NS}/log`)));

  const bad = violations(server.store);
  expect(bad.length === 1 && bad[0].role === 'participant' && bad[0].by === 'p1',
    '⇒ the guarded path now carries a CLIENT-AUTHORED write in the op-log',
    JSON.stringify(bad.map((e) => ({ path: e.path, by: e.by, role: e.role }))));
});

test('0720 B8.4 — ⭐ AND THE DETECTOR BITES: the same predicate reports the violation', async () => {
  /* A test that can never fail is not a test. B8.2's predicate is re-run over the deliberate
     violation B8.3 just committed, and it returns non-empty — so the day someone wires a client
     write to these paths, B8.2 goes red and this comment says why. */
  const bad = violations(server.store);
  expect(bad.length > 0,
    '⭐ violations() is non-empty after a real client write — B8.2 would have failed',
    String(bad.length));
  check(`it names the offender: path=${bad[0].path} by=${bad[0].by} role=${bad[0].role} verb=${bad[0].verb}`,
    bad[0].path === `${NS}/log`);

  // Restore the engagement so nothing downstream inherits a wrecked log.
  await call('combat_begin', { order: FORCE, round: 1 });
  check('the engagement was rebuilt after the deliberate violation',
    Array.isArray(server.store.get(`${NS}/log`)));
});

test('0720 B8.5 — ⭐ THE STATIC HALF: no CLIENT-DELIVERED asset contains a write naming these paths', () => {
  /*
   * The runtime sweep can only see paths a test actually exercised. This one reads the shipped
   * client code: a write from a browser can only arrive through `Argus.op(path, …)`,
   * `Argus.bind(el, path)` / `bindLocked`, or the declarative `data-ap-bind="path"` — so those are
   * what is searched for. A READ of these paths is fine and expected once the panels exist; only a
   * WRITE is the defect.
   *
   * ⛔ Server modules (.mjs) are excluded ON PURPOSE — the server IS the legitimate writer.
   */
  const roots = ['components', 'lib', join('plugins', 'starship-ops')].map((r) => join(ROOT, r)).filter(existsSync);
  expect(roots.length >= 2, 'there are client asset trees to scan', roots.join(','));

  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!/\.(js|html)$/.test(name)) continue;        // .mjs = server side, deliberately excluded
      if (/\.test\.(js|mjs)$/.test(name)) continue;
      files.push(p);
    }
  };
  for (const r of roots) walk(r);

  const PATHS = '(?:shared/)?combat/(?:log|order)';
  const WRITE_FORMS = [
    new RegExp(`\\bop\\(\\s*(['"\`])[^'"\`]*${PATHS}\\1`),                       // Argus.op(path, verb, value)
    new RegExp(`\\bbind(?:Locked)?\\(\\s*[^,]+,\\s*(['"\`])[^'"\`]*${PATHS}\\1`),  // Argus.bind(el, path)
    new RegExp(`data-ap-bind\\s*=\\s*(['"])[^'"]*${PATHS}\\1`),                  // declarative binding
    new RegExp(`path\\s*:\\s*(['"\`])[^'"\`]*${PATHS}\\1`),                        // {path: …, verb: …}
  ];

  const offenders = [], mentions = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (!new RegExp(PATHS).test(src)) continue;
    mentions.push(relative(ROOT, f));
    if (WRITE_FORMS.some((re) => re.test(src))) offenders.push(relative(ROOT, f));
  }

  check(`${files.length} client-delivered assets scanned across ${roots.length} trees`, files.length > 0);
  check(`${mentions.length} mention shared/combat/{log,order} at all (a READ is legitimate)`, true,
    mentions.join(', '));
  expect(offenders.length === 0,
    '⭐ NO client asset writes shared/combat/log or shared/combat/order',
    'offenders: ' + offenders.join(', '));

  /* The scanner must be able to fail, or it is decoration. */
  const decoy = `Argus.op('${NS}/log', 'set', []);`;
  expect(WRITE_FORMS.some((re) => re.test(decoy)),
    '…and the scanner DOES match a client write, so a clean result means something', decoy);
});

test('0720 B8.9 — teardown', async () => {
  if (player) player.close();
  await server.close();
  expect(true, 'server closed');
});
