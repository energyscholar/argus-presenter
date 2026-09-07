/*
 * test/unit/0751-occupant.test.mjs — Plan 0751 (E15d): a SCRIPTED occupant sits at a station and
 * plays through the ordinary participant wire.
 *
 * ⛔ DOMAIN-FREE (this repo is PUBLIC, R-180). Uses `_0514-fixtures.mjs`'s own generic namespace
 * and station codes (`alpha`/`beta`) — never `shared/combat`/`pilot`/`gunner` inside `ap/`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../app/server.mjs';
import { makePluginsDir, stationManifest, withPlugins, wait } from './_0514-fixtures.mjs';
import { connectOccupant, runScript } from '../../lib/occupant.mjs';

const NS = 'shared/demo';
const SCRIPT = { 'default/beta': { text: 'ok', fields: {}, delayMs: 20 } };
const SYS = { userId: 'harness', role: 'system' };

test('t0751-occ-01 — connects with a station identity, gets a snapshot with no gm slice', async () => {
  const dir = makePluginsDir({ fixture: { 'plugin.json': stationManifest() } });
  await withPlugins(dir, async () => {
    const server = await createServer({ port: 0 });
    try {
      const occ = await connectOccupant(server.url(), { stationUID: 2, userName: 'Scripted' });
      assert.equal(occ.role, 'participant', 'the ordinary participant role — no engine privilege');
      assert.ok(occ.userId && occ.userId.startsWith('beta-'), `a station identity, server-derived: ${occ.userId}`);
      assert.ok(!('gm' in occ._state), 'the snapshot carries no gm slice at all');
      occ.close();
    } finally { await server.close(); }
  });
});

test('t0751-occ-02 — its choices come from a declared script table and answer the open ask', async () => {
  const dir = makePluginsDir({ fixture: { 'plugin.json': stationManifest() } });
  await withPlugins(dir, async () => {
    const server = await createServer({ port: 0 });
    try {
      const occ = await connectOccupant(server.url(), { stationUID: 2, userName: 'Scripted' });
      const stop = runScript(occ, { ns: NS, station: 'beta', script: SCRIPT });
      try {
        // ⚠ `server.apply`, NOT `server.store.apply` — found while iterating this test.
        // `store.apply` is the RAW reducer (app/api-surface.mjs's own comment: "writes silently —
        // no diff is broadcast, so no connected client ever hears"). `server.apply` is the
        // broadcasting wrapper (`serverApply` internally) exposed on the api surface exactly so a
        // caller can move shared state AND have every connected client's cache updated the way a
        // real op would. Using `store.apply` here left `askOpen` sitting in the store, visible to
        // `server.store.get`, but NEVER delivered to the occupant's own `_state` cache — so
        // `runScript`'s poll (which reads `occupant.state(...)`, not the server) never saw it.
        server.apply({ path: `${NS}/phase`, verb: 'set', value: 'default' }, SYS);
        server.apply({ path: `${NS}/askOpen`, verb: 'set', value: 'beta' }, SYS);
        // ⚠ 150ms, not 80: runScript's default intervalMs is 100 and the row's own delayMs is 20,
        // so the worst case (askOpen lands just after a poll tick) is ~120ms before the write is
        // sent. A shorter wait here is a genuine timing bug (found while iterating this test) —
        // it does not flake occasionally, it MISSES EVERY TIME, because the interval has not
        // ticked once yet. See report.
        await wait(150);
        const v = server.store.get(`${NS}/declare/beta`);
        assert.ok(v && v.text === 'ok' && v.npc === true, `answered from its script table: ${JSON.stringify(v)}`);
      } finally {
        // stop() clears runScript's setInterval — this MUST run even when the assertion above
        // throws, or a failing run leaves a live, non-unref'd timer and node --test hangs forever
        // instead of reporting the failure (measured: it hung past a 120s wall-clock timeout).
        stop(); occ.close();
      }
    } finally { await server.close(); }
  });
});

test('t0751-occ-03 — disconnected mid-round, its declaration stands', async () => {
  const dir = makePluginsDir({ fixture: { 'plugin.json': stationManifest() } });
  await withPlugins(dir, async () => {
    const server = await createServer({ port: 0 });
    try {
      const occ = await connectOccupant(server.url(), { stationUID: 2, userName: 'Scripted' });
      occ.op(`${NS}/declare/beta`, 'set', { text: 'holding position', npc: true, at: Date.now() });
      await wait(80);
      occ.close();
      await wait(80);
      const v = server.store.get(`${NS}/declare/beta`);
      assert.equal(v && v.text, 'holding position', 'the declaration stands after the occupant disconnects');
    } finally { await server.close(); }
  });
});
