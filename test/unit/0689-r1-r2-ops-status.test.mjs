/*
 * Plan 0689 R1 + R2 — THE OPS SURFACE, PROVED BY WRITING THE FORBIDDEN CASE.
 *
 * ⛔⛔ Two facts here have each lied once on a live box, so each is asserted in the FAILING
 * direction as well as the passing one — a guard you have only ever seen pass is untested:
 *
 *   1. THE SYMLINK IS NOT THE RUNNING CODE (the 0686 rollback failure). t04 drives a unit whose
 *      ExecMainStartTimestamp is EARLIER than the current release's builtAt and requires
 *      `staleUnit.stale:true` — the case where reading the symlink alone reports success.
 *   2. AN ANSWERING PORT IS NOT HEALTH (the 26-hour phantom presenters). t06 serves a 200 with an
 *      error body and requires the probe to call it NOT ok and to NAME the missing markers.
 *
 * ⭐ t07 pins the two markers to the REAL page rather than to a string this file invented: it
 * renders what the server actually serves and asserts both markers survive it. A marker check that
 * has only been run against a fixture proves the fixture, not the presenter.
 */
import { test, expect } from '../../harness/test.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createHttpServer } from 'node:http';
import {
  enumerateReleases, currentRelease, unitStatus, staleUnit, roomTable,
  probe, realPageMarkers, REAL_PAGE_MARKERS, srvRoot,
} from '../../lib/ops-status.mjs';
import { renderPresenterPage } from '../../app/server.mjs';
import { coreTools } from '../../mcp/tools.mjs';

const TOOL = Object.fromEntries(coreTools.map((t) => [t.name, t]));

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ap-0689-'));
  mkdirSync(join(root, 'releases'), { recursive: true });
  return root;
}
function release(root, name, layer) {
  const d = join(root, 'releases', name);
  mkdirSync(d, { recursive: true });
  if (layer !== null) writeFileSync(join(d, 'layer.json'), JSON.stringify(layer));
  return d;
}

