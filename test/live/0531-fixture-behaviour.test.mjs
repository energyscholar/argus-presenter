/*
 * Plan 0531 P2 — THE PRODUCT BEHAVIOUR, KEPT, ON CONTENT THE PUBLIC REPO OWNS.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────
 * Until plan 0531 these assertions lived in a test file that drove a private deployment's authored
 * deck — a real session, real people's seat slugs, a real setting. That file has moved to the
 * private content repo, where it belongs. Moving it as a unit would have deleted SEVENTEEN
 * assertions from this repo's suite in one commit, and every one of them protects the PRODUCT, not
 * the deck: a badge renders, a beat row stages and does not ship, an arrow advances by exactly one,
 * a per-seat send reaches exactly one seat, the health surface names its log directory and carries
 * none of what was said in the room.
 *
 * So each was classified one at a time, and the ones asserting product behaviour are here, re-made
 * on the committed neutral fixture (`0525-fixture-spec.mjs` + `0525-fixture-module/`). Three of the
 * seventeen are NOT here because `0525-fixture-session.test.mjs` t78 already asserts them, on this
 * same fixture, assertion for assertion — duplicating them would inflate a count, not coverage:
 *
 *   t60  five identities, one person one roster row, every display seated where its link asked
 *        → t78 "five identities" / "one person, one roster row" / "every display is seated where…"
 *   t68  a marked beat is reachable by an ordinary explicit click, and reaches the room
 *        → t78 "the second of the run opened on an EXPLICIT CLICK and reached the room"
 *   t82  the outline badges exactly the marked rows, visibly, in words, and badges no other row
 *        → t78's whole (c) block
 *
 * ── WHAT CHANGED IN THE PORT, AND WHAT DID NOT ──────────────────────────────────────────────
 * Nothing about what is asserted. The NUMBERS that were properties of the retired deck are now
 * properties of the fixture deck: 18 beats → 16, the empty post is uid 5 not a named seat, the
 * deployment's word for a post is "Post" and there are 6 of them, and the marked run is two
 * consecutive beats rather than two scattered ones. Each is flagged where it appears.
 *
 * ⚠ ONE THRESHOLD MOVED, AND IT IS THE ONE TO RE-CHECK BY EYE. The durable-log test asserted
 * `appended > 20` against an 18-beat deck. The fixture deck is 16 beats and a measured run appends
 * 19. The floor here is 15 — still far above "the recorder wrote nothing", which is the failure the
 * assertion exists to catch — and it is paired with a cross-check the original did not make:
 * the log's own `stats.appended` must agree with the number of entries a credentialed read returns.
 *
 * ⚠ ONE SESSION, SHARED. `_0531-fixture-run.mjs` memoises it; t78 awaits the same promise.
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, check as expect } from '../../harness/test.mjs';
import { toolMap } from '../../mcp/tools.mjs';
import { SESSION_LOG_DIR_ENV } from '../../lib/session-log.mjs';
import SPEC, { MODULE_DIR, MODULE_ID, STATION_WORD } from './0525-fixture-spec.mjs';
import { fixtureReport } from './_0531-fixture-run.mjs';

const SEATS = SPEC.seats;
const EMPTY_STATION_UID = SPEC.emptyStationUid;

/** The two beats this deck declares `onDemand`, in beats order. A RUN OF TWO, consecutive. */
const MARKED = ['b-door-outer', SPEC.beats.onDemand];

/** The declared shape of the health payload's session-log block, sorted. Same set the unit tier pins. */
const SESSION_LOG_SHAPE = ['enabled', 'sessionLogDir', 'sessionLogDirError', 'sessionLogDirSource', 'sessionLogId', 'stats'];

/** The fixture deck's own counts — the only numbers in this file that are content, not product. */
const DECK_BEATS = 16;
const DECK_SECTIONS = 5;
const POSTS = 6;

/**
 * Point the DEPLOYMENT's log directory at a throwaway for one test, and hand back the undo.
 * ⚠ The whole suite is ONE process and `presenter_start` resolves this from the environment, so a
 * test that raises an MCP session without this writes ops into a human's ~/.local/state. Restored
 * unconditionally.
 */
function withScratchLogDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0531-'));
  const had = Object.prototype.hasOwnProperty.call(process.env, SESSION_LOG_DIR_ENV);
  const prev = process.env[SESSION_LOG_DIR_ENV];
  process.env[SESSION_LOG_DIR_ENV] = dir;
  return () => {
    if (had) process.env[SESSION_LOG_DIR_ENV] = prev; else delete process.env[SESSION_LOG_DIR_ENV];
    try { rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  };
}

const report = fixtureReport;

test('0531 t61 — every seat knows where it is sitting, without opening Config (P13)', async () => {
  const r = await report();
  const labels = r.scenes.find((s) => s.name === 'seated').seatLabels;
  expect('checkVisibility() exists (a rect would not be proof)',
    SEATS.every((s) => labels[s.userId].hasApi === true), JSON.stringify(labels));
  for (const s of SEATS) {
    expect(`${s.userName} sees "${s.station}" — its OWN post, visibly`,
      labels[s.userId].visible === true && (labels[s.userId].text || '').includes(s.station),
      JSON.stringify(labels[s.userId]));
  }
  // and it is each seat's own label, not one label everywhere
  const texts = new Set(SEATS.map((s) => labels[s.userId].text));
  expect('the four labels are four DIFFERENT labels', texts.size === 4, JSON.stringify([...texts]));
});

test('0531 t62 — the deck loads and VALIDATES, and the outline renders every beat AND every section', async () => {
  const r = await report();
  const m = r.scenes.find((s) => s.name === 'module-loaded');
  expect(`${DECK_BEATS} beats`, m.beats === DECK_BEATS, String(m.beats));
  expect(`${DECK_SECTIONS} sections`, m.sections === DECK_SECTIONS, String(m.sections));
  expect('the panel reports it VALID', /valid/i.test(m.valid), m.valid);
  expect('the outline renders every beat as a row', m.outlineRows === DECK_BEATS, String(m.outlineRows));
  expect('and every section as a tier', m.outlineSections === DECK_SECTIONS, String(m.outlineSections));
});

test('0531 t63 — ⛔ STAGING DOES NOT SHIP: the presenter clicks a beat and the room does NOT change', async () => {
  const r = await report();
  const s = r.scenes.find((x) => x.name === 'staged-not-sent');
  expect('the control surface says a beat is staged', s.staged === true, JSON.stringify(s.staged));
  expect('GO is ARMED — the affordance, not just the variable', s.goArmed === true, s.goText);
  expect('and the preview reads STAGED, as rendered text', /STAGED/i.test(s.pvstate), s.pvstate);
  // THE ASSERTION THIS WHOLE RIG EXISTS FOR — checked on all four displays, not one.
  expect('⛔ NOT ONE of the four displays changed while the beat was staged',
    Array.isArray(s.leaked) && s.leaked.length === 0, JSON.stringify(s.leaked));
});

test('0531 t64 — GO ships, and only then', async () => {
  const r = await report();
  const go = r.scenes.find((s) => s.name === 'go');
  expect('the receipt names the beat that was sent',
    go.lastSent && go.lastSent.beatId === SPEC.beats.staged, JSON.stringify(go.lastSent));
  expect('it reached all five', go.lastSent.recipients === 5, String(go.lastSent && go.lastSent.recipients));
  expect('the indicator returns to LIVE', /LIVE/i.test(go.pvstate), go.pvstate);
  expect('and every display is now showing something',
    Object.values(go.sigs).every((v) => v.present && v.len > 1000),
    JSON.stringify(Object.fromEntries(Object.entries(go.sigs).map(([k, v]) => [k, v.len]))));
});

test('0531 t65 — a per-seat send is addressed in the wire form, and reaches exactly one seat', async () => {
  const r = await report();
  const scene = r.scenes.find((s) => s.name === 'site-alpha-fails');
  expect('the target was the first post, in P5\'s wire form',
    scene.target.target === `station:${SEATS[0].stationUid}`, JSON.stringify(scene.target));
  expect(`EXACTLY ONE display moved — ${SEATS[0].userName}'s`,
    JSON.stringify(r.findings.perSeatMoved) === JSON.stringify([SEATS[0].userId]),
    JSON.stringify(r.findings.perSeatMoved));
});

