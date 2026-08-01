/*
 * Plan 0522 P12 — MANAGE MODULES: retire-by-move, symlink read-only, credential-gated write.
 *
 * This is the phase where a mistake is unrecoverable. `modules/*.json` is gitignored, so 28 of
 * the 29 modules on this box exist ONLY on disk with no version history; and `writeFileSync`
 * follows symlinks, so a write through a linked module edits a file in a DIFFERENT repository.
 * The three tests below are the three ways that goes wrong.
 *
 *   t32 — "Retire" MOVES the file to _archive/ and never unlinks it. Asserted by the file
 *         EXISTING at the new path with identical bytes, not merely by the old path being gone:
 *         a delete would satisfy "gone from the picker" just as well, and is the one outcome
 *         with no undo.
 *   t33 — a write to a SYMLINKED module is refused with a visible reason, and the link target is
 *         byte-identical afterwards. The symlink is REAL (symlinkSync into a file the fixture
 *         owns) and identity is proved by sha256, because the failure being guarded against is
 *         precisely one that a mocked link would not reproduce.
 *   t34 — module writes require the control credential UNCONDITIONALLY, including on a server
 *         with none configured (R15 / SHAPE-A7). Fail closed.
 *
 * ⛔ §ANNEAL E — NO TEST HERE MAY TOUCH THE REAL modules/ DIRECTORY. Every fixture lives in a
 * mkdtempSync directory wired in through PRESENTER_MODULES_DIR and removed afterwards. Nothing
 * in this file names, reads, writes or removes a path under the repo's own modules/.
 *
 * Tier: unit. These are pure server + filesystem behaviour over HTTP; no browser is involved.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync, mkdirSync } from 'fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'os';
import { join } from 'path';

const TOKEN = 'p12-manage-token';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const deck = (title, extra = {}) => ({
  manifest: Object.assign({ title, kind: 'demo' }, extra),
  beats: [{ id: 'a', component: 'card', opts: { title: 'A' } }],
});

/** A server whose MODULES_DIR is a private temp dir. Returns { server, dir, cleanup }. */
async function boot({ controlToken = TOKEN } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0522-p12-'));
  const prev = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_MODULES_DIR = dir;                 // read once, inside createServer
  let server;
  try { server = await createServer(Object.assign({ port: 0 }, controlToken ? { controlToken } : {})); }
  finally { if (prev === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prev; }
  return { server, dir, cleanup: async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const post = (server, id, body, token = TOKEN) => fetch(server.url() + '/api/module-admin/' + id, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { 'x-control-token': token } : {}),
  body: JSON.stringify(body),
});

test('0522 t32 — RETIRE MOVES the module into _archive/ and never unlinks it', async () => {
  const { server, dir, cleanup } = await boot();
  try {
    const src = join(dir, 'junk.json');
    writeFileSync(src, JSON.stringify(deck('Junk Deck')));
    const before = sha(src);

    // Sanity: the module is in the picker's list before it is retired, so its later absence
    // means something.
    const listed = await (await fetch(server.url() + '/api/modules')).json();
    expect('the module is in the picker list to begin with', listed.some((m) => m.id === 'junk'), JSON.stringify(listed.map((m) => m.id)));

    const res = await post(server, 'junk', { op: 'retire' });
    const body = await res.json();
    expect('retire → 200 {ok:true}', res.status === 200 && body.ok === true, res.status + ' ' + JSON.stringify(body));

    // THE ASSERTION THAT MATTERS: the file EXISTS at the new path. A delete would also have
    // emptied the old one.
    const dest = join(dir, '_archive', 'junk.json');
    expect('the file EXISTS at modules/_archive/<id>.json', existsSync(dest), dest);
    expect('and it is byte-identical — a move, not a rewrite', existsSync(dest) && sha(dest) === before, existsSync(dest) ? sha(dest) : 'absent');
    expect('the archive path is reported back so the undo is discoverable', body.archived === dest, String(body.archived));
    expect('and it is gone from the scan path', !existsSync(src));

    // §ANNEAL H — the archive needs no exclusion code: the scan is a non-recursive readdir
    // filtered to .json, so a SUBDIRECTORY can never appear as a module.
    const after = await (await fetch(server.url() + '/api/modules')).json();
    expect('the picker no longer lists it', !after.some((m) => m.id === 'junk'), JSON.stringify(after.map((m) => m.id)));
    expect('and the _archive directory itself is not listed as a module', !after.some((m) => m.id === '_archive'), JSON.stringify(after.map((m) => m.id)));

    // An archived id must never be clobbered — the archive is the ONLY copy.
    writeFileSync(src, JSON.stringify(deck('Junk Deck v2')));
    const second = await post(server, 'junk', { op: 'retire' });
    expect('a second retire of the same id is REFUSED, not an overwrite', second.status === 409, 'status=' + second.status);
    expect('and the archived copy is untouched', sha(dest) === before, sha(dest));
  } finally { await cleanup(); }
});

test('0522 t33 — a write to a SYMLINKED module is refused with a reason; the target is byte-identical', async () => {
  const { server, dir, cleanup } = await boot();
  const outside = mkdtempSync(join(tmpdir(), 'ap-0522-p12-target-'));
  try {
    // A REAL symlink, into a real file this fixture owns — standing in for a module linked into
    // another repository. Not simulated: the whole hazard is that writeFileSync follows links.
    const target = join(outside, 'campaign-source.json');
    writeFileSync(target, JSON.stringify(deck('Live Campaign Source'), null, 2));
    const before = sha(target);
    const link = join(dir, 'linked.json');
    symlinkSync(target, link);
    expect('the fixture really is a symlink', lstatSync(link).isSymbolicLink());

    // 1. The curation write (set status).
    const st = await post(server, 'linked', { op: 'status', status: 'retired' });
    const stBody = await st.json();
    expect('status write through a symlink is REFUSED', st.status === 409, 'status=' + st.status);
    expect('and the refusal carries a VISIBLE reason naming the symlink', /symlink/i.test(String(stBody.error)) && stBody.symlink === true, JSON.stringify(stBody));

    // 2. Retire, which would relocate the link out of a directory the operator may not own.
    const rt = await post(server, 'linked', { op: 'retire' });
    expect('retire of a symlinked module is refused too — symlinked modules are READ-ONLY here', rt.status === 409, 'status=' + rt.status);
    expect('the link itself is still in place', existsSync(link) && lstatSync(link).isSymbolicLink());

    // 3. The whole-module write-back (POST /api/modules/:id) — the original SHAPE-A7 mechanism.
    const wb = await fetch(server.url() + '/api/modules/linked', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-control-token': TOKEN },
      body: JSON.stringify(deck('OVERWRITTEN')),
    });
    expect('a CREDENTIALED whole-module write-back through the symlink is refused as well', wb.status === 409, 'status=' + wb.status);

    // THE POINT: the file in the other tree is untouched, proved by hash.
    expect('the link TARGET is byte-identical after all three attempts', sha(target) === before, sha(target) + ' vs ' + before);
  } finally { await cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test('0522 t34 — module writes require the control credential, UNCONDITIONALLY (R15 / SHAPE-A7)', async () => {
  // (a) A gated server: no credential and a wrong credential are both refused.
  const gated = await boot();
  try {
    writeFileSync(join(gated.dir, 'target.json'), JSON.stringify(deck('Target')));
    const src = join(gated.dir, 'target.json');
    const before = sha(src);

    const none = await post(gated.server, 'target', { op: 'status', status: 'retired' }, null);
    expect('no credential → refused', none.status === 403, 'status=' + none.status);
    const wrong = await post(gated.server, 'target', { op: 'status', status: 'retired' }, 'nope');
    expect('wrong credential → refused', wrong.status === 403, 'status=' + wrong.status);
    expect('and nothing on disk changed', sha(src) === before);

    const listNone = await fetch(gated.server.url() + '/api/module-admin');
    expect('the curation LIST is gated on the same credential', listNone.status === 403, 'status=' + listNone.status);

    // The right credential works, and the panel's only write does what it says.
    const ok = await post(gated.server, 'target', { op: 'status', status: 'working' });
    expect('correct credential → 200', ok.status === 200, 'status=' + ok.status);
    const onDisk = JSON.parse(readFileSync(src, 'utf8'));
    expect('the status landed in the manifest', onDisk.manifest.status === 'working', JSON.stringify(onDisk.manifest));
    expect('and the rest of the module survived the edit', onDisk.beats.length === 1 && onDisk.manifest.title === 'Target', JSON.stringify(onDisk.manifest));

    // The WRITE path is stricter than the READ path, deliberately: moduleLifecycle() degrades an
    // unrecognised status to `active` so one typo cannot empty the picker, but a human setting a
    // status right now gets told no rather than silently rewritten.
    const bad = await post(gated.server, 'target', { op: 'status', status: 'mothballed' });
    expect('an unrecognised status is REJECTED on write (strict write, permissive read)', bad.status === 400, 'status=' + bad.status);
    const still = JSON.parse(readFileSync(src, 'utf8'));
    expect('and the stored status is unchanged by the rejection', still.manifest.status === 'working', JSON.stringify(still.manifest));
  } finally { await gated.cleanup(); }

  // (b) A server with NO credential configured at all. This is the clause that closes SHAPE-A7:
  // "nothing to verify against" is not "no gate to apply".
  const open = await boot({ controlToken: null });
  try {
    writeFileSync(join(open.dir, 'target.json'), JSON.stringify(deck('Target')));
    const before = sha(join(open.dir, 'target.json'));

    const admin = await post(open.server, 'target', { op: 'retire' }, null);
    const adminBody = await admin.json();
    expect('an UNGATED server refuses the curation write (fail closed)', admin.status === 403, 'status=' + admin.status);
    expect('and says the credential is missing from the DEPLOYMENT, not just "forbidden"', /credential/i.test(String(adminBody.error)), JSON.stringify(adminBody));

    const wb = await fetch(open.server.url() + '/api/modules/target', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(deck('OVERWRITTEN')),
    });
    expect('and refuses the whole-module write-back too — the SHAPE-A7 endpoint', wb.status === 403, 'status=' + wb.status);
    expect('nothing was written, moved or archived', sha(join(open.dir, 'target.json')) === before && !existsSync(join(open.dir, '_archive')));
  } finally { await open.cleanup(); }
});

test('0522 t32b — the curation list shows what the picker hides: broken modules and symlink state', async () => {
  // The picker's listModules() filters `error` rows out, so a module too broken to load is
  // invisible there — and a file nobody can see is a file nobody can ever clean up. The curation
  // list is the opposite by design: it drops nothing and reports the breakage as a field.
  const { server, dir, cleanup } = await boot();
  const outside = mkdtempSync(join(tmpdir(), 'ap-0522-p12-list-'));
  try {
    writeFileSync(join(dir, 'good.json'), JSON.stringify(deck('Good Deck', { status: 'working' })));
    writeFileSync(join(dir, 'broken.json'), '{ this is not json');
    writeFileSync(join(dir, 'oddstatus.json'), JSON.stringify(deck('Odd', { status: 'mothballed' })));
    const target = join(outside, 'src.json');
    writeFileSync(target, JSON.stringify(deck('Linked')));
    symlinkSync(target, join(dir, 'linked.json'));
    mkdirSync(join(dir, '_archive'), { recursive: true });
    writeFileSync(join(dir, '_archive', 'already.json'), JSON.stringify(deck('Already Archived')));

    const picker = await (await fetch(server.url() + '/api/modules')).json();
    expect('the PICKER hides the broken module', !picker.some((m) => m.id === 'broken'), JSON.stringify(picker.map((m) => m.id)));

    const d = await (await fetch(server.url() + '/api/module-admin', { headers: { 'x-control-token': TOKEN } })).json();
    const by = Object.fromEntries((d.modules || []).map((m) => [m.id, m]));
    expect('the CURATION list shows it, with the parse error as a field', !!by.broken && !!by.broken.error, JSON.stringify(by.broken));
    expect('symlink state is reported', by.linked && by.linked.symlink === true, JSON.stringify(by.linked));
    expect('a real module is not flagged as a symlink', by.good && by.good.symlink === false, JSON.stringify(by.good));
    expect('status rides the row', by.good && by.good.status === 'working', JSON.stringify(by.good));
    expect('an unrecognised status reads as active AND is reported verbatim (permissive read)',
      by.oddstatus && by.oddstatus.status === 'active' && by.oddstatus.statusInvalid === 'mothballed', JSON.stringify(by.oddstatus));
    expect('the archive is out of the scan path, so an archived module is not listed', !by.already, JSON.stringify(Object.keys(by)));
    expect('and the archive directory is never mistaken for a module', !by._archive, JSON.stringify(Object.keys(by)));
  } finally { await cleanup(); rmSync(outside, { recursive: true, force: true }); }
});
