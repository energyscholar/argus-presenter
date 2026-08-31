/*
 * Plan 0720 B6 — PROVE `subscribeState` ACTUALLY DELIVERS A DIFF. Headless.
 *
 * Red-team R2: *"`grep -c subscribeState *.js` returns zero for all eleven [components of this
 * plugin]. The read path was opened by 0575 P1a and nothing has ever used it here."* Every Band C
 * panel depends on it, so it is treated as UNPROVEN until this file runs.
 *
 * ⛔ NO BROWSER. The proof runs at two levels and joins them:
 *   WIRE  — a WebSocket client asserts the frames the server actually sends;
 *   API   — the frame the wire delivered is fed, byte for byte, into the REAL `lib/bridge.js`
 *           (via test/unit/_bridge-harness.mjs), which is the code a component's
 *           `Argus.subscribeState(prefix, handler)` runs.
 * The join is what makes it a proof rather than two half-proofs: app/presenter.html:1027 relays
 * `m.msg` VERBATIM into the content frame — `frame.contentWindow.postMessage(m.msg, '*')` — so the
 * object this test hands the bridge is the same object a component receives.
 *
 * ⭐ THE OUTPUT OF THIS FILE IS A SPECIFICATION. Band C is written from what it records: the
 * message shape, whether the snapshot is separate, and whether a nested path arrives as a subtree
 * or a leaf. Precision matters more than brevity here.
 *
 * ⛔ DOMAIN-FREE FIXTURES (PSS t0531-01).
 */
import { test, expect, check } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { loadBridge } from '../unit/_bridge-harness.mjs';
import { connect, poll, wait } from './_0720-band-b-client.mjs';

const P = 'shared/tactical';
let server, url, writer, observer, gm;

/** Wait until `obs` has a diff frame naming `path`, and return the whole frame's `msg`. */
async function diffFor(obs, path, label) {
  await poll(() => obs.diffFrames.some((f) => Object.prototype.hasOwnProperty.call(f.diff, path)),
    label || ('a diff naming ' + path));
  return obs.diffFrames.filter((f) => Object.prototype.hasOwnProperty.call(f.diff, path)).pop();
}

test('0720 B6.0 — boot, and record THE CONNECT SEQUENCE a real client sees', async () => {
  server = await createServer({ port: 0 });
  url = server.url();
  observer = await connect(url, { userId: 'obs', userName: 'Observer', role: 'participant' });
  writer = await connect(url, { userId: 'wtr', userName: 'Writer', role: 'participant' });
  gm = await connect(url, { userId: 'gm-1', userName: 'Referee', role: 'presenter' });

  const kinds = observer.frames.map((f) => f.t);
  check(`connect frame order begins [${kinds.slice(0, 3).join(', ')}]`,
    kinds[0] === 'welcome' && kinds[1] === 'snapshot' && kinds[2] === 'ping', kinds.join(','));
  /* ⛔ `t:'host'` IS A GENERAL ENVELOPE, NOT A DIFF CHANNEL. Content pushes, identity and poll
     updates ride it too — which is exactly why `subscribeState` filters on `msg.type === 'diff'`
     before it looks at `msg.diff`. A panel that reacts to `t:'host'` alone fires on unrelated
     traffic. */
  const hostTypes = [...new Set(observer.frames.filter((f) => f.t === 'host').map((f) => (f.msg && f.msg.type) || '?'))];
  check(`t:"host" frames so far carry msg.type [${hostTypes.join(', ')}]`, hostTypes.length >= 1, hostTypes.join(','));

  /* ⛔ AND DIFFS ARRIVE THAT THIS CLIENT DID NOT CAUSE AND NOBODY "WROTE": simply having two more
     clients CONNECT produced store writes (identity rows and the loaded plugin's seat write) which
     were broadcast here. ⇒ A Band C panel must be idempotent under diffs for paths it does not own,
     and must never assume "a diff arrived" means "my thing changed". */
  const slices = [...new Set(observer.diffPaths.map((d) => String(d.path).split('/')[0]))].sort();
  check(`${observer.diffPaths.length} diffs arrived from OTHER CLIENTS MERELY CONNECTING, in top-level slices [${slices.join(', ')}]`,
    observer.diffPaths.length > 0 && !slices.includes('shared'), slices.join(','));
  /* ⭐ THE ANSWER TO "does the initial snapshot arrive separately?" — YES. It is its own frame,
     `{t:'snapshot', state, version}`, sent AFTER `welcome` and BEFORE the first `ping`. It is
     never folded into a diff, and a component seeds from it via `Argus.state(path)`. */
  expect(observer.snapshots.length === 1,
    '⭐ the initial snapshot is ONE SEPARATE FRAME, not a diff', JSON.stringify(kinds));
  check('…it carries a numeric version', typeof observer.snapshots[0].version === 'number',
    String(observer.snapshots[0].version));
  check('…and it is role-filtered: a participant\'s snapshot has no `gm` slice',
    observer.snapshots[0].state.gm === undefined, JSON.stringify(Object.keys(observer.snapshots[0].state)));
});

