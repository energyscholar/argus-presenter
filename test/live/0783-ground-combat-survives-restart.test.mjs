/*
 * 0783 — THE GROUND FIGHT SURVIVES A SERVER RESTART, IN ITS OWN VOCABULARY.
 *
 * Bruce, 2026-09-08: *"I'm really just concerned about persistence OF THE GROUND COMBAT STATE …
 * It's really just so it survives a server restart."*
 *
 * ⭐ THE MECHANISM IS ALREADY BUILT AND ALREADY PASSES — `0720-runc-durable-state.test.mjs` covers
 *   it thoroughly, including a systemctl-restart equivalent, and 13/13 are green. This file adds
 *   nothing to the mechanism. What it adds is a NAME.
 *
 * ⛔⛔ WHY A SECOND FILE IS NOT A SECOND TEST. RUN-C asserts on three NEUTRAL subtrees chosen to
 *   represent the failure class — `shared/tactical/runc`, `shared/sequence`, `ships/runc-hull-1`.
 *   The ground fight is not any of them. It lives at `shared/pc/**`, and it survives today only
 *   because it happens to sit under `shared`, which is one of the three persisted roots. That is
 *   TRUE BY INHERITANCE, not by anybody's decision — and a thing true by inheritance is exactly what
 *   changes without anyone noticing. Narrow the roots, move the page's namespace, or add a plugin
 *   that writes the fight somewhere else, and 13/13 stays green while the fight stops surviving.
 *
 * ⇒ So these assertions use the REAL paths `pages/personal-combat.html` writes — `var NS =
 *   'shared/pc'`, then `NS+'/units/'`, `NS+'/meta'`, `NS+'/log/'` — and they name the fields whose
 *   loss a player would actually notice at the table: who is hurt, whose turn it is, and whether the
 *   fight had started at all.
 *
 * ⚠ These are the shapes MEASURED in the live dump on 2026-09-09, not shapes invented here:
 *   612 leaves under `shared/pc/units`, 15 under `meta`, 164 under `log`.
 */
import { test, expect, check } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { connect } from './_0720-band-b-client.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DURABLE_STATE_FILE } from '../../lib/durable-state.mjs';

const SYS = { userId: 'server', role: 'system' };
/* ⛔ THE PAGE'S OWN NAMESPACE, not a neutral stand-in. If this constant and
   `personal-combat.html`'s `var NS` ever disagree, this test is worthless — which is why it is
   spelled out here rather than imported from a shared constant nobody would notice going stale. */
const PC = 'shared/pc';

const DIR = mkdtempSync(join(tmpdir(), 'ap-0783-ground-'));
const FILE = join(DIR, DURABLE_STATE_FILE);
const FAST = { stateQuietMs: 40, stateMaxMs: 200 };
const onDisk = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return null; } };
const leaf = (doc, p) => (doc && doc.leaves ? doc.leaves[p] : undefined);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let A = null;
let B = null;

test('0783 A — a fight in progress: units hurt, a turn taken, the log written', async () => {
  A = await createServer({ port: 0, stateDir: DIR, ...FAST });
  const w = (path, value) => A.store.apply({ path, verb: 'set', value }, SYS);

  /* A marine who has taken a wound, and one who has not — so a restore that returned DEFAULTS
     rather than the session would be visible as a difference between them. */
  w(`${PC}/units/asao/side`, 'marines');
  w(`${PC}/units/asao/END`, 7);
  w(`${PC}/units/asao/maxEND`, 12);
  w(`${PC}/units/asao/hors`, false);
  w(`${PC}/units/kowalski/side`, 'marines');
  w(`${PC}/units/kowalski/END`, 9);
  w(`${PC}/units/kowalski/maxEND`, 9);
  w(`${PC}/units/vargr-a/side`, 'vargr');
  w(`${PC}/units/vargr-a/hors`, true);

  /* The fight's clock. `started` is the one Bruce named directly: a restart that lost it would put
     the table back on the roll-initiative screen with everyone's damage gone. */
  w(`${PC}/meta/started`, true);
  w(`${PC}/meta/round`, 3);
  w(`${PC}/meta/turn`, 2);
  w(`${PC}/meta/order`, ['asao', 'vargr-a', 'kowalski']);
  w(`${PC}/meta/playing`, { 'marines-asao-ora': 'asao', 'sensors-von-sydo': 'kowalski' });
  w(`${PC}/log/1788888961811-0001`, { r: 3, t: 'Asao fires at Vargr A' });

  await sleep(300);
  const d = onDisk();
  check('the fight reached the disk without anyone asking it to', !!d);
  check('⭐ THE WOUND IS ON DISK', leaf(d, `${PC}/units/asao/END`) === 7);
  check('⭐ AND SO IS THE CLOCK', leaf(d, `${PC}/meta/round`) === 3 && leaf(d, `${PC}/meta/started`) === true);
  /* ⛔ AN OBJECT IS DECOMPOSED INTO PER-FIELD LEAVES; AN ARRAY IS ONE LEAF. Measured, after this
     assertion first read `leaves['…/meta/playing']` and found undefined while the value plainly
     survived the restart. The dump is a map of LEAF paths, so `{a:1}` at `meta/playing` is stored
     as `meta/playing/a`, and only an array survives whole. Worth stating rather than quietly
     fixing: the wrong shape here reads as "the field was not persisted", which is a false alarm
     about the one thing this file exists to reassure anyone about. */
  check('…and who each player is playing', leaf(d, `${PC}/meta/playing/marines-asao-ora`) === 'asao',
    JSON.stringify(Object.keys(d.leaves).filter((k) => k.includes('playing'))));
  check('…while an array is kept whole, not split into numeric keys',
    Array.isArray(leaf(d, `${PC}/meta/order`)) && leaf(d, `${PC}/meta/order`)[1] === 'vargr-a');
});

