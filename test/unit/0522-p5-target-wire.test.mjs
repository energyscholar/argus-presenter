/*
 * Plan 0522 P5 — THE UNIFIED TARGET, SERVER SIDE.
 *
 * P5's ruling is "ONE control, not two: the preview shows what THAT target will see, and GO ships
 * to THAT target." That only means anything if a target is one idea end to end — the same string
 * addresses the same people whether it is being previewed or published, and it survives the wire
 * as an ARRAY from the first commit (Bruce: *"data structure should support it later"*). The UI
 * enforces single-select; the protocol, the server handler and the log never learn of it.
 *
 *   t10 — a single target travels as a one-element ARRAY, is echoed back as one, and NARROWS
 *         delivery to exactly those people. `station:<uid>` addresses that station's occupants;
 *         an unoccupied one is honestly 0 (I5). `['all']` means "do not narrow" — byte-identical
 *         to what clicking a beat has always done, per-beat `target:` and layers included.
 *   t11 — a candidate STAGED for a target is rendered AS that target. This is the fidelity bug the
 *         phase names: every identity-bearing branch of renderDisplay stamped the DELIVERY socket,
 *         so previewing a per-user beat showed the presenter the one version no player would get.
 *         (The browser half of t11 — that picking a target changes the pixels in the preview — is
 *         in test/component/0522-p5-target-selector.test.mjs.)
 *
 * Also guarded here, because P5 is what makes explicit targets the ORDINARY path rather than a
 * rarity: a per-user LAYER must survive a send addressed to that user's station (audience
 * intersection, not target-string equality), and a station push must resolve to the PEOPLE seated
 * there rather than leaving a phantom `station:N` row in the durable display map.
 *
 * Server-side only — presence(), the display maps and handleControl, no browser — so this sits in
 * the unit tier beside 0522-p4-staging.test.mjs, which drives the server the same way.
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

async function open(server, hello) {
  const ws = new WebSocket(server.url().replace('http', 'ws'));
  const frames = [];
  ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) {} });
  await new Promise((res, rej) => { ws.on('error', rej); ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', ...hello })); res(); }); });
  await wait(150);
  return {
    ws, frames,
    control: (action, args) => ws.send(JSON.stringify({ t: 'control', action, args: args || {} })),
    of: (t) => frames.filter((f) => f.t === t),
    contentIds: () => frames.filter((f) => f.t === 'content').map((f) => f.contentId),
    lastHtml: () => { const f = frames.filter((x) => x.t === 'content'); return f.length ? (f[f.length - 1].html || '') : ''; },
    last: (t) => [...frames].reverse().find((f) => f.t === t) || null,
  };
}

// Beats carry a promptId, so `contentId` names the beat that arrived without parsing HTML.
const MODULE = {
  title: 'P5 fixture',
  beats: [
    { id: 'b1', component: 'card', promptId: 'pr-b1', opts: { title: 'Beat b1' } },
    { id: 'b2', component: 'card', promptId: 'pr-b2', opts: { title: 'Beat b2' } },
    // `target:'participant'` is the routing an explicit ['all'] must NOT trample: a beat that
    // declares its own audience keeps it when the selector says ALL.
    { id: 'bp', component: 'card', promptId: 'pr-bp', opts: { title: 'Participants only' }, target: 'participant' },
  ],
};

/** Station 2 = Pilot, station 5 = Gunner, station 9 = Medic (declared by plugins/starship-ops). */
const PILOT = 'station:2', GUNNER = 'station:5', EMPTY = 'station:9';