test('0720 B6.1 — ⭐ ONE CLIENT WRITES, ANOTHER IS DELIVERED A DIFF NAMING THAT PATH', async () => {
  writer.op(`${P}/tokens/tok-a`, 'set', { id: 'tok-a', x: 3, y: 4 });
  const msg = await diffFor(observer, `${P}/tokens/tok-a`);

  /* ⭐⭐ THE WIRE SHAPE, EXACTLY:
   *   { t:'host', msg:{ source:'argus-host', type:'diff',
   *                     diff:{ '<full/slash/path>': <value> }, by:'<userId>', version:<int> } } */
  const frame = observer.frames.filter((f) => f.t === 'host' && f.msg === msg).pop();
  check('the wire frame is t:"host"', !!frame, JSON.stringify(observer.frames.map((f) => f.t)));
  check('msg.source === "argus-host"', msg.source === 'argus-host', msg.source);
  check('msg.type === "diff"', msg.type === 'diff', msg.type);
  check('msg.by is the WRITER\'s userId (server-stamped, not the payload)', msg.by === 'wtr', String(msg.by));
  check('msg.version is the store version at that write',
    msg.version === server.store.version(), `${msg.version} vs store ${server.store.version()}`);
  check(`the diff carries EXACTLY ONE key: ${Object.keys(msg.diff).join(',')}`,
    Object.keys(msg.diff).length === 1, JSON.stringify(msg.diff));
  expect(JSON.stringify(msg.diff[`${P}/tokens/tok-a`]) === JSON.stringify(server.store.get(`${P}/tokens/tok-a`)),
    'the delivered value equals what the STORE holds', JSON.stringify(msg.diff));

  /* ⭐ ECHO: the writer is NOT excluded from its own broadcast. A Band C panel that re-renders
     on every diff will re-render on its own write too — that is the `bind()` "hazard 1". */
  const echo = writer.diffPaths.filter((d) => d.path === `${P}/tokens/tok-a`);
  expect(echo.length >= 1, '⭐ the WRITER receives its own diff back (echo)', String(echo.length));
});

test('0720 B6.2 — ⭐ THE JOIN: that exact frame drives the REAL Argus.subscribeState', async () => {
  const { Argus, injectHost } = loadBridge();
  const hits = [];
  const off = Argus.subscribeState(P, (path, value, d) => hits.push({ path, value, version: d.version }));

  const msg = await diffFor(observer, `${P}/tokens/tok-a`);
  injectHost(msg);                                  // ⛔ the frame the WIRE delivered, unmodified

  expect(hits.length === 1, '⭐ subscribeState fired exactly once for the in-prefix path',
    JSON.stringify(hits));
  expect(hits[0].path === `${P}/tokens/tok-a`,
    'handler arg 1 is the FULL path, not a relative one', hits[0].path);
  check('handler arg 2 is the whole written value', hits[0].value && hits[0].value.x === 3,
    JSON.stringify(hits[0].value));
  check('handler arg 3 is the whole host message (version reachable)', hits[0].version === msg.version);

  /* And the bridge folds it into the cache a panel reads with Argus.state(). */
  check('Argus.state() sees it after the diff', Argus.state(`${P}/tokens/tok-a/x`) === 3,
    JSON.stringify(Argus._state));

  // Out-of-prefix and non-diff frames are ignored — the filter is segment-aware.
  injectHost({ type: 'diff', diff: { 'sharedX/tactical/tokens/tok-z': 1 } });
  injectHost({ type: 'poll-update', tally: {} });
  expect(hits.length === 1, 'no false positive from a sibling prefix or a non-diff frame',
    JSON.stringify(hits));
  off();
});

