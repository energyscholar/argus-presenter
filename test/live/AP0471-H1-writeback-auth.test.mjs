/*
 * Plan 0471 H1 — module write-back must be gated whenever ANY control credential is set.
 * A rolePassword/ROLE_HASH-only deployment (no controlToken) previously left POST
 * /api/modules/:id OPEN. Now: no/ wrong credential → 403; the ROLE_HASH → 200.
 *
 * ⚠ AMENDED BY PLAN 0522 P12 (R15) — the SECOND test's claim is REVERSED, deliberately.
 *
 * H1 closed half a hole and recorded the other half as intended behaviour: "ungated (no
 * credential) stays open (LAN back-compat)". SHAPE-A7 (test/live/SHAPE-module-write.test.mjs)
 * was authored later as a deliberately-red DATA-LOSS test asserting the opposite, and both sat
 * invisible for months because the harness never executed the suite (Plan 0522 P1). §6.8 of plan
 * 0522 put the contradiction to Bruce, who ruled (R15) for SHAPE-A7: module writes require a
 * control credential UNCONDITIONALLY, because writeFileSync follows symlinks, a module file may
 * be a symlink into another repository, and a deployment that gitignores its module directory
 * has no version history to restore from. "No credential configured" is not "no gate to apply";
 * it is "nothing to verify against", and the safe answer to an unverifiable request to overwrite
 * a file is no.
 *
 * ⇒ The LAN back-compat allowance is gone. This file's FIRST test — the actual H1 regression
 * guard, that a rolePassword-only deployment gates the write — is UNTOUCHED and still passes
 * every one of its original assertions. The second test keeps its subject (an ungated
 * deployment) and inverts only its expectation, so the retired allowance cannot creep back in
 * unnoticed: it now asserts the refusal AND that nothing was written.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, unlinkSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = join(__dirname, '..', '..', 'modules');
const cleanup = (id) => { const f = join(MODULES_DIR, id + '.json'); if (existsSync(f)) unlinkSync(f); };
const MODULE = { title: 'H1 WB', beats: [{ id: 'a', component: 'narration', opts: { speaker: 's', text: 'hi', cta: 'ok' } }] };

test('H1 — rolePassword-gated (no controlToken): unauth POST → 403; ROLE_HASH → 200', async () => {
  const server = await createServer({ port: 0, rolePassword: 'secret' });   // seed defaults to 'argus-presenter'
  const roleHash = createHash('sha256').update('argus-presenter' + 'secret').digest('hex');
  const id = '_test_h1_wb';
  try {
    // /api/auth advertises gated=true but never leaks the hash.
    const auth = await (await fetch(server.url() + '/api/auth')).json();
    expect(auth.gated === true, '/api/auth reports gated when only a rolePassword is set', JSON.stringify(auth));

    // Unauthenticated write-back → 403 (the closed hole).
    const noTok = await fetch(server.url() + '/api/modules/' + id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(MODULE) });
    expect(noTok.status === 403, 'unauth POST → 403 (was 200 before H1)', 'status=' + noTok.status);
    expect(!existsSync(join(MODULES_DIR, id + '.json')), 'nothing written on 403');

    // Wrong token → 403.
    const badTok = await fetch(server.url() + '/api/modules/' + id, { method: 'POST', headers: { 'content-type': 'application/json', 'x-control-token': 'nope' }, body: JSON.stringify(MODULE) });
    expect(badTok.status === 403, 'wrong token → 403', 'status=' + badTok.status);

    // Correct ROLE_HASH → 200.
    const okTok = await fetch(server.url() + '/api/modules/' + id, { method: 'POST', headers: { 'content-type': 'application/json', 'x-control-token': roleHash }, body: JSON.stringify(MODULE) });
    expect(okTok.status === 200, 'POST with ROLE_HASH → 200', 'status=' + okTok.status);
  } finally { cleanup(id); await server.close(); }
});

test('H1/P12 — ungated (no credential) FAILS CLOSED: the write is refused and nothing is written', async () => {
  const server = await createServer({ port: 0 });
  const id = '_test_h1_open';
  try {
    const post = await fetch(server.url() + '/api/modules/' + id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(MODULE) });
    expect(post.status === 403, 'a server with NO credential configured refuses the write (R15, reversing H1s LAN allowance)', 'status=' + post.status);
    const body = await post.json();
    // The refusal must name the CONFIGURATION fault, not just say "forbidden": the operator has
    // to be able to tell "you sent no credential" from "this server has none to check".
    expect(/credential/i.test(String(body && body.error)), 'and says WHY, so the operator can fix the deployment', JSON.stringify(body));
    expect(!existsSync(join(MODULES_DIR, id + '.json')), 'nothing written on the refusal');
  } finally { cleanup(id); await server.close(); }
});
