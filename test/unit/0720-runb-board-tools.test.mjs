/*
 * Plan 0720 RUN B / B4 — THE BOARD ON THE AGENT SURFACE.
 *
 * Two halves, and the second one exists because of a bug that fourteen tests missed.
 *
 *   (1) THE DESCRIPTIONS. ⭐⭐ A tool's description is the ONLY documentation an agent ever reads.
 *       The two facts that surprised this board's own author — that a whole-board write is
 *       AUTHORITATIVE so omission DELETES, and that it is for RESTORE rather than for editing during
 *       play — are asserted to be IN the text. Not because prose is testable in general, but because
 *       these two are the difference between a correct call and a board full of pieces nobody can
 *       take off, and a future agent with no session context has nothing else to go on.
 *
 *   (2) THE BEHAVIOUR, through the REAL handlers. ⛔ Called the way the DECLARED SCHEMA says, never
 *       the way the handler happens to want: a test written from the implementation reproduces a
 *       schema/handler mismatch instead of detecting it — `combat_acted` declared `stations` while
 *       its handler read `station`, returned a 200 with a wrong answer, and every one of its
 *       fourteen tests called it the handler's way.
 *       → [[feedback-a-test-written-from-the-implementation-cannot-catch-a-contract-mismatch]]
 *
 * Unit tier: no browser, `port: 0`, `tunnel: false`.
 * ⛔ DOMAIN-FREE FIXTURES (PSS t0531-01): this repo is public.
 */
import { test, check, expect } from '../../harness/test.mjs';
import { coreTools } from '../../mcp/tools.mjs';
import { BOARD_PATH_KEY } from '../../app/board-document.mjs';
import { connect } from './_0514-fixtures.mjs';
import { WebSocket } from 'ws';

const T = Object.fromEntries(coreTools.map((t) => [t.name, t]));
const PATH = 'shared/tactical/runb-tools';
const OTHER = 'shared/tactical/runb-tools-2';

/** Call a tool the way its DECLARED SCHEMA says: only keys the schema names. */
function callAsDeclared(name, args) {
  const declared = Object.keys(T[name].input.properties || {});
  for (const k of Object.keys(args)) {
    if (!declared.includes(k)) throw new Error(`${name} has no declared input "${k}" — the test is calling it wrong`);
  }
  return T[name].handler(args);
}

test('0720 RUN-B B4.1 — ⭐⭐ THE DESCRIPTION CARRIES THE TWO FACTS AN AGENT CANNOT GUESS', () => {
  const w = T.board_write;
  expect(!!w, 'board_write is on the surface');
  check('⭐ it says the write is AUTHORITATIVE', /AUTHORITATIVE/.test(w.description));
  check('⭐ …and that OMISSION DELETES, in those words', /omission DELETES/i.test(w.description),
    w.description.slice(0, 160));
  check('⛔ …and that it is RESTORE-ONLY, not the way to edit during play',
    /RESTORE ONLY/i.test(w.description) && /board_add/.test(w.description));
  check('⛔ …and that it never issues a `clear`, with the reason', /clear/.test(w.description));

  check('board_add says it is the NORMAL path and that it is per-key',
    /NORMAL WAY/i.test(T.board_add.description) && /OWN key/i.test(T.board_add.description));
  check('board_remove says why there is deliberately no "clear the board" tool',
    /no "clear the board"/i.test(T.board_remove.description));
  check('board_read says it reads LIVE state, not the authored layout',
    /LIVE store/.test(T.board_read.description) && /authored/.test(T.board_read.description));
  check('board_path says a deploy is not available mid-session, which is why it exists',
    /deploy/.test(T.board_path.description) && /in memory/.test(T.board_path.description));
});

test('0720 RUN-B B4.2 — every DECLARED input is one the handler reads (the lint, on these five)', () => {
  /* The general form of this is 0720-runb-core-tool-schema; asserted here too because these are the
     tools the plan adds, and a lint nobody looks at is not a gate. */
  for (const name of ['board_read', 'board_write', 'board_add', 'board_remove', 'board_path']) {
    const src = String(T[name].handler);
    const open = src.indexOf('{');
    let d = 0, end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) { end = i; break; } }
    }
    const read = src.slice(open + 1, end);
    for (const key of Object.keys(T[name].input.properties || {})) {
      check(`${name} reads its declared "${key}"`, new RegExp('(^|[,{\\s])' + key + '\\s*[,=:}]').test(read), read);
    }
  }
});

