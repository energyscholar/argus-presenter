/*
 * Plan 0522 P4 (R4) — TWO-STAGE DELIVERY EXISTS SERVER-SIDE, PUBLISH UNTOUCHED.
 *
 * `stage_beat` renders a CANDIDATE beat to the calling controller's own surface. `send_beat`
 * publishes what that caller staged, taking `targets`, and reports how many recipients it
 * actually reached (I5). `show_beat` is NOT redefined: it still publishes immediately, on both
 * surfaces, because every existing cue script and the MCP tool depend on that (R4, §5).
 *
 * Staging reuses the EXISTING renderer. `renderDisplay(ws, c, desc)` was already parameterised
 * on (socket, connection, descriptor) and consults no global live state, so staging is that call
 * with a candidate descriptor and WITHOUT a write to displayByUser/displayByRole. No second
 * rendering engine exists, and this suite is what stops one appearing.
 *
 *   t07 — staging mutates NO durable state: displayByRole, displayByUser and every seat's
 *         stationUid are byte-identical across a stage, and no participant receives anything.
 *   t08 — show_beat STILL PUBLISHES IMMEDIATELY, on the WS control surface and the in-process
 *         (MCP) surface alike, and leaves no staging slot behind. Regression guard on cue scripts.
 *   t09 — staging is PER-CALLER: one controller's stage neither renders to, nor arms GO on, a
 *         second controller. Plus the I5 accounting — recipients counted, zero reported as zero.
 *
 * Server-side only — presence(), the display maps and handleControl are core functions with no
 * browser involved — so this sits in the unit tier, alongside 0522-p3-roster-collapse.test.mjs
 * and auth-role.test.mjs, which drive the server the same way.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(pred, { timeout = 4000, every = 25, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return true;
    if (Date.now() - t0 > timeout) throw new Error('timeout waiting for ' + label);
    await wait(every);
  }
}

/** Open a socket, hello, and keep every frame. `send` drives the control protocol. */
async function open(server, hello) {
  const ws = new WebSocket(server.url().replace('http', 'ws'));
  const frames = [];
  ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) {} });
  await new Promise((res, rej) => { ws.on('error', rej); ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', ...hello })); res(); }); });
  await wait(150);
  return {
    ws, frames,
    send: (m) => ws.send(JSON.stringify(m)),
    control: (action, args) => ws.send(JSON.stringify({ t: 'control', action, args: args || {} })),
    of: (t) => frames.filter((f) => f.t === t),
    contentIds: () => frames.filter((f) => f.t === 'content').map((f) => f.contentId),
    last: (t) => [...frames].reverse().find((f) => f.t === t) || null,
  };
}

// Beats carry a promptId, so `contentId` on the wire names the beat that arrived — the only way
// to tell WHICH beat a client was shown without parsing HTML.
const MODULE = {
  title: 'P4 fixture',
  beats: [
    { id: 'b1', component: 'card', promptId: 'pr-b1', opts: { title: 'Beat b1' } },
    { id: 'b2', component: 'card', promptId: 'pr-b2', opts: { title: 'Beat b2' } },
    { id: 'b3', component: 'card', promptId: 'pr-b3', opts: { title: 'Beat b3' } },
  ],
};

test('0522 t07 — staging mutates NO durable state (I3)', async () => {
  const server = await createServer({ port: 0 });
  let gm, p1, p2;
  try {
    gm = await open(server, { userId: 'gm1', userName: 'GM', role: 'presenter' });
    // Seat-linked participants, so every seat really carries a stationUid to compare.
    p1 = await open(server, { stationUID: 1, userName: 'James' });
    p2 = await open(server, { stationUID: 4, userName: 'Von' });
    await until(() => server.presence().length === 3, { label: 'three people connected' });
    const seated = server.presence().filter((u) => u.stationUid != null);
    expect('precondition: the seats carry station uids, so the comparison can fail',
      seated.length >= 2, JSON.stringify(server.presence()));

    server.setModule(MODULE);
    server.showBeat('b2');                                                    // populates displayByRole
    const uid = (server.presence().find((u) => u.stationUid === 1) || {}).userId;
    server.pushComponent(uid, 'card', { title: 'a private push' }, 'argus', []);   // populates displayByUser
    await until(() => p1.contentIds().length >= 2, { label: 'the seat has taken the per-user push' });

    // The three things the plan names, serialised. Compared as STRINGS, not spot-checked field by
    // field: a descriptor that grows a field would walk straight through a field-by-field check.
    const displayBefore = server._displayStateForTest();
    const stationsBefore = JSON.stringify(server.presence().map((u) => [u.userId, u.stationUid]).sort());
    const moduleCurrentBefore = server.store.get('module/current');
    const p1Before = p1.contentIds().slice();
    const p2Before = p2.contentIds().slice();

    expect('precondition: displayByUser is non-empty, so an accidental clear would be VISIBLE',
      displayBefore.indexOf('a private push') > 0, displayBefore.slice(0, 200));

    gm.control('stage_beat', { id: 'b3' });
    await until(() => !!gm.last('staged'), { label: 'the stage is acknowledged' });

    const ack = gm.last('staged');
    expect('the stage is acknowledged as staged, naming the beat', ack.ok === true && ack.staged === true && ack.beatId === 'b3', JSON.stringify(ack));
    expect('the candidate was rendered to the caller (this is not passing by doing nothing)', ack.rendered === true, JSON.stringify(ack));
    expect('the controller actually received the candidate beat', gm.contentIds().indexOf('pr-b3') >= 0, JSON.stringify(gm.contentIds()));

    await wait(200);   // settle: any stray push would have landed by now

    expect('displayByRole + displayByUser are BYTE-IDENTICAL across the stage',
      server._displayStateForTest() === displayBefore,
      'before=' + displayBefore.slice(0, 240) + '\n after=' + server._displayStateForTest().slice(0, 240));
    expect('every seat\'s stationUid is byte-identical across the stage',
      JSON.stringify(server.presence().map((u) => [u.userId, u.stationUid]).sort()) === stationsBefore, stationsBefore);
    expect('module/current is untouched — staging is not a navigation',
      server.store.get('module/current') === moduleCurrentBefore, String(server.store.get('module/current')));
    expect('participant 1 received NOTHING from the stage',
      JSON.stringify(p1.contentIds()) === JSON.stringify(p1Before), JSON.stringify(p1.contentIds()));
    expect('participant 2 received NOTHING from the stage',
      JSON.stringify(p2.contentIds()) === JSON.stringify(p2Before), JSON.stringify(p2.contentIds()));

    // ...and a reconnect must not resurrect the staged beat: the staging slot is not a display map.
    const rejoin = await open(server, { userId: 'gm1', userName: 'GM', role: 'presenter' });
    await wait(150);
    expect('a fresh control socket redisplays the LIVE beat, never the staged one',
      rejoin.contentIds().indexOf('pr-b3') < 0 && rejoin.contentIds().indexOf('pr-b2') >= 0,
      JSON.stringify(rejoin.contentIds()));
    rejoin.ws.close();
  } finally {
    for (const c of [gm, p1, p2]) if (c) c.ws.close();
    await server.close();
  }
});

test('0522 t08 — show_beat still PUBLISHES IMMEDIATELY on both surfaces (R4 regression guard)', async () => {
  const server = await createServer({ port: 0 });
  let gm, pl;
  try {
    gm = await open(server, { userId: 'gm1', userName: 'GM', role: 'presenter' });
    pl = await open(server, { userId: 'pl1', userName: 'Player', role: 'participant' });
    await until(() => server.presence().length === 2, { label: 'both connected' });
    server.setModule(MODULE);

    // Surface 1 — the control page / WS protocol. This is the gesture a cue script performs.
    gm.control('show_beat', { index: 1 });
    await until(() => pl.contentIds().indexOf('pr-b2') >= 0, { label: 'the player is shown b2 by show_beat' });
    expect('show_beat over the control socket reached the player with NO second step',
      pl.contentIds().indexOf('pr-b2') >= 0, JSON.stringify(pl.contentIds()));
    expect('and it moved the live beat', server.store.get('module/current') === 1, String(server.store.get('module/current')));

    // It must not have merely STAGED: with nothing armed, send_beat has nothing to send.
    const empty = server.sendBeat({}, { key: 'ws:probe' });
    expect('show_beat left NO staging slot behind — it published', empty.ok === false && empty.reason === 'nothing-staged', JSON.stringify(empty));

    // Surface 2 — in-process (what the MCP show_beat tool calls). Same immediate publish.
    const before = pl.contentIds().length;
    const r = server.showBeat('b3');
    await until(() => pl.contentIds().length > before, { label: 'the player is shown b3 by the api surface' });
    expect('api.showBeat published immediately too', pl.contentIds().indexOf('pr-b3') >= 0, JSON.stringify(pl.contentIds()));
    expect('and its return shape is unchanged {index, component, target}',
      r && r.index === 2 && r.component === 'card' && r.target === 'all', JSON.stringify(r));
    expect('an out-of-range ref still returns null', server.showBeat(99) === null && server.showBeat('nope') === null);

    // The routing and layer behaviour show_beat has always had, unchanged by the shared publish path.
    server.setModule({ title: 'routed', beats: [{ id: 'r1', component: 'card', promptId: 'pr-r1', target: 'presenter', opts: { title: 'GM only' } }] });
    const gmBefore = gm.contentIds().length, plBefore = pl.contentIds().length;
    server.showBeat('r1');
    await until(() => gm.contentIds().length > gmBefore, { label: 'the presenter-targeted beat lands on the GM' });
    await wait(150);
    expect('a beat declaring target:presenter still routes to the presenter alone',
      gm.contentIds().indexOf('pr-r1') >= 0 && pl.contentIds().length === plBefore,
      'gm=' + JSON.stringify(gm.contentIds()) + ' pl=' + JSON.stringify(pl.contentIds()));
  } finally {
    for (const c of [gm, pl]) if (c) c.ws.close();
    await server.close();
  }
});

test('0522 t09 — staging is PER-CALLER, and send_beat reports the recipients it reached (I5)', async () => {
  const server = await createServer({ port: 0 });
  let a, b, pl;
  try {
    a = await open(server, { userId: 'gmA', userName: 'GM A', role: 'presenter' });
    b = await open(server, { userId: 'gmB', userName: 'GM B', role: 'presenter' });
    pl = await open(server, { userId: 'pl1', userName: 'Player', role: 'participant' });
    await until(() => server.presence().length === 3, { label: 'two controllers and a player' });
    server.setModule(MODULE);
    server.showBeat('b1');
    await until(() => pl.contentIds().indexOf('pr-b1') >= 0, { label: 'everyone is live on b1' });
    await wait(100);

    const bBefore = b.contentIds().slice();
    const plBefore = pl.contentIds().slice();

    a.control('stage_beat', { id: 'b3' });
    await until(() => !!a.last('staged'), { label: 'controller A staged' });
    await wait(200);

    expect('controller A sees the candidate', a.contentIds().indexOf('pr-b3') >= 0, JSON.stringify(a.contentIds()));
    expect('controller B\'s display is UNAFFECTED by A\'s stage',
      JSON.stringify(b.contentIds()) === JSON.stringify(bBefore), JSON.stringify(b.contentIds()));
    expect('the player\'s display is unaffected too', JSON.stringify(pl.contentIds()) === JSON.stringify(plBefore), JSON.stringify(pl.contentIds()));

    // B's GO is NOT armed by A's stage — the slot is keyed to the socket that staged.
    b.control('send_beat', { targets: ['all'] });
    await until(() => !!b.last('sent'), { label: 'controller B got an answer' });
    const bSent = b.last('sent');
    expect('controller B has nothing staged and is told so, rather than shipping A\'s candidate',
      bSent.ok === false && bSent.reason === 'nothing-staged' && bSent.sent === false, JSON.stringify(bSent));
    await wait(150);
    expect('and B\'s refused send published nothing to the player',
      JSON.stringify(pl.contentIds()) === JSON.stringify(plBefore), JSON.stringify(pl.contentIds()));

    // A's GO ships, and the ack accounts for delivery (I5): 3 people are connected.
    a.control('send_beat', { targets: ['all'] });
    await until(() => !!a.last('sent'), { label: 'controller A sent' });
    await until(() => pl.contentIds().indexOf('pr-b3') >= 0, { label: 'the player receives the sent beat' });
    const aSent = a.last('sent');
    expect('A\'s send shipped the beat A staged', aSent.ok === true && aSent.sent === true && aSent.beatId === 'b3', JSON.stringify(aSent));
    expect('the ack carries the recipient count — 3 people are connected', aSent.recipients === 3, JSON.stringify(aSent));
    expect('targets travel as the ARRAY they arrived as', JSON.stringify(aSent.targets) === JSON.stringify(['all']), JSON.stringify(aSent.targets));
    expect('the send DID move the live beat (a publish, not a preview)', server.store.get('module/current') === 2, String(server.store.get('module/current')));

    // The slot disarms on send: a second GO is not a silent re-send.
    a.frames.length = 0;
    a.control('send_beat', { targets: ['all'] });
    await until(() => !!a.last('sent'), { label: 'controller A got a second answer' });
    expect('a second GO with nothing staged is refused, not a silent repeat',
      a.last('sent').ok === false && a.last('sent').reason === 'nothing-staged', JSON.stringify(a.last('sent')));

    // I5 — sending to a target nobody occupies reports ZERO. The UI surfacing is P6; the honest
    // number in the ack is P4's, and without it P6 has nothing truthful to show.
    a.control('stage_beat', { id: 'b2' });
    await until(() => !!a.last('staged') && a.last('staged').beatId === 'b2', { label: 'A staged b2' });
    a.frames.length = 0;
    a.control('send_beat', { targets: ['nobody-is-here'] });
    await until(() => !!a.last('sent'), { label: 'the empty-target send is acknowledged' });
    const zero = a.last('sent');
    expect('a send to an unoccupied target SUCCEEDS but reports 0 recipients',
      zero.ok === true && zero.sent === true && zero.recipients === 0 && zero.sockets === 0, JSON.stringify(zero));

    // A stage slot must not outlive its controller.
    a.ws.close(); a = null;
    await wait(200);
    expect('the staging slot dies with the socket that owned it',
      server.stagedBeat({ key: 'ws:c1' }) === null, JSON.stringify(server.stagedBeat({ key: 'ws:c1' })));
  } finally {
    for (const c of [a, b, pl]) if (c) c.ws.close();
    await server.close();
  }
});