test('0720 B6.3 — ⛔⛔ A NESTED PATH ARRIVES AS A LEAF KEYED BY ITS FULL PATH — NOT A SUBTREE', async () => {
  /* This is the question Band C is written from. The answer is: the diff key is EXACTLY the path
     that was written — whatever depth that is — and the value is exactly what was written there.
     The server never re-roots a diff at the subscription prefix and never sends an enclosing
     subtree. `reduce()` in app/state.mjs returns `{ [op.path]: value }` and that is the whole diff. */
  writer.op(`${P}/tokens/tok-a/pos/x`, 'set', 42);
  const deep = await diffFor(observer, `${P}/tokens/tok-a/pos/x`);
  expect(Object.keys(deep.diff).length === 1 && deep.diff[`${P}/tokens/tok-a/pos/x`] === 42,
    '⭐ a 5-segment write arrives as ONE key, the 5-segment path, value 42', JSON.stringify(deep.diff));
  check('⛔ the ANCESTOR path is NOT also sent',
    !Object.prototype.hasOwnProperty.call(deep.diff, `${P}/tokens/tok-a`), JSON.stringify(deep.diff));

  /* ⛔⛔ THE TRAP THAT WILL BITE BAND C. A subscriber on a CHILD path hears nothing when an
     ANCESTOR is written wholesale — the diff names the ancestor, and `subscribeState`'s filter is
     "path === prefix or path starts with prefix + '/'". A panel subscribed to
     `shared/tactical/tokens/tok-a` goes stale the moment anyone `set`s `shared/tactical/tokens`.
     ⇒ SUBSCRIBE AT THE COLLECTION, NOT AT THE ITEM. */
  const { Argus, injectHost } = loadBridge();
  let itemHits = 0, collHits = 0;
  Argus.subscribeState(`${P}/tokens/tok-a`, () => { itemHits++; });
  Argus.subscribeState(`${P}/tokens`, () => { collHits++; });

  gm.op(`${P}/tokens`, 'set', { 'tok-a': { id: 'tok-a', x: 0 }, 'tok-b': { id: 'tok-b', x: 1 } });
  const whole = await diffFor(observer, `${P}/tokens`);
  injectHost(whole);
  expect(Object.keys(whole.diff).length === 1 && Object.keys(whole.diff)[0] === `${P}/tokens`,
    'a wholesale parent write arrives as ONE key: the PARENT path, carrying the whole object',
    JSON.stringify(whole.diff));
  expect(itemHits === 0,
    '⛔⛔ a subscriber on the ITEM path hears NOTHING when the collection is replaced', String(itemHits));
  expect(collHits === 1,
    '⭐ a subscriber on the COLLECTION path hears it — subscribe at the collection', String(collHits));
});

test('0720 B6.4 — the diff shape of EVERY verb, recorded for Band C', async () => {
  const shapes = {};

  // merge — ⛔ carries the WHOLE merged object at the path, not just the changed keys.
  writer.op(`${P}/tokens/tok-b`, 'merge', { y: 7 });
  const m = await diffFor(observer, `${P}/tokens/tok-b`, 'merge diff');
  shapes.merge = m.diff[`${P}/tokens/tok-b`];
  expect(shapes.merge && shapes.merge.id === 'tok-b' && shapes.merge.y === 7,
    '⛔ MERGE delivers the WHOLE object at that path, not the delta',
    JSON.stringify(shapes.merge));

  // add — the key is `<path>/<id>`, taken from the value's id.
  writer.op(`${P}/marks`, 'add', { id: 'm1', label: 'alpha' });
  const a = await diffFor(observer, `${P}/marks/m1`, 'add diff');
  shapes.add = Object.keys(a.diff);
  expect(shapes.add.length === 1 && shapes.add[0] === `${P}/marks/m1`,
    'ADD delivers `<path>/<id>` — the collection path is never re-sent', JSON.stringify(a.diff));

  // remove — the same key, value null. null MEANS REMOVED.
  writer.op(`${P}/marks`, 'remove', 'm1');
  await poll(() => observer.diffPaths.some((d) => d.path === `${P}/marks/m1` && d.value === null), 'remove diff');
  const r = observer.diffFrames.filter((f) => f.diff[`${P}/marks/m1`] === null).pop();
  expect(r.diff[`${P}/marks/m1`] === null, 'REMOVE delivers `<path>/<id>`: null', JSON.stringify(r.diff));
  check('…and the store agrees the key is gone', server.store.get(`${P}/marks/m1`) === undefined);

  // clear — the PATH itself, value {}. A child subscriber hears nothing (same trap as B6.3).
  writer.op(`${P}/marks`, 'add', { id: 'm2' });
  await diffFor(observer, `${P}/marks/m2`, 'a mark to clear');
  writer.op(`${P}/marks`, 'clear');
  await poll(() => {
    const c = server.store.get(`${P}/marks`);
    return c && Object.keys(c).length === 0;
  }, 'clear landed');
  const c = observer.diffFrames.filter((f) => Object.prototype.hasOwnProperty.call(f.diff, `${P}/marks`)).pop();
  expect(c && JSON.stringify(c.diff[`${P}/marks`]) === '{}',
    'CLEAR delivers `<path>`: {} — the subtree is reset in one key', JSON.stringify(c && c.diff));
});