test('0689 t01 — a release is identified by WHAT IT IS, and every rejection is NAMED', () => {
  const root = fixtureRoot();
  try {
    release(root, '2026-08-25T00-00-00Z', { sha: 'aaa', contentHash: 'h1', builtAt: '2026-08-25T00:00:00Z' });
    release(root, '2026-08-26T00-00-00Z', { sha: 'bbb', contentHash: 'h2', builtAt: '2026-08-26T00:00:00Z' });
    // ⛔⛔ THE ACTUAL 2026-08-26 OUTAGE: one stray directory made a name-matching enumerator
    //    count 0 of 11. Here it must cost nothing at all.
    release(root, 'PHANTOM-TEST-scratch', null);
    release(root, '.incoming-XXXXXX', { sha: 'ccc', contentHash: 'h3', builtAt: '2026-08-27T00:00:00Z' });
    release(root, 'half-written', { sha: 'ddd' });                       // no contentHash
    writeFileSync(join(root, 'releases', 'notes.txt'), 'hello');
    symlinkSync(join(root, 'releases', '2026-08-25T00-00-00Z'), join(root, 'releases', 'a-symlink'));

    const r = enumerateReleases({ root });
    expect(r.ok, 'the releases directory was readable');
    expect(r.releases.length === 2, 'exactly the two real releases are usable', r.releases.map((x) => x.name).join(','));
    expect(r.releases[0].name === '2026-08-25T00-00-00Z', 'OLDEST FIRST — sorted by the builtAt the release carries, not by its name');
    expect(r.releases[1].sha === 'bbb' && r.releases[1].contentHash === 'h2', 'the sha and contentHash come from layer.json');

    const rejected = Object.fromEntries(r.rejected.map((x) => [x.name, x.reason]));
    for (const n of ['PHANTOM-TEST-scratch', '.incoming-XXXXXX', 'half-written', 'notes.txt', 'a-symlink']) {
      expect(typeof rejected[n] === 'string' && rejected[n].length > 10,
        `"${n}" is rejected WITH A STATED REASON — "have 0" tells an operator nothing`, rejected[n]);
    }
    expect(/staging|in-progress|interrupted/i.test(rejected['.incoming-XXXXXX']),
      'a half-unpacked deploy is rejected AS ONE — it has a layer.json, so content alone would adopt it', rejected['.incoming-XXXXXX']);
    expect(/contentHash/i.test(rejected['half-written']), 'the missing field is named', rejected['half-written']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('0689 t02 — an unreadable builtAt is a metadata defect, not a broken release (and it SAYS mtime)', () => {
  const root = fixtureRoot();
  try {
    const d = release(root, 'no-builtat', { sha: 'aaa', contentHash: 'h1' });
    utimesSync(d, new Date(1e9), new Date(1e9));
    const r = enumerateReleases({ root });
    expect(r.releases.length === 1, 'still usable — refusing a real release over a missing metadata field is the same outage in a different costume');
    expect(r.releases[0].keySource === 'mtime', 'the fallback ordering key is STATED, never assumed silently', r.releases[0].keySource);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('0689 t03 — "cannot read the releases directory" is NOT the same fact as "zero releases"', () => {
  const empty = fixtureRoot();
  try {
    const gone = enumerateReleases({ root: join(empty, 'nowhere') });
    expect(gone.ok === false && typeof gone.error === 'string', 'an absent releases dir is ok:false WITH an error');
    const none = enumerateReleases({ root: empty });
    expect(none.ok === true && none.releases.length === 0 && none.error === null, 'an EMPTY releases dir is ok:true with zero rows — a different fact, reported differently');
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('0689 t04 — ⛔⛔ THE SYMLINK LIED: a unit started BEFORE the current release is reported stale', () => {
  const root = fixtureRoot();
  try {
    const d = release(root, 'newest', { sha: 'bbb', contentHash: 'h2', builtAt: '2026-08-26T06:00:00Z' });
    symlinkSync(d, join(root, 'current'));
    const cur = currentRelease({ root });
    expect(cur.exists && cur.sha === 'bbb', 'current resolves and reports the tree it points at', cur.error);

    // THE FORBIDDEN CASE — the unit never restarted onto the release the symlink names.
    const stale = staleUnit(cur, { execMainStartTimestamp: 'Tue 2026-08-26 05:00:00 UTC' });
    expect(stale.stale === true, 'a start timestamp EARLIER than builtAt is reported stale — this is the whole reason the pid and timestamp are reported at all', JSON.stringify(stale));
    expect(/symlink/i.test(stale.reason), 'the reason names the shape rather than only the numbers', stale.reason);

    // and the passing direction, so the guard is not vacuously true
    const fresh = staleUnit(cur, { execMainStartTimestamp: 'Tue 2026-08-26 07:00:00 UTC' });
    expect(fresh.stale === false, 'a restart AFTER the build is not stale', JSON.stringify(fresh));
    expect(staleUnit(cur, {}).stale === null, 'an uncomparable pair is null — never a confident false');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('0689 t05 — unitStatus reports MainPID and ExecMainStartTimestamp, and 0 is not a pid', async () => {
  const fake = async () => ({ ok: true, code: 0, stderr: '', error: null, stdout:
    'LoadState=loaded\nMainPID=4242\nExecMainStartTimestamp=Tue 2026-08-26 07:00:00 UTC\nExecMainStartTimestampMonotonic=1\nActiveState=active\nSubState=running\nNRestarts=3\nFragmentPath=/etc/systemd/system/x.service\n' });
  const u = await unitStatus('x.service', { exec: fake });
  expect(u.present && u.mainPID === 4242, 'the PID is reported', JSON.stringify(u));
  expect(u.execMainStartTimestamp === 'Tue 2026-08-26 07:00:00 UTC', 'the START TIMESTAMP is reported — the symlink alone cannot say whether the unit restarted');
  expect(u.activeState === 'active' && u.subState === 'running' && u.nRestarts === 3, 'state and restart count ride along');

  const stopped = await unitStatus('x.service', { exec: async () => ({ ok: true, code: 0, stderr: '', error: null, stdout: 'LoadState=loaded\nMainPID=0\nActiveState=inactive\nSubState=dead\n' }) });
  expect(stopped.mainPID === null, 'systemd reports a stopped unit as MainPID=0 — reported as null, because 0 read as a pid is a running process that is not there');

  const missing = await unitStatus('nope.service', { exec: async () => ({ ok: false, code: 1, stderr: '', error: null, stdout: 'LoadState=not-found\nMainPID=0\nActiveState=inactive\nSubState=dead\n' }) });
  expect(missing.present === false && missing.loadState === 'not-found',
    '⛔ "there is no such unit" and "the presenter is stopped" both answer inactive/dead — LoadState is what separates them');
});

test('0689 t06 — ⛔⛔ AN ANSWERING PORT IS NOT HEALTH: a 200 with no stage is NOT ok, and says what is missing', async () => {
  const srv = createHttpServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Argus Presenter</title><h1>Service Unavailable</h1>'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const p = await probe(`http://127.0.0.1:${srv.address().port}/`, { timeoutMs: 4000 });
    expect(p.status === 200, 'the phantom answers 200 — which is exactly why 200 is not the test', p.status);
    expect(p.ok === false && p.realPage === false, 'a 200 that is not a real page is NOT healthy — the 26-hour phantom shape');
    expect(p.missing.length === 2, 'both missing markers are NAMED, so an operator knows what was looked for', p.missing.join(','));
  } finally { srv.close(); }
});

test('0689 t07 — the two markers are pinned to the REAL page the server serves, not to a fixture', async () => {
  // ⭐ Both markers must survive the voice-strip transform, so BOTH renderings are checked.
  for (const voice of [true, false]) {
    const marks = realPageMarkers(renderPresenterPage(voice));
    expect(marks.realPage, `the served presenter page carries every marker (voice=${voice}) — if this fails the MARKERS are wrong, not the page`, marks.missing.join(','));
  }
  expect(REAL_PAGE_MARKERS.length === 2, 'exactly the two structural markers pipeline/smoke.sh asserts');

  const srv = createHttpServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(renderPresenterPage(false)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const p = await probe(`http://127.0.0.1:${srv.address().port}/`, { timeoutMs: 4000 });
    expect(p.ok && p.realPage && p.missing.length === 0, 'a real page probes healthy — the guard is not vacuously red', JSON.stringify(p));
  } finally { srv.close(); }
});

test('0689 t08 — a port that answers nothing is an error, not a silent false', async () => {
  const srv = createHttpServer(() => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  srv.close();
  await new Promise((r) => setTimeout(r, 50));
  const p = await probe(`http://127.0.0.1:${port}/`, { timeoutMs: 2000 });
  expect(p.ok === false && typeof p.error === 'string' && p.error.length > 0, 'the refusal is NAMED', JSON.stringify(p));
});

test('0689 t09 — the room table comes from the deployment config the ENGINE reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0689-cfg-'));
  const prev = process.env.PRESENTER_CONFIG_FILE;
  try {
    const cfg = join(dir, 'presenter-config.json');
    writeFileSync(cfg, JSON.stringify({ presenterPort: 3000, rooms: { alpha: { port: 3000, voice: true }, beta: { port: 3001 } } }));
    process.env.PRESENTER_CONFIG_FILE = cfg;
    const t = roomTable();
    expect(t.legacy === false && t.rooms.length === 2, 'both declared rooms are enumerated', JSON.stringify(t.rooms));
    const byName = Object.fromEntries(t.rooms.map((r) => [r.name, r]));
    expect(byName.beta.port === 3001, 'each room carries its own port');
    expect(byName.beta.unit === 'argus-presenter@beta.service', 'a room name becomes a systemd INSTANCE name');

    // ⛔ NO rooms{} BLOCK IS NOT AN ERROR — it is the single legacy room.
    writeFileSync(cfg, JSON.stringify({ presenterPort: 3000 }));
    const legacy = roomTable();
    expect(legacy.legacy === true && legacy.rooms.length === 1 && legacy.rooms[0].unit === 'argus-presenter.service',
      'no rooms block ⇒ exactly one legacy row, which is what the pipeline did before rooms existed', JSON.stringify(legacy.rooms));
  } finally {
    if (prev === undefined) delete process.env.PRESENTER_CONFIG_FILE; else process.env.PRESENTER_CONFIG_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('0689 t10 — presenter_health_deep REFUSES on an unreadable room map (probing nothing is not a pass)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0689-bad-'));
  const prev = process.env.PRESENTER_CONFIG_FILE;
  try {
    const cfg = join(dir, 'presenter-config.json');
    writeFileSync(cfg, '{ not json');
    process.env.PRESENTER_CONFIG_FILE = cfg;
    const r = await TOOL.presenter_health_deep.handler({ timeoutMs: 500, skipTailnet: true });
    expect(r.verdict === 'refused' && typeof r.error === 'string', 'a room map we cannot read is a REFUSAL, never an empty loop reporting success', JSON.stringify(r));
  } finally {
    if (prev === undefined) delete process.env.PRESENTER_CONFIG_FILE; else process.env.PRESENTER_CONFIG_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('0689 t11 — an unchecked tailnet can never be green', async () => {
  const srv = createHttpServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(renderPresenterPage(false)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const dir = mkdtempSync(join(tmpdir(), 'ap-0689-tn-'));
  const prev = process.env.PRESENTER_CONFIG_FILE;
  try {
    const cfg = join(dir, 'presenter-config.json');
    writeFileSync(cfg, JSON.stringify({ presenterPort: port }));
    process.env.PRESENTER_CONFIG_FILE = cfg;
    const r = await TOOL.presenter_health_deep.handler({ timeoutMs: 4000, skipTailnet: true });
    expect(r.rooms[0].probes.loopback.ok === true, 'the room is genuinely serving a real page on loopback', JSON.stringify(r.rooms[0].probes.loopback));
    expect(r.verdict === 'partial', '⚠ an UNCHECKABLE tailnet is not a PASSED tailnet — the verdict downgrades, it never goes green', r.verdict);
    expect(/cannot be green/i.test(r.note), 'and the note says so out loud', r.note);
  } finally {
    if (prev === undefined) delete process.env.PRESENTER_CONFIG_FILE; else process.env.PRESENTER_CONFIG_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
    srv.close();
  }
});

test('0689 t12 — presenter_release_status refuses rollback-ready WITH a reason, and needs no running presenter', async () => {
  const root = fixtureRoot();
  try {
    release(root, 'only-one', { sha: 'aaa', contentHash: 'h1', builtAt: '2026-08-26T00:00:00Z' });
    // ⛔ NO presenter_start anywhere in this test — the moment you need this tool is the moment
    //    the presenter is down, so it must not be gated on one running.
    const r = await TOOL.presenter_release_status.handler({ root, unit: 'nothing-here.service' });
    expect(r.rollbackReady === false, 'one release is not two');
    expect(/only 1 usable release/i.test(r.rollbackReadyReason), 'the refusal STATES why — "could not" and "did" must never look alike', r.rollbackReadyReason);
    expect(r.releases.count === 1 && r.units.length === 1, 'it still reported the release and the unit it was asked about');
    expect(Object.prototype.hasOwnProperty.call(r.units[0], 'mainPID') && Object.prototype.hasOwnProperty.call(r.units[0], 'execMainStartTimestamp'),
      '⛔ the PID AND the start timestamp are always in the shape, not just the symlink');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('0689 t13 — the deployment root is $ARGUS_SRV_ROOT, else /srv/argus', () => {
  expect(srvRoot({}) === '/srv/argus', 'the default matches what the pipeline scripts read');
  expect(srvRoot({ ARGUS_SRV_ROOT: '/tmp/elsewhere' }) === '/tmp/elsewhere', 'the env override wins');
});