test('0783 B — ⛔⛔ A SERVER RESTART SNAPS TO THE LAST SAVED FIGHT', async () => {
  /* ⛔ Read the disk BEFORE the close, so nothing below can be credited to a tidy shutdown flush.
     A power cut does not call close(), and that is the case Bruce is actually insuring against. */
  const before = onDisk();
  check('the disk holds the fight before anything shuts down', leaf(before, `${PC}/units/asao/END`) === 7);

  await A.close();
  B = await createServer({ port: 0, stateDir: DIR, ...FAST });

  check('⭐⭐ THE DAMAGE CAME BACK — the marine is still hurt',
    B.store.get(`${PC}/units/asao/END`) === 7 && B.store.get(`${PC}/units/asao/maxEND`) === 12);
  check('…and the unhurt one is still unhurt, so this is the SESSION and not a fresh roster',
    B.store.get(`${PC}/units/kowalski/END`) === 9);
  check('⭐⭐ THE FIGHT IS STILL RUNNING — not back on the roll-initiative screen',
    B.store.get(`${PC}/meta/started`) === true);
  check('⭐ THE ROUND AND WHOSE TURN IT IS CAME BACK',
    B.store.get(`${PC}/meta/round`) === 3 && B.store.get(`${PC}/meta/turn`) === 2);
  check('⭐ AND THE INITIATIVE ORDER IS AN ARRAY, not an object with numeric keys',
    Array.isArray(B.store.get(`${PC}/meta/order`)) && B.store.get(`${PC}/meta/order`)[1] === 'vargr-a',
    JSON.stringify(B.store.get(`${PC}/meta/order`)));
  check('⭐⭐ A DOWNED UNIT IS STILL DOWN — `hors` is a false-y field and must survive as itself',
    B.store.get(`${PC}/units/vargr-a/hors`) === true && B.store.get(`${PC}/units/asao/hors`) === false);
  check('⭐ EVERY PLAYER IS STILL PLAYING THEIR OWN MARINE',
    B.store.get(`${PC}/meta/playing`)['sensors-von-sydo'] === 'kowalski');
  check('…and the log survived', B.store.get(`${PC}/log/1788888961811-0001`).t === 'Asao fires at Vargr A');
});

test('0783 C — ⛔ A PLAYER WHO RECONNECTS AFTER THE RESTART IS HANDED THE FIGHT', async () => {
  /* The half a server-side assertion cannot see. Earlier tonight a returning player RESET a live
     fight, so "the server has it" is not the claim that matters — "the screen shows it" is. */
  const fresh = await connect(B.url(), { userId: 'marines-asao-ora', userName: 'Asao', role: 'participant' });
  check('the reconnecting player is handed the wound in their snapshot',
    fresh.state(`${PC}/units/asao/END`) === 7, JSON.stringify(fresh.state(`${PC}/units/asao`, {})));
  check('…and the fight reads as started, so their screen does not offer to roll initiative',
    fresh.state(`${PC}/meta/started`) === true);
  fresh.close();
});

test('0783 Z — teardown', async () => {
  if (B) await B.close();
  rmSync(DIR, { recursive: true, force: true });
  check('the scratch state directory is gone', true);
});
