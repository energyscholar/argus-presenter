/*
 * Plan 0473 P11 — TEACHING PROFILE SCENARIO GATE: T-SCENARIO-TEACHING.
 *
 * The teaching profile is the many-students-plus-teacher (class-scale) use case. Two class-scale
 * behaviours make the working set stay ergonomic under a class:
 *
 *   (F-6) QUESTION DEDUPE/CLUSTER — at class scale the work queue ITSELF overloads: 20 near-simultaneous
 *   questions is its own overload even though each is a real judgment item. Similar questions CLUSTER into
 *   ONE queue item ("N students asked about X" — a count + the contributing askers) instead of 20 rows, so
 *   the queue stays bounded + glanceable and nothing important is silently lost (distinct questions survive
 *   as their own items). The clustering is CHEAP: normalized-keyword Jaccard overlap — no ML / no LLM / no
 *   new deps. Gated on the `queuePolicy.cluster` knob (DATA; wearable/rpg leave it off).
 *
 *   (F-7) EXPLICIT MODERATION OVERRIDES the automatic floor — the teacher/presenter can gate WHO reaches
 *   the queue. An explicit moderation decision WINS over the automatic load-based floor (moderationFloor
 *   precedence seam from P6): a teacher "hold" gates input even when the auto floor would say "go", and
 *   vice-versa the teacher can "go" (allow) even when the auto floor would "hold". A MUTED student produces
 *   NO work items.
 *
 * All DATA knobs (profiles.mjs teaching row): shedding='summarize', enqueue='questions', cluster=true,
 * digestContent='class', floorThresholds.moderationOverrides=true — NOT a per-name code fork. Students are
 * PARTICIPANTS (P9): their turns are untrusted + fenced.
 *
 * settlingMs is tuned down for a fast test (knob override, established pattern); floorThresholds injects a
 * queue-depth level so the AUTO floor is observable — both are knob overrides, NOT code forks.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function wsClient(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws'));
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('message', (d, b) => { if (b) return; let m; try { m = JSON.parse(d.toString()); } catch (e) { return; } if (m.t === 'welcome') resolve({ ws }); });
  });
}
async function poll(pred, label, { timeout = 6000 } = {}) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(15); } throw new Error('timeout ' + label); }
const chat = (c, text, id) => c.ws.send(JSON.stringify({ t: 'chat', text, id }));

test('T-SCENARIO-TEACHING (MILESTONE): many students + teacher → similar questions cluster, moderation overrides auto floor, class digest, students fenced', async () => {
  // REAL teaching profile; settling tuned down for a fast test; inject a queue-depth floor level so the
  // AUTOMATIC floor is observable (both are knob overrides, not code forks). moderationOverrides comes
  // from the teaching profile and is preserved through the merge.
  const s = await createServer({ port: 0, profile: 'teaching', settlingMs: 15, floorThresholds: { queue: { wrap: 3, hold: 5 } } });
  try {
    // --- teaching is DATA & ACTIVE (knobs, not a code fork) ---
    const prof = s.profile();
    expect('teaching profile is selected', prof.name === 'teaching', prof.name);
    expect('teaching profile is WIRED (active, not a placeholder)', prof.wired === true, JSON.stringify({ wired: prof.wired }));
    expect('teaching queue enqueues only questions (ambient shed→summary)', prof.queuePolicy && prof.queuePolicy.enqueue === 'questions', JSON.stringify(prof.queuePolicy));
    expect('teaching queue CLUSTERS similar questions (F-6 knob is DATA)', prof.queuePolicy && prof.queuePolicy.cluster === true, JSON.stringify(prof.queuePolicy));
    expect('teaching digest = class view', prof.digestContent === 'class', prof.digestContent);
    expect('teaching floor: explicit moderation OVERRIDES auto (F-7 knob is DATA)', !!(prof.floorThresholds && prof.floorThresholds.moderationOverrides), JSON.stringify(prof.floorThresholds));

    // teacher = a gated control role (presenter) ⇒ trust 'self'. Students = participants (untrusted/fenced).
    const teacher = await wsClient(s.url(), { userId: 'teacher', userName: 'Teacher', role: 'presenter' });
    const STUDENTS = [];
    for (let i = 1; i <= 20; i++) STUDENTS.push('s' + i);
    const students = {};
    for (const id of STUDENTS) students[id] = await wsClient(s.url(), { userId: id, userName: id.toUpperCase(), role: 'participant' });
    const sm = await wsClient(s.url(), { userId: 'sm', userName: 'SM', role: 'participant' });   // the muted student

    // ============================================================================================
    // (b) EXPLICIT MODERATION OVERRIDES THE AUTOMATIC FLOOR — tested BEFORE the flood (low load ⇒ auto 'go').
    // ============================================================================================
    // With no questions pending and no speakers, the AUTOMATIC floor is 'go'.
    expect('auto floor is GO under no load (baseline)', s.autoFloor() === 'go', s.autoFloor());
    // Teacher HOLD: explicit moderation gates input even though the auto floor says 'go' (hold wins over go).
    const mh = s.setModerationFloor('hold');
    expect('teacher moderation HOLD is accepted (moderation permitted in teaching)', mh.ok === true, JSON.stringify(mh));
    expect('moderation HOLD overrides the auto floor: EFFECTIVE floor is hold', s.floorState() === 'hold', s.floorState());
    expect('...while the AUTOMATIC floor is still go (moderation, not load)', s.autoFloor() === 'go', s.autoFloor());
    expect('moderation HOLD gates new input at the source even though auto=go', s.floorGated() === true, JSON.stringify({ gated: s.floorGated() }));
    // Clear the moderation hold → the floor reverts to the automatic level.
    s.setModerationFloor(null);
    expect('clearing moderation reverts to the auto floor (go)', s.floorState() === 'go' && s.floorGated() === false, s.floorState());

    // A MUTED student produces NO work items even though they ask a real question.
    const mm = s.muteParticipant('sm');
    expect('teacher can mute a student (moderation permitted)', mm.ok === true && s.isMuted('sm'), JSON.stringify(mm));
    chat(sm, 'What is the deadline for the makeup exam?', 'muted-q');
    chat(students.s1, 'x', 'nudge-mute');   // distinct speaker closes the muted turn; non-question ⇒ not enqueued
    await wait(80);
    expect('a MUTED student produces NO work item (input gated by explicit moderation)',
      !s.workItems().some((w) => w.userId === 'sm'), JSON.stringify(s.workItems().map((w) => w.userId)));
    // Un-mute (teacher can allow again) → the student's next question DOES reach the queue.
    s.unmuteParticipant('sm');
    chat(sm, 'How are late penalties calculated for projects?', 'unmuted-q');
    chat(students.s1, 'x2', 'nudge-unmute');
    await poll(() => s.workItems().some((w) => w.userId === 'sm'), 'un-muted student question reaches the queue');
    expect('after un-mute the student reaches the queue (teacher can allow)',
      s.workItems().some((w) => w.userId === 'sm'), JSON.stringify(s.workItems().map((w) => w.userId)));

    // ============================================================================================
    // (a) 20 NEAR-SIMULTANEOUS QUESTIONS, several ASKING THE SAME THING → DEDUPE/CLUSTER.
    //   s1..s10  = topic CLOSURES (mostly identical, 2 near-duplicate phrasings) → ONE cluster of 10
    //   s11..s16 = topic RECURSION (identical)                                    → ONE cluster of 6
    //   s17..s20 = four DISTINCT questions                                        → 4 separate items
    // ============================================================================================
    const CLOSURE = 'What is a closure in JavaScript?';
    const closureTexts = {
      s1: CLOSURE, s2: CLOSURE, s3: CLOSURE, s4: CLOSURE, s5: CLOSURE, s6: CLOSURE, s7: CLOSURE, s8: CLOSURE,
      s9: 'How do closures work in JavaScript?',           // near-duplicate (heuristic, not exact match)
      s10: 'Can someone explain closures in JavaScript?',  // near-duplicate
    };
    const RECURSION = 'How does recursion work in code?';
    const distinctTexts = {
      s17: 'When is the midterm exam scheduled?',
      s18: 'Where do I submit homework assignments?',
      s19: 'Why did my program crash yesterday?',
      s20: 'What database should we use for the project?',
    };
    // Interleave the sends across students (round-robin-ish) so clustering is order-robust, not just
    // "all identical arrive together". A distinct speaker per send closes the prior turn immediately.
    const order = ['s1', 's11', 's17', 's2', 's12', 's18', 's3', 's13', 's19', 's4', 's14', 's20',
      's5', 's15', 's6', 's16', 's7', 's8', 's9', 's10'];
    let n = 0;
    for (const id of order) {
      const text = closureTexts[id] || distinctTexts[id] || RECURSION;
      chat(students[id], text, 'q-' + id);
      await wait(4);
      n++;
    }
    // Nudge the final open turn closed + let everything settle.
    chat(teacher, 'ok settling', 'settle');   // teacher line (self/presenter, not a question) closes the last student turn
    await poll(() => {
      const q = s.workItems().filter((w) => w.priority === 2);
      const closure = q.find((w) => w.cluster && w.count >= 10);
      return !!closure;
    }, 'closures clustered into one item of count>=10');
    await wait(60);

    const ai = s.situation({ consumerId: 'argus' });
    const queue = ai.queue || [];
    const questions = queue.filter((w) => w.priority === 2);

    // ----- the queue stays BOUNDED + glanceable (far fewer items than the 20 asks) -----
    expect('the question queue is BOUNDED — far fewer items than the ~20 questions asked (cluster keeps it glanceable)',
      questions.length <= 10 && questions.length < 20, JSON.stringify({ items: questions.length, texts: questions.map((w) => w.text) }));

    // ----- CLOSURES clustered into ONE item carrying count + askers -----
    const closureItem = questions.find((w) => w.text.toLowerCase().indexOf('closure') >= 0);
    expect('the CLOSURES questions collapsed into ONE clustered item', closureItem && closureItem.cluster === true, JSON.stringify(closureItem && { cluster: closureItem.cluster }));
    expect('the closures cluster carries a COUNT of all 10 askers', closureItem && closureItem.count === 10, JSON.stringify(closureItem && { count: closureItem.count }));
    expect('the closures cluster lists its contributing askers (count + askers)', closureItem && Array.isArray(closureItem.askers) && closureItem.askers.length === 10, JSON.stringify(closureItem && { askers: (closureItem.askers || []).length }));
    // near-duplicate phrasings (s9/s10) were caught by the CHEAP heuristic, not just exact matches.
    const closureAskers = new Set((closureItem.askers || []).map((a) => a.userId));
    expect('near-duplicate phrasings were clustered too (heuristic, not exact-match)', closureAskers.has('s9') && closureAskers.has('s10'), JSON.stringify([...closureAskers]));

    // ----- RECURSION clustered into ONE item of count 6 -----
    const recursionItem = questions.find((w) => w.text.toLowerCase().indexOf('recursion') >= 0);
    expect('the RECURSION questions collapsed into ONE clustered item of count 6', recursionItem && recursionItem.cluster === true && recursionItem.count === 6, JSON.stringify(recursionItem && { cluster: recursionItem.cluster, count: recursionItem.count }));

    // ----- DISTINCT questions SURVIVE as their own items (nothing important silently merged away) -----
    for (const id of Object.keys(distinctTexts)) {
      const own = questions.find((w) => w.userId === id);
      expect('distinct question from ' + id + ' survives as its OWN item (not merged)', !!own && (own.count || 1) === 1, JSON.stringify(own && { userId: own.userId, count: own.count }));
    }

    // ----- NOTHING IMPORTANT SILENTLY LOST: every flooding asker is represented (in a cluster or singly) -----
    const represented = new Set();
    for (const w of questions) {
      if (w.cluster) for (const a of (w.askers || [])) represented.add(a.userId);
      else represented.add(w.userId);
    }
    const floodAskers = order.slice();   // s1..s20 all asked a question
    expect('every one of the ~20 flooding askers is represented (nothing silently lost to clustering)',
      floodAskers.every((id) => represented.has(id)), JSON.stringify(floodAskers.filter((id) => !represented.has(id))));
    expect('no reactive queue-overflow shed occurred (clustering kept it bounded)', s.backpressure().sheddedCount === 0, JSON.stringify(s.backpressure()));

    // ----- moderation "ALLOW" direction: auto floor is now HOLD (load), teacher GO overrides it -----
    expect('under the question load the AUTOMATIC floor is now HOLD', s.autoFloor() === 'hold', JSON.stringify({ auto: s.autoFloor(), pending: questions.length }));
    const mg = s.setModerationFloor('go');
    expect('teacher moderation GO overrides the auto HOLD (teacher can allow): EFFECTIVE floor is go', mg.ok === true && s.floorState() === 'go', JSON.stringify({ ok: mg.ok, effective: s.floorState(), auto: s.autoFloor() }));
    expect('...and input is NOT gated (moderation GO wins over auto HOLD)', s.floorGated() === false, JSON.stringify({ gated: s.floorGated(), auto: s.autoFloor() }));
    s.setModerationFloor(null);

    // ============================================================================================
    // (c) CLASS DIGEST surfaces class-relevant content (hands/queue depth/poll-quiz seam).
    // ============================================================================================
    const digest = ai.situation && ai.situation.digest;
    expect('the situation carries a CLASS digest section', digest && digest.kind === 'class', JSON.stringify(digest && { kind: digest.kind }));
    expect('class digest surfaces the (clustered) questions', digest && Array.isArray(digest.questions) && digest.questions.some((w) => w.cluster && w.text.toLowerCase().indexOf('closure') >= 0), JSON.stringify(digest && (digest.questions || []).map((w) => w.text)));
    expect('class digest surfaces the queue depth', digest && typeof digest.queueDepth === 'number', JSON.stringify(digest && { queueDepth: digest.queueDepth }));
    expect('class digest surfaces HANDS RAISED = students waiting (cluster of N = N hands, > the item count)',
      digest && digest.handsRaised >= 16 && digest.handsRaised > digest.questions.length, JSON.stringify(digest && { handsRaised: digest.handsRaised, items: digest.questions.length }));
    expect('class digest declares the poll/quiz SEAM (placeholders)', digest && 'poll' in digest && 'quiz' in digest, JSON.stringify(digest && Object.keys(digest)));

    // ============================================================================================
    // (d) STUDENTS ARE PARTICIPANTS → untrusted-FENCED (P9).
    // ============================================================================================
    const studentTurns = (ai.recentTurns || []).filter((t) => t.userId !== 'teacher');
    expect('every student turn is marked untrusted', studentTurns.length > 0 && studentTurns.every((t) => t.untrusted === true), JSON.stringify(studentTurns.map((t) => ({ u: t.userId, un: t.untrusted }))));
    expect('every student turn is FENCED as data (never merged into the instruction channel)',
      studentTurns.every((t) => typeof t.fenced === 'string' && t.fenced.length > 0), 'someUnfenced');
    // The clustered/queued question items (from students) are likewise untrusted + fenced.
    expect('the clustered closures item is untrusted + fenced (students = participants)',
      closureItem && closureItem.untrusted === true && typeof closureItem.fenced === 'string', JSON.stringify(closureItem && { untrusted: closureItem.untrusted, hasFence: typeof closureItem.fenced }));

    teacher.ws.close(); sm.ws.close();
    for (const id of STUDENTS) students[id].ws.close();
  } finally { await s.close(); }
});