test('0720 B6.5 — ⛔ EPHEMERAL PATHS ARE A DIFFERENT ANIMAL: `pointer`/`laser` are coalesced', async () => {
  /* app/state.mjs `isEphemeral`: ANY path with a `pointer` or `laser` SEGMENT. Those ops still
     change the store, but they are coalesced at ~15 Hz, carry NO version, and are not op-logged.
     ⇒ A Band C token DRAG can ride an ephemeral path deliberately (cheap, lossy, fine) but a token
     DROP must not, or the position is not durable. ⛔ And a panel must not name a path segment
     `pointer` by accident. */
  const before = server.store.version();
  for (let i = 0; i < 12; i++) writer.op(`${P}/pointer/wtr`, 'set', { x: i, y: i });
  await poll(() => {
    const v = server.store.get(`${P}/pointer/wtr`);
    return v && v.x === 11;
  }, 'the last ephemeral position reached the store');
  await wait(150);

  const eph = observer.diffPaths.filter((d) => d.path === `${P}/pointer/wtr`);
  check(`12 ephemeral ops produced ${eph.length} delivered diffs (coalescing is real)`,
    eph.length < 12, String(eph.length));
  check('…and they carry version: null', eph.every((d) => d.version === null),
    JSON.stringify(eph.map((d) => d.version)));
  check(`…and the durable version did not move for them (${before} -> ${server.store.version()})`,
    server.store.version() === before, `${before} -> ${server.store.version()}`);
});

test('0720 B6.6 — ⛔ DELIVERY IS READ-FILTERED PER RECIPIENT, not broadcast-all', async () => {
  gm.op('gm/asides/a1', 'set', { id: 'a1', text: 'referee note' });
  await poll(() => (server.store.get('gm/asides/a1') || {}).id === 'a1', 'the aside is in the store');
  await wait(120);

  const leaked = observer.diffPaths.filter((d) => String(d.path).indexOf('gm') === 0);
  expect(leaked.length === 0,
    '⛔ a participant is delivered NO diff for a path it may not read', JSON.stringify(leaked));
  const sawIt = gm.diffPaths.filter((d) => d.path === 'gm/asides/a1');
  expect(sawIt.length >= 1, '…while the controller IS delivered it', String(sawIt.length));
  check('⇒ a Band C panel bound to a controller-only path renders BLANK for a player, never leaks',
    server.store.perms.canRead({ role: 'participant', userId: 'obs' }, 'gm/asides/a1') === false);
});

test('0720 B6.7 — ⭐ A LATE JOINER SEEDS FROM THE SNAPSHOT, so a panel is never blank on mount', async () => {
  const late = await connect(url, { userId: 'late', userName: 'Latecomer', role: 'participant' });
  const st = late.snapshots[0].state;
  const tok = st && st.shared && st.shared.tactical && st.shared.tactical.tokens;
  expect(tok && tok['tok-a'] && tok['tok-b'],
    '⭐ every token written before this client existed is in ITS FIRST SNAPSHOT',
    JSON.stringify(Object.keys(tok || {})));
  check('…and it arrived with ZERO diff frames so far (the snapshot did all the work)',
    late.diffPaths.length === 0, String(late.diffPaths.length));
  check('⚠ the ephemeral pointer IS in the snapshot too (it lives in the same tree)',
    !!(st.shared.tactical.pointer), JSON.stringify(st.shared.tactical.pointer));
  check('…and the snapshot still hides `gm` from a participant', st.gm === undefined);
  late.close();
});

test('0720 B6.9 — teardown', async () => {
  for (const c of [writer, observer, gm]) c.close();
  await server.close();
  expect(true, 'server closed');
});