test('0531 t66 — ⚠ sending to an EMPTY post is LOUD, not silently successful', async () => {
  const r = await report();
  const e = r.findings.emptyStation;
  expect('the receipt says ZERO RECIPIENTS, in words', /0 RECIPIENTS/i.test(e.receipt), e.receipt);
  expect('the server agrees nobody received it', e.lastSent && e.lastSent.recipients === 0, JSON.stringify(e.lastSent));
  expect('it was addressed at the empty post, in the wire form',
    JSON.stringify(e.lastSent.targets) === JSON.stringify([`station:${EMPTY_STATION_UID}`]),
    JSON.stringify(e.lastSent.targets));
  expect('and NOT ONE display changed', e.moved.length === 0, JSON.stringify(e.moved));
});

test('0531 t67 — R4\'s split is real: a beat row STAGES, an arrow SHIPS', async () => {
  const r = await report();
  const staged = r.scenes.find((s) => s.name === 'staged-not-sent');
  expect('half 1 — a BEAT ROW staged and shipped nothing',
    staged.staged === true && staged.leaked.length === 0, JSON.stringify(staged.leaked));
  expect('half 2 — an ARROW published immediately', r.findings.arrow.shipped === true, JSON.stringify(r.findings.arrow));
  expect('…and left nothing staged behind it', r.findings.arrow.stagedAfter === false, JSON.stringify(r.findings.arrow));
});

test('0531 t69 — the post tier projects to the room and re-seats NOBODY (I3)', async () => {
  const r = await report();
  const p = r.findings.projection;
  expect('the tier is present and visible', p.tier.present === true && p.tier.visible === true, JSON.stringify(p.tier));
  expect('it is COLLAPSED before anyone opens it', p.tier.openBefore === false, JSON.stringify(p.tier));
  // ⚠ the WORD and the COUNT are the deployment's own — the fixture registry's, here.
  expect('it is headed with the deployment\'s own word and the count',
    new RegExp(STATION_WORD).test(p.tier.title) && p.tier.count === `(${POSTS})`,
    `${p.tier.title} ${p.tier.count}`);
  expect('the ▣ button existed and was pressed', p.projected.pressed === true, JSON.stringify(p.projected));
  expect('the receipt names the post and how many screens it reached',
    /projected/i.test(p.receipt) && /\d+ screens?/.test(p.receipt), p.receipt);
  expect('⛔ EVERY seat\'s stationUid is unchanged — transient render, durable assignment',
    p.seatsUnchanged === true, JSON.stringify({ before: p.seatsBefore, after: p.seatsAfter }));
  expect('…and the room\'s screens really did change', p.roomChanged.length >= 1, JSON.stringify(p.roomChanged));
});

test('0531 t70 — a display RELOAD does not double-count the roster', async () => {
  const r = await report();
  const rl = r.findings.reload;
  expect('the roster held 5 rows before the reload', rl.rosterBefore === 5, String(rl.rosterBefore));
  expect('and STILL holds 5 rows after it', rl.rosterAfter === 5, String(rl.rosterAfter));
  expect('the server agrees — 5 identities, not 6', rl.presenceAfter === 5, String(rl.presenceAfter));
  expect('and no row is marked contested', rl.contested.length === 0, JSON.stringify(rl.contested));
});

test('0531 t71 — the DURABLE LOG caught the session, and refuses an uncredentialed read', async () => {
  const r = await report();
  const L = r.findings.sessionLog;
  expect('the log is enabled for this deployment', L.enabled === true, JSON.stringify(L));
  /*
   * ⚠ APPENDED, against a baseline — never an absolute count. The oplog is NOT empty at boot, and
   * that assumption is exactly what makes 8 of the 9 pre-existing live failures fail.
   * ⚠ The floor is 15, not the retired deck's 20: this deck is 16 beats and a measured run appends
   * 19. Far above "the recorder wrote nothing", which is the failure this catches.
   */
  expect('ops were APPENDED during the session, measured against the S0 baseline',
    L.appended > 15, `baseline ${L.baselineEntries} → ${L.afterEntries} (appended ${L.appended})`);
  expect('…and the recorder\'s own counter agrees with what a credentialed read returns',
    L.stats && L.stats.appended === L.afterEntries, JSON.stringify({ stats: L.stats && L.stats.appended, read: L.afterEntries }));
  expect('nothing was dropped and nothing failed to write',
    L.stats && L.stats.dropped === 0 && L.stats.failures === 0, JSON.stringify(L.stats));
  expect('and an UNCREDENTIALED read is refused (R6 — the log carries five people\'s own words)',
    L.anonRefused === true && L.anonStatus === 403, String(L.anonStatus));
});

