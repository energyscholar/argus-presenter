/*
 * Plan 0525 P3 — t78: THE RIG RUNS WHERE THE PRIVATE CONTENT DOES NOT.
 *
 * The session rig is this repo's only instrument that exercises a WHOLE session in real browsers —
 * seat by seat link, load, stage, GO, address one post, address the room, address an empty post,
 * press the arrow, open a door, project, reload, close. Its other spec drives a real deployment's
 * content, and `modules/*.json` and `plugins/<name>/` are BOTH gitignored, so that spec skips in a
 * clean clone, in every scratch worktree a revert check uses, and in CI. The instrument existed and
 * could not be pointed at anything, anywhere but one working tree.
 *
 * This test runs the SAME walk on committed content, and asserts two things that are one thing:
 *
 *   (a) the walk completed, scene by scene — a rig that runs but proves nothing is a demo;
 *   (b) NOTHING IT TOUCHED IS GITIGNORED, established STRUCTURALLY. `git check-ignore` and
 *       `git ls-files` are asked about every source, and the paths the RUN actually resolved are
 *       asserted to live under test/. ⚠ This matters more than it looks: a test that merely passed
 *       today would also pass if somebody later re-pointed the fixture at private content, and the
 *       skip would come back silently. The structural half is what makes that impossible.
 *
 * And (c): plan 0525 P1's on-demand marker holds here, so it has a home that survives a clean
 * checkout. The fixture deck carries a RUN OF TWO consecutive marked beats on purpose — the case a
 * navigation "fix" would get wrong in a way one marked beat would hide.
 *
 * ⛔ NAVIGATION IS UNCHANGED AND MUST STAY THAT WAY (R5). The arrow pressed on `b-before-door`
 * lands on `b-door-outer`, which is marked, AND SHIPS IT. That is the DESIGNED behaviour: the
 * marker is a note to whoever is presenting — *prepared, but not on the path; show it iff they ask*
 * — and not a rule the product enforces. It is asserted below as a `true` most readers would call a
 * bug, which is exactly why it is asserted.
 *
 * ⚠ ONE SESSION. Every assertion reads one recorded report; the rig observes and this file fails.
 * ⚠ Visibility is `checkVisibility()`, never a rect. ⚠ Every wait inside the rig is until()+evaluate,
 * never page.waitForFunction — Chrome pauses rAF in a backgrounded tab and four of five pages
 * always are. ⚠ Every browser call in the rig is bounded; an unbounded one loses the whole report.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, check as expect } from '../../harness/test.mjs';
import { toolMap } from '../../mcp/tools.mjs';
import SPEC, { SOURCES, MODULE_DIR, MODULE_ID, STATION_WORD } from './0525-fixture-spec.mjs';
// 0531 P2: the session itself moved to a shared, memoised helper — a second test file now asserts
// over the SAME walk, and booting five browsers twice would cost a minute and prove nothing extra.
import { fixtureRun } from './_0531-fixture-run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MARKED = ['b-door-outer', 'b-door-inner'];   // the run of two, in beats order

const session = fixtureRun;

/** true iff `p` is inside `base` — the "is this path where it claims to be" primitive. */
const inside = (base, p) => { const r = relative(base, p); return !!r && !r.startsWith('..') && !isAbsolute(r); };

/** git, run at the repo root, answering with its EXIT CODE. Never throws. */
function git(args) {
  try { execFileSync('git', args, { cwd: ROOT, stdio: 'pipe' }); return 0; }
  catch (e) { return typeof e.status === 'number' ? e.status : -1; }
}
const isTracked = (p) => git(['ls-files', '--error-unmatch', p]) === 0;
const isIgnored = (p) => git(['check-ignore', '-q', p]) === 0;    // 0 = ignored, 1 = not ignored

