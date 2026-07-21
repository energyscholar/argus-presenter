/*
 * SHAPE-A7 — module write-back cannot destroy the campaign file. DATA-LOSS PREVENTION.
 * RED TODAY: POST /api/modules/:id (app/server.mjs:346-378) is gated ONLY if CONTROL_TOKEN
 * is set, and writeFileSync FOLLOWS SYMLINKS - and modules/arabus.json symlinks to the live
 * campaign source. The fs watcher then hot-reloads the wreckage.
 * END STATE: write-back requires the control credential unconditionally (deny when none is
 * configured), and never writes through a symlink.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';

const MODULE = { title: 'overwrite-attempt', beats: [{ component: 'card', opts: { title: 'x' } }] };

test('SHAPE-A7 — an uncredentialed module write is refused', async () => {
  const server = await createServer({ port: 0 });
  try {
    const res = await fetch(server.url() + '/api/modules/sec-write-probe', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(MODULE),
    });
    expect('uncredentialed POST /api/modules is refused (401/403)',
      res.status === 401 || res.status === 403, 'status=' + res.status);
  } finally { await server.close(); }
});