test('0531 t72 — ⛔ the source deck was never written to', async () => {
  const r = await report();
  expect(`${MODULE_ID}.json is byte-identical to how the rig found it`,
    r.module.untouched === true, `${r.module.sourceSha} → ${r.module.sourceShaAfter}`);
  expect('the rig ran against a COPY in a throwaway directory',
    typeof r.module.tempDir === 'string' && !r.module.tempDir.includes('argus-presenter'), r.module.tempDir);
  expect('and it produced screenshots', r.shots.length >= 50, String(r.shots.length));
});

test('0531 t83 — the cue sheet an AI reads and the outline a human reads mark the SAME beats', async () => {
  // The browser run first, on purpose: the last assertion is the cross-surface one.
  const r = await report();
  const deck = JSON.parse(readFileSync(join(MODULE_DIR, `${MODULE_ID}.json`), 'utf8'));

  const undo = withScratchLogDir();
  const T = toolMap();
  await T.presenter_start.handler({ port: 0, tunnel: false });
  try {
    await T.present_module.handler({ title: (deck.manifest && deck.manifest.title) || MODULE_ID, beats: deck.beats });
    const rows = (await T.presenter_beats.handler({})).beats;
    expect('the cue sheet lists every beat of the deck', rows.length === DECK_BEATS, String(rows.length));

    const marked = rows.filter((x) => x.onDemand === true).map((x) => x.id);
    expect('presenter_beats reports onDemand:true on exactly the two marked beats',
      JSON.stringify(marked) === JSON.stringify(MARKED), JSON.stringify(rows.filter((x) => 'onDemand' in x)));
    // ABSENT, not false — an ordinary beat's shape is byte-for-byte what it was before 0525 P1.
    expect('and OMITS the key entirely on every ordinary beat',
      rows.filter((x) => !MARKED.includes(x.id)).every((x) => !('onDemand' in x)),
      JSON.stringify(rows.filter((x) => !MARKED.includes(x.id) && 'onDemand' in x)));

    expect('⚑ and the cue sheet marks the SAME beats the live outline badged — one fact, two surfaces',
      JSON.stringify(marked) === JSON.stringify(r.findings.outlineMarkers.rows.filter((x) => x.badge).map((x) => x.id)),
      JSON.stringify(marked));
  } finally {
    try { await T.presenter_stop.handler({}); } finally { undo(); }
  }
});

test('0531 t84 — presenter_health\'s session-log block, on a REAL five-browser session, says ENABLED and names its directory', async () => {
  const r = await report();
  /*
   * `findings.health` is taken by the rig WHILE the five browsers are still connected, from
   * `server.health({staleMs:10000})` — which is verbatim the body of the `presenter_health` MCP
   * handler (`need().health({staleMs})`). t76/t77 pin that the tool forwards this block; what is
   * shown only here is that it is TRUE of a real session rather than of a fixture server. The
   * failure this exists to catch is silent: a recorder that is configured, reports nothing, and
   * loses a session's ops with the process.
   */
  const h = r.findings.health;
  expect('the rig captured a health payload while the session was still up', !!h && typeof h === 'object', JSON.stringify(h));
  const sl = h.sessionLog;
  expect('P2\'s session-log block is present at all', !!sl && typeof sl === 'object', JSON.stringify(h && Object.keys(h)));

  expect('it reports this session ENABLED — the recorder is running, not merely configured',
    sl.enabled === true, JSON.stringify(sl));
  expect('it NAMES the directory, and it is the one THIS session was given',
    typeof sl.sessionLogDir === 'string' && sl.sessionLogDir === r.sessionLogDir,
    `${sl.sessionLogDir} vs ${r.sessionLogDir}`);
  expect('it says where that directory came from', sl.sessionLogDirSource === 'option', String(sl.sessionLogDirSource));
  expect('and there is a session id to ask about afterwards',
    typeof sl.sessionLogId === 'string' && sl.sessionLogId.length > 0, String(sl.sessionLogId));
  expect('the counters show a real session went through it — nothing dropped, nothing failed',
    sl.stats && sl.stats.appended > 15 && sl.stats.dropped === 0 && sl.stats.failures === 0, JSON.stringify(sl.stats));
  expect('the reported shape is exactly the six declared keys — the same set the unit tier pins',
    Object.keys(sl).sort().join(',') === SESSION_LOG_SHAPE.join(','), Object.keys(sl).sort().join(','));

  // ⛔ STATE, NEVER CONTENT. The log holds five people's own words; a status surface must not be a
  // second way to read them. Asserted over the WHOLE payload — a leak one level up is still a leak.
  const whole = JSON.stringify(h);
  expect('⛔ and the status surface carries not one line of what was said in the room',
    ['"entries"', '"lines"', '"tail"', '"sessions"'].every((k) => !whole.includes(k)), whole.slice(0, 300));
});

