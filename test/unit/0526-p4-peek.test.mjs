/*
 * Plan 0526 P4 (plan 0534 wave W4b) — PEEK / UNPEEK: self-service navigation.
 *
 * A participant summons a declared surface onto THEIR OWN screen, and puts it away again, without
 * changing what anyone else sees and without disturbing the session's beat. That last clause is
 * the whole difficulty: every existing way to put something on a screen either writes a seat
 * (`station-select`), reaches other people (`station-share`), or is a controller's to press. This
 * is the first one that belongs to the person looking.
 *
 *   t0526-07  ⛓ ONLY THE PEEKER'S SCREEN CHANGES — the other participant and the presenter get
 *             nothing at all. This is the property the phase exists for and the easy one to lose.
 *   t0526-08  `unpeek` returns the viewer to WHAT THE ROOM IS SHOWING NOW — including a beat that
 *             moved while they were away. (Declared ruling, not an accident: see below.)
 *   t0526-09  ⛔ DEFAULT-DENY holds, and every refusal fires BY NAME with nothing rendered.
 *   t0526-10  a peek DISTURBS NOTHING — durable display state byte-identical, module and beat
 *             untouched, and a viewer who joins afterwards still lands on the room's beat.
 *   t0526-11  a participant with NO station screen of their own can still peek.
 *
 * ⛓ THE RULING THIS FILE ENCODES, stated so the next reader does not have to infer it:
 *   · THE ROOM WINS. A room push during a peek lands on the peeker like anybody else — there is no
 *     peek STATE to defer to, so a presenter can always reach a viewer (0526 P4's precedence).
 *   · UNPEEK IS "NOW", NOT "THEN". It re-renders the LIVE display maps, so a viewer who peeked at
 *     beat 1 and unpeeks at beat 2 rejoins at beat 2. Restoring a snapshot would strand one person
 *     on a beat nobody else is on, invisibly to the presenter — the desync peek exists to avoid.
 *   · SURFACES ARE ADDRESSED BY UID (naming canon §3). `{t:'peek', surfaceUid:<int>}`. The
 *     author's `surfaceId` is not on the wire and is refused as `not-a-uid` if sent.
 *
 * NAMES: invented and neutral throughout (guard t0531-01). Two plugins, `alpha` and `beta`;
 * nothing here names anybody's session, setting or seat.
 *
 * Unit tier: no browser. `port: 0` and `tunnel:false`, so nothing binds :3000 or :4300.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { makePluginsDir, withPlugins, connect, last, wait } from './_0514-fixtures.mjs';
import { WebSocket } from 'ws';

const SURFACE_MARK = 'PEEK-SURFACE-MARK';
const OTHER_MARK = 'PEEK-OTHER-SURFACE-MARK';
const BEAT1 = 'PEEK-BEAT-ONE';
const BEAT2 = 'PEEK-BEAT-TWO';

/** One plugin, two surfaces: one offered to viewers, one that never said it may be. */
const ALPHA = {
  name: 'alpha', requires: [], components: [], presets: {}, fieldSchemas: {},
  surfaces: [
    { surfaceId: 'open-screen', surfaceLabel: 'The open screen', peekable: true, icon: '#', sortOrder: 1,
      screen: { component: 'card', opts: { title: 'The open screen', body: SURFACE_MARK } } },
    // NO `peekable` key at all — default-deny is what t0526-09 is about.
    { surfaceId: 'closed-screen', surfaceLabel: 'The closed screen', sortOrder: 2,
      screen: { component: 'card', opts: { title: 'The closed screen', body: 'nope' } } },
  ],
};

/** A SECOND plugin's surface, to keep the uid assignment honest across a merge. */
const BETA = {
  name: 'beta', requires: [], components: [], presets: {}, fieldSchemas: {},
  surfaces: [
    { surfaceId: 'second-screen', surfaceLabel: 'The second screen', peekable: true, sortOrder: 3,
      screen: { component: 'card', opts: { title: 'The second screen', body: OTHER_MARK } } },
  ],
};

const TWO_BEAT_MODULE = {
  title: 'A module',
  manifest: { title: 'A module' },
  beats: [
    { id: 'one', component: 'card', opts: { title: 'Beat one', body: BEAT1 } },
    { id: 'two', component: 'card', opts: { title: 'Beat two', body: BEAT2 } },
  ],
};

/** Run `fn` against a server booted over a throwaway plugin tree, and always close it. */
async function withServer(plugins, fn) {
  const dir = makePluginsDir(plugins);
  return withPlugins(dir, async () => {
    const server = await createServer({ port: 0, tunnel: false });
    try { return await fn(server); } finally { await server.close(); }
  });
}

const BOTH_PLUGINS = { alpha: { 'plugin.json': ALPHA }, beta: { 'plugin.json': BETA } };

