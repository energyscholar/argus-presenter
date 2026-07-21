/*
 * Plan 0471 H1 — module write-back must be gated whenever ANY control credential is set.
 * A rolePassword/ROLE_HASH-only deployment (no controlToken) previously left POST
 * /api/modules/:id OPEN. Now: no/ wrong credential → 403; the ROLE_HASH → 200.
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

test('H1 — ungated (no credential) stays open (LAN back-compat)', async () => {
  const server = await createServer({ port: 0 });
  const id = '_test_h1_open';
  try {
    const post = await fetch(server.url() + '/api/modules/' + id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(MODULE) });
    expect(post.status === 200, 'ungated deployment still accepts the write', 'status=' + post.status);
  } finally { cleanup(id); await server.close(); }
});
