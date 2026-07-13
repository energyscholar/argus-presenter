/*
 * CLI-1 — standalone launcher + listModules garbage filter (Plan P2).
 *   #1 listModules filter: /api/modules returns ONLY real content modules (has beats
 *      and/or sections). A stray JSON that parses but is not a module (e.g. a
 *      *-responses.json log, no beats) must NOT appear. Deterministic (temp fixture).
 *   #2 CLI prints URLs: `node app/server.mjs 0` prints the three entry URLs; assert
 *      stdout carries the /control line, then kill the child (bounded by a timeout).
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

test('CLI-1 — /api/modules lists real modules only; parses-but-not-a-module is filtered out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'argus-mods-'));
  // (a) a real content module (has beats) and (b) garbage JSON that parses but has no beats.
  writeFileSync(join(dir, 'goodmod.json'), JSON.stringify({
    manifest: { title: 'Good Module' },
    beats: [{ component: 'narration', promptId: 'g-intro', durationSec: 30 }],
  }));
  writeFileSync(join(dir, 'stuff-responses.json'), JSON.stringify({ foo: 1 }));

  const prevDir = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_MODULES_DIR = dir;   // MODULES_DIR is read at createServer time
  let server;
  try {
    server = await createServer({ port: 0 });
    const res = await fetch(server.url() + '/api/modules');
    const list = await res.json();
    const ids = list.map((m) => m.id);
    expect(ids.includes('goodmod'), 'real module appears', JSON.stringify(ids));
    expect(!ids.includes('stuff-responses'), 'garbage (no beats/sections) is filtered out', JSON.stringify(ids));
  } finally {
    if (server) await server.close();
    if (prevDir === undefined) delete process.env.PRESENTER_MODULES_DIR;
    else process.env.PRESENTER_MODULES_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI-1 — `node app/server.mjs 0` prints the three entry URLs (control line present)', async () => {
  const serverPath = fileURLToPath(new URL('../../app/server.mjs', import.meta.url));
  const child = spawn(process.execPath, [serverPath, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const seen = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);   // bound: never hang
    child.stdout.on('data', (b) => {
      out += b.toString();
      if (out.includes('/control')) { clearTimeout(timer); resolve(true); }
    });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  });
  child.kill('SIGKILL');
  expect(seen, 'stdout contains a /control URL line', JSON.stringify(out.slice(0, 300)));
});
