/*
 * Plan 0473 P6 — FLOOR CONTROL (proactive, at the SOURCE) + REACTIVE BACKSTOP (last resort).
 *
 * PROACTIVE-FIRST overload prevention. The server measures live LOAD from EXISTING state (concurrent
 * active speakers / work-queue depth / consumer falling behind) against the ACTIVE PROFILE's
 * `floorThresholds` knob (DATA, read via api.profile() — NEVER a name fork). Crossing WRAP emits a
 * gentle "please wrap" floor cue; crossing HOLD emits "please hold" AND GATES new capture AT THE
 * SOURCE (a would-be speaker is told to hold, instead of the server accepting audio only to shed it).
 * When load clears the floor returns to 'go'. The wearable profile has floorThresholds.enabled:false
 * (solo → no-op); the MECHANISM is built + tested with an ENABLED/INJECTED threshold, threaded through
 * the profile knob via createServer({floorThresholds}) — a tuning override, not a code branch.
 *
 * The REACTIVE backstop is the LAST resort: input that still exceeds capacity is folded-to-summary
 * WITH an explicit COUNT (`sheddedCount`, surfaced in situation().backpressure) — NEVER silent — while
 * the actual work items (questions/directed turns) are PRESERVED.
 *
 *   T-FLOOR-CONTROL     — under simulated overload the server emits wrap/hold and gates new input at
 *                         the source; a gated speaker gets a transparent cue; when load clears, 'go'.
 *   T-PROACTIVE-FIRST   — proactive floor gating engages BEFORE the reactive backpressure counter rises
 *                         (the counter only increments after the floor is already in effect).
 *   T-BACKPRESSURE-COUNTED — input beyond capacity → ambient overflow shed WITH an explicit surfaced
 *                         count (never silent); the work items are preserved.
 *   T-ZERO-WHEN-OFF (regression) — the client floor cue is fenced (absent from the served OFF page).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';
import http from 'http';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws'));
    const msgs = [];
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('message', (d, b) => { if (b) return; let m; try { m = JSON.parse(d.toString()); } catch (e) { return; } msgs.push(m); if (m.t === 'welcome') resolve({ ws, msgs }); });
  });
}
async function until(pred, label, { timeout = 5000 } = {}) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await pred()) return true; await wait(20); } throw new Error('timeout ' + label); }
const chat = (c, text, id) => c.ws.send(JSON.stringify({ t: 'chat', text, id }));
const segStart = (c, seq) => c.ws.send(JSON.stringify({ t: 'voice_seg_start', seq }));
const floorMsgs = (c) => c.msgs.filter((m) => m.t === 'floor');
function getPage(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let d = ''; res.on('data', (x) => (d += x)); res.on('end', () => resolve(d)); }).on('error', reject); }); }

// T-FLOOR-CONTROL: overload (injected queue-depth thresholds) → the server emits wrap then hold and
// GATES a new voice segment at the source (transparent cue, capture NOT started); when load clears, 'go'.
test('T-FLOOR-CONTROL: overload emits wrap/hold + gates new input at the source; load clears → go', async () => {
  // Inject an ENABLED floor threshold onto the wearable engine (a tuning override, not a name fork):
  // wrap at 1 pending, hold at 2. settlingMs:0 ⇒ every chat is its own settled turn ⇒ a work item.
  // enqueue:'all' (wearable) ⇒ ambient text enters the queue. maxPending 50 ⇒ the reactive shed does
  // NOT fire here (we isolate FLOOR, not shedding).
  const s = await createServer({ port: 0, settlingMs: 0, queueMaxPending: 50, floorThresholds: { enabled: true, queue: { wrap: 1, hold: 2 } } });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'Speaker', role: 'participant' });
    expect('floor starts at go (no load)', s.floorState() === 'go', s.floorState());

    // one pending item ⇒ WRAP cue (proactive: please wrap up).
    chat(c, 'first item', 'm1');
    await until(() => floorMsgs(c).some((m) => m.state === 'wrap'), 'wrap cue arrives');
    expect('server floor is wrap at 1 pending', s.floorState() === 'wrap', s.floorState());

    // two pending items ⇒ HOLD cue (overload: please hold, capture gated).
    chat(c, 'second item', 'm2');
    await until(() => floorMsgs(c).some((m) => m.state === 'hold'), 'hold cue arrives');
    expect('server floor is hold at 2 pending', s.floorState() === 'hold', s.floorState());
    // ordering: the client saw wrap BEFORE hold (proactive escalation, never a jump-to-shed).
    const states = floorMsgs(c).map((m) => m.state);
    expect('wrap cue preceded hold cue', states.indexOf('wrap') >= 0 && states.indexOf('wrap') < states.indexOf('hold'), JSON.stringify(states));

    // GATE AT THE SOURCE: a would-be speaker's new segment is refused under hold — the speaker gets a
    // transparent gated floor cue and NO capture session is started (never accept audio only to shed it).
    expect('no voice session before the gated attempt', s.voiceSessionCount() === 0, String(s.voiceSessionCount()));
    segStart(c, 1);
    await until(() => floorMsgs(c).some((m) => m.gated === true), 'gated cue for the would-be speaker');
    const gated = floorMsgs(c).find((m) => m.gated === true);
    expect('the gated cue is a hold (please hold)', gated.state === 'hold', JSON.stringify(gated));
    await wait(60);
    expect('capture was GATED at the source (no session started)', s.voiceSessionCount() === 0, String(s.voiceSessionCount()));

    // load clears (resolve every pending item) ⇒ the floor returns to 'go' and the client is told.
    for (const w of s.workItems()) s.resolveWork(w.id);
    await until(() => floorMsgs(c).some((m) => m.state === 'go'), 'go cue when load clears');
    expect('server floor back to go when load clears', s.floorState() === 'go', s.floorState());
    c.ws.close();
  } finally { await s.close(); }
});

// T-PROACTIVE-FIRST: the proactive floor engages (hold) BEFORE the reactive backpressure counter ever
// rises. With hold at 2 pending and maxPending 3, the floor is ALREADY in hold while sheddedCount is
// still 0 — only once input pushes PAST capacity does the reactive shed (last resort) increment.
test('T-PROACTIVE-FIRST: floor hold engages before the reactive sheddedCount rises', async () => {
  const s = await createServer({ port: 0, settlingMs: 0, queueMaxPending: 3, floorThresholds: { enabled: true, queue: { wrap: 1, hold: 2 } } });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'Speaker', role: 'participant' });

    chat(c, 'one', 'm1');
    chat(c, 'two', 'm2');
    // at 2 pending the floor is HOLD, and NOTHING has been shed yet (proactive before reactive).
    await until(() => s.floorState() === 'hold', 'floor reaches hold');
    expect('floor is in hold (proactive engaged)', s.floorState() === 'hold', s.floorState());
    expect('reactive sheddedCount is STILL 0 at hold (nothing shed yet)', s.backpressure().sheddedCount === 0, JSON.stringify(s.backpressure()));

    // keep pushing PAST capacity (maxPending 3) — now, and only now, the reactive backstop sheds.
    chat(c, 'three', 'm3');
    chat(c, 'four', 'm4');
    chat(c, 'five', 'm5');
    await until(() => s.backpressure().sheddedCount > 0, 'reactive shed finally fires past capacity');
    expect('the floor was ALREADY in hold when the shed fired (proactive-first)', s.floorState() === 'hold', s.floorState());
    c.ws.close();
  } finally { await s.close(); }
});

// T-BACKPRESSURE-COUNTED: input beyond capacity → ambient overflow shed WITH an explicit count surfaced
// in situation().backpressure (never silent); the high-priority WORK ITEM (a question) is PRESERVED.
test('T-BACKPRESSURE-COUNTED: ambient overflow shed with an explicit surfaced count; work items preserved', async () => {
  // Small bound so the flood overflows. Wearable default (enqueue:'all' ⇒ ambient enters as low priority;
  // a question is high priority). settlingMs:0 ⇒ one turn per line. Floor disabled here — the reactive
  // backstop must COUNT + SURFACE the shed on its own (it is independent of, and secondary to, the floor).
  const s = await createServer({ port: 0, settlingMs: 0, queueMaxPending: 3 });
  try {
    const c = await client(s.url(), { userId: 'u1', userName: 'Speaker', role: 'participant' });

    // a directed QUESTION (high priority) — must survive the flood.
    chat(c, 'should we ship it?', 'q1');
    await until(() => s.workItems().some((w) => /ship it/.test(w.text)), 'question enqueued');

    // now FLOOD ambient statements far beyond the bound (maxPending 3) — the queue sheds the ambient.
    for (let i = 0; i < 12; i++) chat(c, 'ambient chatter number ' + i, 'a' + i);
    await until(() => s.backpressure().sheddedCount > 0, 'ambient overflow shed');

    const bp = s.backpressure();
    expect('sheddedCount is an explicit positive count (never silent)', typeof bp.sheddedCount === 'number' && bp.sheddedCount > 0, JSON.stringify(bp));

    // the count is SURFACED in the situation working set (the consumer sees it, not a silent drop).
    const sit = s.situation({ consumerId: 'bp' });
    expect('situation surfaces backpressure.sheddedCount', sit.backpressure && typeof sit.backpressure.sheddedCount === 'number' && sit.backpressure.sheddedCount > 0, JSON.stringify(sit.backpressure));
    expect('queue stayed BOUNDED under the flood (<= maxPending)', sit.queue.length <= 3, String(sit.queue.length));
    // the WORK ITEM (the question) is PRESERVED — ambient was shed around it, never it.
    expect('the directed question SURVIVED the shed (work items preserved)', sit.queue.some((w) => /ship it/.test(w.text)), JSON.stringify(sit.queue.map((w) => w.text)));
    c.ws.close();
  } finally { await s.close(); }
});

// T-ZERO-WHEN-OFF (regression): the client-side floor cue lives inside the AP-VOICE fenced block, so the
// served audience page carries ZERO floor code when voice is OFF (and it IS present when ON).
test('T-ZERO-WHEN-OFF (regression): the floor cue is fenced — absent from the served OFF page', async () => {
  const off = await createServer({ port: 0, voiceEnabled: false });
  try {
    const raw = await getPage(off.url() + '/');
    expect("no floor handler (t === 'floor') in the OFF page", !/'floor'/.test(raw) && !/please hold/i.test(raw), 'floor markers leaked into OFF page');
  } finally { await off.close(); }
  const on = await createServer({ port: 0, voiceEnabled: true });
  try {
    const raw = await getPage(on.url() + '/');
    expect('the floor cue IS present when voice is ON (proves it was fenced, not deleted)', /'floor'/.test(raw), 'floor handler missing when ON');
  } finally { await on.close(); }
});
