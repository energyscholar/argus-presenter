/*
 * Plan 0575 PHASE 9 — STATE PERSISTENCE, at the state layer.
 *
 * ⭐⭐ THE FEATURE IS BRUCE'S SENTENCE (2026-08-13): "captain need only ever set CONDITION GREEN
 * once, then it will stick for all time unless changed."
 *
 * ⛔ THE FAILURE IT DELETES IS WORSE THAN A BLANK BOARD. Until this phase the machine re-seeded
 * from the chart on every boot, so restarting the presenter mid-session stood a ship down from
 * battle stations WITHOUT SAYING SO — a confident, safe-sounding, false claim that a GM glancing
 * at thirteen green stations could not tell from a real stand-down.
 *
 * The PAINTED half of this phase (a real browser, a real seat, a real restart) is in
 * test/live/0575-persistence-e2e.test.mjs. This file is the machinery underneath it:
 * t0575-09c (a corrupt file reads as `unknown`, never a guess) and t0575-09d (two ships persist
 * independently).
 *
 * ⛔ NO CAMPAIGN VOCABULARY. The ship ids here are invented fixture names; the real one is asked
 * for, never written down (t0531-01).
 */
import { test, expect } from '../../harness/test.mjs';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { existsSync as have } from 'fs';
import { REAL_PLUGINS, loadShipPluginModule } from './_0514-fixtures.mjs';

const haveStore = have(join(REAL_PLUGINS, 'starship-ops', 'ship-state-store.mjs'));

