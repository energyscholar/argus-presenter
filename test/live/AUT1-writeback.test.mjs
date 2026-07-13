/*
 * AUT-1 — module write-back. POST /api/modules/:id writes a module JSON into
 * MODULES_DIR so the Content Creator's output enters the registry (the GM <select>
 * then discovers it via GET /api/modules). MUTATION → guarded: path-safe id, hard
 * size cap, AUTH-gated when a control token is configured.
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

test('AUT-1 — POST writes a module; it then appears in the registry + fetchable', async () => {
  const server = await createServer({ port: 0 });
  const id = '_test_wb';
  try {
    const post = await fetch(server.url() + '/api/modules/' + id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(MODULE) });
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
  const server = await createServer({ port: 0 });
  const evil = join(MODULES_DIR, '..', 'evil.json');
  try {
    const bad = await fetch(server.url() + '/api/modules/' + encodeURIComponent('../evil'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(MODULE) });
    expect(bad.status === 400, 'traversal id rejected (400)', 'status=' + bad.status);
    expect(!existsSync(evil), 'no file written outside MODULES_DIR', 'evilExists=' + existsSync(evil));
  } finally { if (existsSync(evil)) unlinkSync(evil); await server.close(); }
});
