/*
 * Plan 1149 P2 — a coalesced turn carries `conf` and `suspect`, derived from its items.
 *   conf    = the MINIMUM item conf, or null when no item carries one (null is a value, not a patch).
 *   suspect = true iff ANY item was flagged suspectHallucination.
 * Fixture speech is invented and neutral.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';

const hear = (s, text, conf = null) => s._emitInboxForTest({ kind: 'voice', userId: 'u1', userName: 'Speaker', role: 'presenter', text, conf });
const turns = async (s) => (await s.situation({ consumerId: 'pvs:t1149' })).recentTurns;

test('1149-T2a: a turn of three items (0.9/0.4/0.8) carries conf === 0.4 (the minimum)', async () => {
  const s = await createServer({ port: 0, settlingMs: 5000 });
  try {
    s.pvsStart({ consumer: 't1149' });
    hear(s, 'the blue kettle', 0.9); hear(s, 'sits on the shelf', 0.4); hear(s, 'beside a green jar', 0.8);
    const t = await turns(s);
    expect(`one coalesced turn (got ${t.length})`, t.length === 1 && t[0].count === 3, JSON.stringify(t.map((x) => x.count)));
    expect('conf is the minimum of the items', t[0].conf === 0.4, String(t[0].conf));
  } finally { await s.close(); }
});

test('1149-T2b: one suspectHallucination item makes the turn suspect:true', async () => {
  const s = await createServer({ port: 0, settlingMs: 5000 });
  try {
    s.pvsStart({ consumer: 't1149' });
    hear(s, 'the blue kettle', 0.9);
    const h = hear(s, 'Thank you.', 0.2);
    expect('precondition: the item is flagged', h.suspectHallucination === true, JSON.stringify(h.suspectHallucination));
    hear(s, 'beside a green jar', 0.8);
    const t = await turns(s);
    expect('turn is suspect:true', t.length === 1 && t[0].suspect === true, JSON.stringify(t.map((x) => x.suspect)));
  } finally { await s.close(); }
});

test('1149-T2c: items without conf give conf:null and suspect:false', async () => {
  const s = await createServer({ port: 0, settlingMs: 5000 });
  try {
    s.pvsStart({ consumer: 't1149' });
    hear(s, 'the blue kettle'); hear(s, 'sits on the shelf');
    const t = await turns(s);
    expect('conf is null (not 0, not undefined)', t.length === 1 && t[0].conf === null, String(t[0] && t[0].conf));
    expect('suspect is false (not undefined)', t[0].suspect === false, String(t[0].suspect));
  } finally { await s.close(); }
});

// T2d — the existing turnComplete assertions must pass UNMODIFIED. They live in
//   test/live/V0473-turn-coalesce.test.mjs  ('T-TURN-COALESCE (a)+(d)' …: "turn OPEN mid-turn ⇒ turnComplete:false",
//   "turnComplete fires EXACTLY once for the coalesced turn", "both ring items marked turnComplete after settle")
//   test/live/V0473-turn-budget.test.mjs
// This test does not edit them; it asserts the new fields do not disturb turnComplete on the same path.
test('1149-T2d: turnComplete is unchanged by conf/suspect (V0473-turn-coalesce + V0473-turn-budget still own the assertions)', async () => {
  const s = await createServer({ port: 0, settlingMs: 150 });
  try {
    s.pvsStart({ consumer: 't1149' });
    hear(s, 'the blue kettle', 0.9);
    expect('open turn ⇒ turnComplete:false', (await turns(s))[0].turnComplete === false, '');
    await new Promise((r) => setTimeout(r, 500));
    const t = await turns(s);
    expect('settled turn ⇒ turnComplete:true, conf kept', t[0].turnComplete === true && t[0].conf === 0.9, JSON.stringify(t[0]));
  } finally { await s.close(); }
});