/** A scratch state dir, pointed at by the plugin's own env var, cleaned up no matter what. */
async function withState(fn) {
  const prev = process.env.PRESENTER_PLUGIN_STATE_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'ap-0575-state-'));
  process.env.PRESENTER_PLUGIN_STATE_DIR = dir;
  try { return await fn(dir); }
  finally {
    if (prev === undefined) delete process.env.PRESENTER_PLUGIN_STATE_DIR;
    else process.env.PRESENTER_PLUGIN_STATE_DIR = prev;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/** A machine over the SHIPPED chart, restored from whatever `readShipState` says about `shipId`. */
async function bootFrom(shipId) {
  const [store, mod] = await Promise.all([
    loadShipPluginModule('ship-state-store.mjs'),
    loadShipPluginModule('ship-machine.mjs'),
  ]);
  const persisted = store.readShipState(shipId);
  const m = mod.createShipMachine(mod.loadChart(), { restore: persisted && persisted.regions });
  return { m, persisted, store, mod };
}

test('t0575-09c — a CORRUPT persisted state restores as `unknown`, never as a guess and never `normal`', async () => {
  if (!haveStore) { expect(false, 'ship-state-store.mjs is installed (run tools/install-system-plugins.sh)'); return; }
  await withState(async () => {
    const store = await loadShipPluginModule('ship-state-store.mjs');

    /* ── FIRST: prove the restore path is LIVE. Without this half, everything below passes for a
       build that simply never restores anything — a test that can no longer fail, which the brief
       names as worse than no test. */
    expect(store.writeShipState('hull-a', { alert: 'action', nav: 'in-system' }), 'a good state was written');
    const good = await bootFrom('hull-a');
    expect(good.m.state().alert === 'action', '⭐ a saved battle-stations DOES come back', JSON.stringify(good.m.state()));
    expect(good.m.restoredRegions().includes('alert'), 'and the machine says which regions it restored',
      JSON.stringify(good.m.restoredRegions()));

    /* ── THEN: break the same file and boot again. */
    const file = store.stateFileFor('hull-a');
    writeFileSync(file, '{"format":1,"shipId":"hull-a","regions":{"alert":"act', 'utf8');   // truncated
    const bad = await bootFrom('hull-a');
    expect(bad.persisted === null, 'the corrupt file reads as ABSENT, not as junk', JSON.stringify(bad.persisted));
    expect(bad.m.state().alert === 'unknown', '⛔ and the board says UNKNOWN', bad.m.state().alert);
    expect(bad.m.state().alert !== 'normal', '⛔⛔ it does NOT quietly claim GREEN', bad.m.state().alert);
    expect(bad.m.state().nav === 'docked', 'every other region falls back to its chart initial too', bad.m.state().nav);
    expect(bad.m.restoredRegions().length === 0, 'and NOTHING was reported as restored',
      JSON.stringify(bad.m.restoredRegions()));
  });
});

test('t0575-09c2 — every OTHER way a saved state can be wrong also reads as absent', async () => {
  if (!haveStore) { expect(false, 'ship-state-store.mjs is installed'); return; }
  await withState(async (dir) => {
    const store = await loadShipPluginModule('ship-state-store.mjs');
    mkdirSync(join(dir, 'starship-ops'), { recursive: true });
    const bad = {
      'a-scalar': '"just a string"',
      'an-array': '[1,2,3]',
      'no-format': JSON.stringify({ shipId: 'no-format', regions: { alert: 'action' } }),
      'wrong-format': JSON.stringify({ format: 999, shipId: 'wrong-format', regions: { alert: 'action' } }),
      'wrong-ship': JSON.stringify({ format: 1, shipId: 'somebody-else', regions: { alert: 'action' } }),
      'no-regions': JSON.stringify({ format: 1, shipId: 'no-regions' }),
      'regions-array': JSON.stringify({ format: 1, shipId: 'regions-array', regions: ['action'] }),
      'empty-regions': JSON.stringify({ format: 1, shipId: 'empty-regions', regions: {} }),
    };
    for (const [id, body] of Object.entries(bad)) {
      writeFileSync(store.stateFileFor(id), body, 'utf8');
      expect(store.readShipState(id) === null, `refused: ${id}`, JSON.stringify(store.readShipState(id)));
    }
    // Absent is the same answer, by the same route.
    expect(store.readShipState('never-existed') === null, 'a ship with no file at all reads as absent');

    /* ⛔ A saved state that names NO REAL STATE is ignored by the interpreter rather than adopted —
       the same discipline `resolveTarget` applies to an untrusted `$event.` target. */
    store.writeShipState('liar', { alert: '../../etc/passwd', nav: 'somewhere-else', power: 'combat' });
    const m = (await bootFrom('liar')).m;
    expect(m.state().alert === 'unknown', 'a bogus region value leaves that region at its initial', m.state().alert);
    expect(m.state().nav === 'docked', 'and so does another', m.state().nav);
    expect(m.state().power === 'combat', '⭐ while a VALID sibling in the SAME file still restores', m.state().power);
  });
});

test('t0575-09d — TWO SHIPS persist INDEPENDENTLY; restoring one never writes the other board', async () => {
  if (!haveStore) { expect(false, 'ship-state-store.mjs is installed'); return; }
  /* ⚠ AUDITOR AMENDMENT (HANDOFF §2): phase 9 runs BEFORE phase 5, so there is no second
     commissioned hull yet. The second hull is commissioned HERE, inside the test, at the layer
     this phase owns — one persisted record per shipId. ⛔ This is not a substitute for the real
     thing: this test is RE-RUN at the end of phase 5 against the real ships.json. */
  await withState(async () => {
    const store = await loadShipPluginModule('ship-state-store.mjs');

    expect(store.writeShipState('hull-a', { alert: 'action', power: 'combat' }), 'ship A saved at battle stations');
    expect(store.writeShipState('hull-b', { alert: 'normal', power: 'standard' }), 'ship B saved at green');

    expect(store.stateFileFor('hull-a') !== store.stateFileFor('hull-b'),
      '⭐ one FILE per ship — the independence is structural, not a convention',
      store.stateFileFor('hull-a'));

    const a = await bootFrom('hull-a');
    const b = await bootFrom('hull-b');
    expect(a.m.state().alert === 'action', 'A comes up at battle stations', a.m.state().alert);
    expect(b.m.state().alert === 'normal', 'B comes up green', b.m.state().alert);
    expect(a.m.state().power === 'combat' && b.m.state().power === 'standard',
      'and their other regions did not cross either', `${a.m.state().power} / ${b.m.state().power}`);

    // ⛔ THE CONVERSE, which is the one that would bite: writing A must not touch B's record.
    const bBefore = JSON.stringify(store.readShipState('hull-b').regions);
    store.writeShipState('hull-a', { alert: 'elevated', power: 'silent' });
    expect(JSON.stringify(store.readShipState('hull-b').regions) === bBefore,
      "⛔⛔ changing A left B's saved board BYTE-IDENTICAL", `${bBefore} vs ${JSON.stringify(store.readShipState('hull-b').regions)}`);
    expect((await bootFrom('hull-b')).m.state().alert === 'normal', 'and B still boots green', 'B moved');
  });
});

test('t0575-09e — the state dir is XDG state by default, NEVER the plugin directory or the checkout', async () => {
  if (!haveStore) { expect(false, 'ship-state-store.mjs is installed'); return; }
  const store = await loadShipPluginModule('ship-state-store.mjs');
  /* ⛔ Two mechanical reasons, either alone decisive: install-system-plugins.sh fails on an
     UNEXPECTED file in the destination, and it `rm -rf`s the destination before copying — so
     state written beside the chart would turn every install RED and then be deleted. */
  const d = store.defaultPluginStateDir({ env: { HOME: '/home/nobody' } });
  expect(d === '/home/nobody/.local/state/argus-presenter/plugin-state', 'the XDG-state default', d);
  const x = store.defaultPluginStateDir({ env: { XDG_STATE_HOME: '/somewhere/state', HOME: '/home/nobody' } });
  expect(x === '/somewhere/state/argus-presenter/plugin-state', 'and XDG_STATE_HOME wins', x);
  const resolved = store.stateDir({ env: { PRESENTER_PLUGIN_STATE_DIR: '/declared' } });
  expect(resolved === join('/declared', 'starship-ops'), 'the env var wins over both, and the plugin owns its subdir', resolved);
  expect(!resolved.includes(REAL_PLUGINS), 'and nothing resolves inside the installed plugin tree', resolved);
});

test('t0575-09f — a shipId cannot escape the state directory', async () => {
  if (!haveStore) { expect(false, 'ship-state-store.mjs is installed'); return; }
  await withState(async (dir) => {
    const store = await loadShipPluginModule('ship-state-store.mjs');
    /* A shipId is deployment-supplied text. Without sanitising, this function is a file-write
       primitive aimed anywhere on disk — and the deployment file is hand-edited. */
    for (const evil of ['../../escape', '/etc/passwd', '..', '.', 'a/b/c']) {
      const f = store.stateFileFor(evil);
      expect(f.startsWith(join(dir, 'starship-ops') + '/'), `stays inside the state dir: ${evil}`, f);
      /* ⚠ The check is on the RESOLVED path, not on whether `..` survives as text. Sanitising
         `../../escape` yields the perfectly legal filename `__.._escape.json`, and an assertion
         that no dot-dot appears anywhere in the string fails on a file that escapes nothing —
         a guard aimed at the spelling instead of at the behaviour. */
      expect(resolve(f) === f && dirname(f) === join(dir, 'starship-ops'),
        'and it is a leaf IN that directory, with no traversal segment', `${resolve(f)} | ${dirname(f)}`);
    }
    store.writeShipState('../../escape', { alert: 'action' });
    expect(!existsSync(join(dir, '..', '..', 'escape.json')), 'nothing was written outside the state dir');
  });
});

test('t0575-09g — a write failure is REPORTED, not swallowed, and never throws', async () => {
  if (!haveStore) { expect(false, 'ship-state-store.mjs is installed'); return; }
  await withState(async (dir) => {
    const store = await loadShipPluginModule('ship-state-store.mjs');
    // Make the state dir path un-creatable by planting a FILE where the directory must go.
    writeFileSync(join(dir, 'starship-ops'), 'not a directory', 'utf8');
    let threw = false, ok = null;
    try { ok = store.writeShipState('hull-a', { alert: 'action' }); } catch { threw = true; }
    expect(!threw, '⛔ a full or read-only disk must NOT take a live session down');
    expect(ok === false, 'and the failure is RETURNED so the caller can log it', String(ok));
    expect(store.readShipState('hull-a') === null, 'the honest consequence: the next boot reads absent ⇒ unknown');
  });
});
