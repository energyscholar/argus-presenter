/*
 * AUT-2 — hot-reload. A module file written into MODULES_DIR while the server runs
 * is picked up by the fs.watch watcher: the cache is invalidated and every CONTROL
 * role (presenter/ai/gm) receives a {t:'module-changed', id} frame — so a just-saved
 * module is discoverable without a restart. Debounced against fs.watch's rapid dupes.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { WebSocket } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = join(__dirname, '..', '..', 'modules');   // the server's default MODULES_DIR

// Raw ws that authenticates `hello` and collects every frame it receives.
function rawConn(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const frames = [];
    ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) {} });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws, frames }); });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('AUT-2 — a new module file on disk pushes {t:module-changed} to control roles', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  const id = '_hot_test';
  const file = join(MODULES_DIR, id + '.json');
  try {
    const presenter = await rawConn(url, { userId: 'gm', userName: 'GM', role: 'presenter' });
    await wait(100);   // settle hello

    // Write a brand-new module file into MODULES_DIR while the server watches.
    writeFileSync(file, JSON.stringify({ manifest: { title: 'X' }, beats: [{ id: 'a', component: 'card' }] }));

    // Wait for fs.watch + the ~150ms debounce to fire, then the notify.
    await wait(500);

    const hit = presenter.frames.find((f) => f.t === 'module-changed' && f.id === id);
    expect('presenter received {t:module-changed, id:_hot_test}', !!hit, JSON.stringify(presenter.frames.filter((f) => f.t === 'module-changed')));

    presenter.ws.close();
  } finally {
    if (existsSync(file)) unlinkSync(file);   // no stray files
    await server.close();
  }
});