test('0720 RUN-B B4.3 — the tools drive a real board end to end', async () => {
  await T.presenter_stop.handler({ tunnel: false }).catch(() => {});
  const started = await T.presenter_start.handler({ port: 0, voice: false, tunnel: false });
  expect(!started.already && typeof started.url === 'string', 'a fresh server started',
    JSON.stringify(started).slice(0, 160));

  const empty = await callAsDeclared('board_read', { path: PATH });
  check('an empty board reads as an empty document, not an error',
    empty.ok && empty.document.tokens.length === 0, JSON.stringify(empty));

  await callAsDeclared('board_add', { path: PATH, token: { id: 'flag', label: 'Flag', px: 0.5, py: 0.5, pin: true } });
  await callAsDeclared('board_add', { path: PATH, token: { id: 'raider', label: 'Raider', px: 0.2, py: 0.2, size: 3 } });
  const two = await callAsDeclared('board_read', { path: PATH });
  check('two pieces, sorted by id', two.document.tokens.map((t) => t.id).join(',') === 'flag,raider',
    JSON.stringify(two.document.tokens.map((t) => t.id)));
  check('a field the component has never heard of survives the round trip',
    two.document.tokens.find((t) => t.id === 'raider').size === 3, JSON.stringify(two.document.tokens));
  check('⛔ an id-less piece is REFUSED BY NAME, not silently dropped',
    (await callAsDeclared('board_add', { path: PATH, token: { label: 'nameless' } })).reason === 'no-id');
  /* ⛔ THE TWO DOORS MUST AGREE. `deserialise` refuses a compound id; if this one did not, the
     piece would be written NESTED under another key — off the document and reachable by no
     ordinary removal, which is the "a piece nobody can take off the board" failure again. */
  for (const bad of ['a/b', '_locks', '..']) {
    const r = await callAsDeclared('board_add', { path: PATH, token: { id: bad, px: 0.5, py: 0.5 } });
    check(`⛔ the id "${bad}" is refused BY NAME`, r.reason === 'bad-id', JSON.stringify(r));
  }

  const rm = await callAsDeclared('board_remove', { path: PATH, id: 'raider' });
  check('a removal reports whether the piece was actually there', rm.ok && rm.existed === true, JSON.stringify(rm));
  check('…and removing something absent is honest about it',
    (await callAsDeclared('board_remove', { path: PATH, id: 'ghost' })).existed === false);
  check('the board is down to one piece',
    (await callAsDeclared('board_read', { path: PATH })).document.tokens.length === 1);
});

test('0720 RUN-B B4.4 — ⭐ board_write is AUTHORITATIVE: omission DELETES, and the pieces named survive', async () => {
  await callAsDeclared('board_add', { path: PATH, token: { id: 'scout-1', px: 0.1, py: 0.1 } });
  await callAsDeclared('board_add', { path: PATH, token: { id: 'scout-2', px: 0.9, py: 0.9 } });
  const before = await callAsDeclared('board_read', { path: PATH });
  check('three pieces before the write', before.document.tokens.length === 3,
    JSON.stringify(before.document.tokens.map((t) => t.id)));

  const res = await callAsDeclared('board_write', {
    path: PATH,
    document: { v: 1, tokens: [{ id: 'flag', label: 'Flag', px: 0.5, py: 0.5 }, { id: 'raider-2', px: 0.3, py: 0.3 }] },
  });
  check('it reports what it did, per direction', res.ok && res.written === 2 && res.removed === 2,
    JSON.stringify(res));
  const after = await callAsDeclared('board_read', { path: PATH });
  check('⭐ the omitted pieces are GONE', after.document.tokens.map((t) => t.id).join(',') === 'flag,raider-2',
    JSON.stringify(after.document.tokens.map((t) => t.id)));
  check('…and nothing was refused', res.refused.length === 0, JSON.stringify(res.refused));
});