/**
 * How a CLIENT finds a surface, and therefore how these tests do: read the label off the list the
 * server sent, address it by the uid that came with it. No test below names a surface by its code.
 */
const uidOf = (server, surfaceLabel) => {
  const row = server.surfaces().surfaces.find((s) => s.surfaceLabel === surfaceLabel);
  return row ? row.surfaceUid : null;
};

/** Every `content` frame this connection has received, newest last. */
const contents = (conn) => conn.frames.filter((f) => f.t === 'content');

const wsUrl = (server) => server.url().replace('http', 'ws');

test('t0526-07 — ⛓ a peek changes ONLY the peeker\'s screen: the other participant and the presenter see nothing', async () => {
  await withServer(BOTH_PLUGINS, async (server) => {
    const peeker = await connect(WebSocket, wsUrl(server), { userId: 'p-one', userName: 'Peeker' });
    const bystander = await connect(WebSocket, wsUrl(server), { userId: 'p-two', userName: 'Bystander' });
    const presenter = await connect(WebSocket, wsUrl(server), { userId: 'host', userName: 'Host', role: 'presenter' });
    try {
      // The room is on a beat, and all three are looking at it.
      server.setModule(TWO_BEAT_MODULE);
      server.showBeat(0);
      await wait(140);
      expect(last(bystander, 'content').html.includes(BEAT1), 'the bystander is on the room\'s beat to start with');
      expect(last(presenter, 'content').html.includes(BEAT1), 'and so is the presenter');

      peeker.clear(); bystander.clear(); presenter.clear();

      // ── ONE PARTICIPANT PEEKS.
      const uid = uidOf(server, 'The open screen');
      expect(Number.isInteger(uid), 'the surface is addressed by an INTEGER uid, off the wire list', String(uid));
      peeker.send({ t: 'peek', surfaceUid: uid });
      await wait(160);

      const mine = last(peeker, 'content');
      expect(mine && mine.html.includes(SURFACE_MARK),
        'the peeker\'s own screen shows the surface', mine && mine.html.slice(0, 160));
      const reply = last(peeker, 'surface');
      expect(reply && reply.ok === true && reply.surfaceUid === uid && reply.surfaceLabel === 'The open screen',
        'and the reply names the surface BY UID, never by the authoring code', JSON.stringify(reply));
      expect(reply.surfaceId === undefined, 'the authoring code is not on the wire (canon §3)', JSON.stringify(reply));

      // ── ⛓ AND NOBODY ELSE'S SCREEN MOVED. Not "shows something else" — receives NOTHING.
      expect(contents(bystander).length === 0,
        'the OTHER PARTICIPANT received no content frame at all', JSON.stringify(contents(bystander).map((f) => f.html.slice(0, 60))));
      expect(contents(presenter).length === 0,
        'and neither did the presenter', JSON.stringify(contents(presenter).map((f) => f.html.slice(0, 60))));
      expect(bystander.frames.length === 0 && presenter.frames.length === 0,
        'no frame of ANY kind reached them — a peek is not a broadcast of any sort',
        JSON.stringify({ by: bystander.frames.map((f) => f.t), pr: presenter.frames.map((f) => f.t) }));

      // A second peeker, at a surface declared by a DIFFERENT plugin, is still only their own.
      bystander.clear();
      bystander.send({ t: 'peek', surfaceUid: uidOf(server, 'The second screen') });
      await wait(160);
      expect(last(bystander, 'content').html.includes(OTHER_MARK), 'the second participant peeks their own choice');
      expect(last(peeker, 'content').html.includes(SURFACE_MARK),
        'and the first one is still on the surface THEY chose — two peeks do not collide');
    } finally { peeker.ws.close(); bystander.ws.close(); presenter.ws.close(); }
  });
});

test('t0526-08 — unpeek returns to what the room is showing NOW, including a beat that moved during the peek', async () => {
  await withServer(BOTH_PLUGINS, async (server) => {
    const viewer = await connect(WebSocket, wsUrl(server), { userId: 'p-one', userName: 'Viewer' });
    try {
      server.setModule(TWO_BEAT_MODULE);
      server.showBeat(0);
      await wait(140);
      expect(last(viewer, 'content').html.includes(BEAT1), 'the room is on beat one');

      viewer.clear();
      viewer.send({ t: 'peek', surfaceUid: uidOf(server, 'The open screen') });
      await wait(160);
      expect(last(viewer, 'content').html.includes(SURFACE_MARK), 'the viewer is looking at a surface');

      // ── THE ROOM MOVES WHILE THEY ARE AWAY. The room WINS: this reaches them immediately,
      // because a peek leaves no state behind for a push to have to defer to.
      viewer.clear();
      server.showBeat(1);
      await wait(140);
      const pushed = last(viewer, 'content');
      expect(pushed && pushed.html.includes(BEAT2),
        'a room push during a peek REACHES the peeker — the presenter is never locked out',
        pushed && pushed.html.slice(0, 160));

      // ── AND UNPEEK GIVES THEM THE ROOM AS IT IS NOW, not the beat they left.
      viewer.clear();
      viewer.send({ t: 'unpeek' });
      await wait(160);
      const back = last(viewer, 'content');
      expect(back && back.html.includes(BEAT2),
        'unpeek returns the viewer to the CURRENT beat', back && back.html.slice(0, 160));
      expect(back && !back.html.includes(BEAT1),
        'and NOT to the beat that was on screen when they peeked — no snapshot is restored',
        back && back.html.slice(0, 160));
      const reply = last(viewer, 'surface');
      expect(reply && reply.ok === true && reply.unpeeked === true && reply.restored === true,
        'and it says so', JSON.stringify(reply));
      expect(reply.surfaceUid === null, 'with no surface on it — the viewer is back in the room', JSON.stringify(reply));
    } finally { viewer.ws.close(); }
  });
});