test('0522 t10 — a single target travels as an ARRAY and narrows delivery to exactly those people', async () => {
  const server = await createServer({ port: 0 });
  let gm, alice, bob;
  try {
    gm = await open(server, { userId: 'gm1', userName: 'GM', role: 'presenter' });
    alice = await open(server, { stationUID: 2, userName: 'Alice' });     // Pilot
    bob = await open(server, { stationUID: 5, userName: 'Bob' });         // Gunner
    await until(() => server.presence().length === 3, { label: 'three people connected' });
    const aliceId = server.presence().find((u) => u.userName === 'Alice').userId;
    const bobId = server.presence().find((u) => u.userName === 'Bob').userId;
    expect('precondition: the two players are seated at DIFFERENT stations',
      server.presence().find((u) => u.userName === 'Alice').stationUid === 2
      && server.presence().find((u) => u.userName === 'Bob').stationUid === 5, JSON.stringify(server.presence()));

    server.setModule(JSON.parse(JSON.stringify(MODULE)));
    await wait(100);

    // ── One PERSON. The array is preserved on the way in and echoed on the way out.
    alice.frames.length = 0; bob.frames.length = 0;
    gm.control('send_beat', { id: 'b1', targets: [aliceId] });
    await until(() => !!gm.last('sent'), { label: 'the send is acknowledged' });
    const one = gm.last('sent');
    expect('the ack carries targets as an ARRAY, not the scalar the UI thinks it picked',
      Array.isArray(one.targets) && one.targets.length === 1 && one.targets[0] === aliceId, JSON.stringify(one.targets));
    expect('a single named target reports exactly one recipient (I5)',
      one.ok === true && one.sent === true && one.recipients === 1 && one.sockets === 1, JSON.stringify(one));
    await until(() => alice.contentIds().indexOf('pr-b1') >= 0, { label: 'alice received b1' });
    await wait(200);
    expect('and NOBODY else did — a narrowed send is actually narrow',
      bob.contentIds().indexOf('pr-b1') < 0, JSON.stringify(bob.contentIds()));

    // ── A bare string is tolerated and becomes an array. The protocol never carries a scalar
    //    downstream, so a later multiselect needs no second code path (and no second bug).
    gm.frames.length = 0; bob.frames.length = 0;
    gm.control('send_beat', { id: 'b2', targets: bobId });
    await until(() => !!gm.last('sent'), { label: 'the bare-string send is acknowledged' });
    expect('a bare string target is normalised to a one-element array',
      Array.isArray(gm.last('sent').targets) && gm.last('sent').targets[0] === bobId, JSON.stringify(gm.last('sent').targets));
    await until(() => bob.contentIds().indexOf('pr-b2') >= 0, { label: 'bob received b2' });

    // ── A STATION. The selector offers stations, so the wire has to address them; core holds no
    //    occupancy, it asks the plugin per connection exactly as pushPresence does.
    gm.frames.length = 0; alice.frames.length = 0; bob.frames.length = 0;
    gm.control('send_beat', { id: 'b1', targets: [GUNNER] });
    await until(() => !!gm.last('sent'), { label: 'the station send is acknowledged' });
    const st = gm.last('sent');
    expect('a station target reports the ONE person seated there', st.recipients === 1 && st.sockets === 1, JSON.stringify(st));
    expect('and echoes the station as the array element it arrived as',
      JSON.stringify(st.targets) === JSON.stringify([GUNNER]), JSON.stringify(st.targets));
    await until(() => bob.contentIds().indexOf('pr-b1') >= 0, { label: 'the occupant of Gunner received it' });
    await wait(200);
    expect('the pilot, who is not at that station, received nothing',
      alice.contentIds().indexOf('pr-b1') < 0, JSON.stringify(alice.contentIds()));

    // A station push is durable FOR THE OCCUPANTS. A `station:5` key in displayByUser would be a
    // row no connection ever reads, visible in the roster and surviving everyone leaving.
    const durable = JSON.parse(server._displayStateForTest());
    expect('a station push writes the OCCUPANT\'s per-user display', durable.byUser[bobId] != null, JSON.stringify(Object.keys(durable.byUser)));
    expect('and leaves NO phantom station row behind', durable.byUser[GUNNER] === undefined, JSON.stringify(Object.keys(durable.byUser)));

    // ── An EMPTY station. Honest zero is the whole basis of P6's "sent to 0 recipients" (I5).
    gm.frames.length = 0;
    gm.control('send_beat', { id: 'b2', targets: [EMPTY] });
    await until(() => !!gm.last('sent'), { label: 'the empty-station send is acknowledged' });
    const zero = gm.last('sent');
    expect('an unoccupied station SUCCEEDS and reports 0 recipients, rather than pretending',
      zero.ok === true && zero.sent === true && zero.recipients === 0 && zero.sockets === 0, JSON.stringify(zero));
    expect('and writes no durable row for a station nobody occupies',
      JSON.parse(server._displayStateForTest()).byUser[EMPTY] === undefined, server._displayStateForTest().slice(0, 200));

    // ── ['all'] means DO NOT NARROW — the beat's own declared routing still applies. This is what
    //    makes picking the default target byte-identical to the click path a live session runs.
    gm.frames.length = 0; alice.frames.length = 0; bob.frames.length = 0;
    gm.control('send_beat', { id: 'bp', targets: ['all'] });
    await until(() => !!gm.last('sent'), { label: 'the ALL send is acknowledged' });
    await until(() => alice.contentIds().indexOf('pr-bp') >= 0 && bob.contentIds().indexOf('pr-bp') >= 0,
      { label: 'both participants received the participant-routed beat' });
    await wait(200);
    expect('a beat declaring target:"participant" still went to participants only — ALL did not trample its routing',
      gm.contentIds().indexOf('pr-bp') < 0, JSON.stringify(gm.contentIds()));
    expect('and the ack reports the beat\'s OWN target, not a fabricated "all"',
      JSON.stringify(gm.last('sent').targets) === JSON.stringify(['participant']), JSON.stringify(gm.last('sent').targets));
  } finally {
    for (const c of [gm, alice, bob]) if (c) c.ws.close();
    await server.close();
  }
});

