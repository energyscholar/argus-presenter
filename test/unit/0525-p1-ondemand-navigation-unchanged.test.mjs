/*
 * Plan 0525 P1 (R5) — t75: ⛔ NAVIGATION IS UNCHANGED. THIS TEST EXISTS TO STOP A FIX.
 *
 * READ THIS BEFORE YOU "IMPROVE" ANYTHING HERE.
 *
 * `onDemand` marks a beat as prepared-but-not-on-the-path. Twice, from correct evidence both
 * times, that was read as an instruction to the PRODUCT: draft 1 of plan 0525 proposed making the
 * arrow SKIP an on-demand beat; draft 2 proposed the skip plus folding such beats out of the GM
 * outline. Bruce refused both (R5, superseding R1):
 *
 *     "In your first attempts at running modules you went into new beats mechanically and first,
 *      rather than waiting for players to ask about a thing. That's what this was about. There's
 *      no implementation in the PRODUCT — it's a stylistic thing about the one doing the
 *      presenting. A standard design trope is to have a beat to show what's behind the Secret Door
 *      IFF the players FIND IT and decide to OPEN IT. So only on demand."
 *
 * The marker is a note to whoever is presenting. It is DISCIPLINE, not a rule the software
 * applies — and enforcement would be wrong on its own terms, because when they DO find the door
 * the presenter opens it, and that is one ordinary click on an ordinary beat.
 *
 * So: if a future change makes linear navigation step OVER an on-demand beat, this test fails, and
 * that failure is the correct answer. Do not relax it, do not delete it, do not rewrite it to
 * match the new behaviour. Making the marker visible is P1's whole job; making it operative is
 * a change to what happens in a live session, and it has already been refused.
 *
 * Unit tier: the MCP handlers over an ephemeral port, no browser, all beats inline — the repo's
 * gitignored modules/ directory is neither read nor written.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { toolMap, _server } from '../../mcp/tools.mjs';

/*
 * A RUN OF TWO on-demand beats sits in the middle. One would catch a skip; two also catch the
 * variant where a skip lands on the next unmarked beat and quietly swallows a second one.
 */
const beats = () => [
  { id: 'approach', component: 'card', opts: { title: 'The approach' } },
  { id: 'corridor', component: 'card', opts: { title: 'The corridor' } },          // the beat BEFORE
  { id: 'behind-the-door', component: 'card', opts: { title: 'Behind the door' }, onDemand: true },
  { id: 'under-the-floor', component: 'card', opts: { title: 'Under the floor' }, onDemand: true },
  { id: 'stairwell', component: 'card', opts: { title: 'The stairwell' } },
];

test('0525 t75 — next_beat from the beat BEFORE an on-demand beat still lands ON it (R5: no skip, ever)', async () => {
  const T = toolMap();
  await T.presenter_start.handler({ port: 0, tunnel: false });
  try {
    const authored = beats();
    await T.present_module.handler({ title: 'On-demand fixture', beats: authored });
    const server = _server();

    // Stand on 'corridor' — index 1, the beat immediately before the marked run.
    await T.show_beat.handler({ beatId: 'corridor' });
    expect('standing on the beat before the marked one', server.store.get('module/current') === 1,
      String(server.store.get('module/current')));

    // ── THE ASSERTION THIS FILE EXISTS FOR ──────────────────────────────────────────────────
    const step = await T.next_beat.handler({});
    expect('next_beat advanced to index 2 — the ON-DEMAND beat, exactly as it did before P1',
      step && step.beat && step.beat.index === 2, JSON.stringify(step));
    expect('and the session state agrees: the on-demand beat is the live beat',
      server.store.get('module/current') === 2, String(server.store.get('module/current')));
    expect('which is "behind-the-door" — the marker informed the presenter and moved nothing',
      authored[server.store.get('module/current')].id === 'behind-the-door',
      authored[server.store.get('module/current')].id);

    // ── and the SECOND marked beat is not swallowed either ──────────────────────────────────
    const step2 = await T.next_beat.handler({});
    expect('the next step lands on the second on-demand beat, not past the run',
      step2 && step2.beat && step2.beat.index === 3 && authored[3].id === 'under-the-floor', JSON.stringify(step2));
  } finally { await T.presenter_stop.handler({}); }
});