test('t0526-09 — ⛔ DEFAULT-DENY: a surface that never said it was peekable is refused BY NAME, and nothing renders', async () => {
  await withServer(BOTH_PLUGINS, async (server) => {
    const viewer = await connect(WebSocket, wsUrl(server), { userId: 'p-one', userName: 'Viewer' });
    try {
      server.setModule(TWO_BEAT_MODULE);
      server.showBeat(0);
      await wait(140);
      viewer.clear();

      // ── THE ONE THAT MATTERS: declared, and silent about `peekable`.
      const closed = uidOf(server, 'The closed screen');
      expect(Number.isInteger(closed), 'the closed surface IS declared and IS listed', String(closed));
      viewer.send({ t: 'peek', surfaceUid: closed });
      await wait(160);
      const denial = last(viewer, 'surface');
      expect(denial && denial.ok === false && denial.reason === 'not-peekable',
        'default-deny: silence is NO, and the refusal names the reason', JSON.stringify(denial));
      expect(denial.surfaceUid === closed && denial.surfaceLabel === 'The closed screen',
        'and names the surface it refused', JSON.stringify(denial));
      expect(contents(viewer).length === 0,
        'and NOTHING was rendered — a refused peek does not half-happen', JSON.stringify(contents(viewer).length));

      // ── The other two refusals, each by its own name.
      viewer.clear();
      viewer.send({ t: 'peek', surfaceUid: 9999 });
      await wait(120);
      expect(last(viewer, 'surface').reason === 'no-such-surface',
        'an undeclared uid refuses by name', JSON.stringify(last(viewer, 'surface')));

      viewer.clear();
      viewer.send({ t: 'peek', surfaceUid: 'open-screen' });
      await wait(120);
      expect(last(viewer, 'surface').reason === 'not-a-uid',
        'the AUTHORING code, sent where a uid belongs, fails LOUDLY instead of resolving (canon §3)',
        JSON.stringify(last(viewer, 'surface')));

      viewer.clear();
      viewer.send({ t: 'peek' });
      await wait(120);
      expect(last(viewer, 'surface').reason === 'not-a-uid',
        'and so does a peek with no uid at all', JSON.stringify(last(viewer, 'surface')));
      expect(contents(viewer).length === 0, 'none of the three rendered anything either');
    } finally { viewer.ws.close(); }
  });
});

test('t0526-09b — a deployment that declares no surfaces refuses every peek, and unpeek is still safe', async () => {
  await withServer({ alpha: { 'plugin.json': { name: 'alpha', requires: [] } } }, async (server) => {
    const viewer = await connect(WebSocket, wsUrl(server), { userId: 'p-one', userName: 'Viewer' });
    try {
      expect((last(viewer, 'welcome') || {}).surfaceRegistry === undefined,
        'a deployment with no surfaces mentions none in its welcome — nothing changes for it at all',
        JSON.stringify(last(viewer, 'welcome')));
      viewer.clear();
      viewer.send({ t: 'peek', surfaceUid: 1 });
      await wait(140);
      expect(last(viewer, 'surface').reason === 'no-surfaces',
        'and every peek refuses by name', JSON.stringify(last(viewer, 'surface')));

      // unpeek is stateless: it means "show me what the room is showing me", which is a sensible
      // request from someone who never peeked — and an honest `restored:false` when there is nothing.
      viewer.clear();
      viewer.send({ t: 'unpeek' });
      await wait(140);
      const reply = last(viewer, 'surface');
      expect(reply && reply.ok === true && reply.restored === false,
        'unpeek with nothing on the room\'s screen says so rather than silently doing nothing',
        JSON.stringify(reply));
      expect(contents(viewer).length === 0, 'and renders nothing');
    } finally { viewer.ws.close(); }
  });
});