test('0522 t11 — a candidate staged for a target is rendered AS that target, not as the presenter', async () => {
  const server = await createServer({ port: 0 });
  let gm, alice;
  try {
    gm = await open(server, { userId: 'gm1', userName: 'GM', role: 'presenter' });
    alice = await open(server, { stationUID: 2, userName: 'Alice' });
    await until(() => server.presence().length === 2, { label: 'gm + alice connected' });
    const aliceId = server.presence().find((u) => u.userName === 'Alice').userId;

    server.setModule(JSON.parse(JSON.stringify(MODULE)));
    await wait(100);

    // Baseline: no target ⇒ the candidate is stamped with the CALLER's identity, unchanged.
    gm.frames.length = 0;
    gm.control('stage_beat', { id: 'b1' });
    await until(() => !!gm.last('staged'), { label: 'staged with no target' });
    await wait(150);
    const own = gm.lastHtml();
    expect('with no target, the preview is still stamped as the caller — the default is unchanged',
      own.indexOf('"userId":"gm1"') >= 0, own.slice(Math.max(0, own.indexOf('OPTS')), own.indexOf('OPTS') + 200));

    // The fidelity fix: staged FOR alice ⇒ stamped as alice, delivered down the GM's socket.
    gm.frames.length = 0;
    gm.control('stage_beat', { id: 'b1', targets: [aliceId] });
    await until(() => !!gm.last('staged'), { label: 'staged for alice' });
    await wait(150);
    const asAlice = gm.lastHtml();
    expect('the ack says which target it was rendered as', gm.last('staged').as === aliceId, JSON.stringify(gm.last('staged')));
    expect('the preview carries the TARGET\'s identity', asAlice.indexOf('"userId":"' + aliceId + '"') >= 0, asAlice.slice(0, 80));
    expect('and NOT the presenter\'s — this is the version a player would actually receive',
      asAlice.indexOf('"userId":"gm1"') < 0 && asAlice.indexOf('"viewerRole":"presenter"') < 0, 'presenter identity leaked into the preview');
    expect('the candidate reached only the controller — staging still publishes nothing',
      alice.contentIds().indexOf('pr-b1') < 0, JSON.stringify(alice.contentIds()));

    // A STATION target renders as whoever is sitting there.
    gm.frames.length = 0;
    gm.control('stage_beat', { id: 'b2', targets: [PILOT] });
    await until(() => !!gm.last('staged'), { label: 'staged for the pilot station' });
    await wait(150);
    expect('a station target previews as its OCCUPANT',
      gm.lastHtml().indexOf('"userId":"' + aliceId + '"') >= 0, gm.lastHtml().slice(0, 80));

    // An UNOCCUPIED station still previews — as a synthetic participant carrying the station's
    // label. `participant` is the conservative role: the OPSEC strip can only remove more.
    gm.frames.length = 0;
    gm.control('stage_beat', { id: 'b2', targets: [EMPTY] });
    await until(() => !!gm.last('staged'), { label: 'staged for an empty station' });
    await wait(150);
    const empty = gm.lastHtml();
    expect('an empty station previews as a participant, never as the presenter',
      empty.indexOf('"viewerRole":"participant"') >= 0 && empty.indexOf('"viewerRole":"presenter"') < 0, empty.slice(0, 80));

    // And GO with no targets of its own ships where the preview said it would — one control.
    gm.frames.length = 0; alice.frames.length = 0;
    gm.control('stage_beat', { id: 'b2', targets: [aliceId] });
    await until(() => !!gm.last('staged'), { label: 're-staged for alice' });
    gm.control('send_beat', {});
    await until(() => !!gm.last('sent'), { label: 'the inherited-target send is acknowledged' });
    expect('a GO with no targets inherits the ones the preview was rendered for',
      JSON.stringify(gm.last('sent').targets) === JSON.stringify([aliceId]), JSON.stringify(gm.last('sent').targets));
    await until(() => alice.contentIds().indexOf('pr-b2') >= 0, { label: 'alice received the sent beat' });
  } finally {
    for (const c of [gm, alice]) if (c) c.ws.close();
    await server.close();
  }
});