test('0720 RUN-B B4.5 — \u26d4 A LOCK IS REPORTED, NOT SILENTLY SKIPPED; `force` breaks it and stores nothing', async () => {
  /*
   * \u26d4\u26d4 ANY PARTICIPANT MAY `lock` ANYTHING UNDER `shared/**` (app/permissions.mjs), so a
   * board piece can be locked by somebody who then closes their laptop. A restore that quietly
   * skipped that piece would report success and come back one piece short — which on a live board
   * is a hull that is simply not there any more, with nothing anywhere saying why.
   */
  const url = (await T.presenter_status.handler({})).url.replace('http', 'ws');
  const mallory = await connect(WebSocket, url, { userId: 'mallory', userName: 'M', role: 'participant' });
  await callAsDeclared('board_add', { path: PATH, token: { id: 'flag', label: 'Flag', px: 0.5, py: 0.5 } });
  mallory.send({ t: 'op', path: PATH + '/flag', verb: 'lock', value: {}, opId: 'm:1' });
  await new Promise((r) => setTimeout(r, 200));

  const held = await callAsDeclared('board_read', { path: PATH });
  check('precondition: the lock is HELD, and it is not in the document either',
    !held.document.tokens.some((t) => 'lock' in t), JSON.stringify(held.document.tokens));

  const blocked = await callAsDeclared('board_write', {
    path: PATH, document: { v: 1, tokens: [{ id: 'flag', px: 0.9, py: 0.9 }] },
  });
  check('\u26d4 the write is REFUSED and says which piece', blocked.ok === false && blocked.refused.includes('flag'),
    JSON.stringify(blocked));
  check('\u2026and the piece really did not move', (await callAsDeclared('board_read', { path: PATH }))
    .document.tokens.find((t) => t.id === 'flag').px === 0.5);

  const forced = await callAsDeclared('board_write', {
    path: PATH, document: { v: 1, tokens: [{ id: 'flag', px: 0.9, py: 0.9 }] }, force: true,
  });
  check('\u2b50 with force it goes through', forced.ok === true && forced.refused.length === 0, JSON.stringify(forced));
  const rec = (await callAsDeclared('board_read', { path: PATH })).document.tokens.find((t) => t.id === 'flag');
  check('\u2026the piece moved', rec.px === 0.9, JSON.stringify(rec));
  /*
   * \u26d4\u26d4 READ THE RAW STORE, NOT THE DOCUMENT. `serialise` strips `force` on the way out, so
   * asserting on `board_read` here would pass whatever the implementation did \u2014 measured: the
   * broken version (force in the op value) rendered this check GREEN. The store's own snapshot is
   * the only place the residue is visible, and it is what every client is sent.
   */
  const raw = (await T.presenter_debug.handler({ role: 'presenter' }))
    .state.store.shared.tactical[PATH.split('/').pop()].flag;
  check('\u26d4 AND NO `force` FIELD WAS LEFT IN THE STORED RECORD. `apply` reads force off the op '
    + 'VALUE and `set` CLONES THAT VALUE INTO THE TREE, so a forced write done the obvious way brands '
    + 'the piece "somebody once forced this" for the rest of the session and every client carries it '
    + 'forward through read, drag and re-read. The lock is broken with `unlock`, which stores nothing.',
    !('force' in raw), JSON.stringify(raw));
  mallory.ws.close();
});

test('0720 RUN-B B4.6 — ⭐ board_path reads, re-points, and refuses junk BY NAME', async () => {
  const read = await callAsDeclared('board_path', {});
  check('with nothing set it reports the default', read.ok && read.changed === false && read.path === 'shared/tactical/tokens',
    JSON.stringify(read));

  await callAsDeclared('board_add', { path: OTHER, token: { id: 'raider-9', px: 0.4, py: 0.4 } });
  const set = await callAsDeclared('board_path', { path: OTHER });
  check('re-pointing reports the new path', set.ok && set.changed === true && set.path === OTHER, JSON.stringify(set));

  const now = await callAsDeclared('board_read', {});
  check('⭐ board_read with NO path now reads the re-pointed collection',
    now.document.path === OTHER && now.document.tokens[0].id === 'raider-9', JSON.stringify(now.document));
  check('⛔ and the abandoned collection is still readable by naming it — re-pointing does not delete',
    (await callAsDeclared('board_read', { path: PATH })).document.tokens.length > 0);

  const junk = await callAsDeclared('board_path', { path: '../../etc' });
  check('⛔ junk is refused BY NAME, and the board is not re-pointed at it',
    junk.ok === false && junk.reason === 'unusable-path' && junk.path === OTHER, JSON.stringify(junk));
  check('…and the store key was not written', (await callAsDeclared('board_path', {})).path === OTHER);
  void BOARD_PATH_KEY;
});

test('0720 RUN-B B4.9 — teardown', async () => {
  await T.presenter_stop.handler({ tunnel: false }).catch(() => {});
  expect(true, 'stopped');
});