test('t0526-10 — a peek DISTURBS NOTHING: display state byte-identical, module and beat untouched, a later joiner still lands on the beat', async () => {
  await withServer(BOTH_PLUGINS, async (server) => {
    const peeker = await connect(WebSocket, wsUrl(server), { userId: 'p-one', userName: 'Peeker' });
    try {
      server.setModule(TWO_BEAT_MODULE);
      server.showBeat(0);
      await wait(140);

      // The DURABLE display state, serialised — the same seam 0522 P4's staging test uses, chosen
      // because a field-by-field check would let a new descriptor field through unnoticed.
      const before = server._displayStateForTest();
      // The SESSION's own state: the shared store (which holds module/current — the beat) and its
      // version. If a peek moved the room by so much as one op, both of these move with it.
      const dumpBefore = server.debugDump('presenter');
      const storeBefore = JSON.stringify(dumpBefore.state.store);
      const versionBefore = dumpBefore.version;

      peeker.send({ t: 'peek', surfaceUid: uidOf(server, 'The open screen') });
      await wait(160);
      expect(last(peeker, 'content').html.includes(SURFACE_MARK), 'the peek happened (else this test proves nothing)');

      expect(server._displayStateForTest() === before,
        'the durable display state is BYTE-IDENTICAL across the peek — no descriptor was written for anybody',
        JSON.stringify({ before, after: server._displayStateForTest() }));
      const dumpAfter = server.debugDump('presenter');
      expect(JSON.stringify(dumpAfter.state.store) === storeBefore,
        'the shared store is byte-identical too — the session is still on the same beat',
        JSON.stringify({ before: storeBefore, after: JSON.stringify(dumpAfter.state.store) }));
      expect(dumpAfter.version === versionBefore,
        'and its version did not move: a peek is not an op', `${versionBefore} -> ${dumpAfter.version}`);

      // ⛓ THE STRONGEST FORM: somebody who arrives AFTER the peek gets the ROOM, not the surface.
      const latecomer = await connect(WebSocket, wsUrl(server), { userId: 'p-late', userName: 'Latecomer' });
      try {
        await wait(140);
        const got = last(latecomer, 'content');
        expect(got && got.html.includes(BEAT1),
          'a viewer who joins after the peek lands on the room\'s beat — the peek left no trace in the session',
          got && got.html.slice(0, 160));
      } finally { latecomer.ws.close(); }

      // ...and unpeeking writes nothing either.
      const beforeUnpeek = server._displayStateForTest();
      peeker.send({ t: 'unpeek' });
      await wait(160);
      expect(server._displayStateForTest() === beforeUnpeek,
        'unpeek writes nothing either — it only re-renders what is already there',
        server._displayStateForTest());
    } finally { peeker.ws.close(); }
  });
});

test('t0526-11 — a participant with no station screen of their own can still peek, and the welcome tells them what there is', async () => {
  await withServer(BOTH_PLUGINS, async (server) => {
    const viewer = await connect(WebSocket, wsUrl(server), { userId: 'p-one', userName: 'Viewer' });
    try {
      // The welcome carries the surface list — uid + label + flags, and never the authoring code.
      const reg = (last(viewer, 'welcome') || {}).surfaceRegistry;
      expect(Array.isArray(reg) && reg.length === 3, 'the welcome carries the surface list', JSON.stringify(reg));
      expect(reg.every((r) => Number.isInteger(r.surfaceUid) && r.surfaceId === undefined),
        'by uid, never by authoring code', JSON.stringify(reg));
      expect(reg.filter((r) => r.peekable).length === 2 && reg.find((r) => !r.peekable).surfaceLabel === 'The closed screen',
        'and it shows WHICH may be summoned — refusing is not the same as hiding', JSON.stringify(reg));

      // ⚠ WHAT THIS VIEWER IS: someone the station path has nothing for. `station-show` — the
      // existing self-scoped verb — refuses them `no-station`. Peek is deliberately NOT routed
      // through that gate, so it works anyway. (This fixture declares no stations at all; the
      // stronger case — stations LIVE and this seat empty — needs a plugin seat resolver and is
      // the live rig's to prove, 0526 P5.)
      viewer.clear();
      viewer.send({ t: 'station-show' });
      await wait(140);
      expect((last(viewer, 'station') || {}).reason === 'no-station',
        'the station verb has nothing for this participant', JSON.stringify(last(viewer, 'station')));

      viewer.clear();
      viewer.send({ t: 'peek', surfaceUid: uidOf(server, 'The open screen') });
      await wait(160);
      expect(last(viewer, 'content').html.includes(SURFACE_MARK),
        'and the surface verb still shows them a screen', (last(viewer, 'content') || {}).html);
      expect(last(viewer, 'surface').ok === true, 'with an ok reply', JSON.stringify(last(viewer, 'surface')));
    } finally { viewer.ws.close(); }
  });
});
