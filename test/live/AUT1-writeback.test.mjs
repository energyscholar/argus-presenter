/*
 * AUT-1 — module write-back. POST /api/modules/:id writes a module JSON into
 * MODULES_DIR so the Content Creator's output enters the registry (the GM <select>
 * then discovers it via GET /api/modules). MUTATION → guarded: path-safe id, hard
 * size cap, AUTH-gated when a control token is configured.
 *
 * ⚠ AMENDED BY PLAN 0522 P12 (R15) — the SETUP changed; not one claim did.
 *
 * This file and test/live/SHAPE-module-write.test.mjs asserted OPPOSITE outcomes for an
 * identical setup: createServer({port:0}) with no credential, POST with no credential — AUT-1
 * required 200, SHAPE-A7 required 401/403. Both were invisible for months because the harness
 * never executed the suite (Plan 0522 P1). SHAPE-A7 is a DATA-LOSS test — writeFileSync follows
 * symlinks, and a module file may be a symlink into another repository — so Bruce ruled (R15)
 * that module writes now require a control credential UNCONDITIONALLY: "no credential
 * configured" means "nothing to verify against", and the safe answer to an unverifiable request
 * to overwrite a file is no.
 *
 * ⇒ Every test below that used to POST with no credential now configures one. NOTHING was
 * weakened, and no assertion was deleted or relaxed:
 *   · test 1 still claims "a POST writes a module, and it then appears in the registry and is
 *     fetchable" — a claim about write-back working, entirely unaffected by requiring a token.
 *   · test 2 is UNTOUCHED (it always configured a token).
 *   · test 3 still claims "a traversal id is rejected 400 and nothing is written outside
 *     MODULES_DIR". It now sends a VALID credential, which makes the claim STRONGER: it proves
 *     the id guard rejects traversal on its own merits rather than being masked by the new auth
 *     refusal that fires first for a credentialed-by-nobody request.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, unlinkSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = join(__dirname, '..', '..', 'modules');
const cleanup = (id) => { const f = join(MODULES_DIR, id + '.json'); if (existsSync(f)) unlinkSync(f); };

const MODULE = { title: 'WB test', beats: [{ id: 'a', component: 'narration', opts: { speaker: 's', text: 'hi', cta: 'ok' } }] };

const TOKEN = 'aut1-writeback-token';   // P12/R15: a write needs a credential, so the fixture configures one.

test('AUT-1 — POST writes a module; it then appears in the registry + fetchable', async () => {
  const server = await createServer({ port: 0, controlToken: TOKEN });
  const id = '_test_wb';
  try {
    const post = await fetch(server.url() + '/api/modules/' + id, { method: 'POST', headers: { 'content-type': 'application/json', 'x-control-token': TOKEN }, body: JSON.stringify(MODULE) });
    const pj = await post.json();
    expect(post.status === 200 && pj.ok === true && pj.id === id, 'POST → 200 {ok:true}', 'status=' + post.status + ' ' + JSON.stringify(pj));
    const list = await (await fetch(server.url() + '/api/modules')).json();
    expect(Array.isArray(list) && list.some((m) => m.id === id), 'registry now discovers the written module', JSON.stringify(list.map((m) => m.id)));
    const one = await (await fetch(server.url() + '/api/modules/' + id)).json();
    expect(one.module && one.module.title === 'WB test' && one.module.beats.length === 1, 'GET returns the written module', JSON.stringify(one.module && one.module.title));
  } finally { cleanup(id); await server.close(); }
});

test('AUT-1 — AUTH gate: no token → 403; correct token → 200', async () => {
  const server = await createServer({ port: 0, controlToken: 'secret' });
  const id = '_test_wb_auth';
  try {
    const noTok = await fetch(server.url() + '/api/modules/' + id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(MODULE) });
    expect(noTok.status === 403, 'POST without token → 403', 'status=' + noTok.status);
    expect(!existsSync(join(MODULES_DIR, id + '.json')), 'no file written on 403', 'exists=' + existsSync(join(MODULES_DIR, id + '.json')));
    const withTok = await fetch(server.url() + '/api/modules/' + id, { method: 'POST', headers: { 'content-type': 'application/json', 'x-control-token': 'secret' }, body: JSON.stringify(MODULE) });
    expect(withTok.status === 200, 'POST with x-control-token → 200', 'status=' + withTok.status);
  } finally { cleanup(id); await server.close(); }
});

test('AUT-1 — path traversal id → 400, nothing written outside MODULES_DIR', async () => {
  const server = await createServer({ port: 0, controlToken: TOKEN });
  const evil = join(MODULES_DIR, '..', 'evil.json');
  try {
    const bad = await fetch(server.url() + '/api/modules/' + encodeURIComponent('../evil'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-control-token': TOKEN }, body: JSON.stringify(MODULE) });
    expect(bad.status === 400, 'traversal id rejected (400)', 'status=' + bad.status);
    expect(!existsSync(evil), 'no file written outside MODULES_DIR', 'evilExists=' + existsSync(evil));
  } finally { if (existsSync(evil)) unlinkSync(evil); await server.close(); }
});