/*
 * ══ READ THIS BEFORE YOU "FIX" t85. IT ASSERTS A `true` THAT LOOKS LIKE A BUG, AND IS NOT. ═══
 *
 * Pressing → on the beat before a marked beat walks straight ONTO the marked beat and PUBLISHES it
 * to every screen in the room. That is the DESIGNED behaviour under ruling R5, and it must stay
 * true. `onDemand` is a note to whoever is presenting — *prepared, but not on the path; show it iff
 * they ask* — and it is NOT a rule the product enforces. Bruce, in his own words:
 *
 *     "There's no implementation in the PRODUCT — it's a stylistic thing about the one doing the
 *      presenting. A standard design trope is to have a beat to show what's behind the Secret Door
 *      IFF the players FIND IT and decide to OPEN IT. So only on demand."
 *
 * Plan 0525 was drafted TWICE as a navigation skip, from correct evidence both times, and refused
 * both times. If you are here because this assertion offends you: the skip has already been
 * considered and rejected, and it would be wrong on its own terms — when they DO find the door, the
 * presenter opens it, and that is one ordinary click on an ordinary beat.
 *
 * So a change that makes linear navigation step OVER a marked beat fails this test, and that
 * failure is the correct answer. Do not relax it, do not delete it, do not rewrite it to match the
 * new behaviour. t75 is the unit twin; this is the same invariant in a real browser, with four real
 * displays watching, which is where a navigation change would actually be felt.
 *
 * ⚑ The assertion t78 does NOT make, and this one does: the arrow advanced by EXACTLY ONE INDEX.
 * "It landed on the marked beat" would also be true of a walk that skipped two and came back.
 */
test('0531 t85 — ⛔ → from the beat before an on-demand beat still LANDS ON IT and SHIPS it, by exactly one step (R5)', async () => {
  const r = await report();
  const a = r.findings.arrow;
  const pulse = r.scenes.find((s) => s.name === 'the-pulse');

  expect('the arrow PUBLISHED immediately — a beat row stages, an arrow ships (R4)',
    a.shipped === true, JSON.stringify(a));
  expect('…and left nothing staged behind it', a.stagedAfter === false, JSON.stringify(a));
  expect(`it advanced by exactly ONE step from ${SPEC.beats.beforeArrow} — no skip, no swallow`,
    Number.isInteger(pulse.arrow.before) && a.landed.index === pulse.arrow.before + 1,
    `${pulse.arrow.before} → ${a.landed && a.landed.index}`);
  expect(`and the beat it landed on is ${MARKED[0]}`, a.landed && a.landed.id === MARKED[0], JSON.stringify(a.landed));

  // ── THE ASSERTION THIS TEST EXISTS FOR — see the block comment above before changing it ──────
  expect('⛔ that beat IS marked on demand, and the linear walk went onto it anyway: CORRECT under R5',
    a.landed.onDemand === true && a.linearWalkIncludesOnDemand === true, JSON.stringify(a));
  // and the marker still does its ONE job elsewhere: the beat remains reachable by an ordinary
  // click, which is the only thing "on demand" can mean.
  expect('…while the marked beat the presenter chose to open reached the whole room on a plain click',
    r.findings.onDemandReachable.beatId === MARKED[1] && r.findings.onDemandReachable.sent.lastSent.recipients === 5,
    JSON.stringify(r.findings.onDemandReachable));
});