test('0522 P5 — a per-user layer survives a send addressed to that user\'s STATION', async () => {
  // P4 skipped a layer unless the explicit target list literally CONTAINED `L.target`. That was
  // right for the one case it had; P5 makes explicit targets ordinary, and string equality then
  // drops a layer whose target names the same person by another name. A dropped layer is a beat
  // that arrives without its personalisation, silently (I4). Audiences intersect; strings do not.
  const server = await createServer({ port: 0 });
  let gm, alice;
  try {
    gm = await open(server, { userId: 'gm1', userName: 'GM', role: 'presenter' });
    alice = await open(server, { stationUID: 2, userName: 'Alice' });
    await until(() => server.presence().length === 2, { label: 'gm + alice connected' });
    const aliceId = server.presence().find((u) => u.userName === 'Alice').userId;

    server.setModule({
      title: 'layered',
      beats: [{
        id: 'bl', component: 'card', promptId: 'pr-bl', opts: { title: 'BASE COPY' },
        layers: [{ target: aliceId, opts: { title: 'ALICE ONLY' } }],
      }],
    });
    await wait(100);

    alice.frames.length = 0;
    gm.control('send_beat', { id: 'bl', targets: [PILOT] });
    await until(() => !!gm.last('sent'), { label: 'the station send is acknowledged' });
    await until(() => alice.lastHtml().indexOf('ALICE ONLY') >= 0, { label: 'alice received her layered copy' })
      .catch(() => {});
    expect('the layer addressed by userId reached the person addressed by station',
      alice.lastHtml().indexOf('ALICE ONLY') >= 0, alice.lastHtml().indexOf('BASE COPY') >= 0 ? 'she got only the BASE copy — the layer was dropped' : 'she got nothing');
  } finally {
    for (const c of [gm, alice]) if (c) c.ws.close();
    await server.close();
  }
});