test('0525 t78 — the whole session walk runs on COMMITTED content, and the on-demand marker holds on it', async () => {
  // ── (b) FIRST, AND STRUCTURALLY: nothing this spec depends on is gitignored ────────────────
  expect('git is answering here at all (0 and 1 are both real answers; -1 is not)',
    git(['rev-parse', '--git-dir']) === 0, 'no git in this checkout — the structural half cannot be proved');

  for (const src of SOURCES) {
    expect(`${relative(ROOT, src)} exists`, existsSync(src), src);
    expect(`${relative(ROOT, src)} is TRACKED — not merely present in somebody's working tree`, isTracked(src), src);
    expect(`${relative(ROOT, src)} is NOT gitignored`, !isIgnored(src), src);
    expect(`${relative(ROOT, src)} lives under test/ — the one tree that is neither modules/ nor plugins/`,
      inside(join(ROOT, 'test'), src), src);
  }
  // The counterpoint, so the four checks above are known to be capable of failing:
  expect('…and the check is not vacuous — the repo\'s own modules/ IS ignored',
    isIgnored(join(ROOT, 'modules', 'placeholder.json')), 'modules/*.json should be ignored');

  expect('the spec sources its module from test/, not from the gitignored modules/',
    inside(join(ROOT, 'test'), MODULE_DIR) && !inside(join(ROOT, 'modules'), MODULE_DIR), MODULE_DIR);

  // ── (a) THE WALK ──────────────────────────────────────────────────────────────────────────
  const r = await session();
  expect('the session completed end to end', r.ok === true, r.error || '');

  // What the RUN actually resolved — not what the spec says it would. A spec re-pointed at private
  // content later would still pass every assertion above; it would fail these.
  expect('the module the rig actually READ is under test/', inside(join(ROOT, 'test'), r.module.src), r.module.src);
  expect('…and it is the committed fixture file itself', r.module.src === join(MODULE_DIR, `${MODULE_ID}.json`), r.module.src);
  expect('the plugin tree the run served is NOT the repo\'s gitignored plugins/',
    !inside(join(ROOT, 'plugins'), r.pluginsDir) && r.pluginsDir !== join(ROOT, 'plugins'), r.pluginsDir);
  expect('⛔ and the committed module is byte-identical to how the rig found it',
    r.module.untouched === true, `${r.module.sourceSha} → ${r.module.sourceShaAfter}`);

  const scene = (n) => r.scenes.find((s) => s.name === n);
  const boot = scene('boot');
  // Proof the FIXTURE registry was in force, not the installed one: a different deployment's
  // stations would give a different count and a different word for them.
  expect('the six fixture posts are the registry the session ran on', boot.stations === 6, String(boot.stations));
  expect(`and the deployment's own word for a post is "${STATION_WORD}"`, boot.stationWord === STATION_WORD, String(boot.stationWord));

  const seated = scene('seated');
  expect('five identities — the control page and four displays', seated.presence === 5, String(seated.presence));
  expect('one person, one roster row', seated.rosterRows === 5, String(seated.rosterRows));
  expect('every display is seated where its link asked',
    SPEC.seats.every((s) => seated.seats.some((x) => x.stationUid === s.stationUid)), JSON.stringify(seated.seats));

  const loaded = scene('module-loaded');
  expect('the committed deck loaded: 16 beats', loaded.beats === 16, String(loaded.beats));
  expect('5 sections', loaded.sections === 5, String(loaded.sections));
  expect('the panel reports it VALID', /valid/i.test(loaded.valid), loaded.valid);
  expect('and the outline rendered every beat as a row', loaded.outlineRows === 16, String(loaded.outlineRows));

  expect('the default beat cascaded to every display at LOAD, before anything was sent (P3.3)',
    r.findings.defaultBeatCascade.defaultBeatId === 'b-title' && r.findings.defaultBeatCascade.allPresent === true
    && r.findings.defaultBeatCascade.lensBeforeAnySend == null,
    JSON.stringify(r.findings.defaultBeatCascade));

  expect('⛔ staging shipped NOTHING — not one of the four displays moved',
    r.findings.stagingLeak.length === 0, JSON.stringify(r.findings.stagingLeak));
  const go = scene('go');
  expect('GO shipped the staged beat to all five', go.lastSent && go.lastSent.beatId === 'b-staged' && go.lastSent.recipients === 5, JSON.stringify(go.lastSent));
  expect('a per-post send reached EXACTLY ONE display',
    JSON.stringify(r.findings.perSeatMoved) === JSON.stringify([SPEC.seats[0].userId]), JSON.stringify(r.findings.perSeatMoved));
  expect('sending to the EMPTY post is loud: the receipt says zero recipients, in words',
    /0 RECIPIENTS/i.test(r.findings.emptyStation.receipt), r.findings.emptyStation.receipt);
  expect('…the server agrees nobody received it, and no display moved',
    r.findings.emptyStation.lastSent.recipients === 0 && r.findings.emptyStation.moved.length === 0,
    JSON.stringify(r.findings.emptyStation));
  expect('a reload did not double-count the roster',
    r.findings.reload.rosterBefore === 5 && r.findings.reload.rosterAfter === 5 && r.findings.reload.presenceAfter === 5,
    JSON.stringify(r.findings.reload));
  expect('every scene of the walk was reached', r.scenes.length === 13, String(r.scenes.length));
  expect('and the run captured a screenshot of every surface at every scene', r.shots.length >= 50, String(r.shots.length));

  // ── (c) P1'S MARKER, ON CONTENT THAT SURVIVES A CLEAN CHECKOUT ────────────────────────────
  const om = r.findings.outlineMarkers;
  expect('checkVisibility() is available (a rect would not be proof)', om.hasApi === true, JSON.stringify(om.hasApi));
  const authored = om.rows.filter((x) => x.authored).map((x) => x.id);
  expect('the deck marks exactly two beats on demand — a RUN OF TWO, consecutive',
    JSON.stringify(authored) === JSON.stringify(MARKED), JSON.stringify(authored));
  const badged = om.rows.filter((x) => x.badge);
  expect('the GM outline badges exactly those two rows',
    JSON.stringify(badged.map((x) => x.id)) === JSON.stringify(MARKED), JSON.stringify(om.rows.map((x) => [x.id, x.badge])));
  expect('both badges are VISIBLE, per checkVisibility()', badged.every((x) => x.badgeVisible === true), JSON.stringify(badged));
  expect('and each says what it means in words a presenter can scan', badged.every((x) => /on demand/i.test(x.badgeText || '')), JSON.stringify(badged.map((x) => x.badgeText)));
  expect('NO other row is badged — the marker distinguishes, or it says nothing',
    om.rows.filter((x) => !x.authored).every((x) => x.badge === false && x.badgeVisible === null),
    JSON.stringify(om.rows.filter((x) => !x.authored && x.badge)));

  /*
   * ⛔ THE `true` THAT LOOKS LIKE A BUG, AND IS NOT (R5). Pressing → on the beat before the run
   * walks straight onto the FIRST marked beat and publishes it. That is correct and must stay
   * correct: `onDemand` informs the presenter, it does not gate the software. Plan 0525 P1 was
   * drafted twice as a navigation skip, from correct evidence both times. If you are here to
   * "fix" this, read R5 first — and note that the beat is still reachable by an ordinary click,
   * which is the only thing on demand can mean.
   */
  expect('the arrow SHIPPED immediately — a row stages, an arrow publishes', r.findings.arrow.shipped === true, JSON.stringify(r.findings.arrow));
  expect('…and it landed ON the first marked beat, by design under R5, not skipping it',
    r.findings.arrow.landed.id === MARKED[0] && r.findings.arrow.linearWalkIncludesOnDemand === true,
    JSON.stringify(r.findings.arrow));
  expect('the second of the run opened on an EXPLICIT CLICK and reached the room',
    r.findings.onDemandReachable.beatId === MARKED[1] && r.findings.onDemandReachable.sent.lastSent.recipients === 5,
    JSON.stringify(r.findings.onDemandReachable));

  // ── (c2) THE CUE SHEET — the surface an AI presenter reads, on the SAME committed deck ─────
  const deck = JSON.parse(readFileSync(join(MODULE_DIR, `${MODULE_ID}.json`), 'utf8'));
  const T = toolMap();
  await T.presenter_start.handler({ port: 0, tunnel: false });
  try {
    await T.present_module.handler({ title: deck.manifest.title, beats: deck.beats });
    const rows = (await T.presenter_beats.handler({})).beats;
    expect('the cue sheet lists every beat of the committed deck', rows.length === 16, String(rows.length));
    expect('presenter_beats reports onDemand:true on exactly the two marked beats',
      JSON.stringify(rows.filter((x) => x.onDemand === true).map((x) => x.id)) === JSON.stringify(MARKED),
      JSON.stringify(rows.filter((x) => 'onDemand' in x)));
    expect('and OMITS the key on every ordinary beat — absent, not false',
      rows.filter((x) => !MARKED.includes(x.id)).every((x) => !('onDemand' in x)),
      JSON.stringify(rows.filter((x) => !MARKED.includes(x.id) && 'onDemand' in x)));
  } finally {
    await T.presenter_stop.handler({});
  }
});
