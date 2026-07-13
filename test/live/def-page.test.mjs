/*
 * DEF-1 — cascading default page + STOP (live, deterministic ws round-trips, no puppeteer).
 * A module WITH manifest.defaultBeatId auto-shows its title/default beat on setModule; the
 * show_default op (Home) re-shows it after advancing; clear (STOP) returns to branding.
 * A t:'content' push carries the beat opts JSON-embedded in its html; a t:'clear' is branding.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

function connect(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on('message', (b) => { try { inbox.push(JSON.parse(b.toString())); } catch {} });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws, inbox }); });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const MODULE = {
  manifest: { title: 'Deck', defaultBeatId: 'b-title', requirements: { terminalClear: true } },
  beats: [
    { id: 'b-one', component: 'card', opts: { title: 'FIRST_CONTENT_BEAT' } },
    { id: 'b-two', component: 'card', opts: { title: 'SECOND_CONTENT_BEAT' } },
    { id: 'b-title', component: 'card', opts: { title: 'MODULE_TITLE_PAGE' } },
  ],
};
// last content-push html reaching this client after `mark`
const lastContent = (inbox, mark = 0) => inbox.slice(mark).filter((m) => m.t === 'content').map((m) => m.html).pop() || null;
const lastType = (inbox, mark = 0) => (inbox.slice(mark).filter((m) => m.t === 'content' || m.t === 'clear').pop() || {}).t || null;

test('DEF-1 — setModule auto-shows the manifest default (title) beat to a live client', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await connect(url, { userId: 'u1', userName: 'Alice', role: 'participant' });
    await wait(120);
    const mark = a.inbox.length;

    server.setModule(MODULE);
    await wait(200);

    const html = lastContent(a.inbox, mark);
    expect('client received a content push (not branding) on load', lastType(a.inbox, mark) === 'content', String(lastType(a.inbox, mark)));
    expect('the pushed content is the TITLE beat', html != null && /MODULE_TITLE_PAGE/.test(html), html && html.slice(0, 60));
    expect('title beat is NOT a content beat (b-one stays index 0 for Start)', !(html && /FIRST_CONTENT_BEAT/.test(html)));
    expect('module/current points at the title beat (index 2)', server.store.get('module/current') === 2, String(server.store.get('module/current')));
    a.ws.close();
  } finally { await server.close(); }
});

test('DEF-1 — a module WITHOUT a default stays on branding at load (cascade fallback)', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await connect(url, { userId: 'u1', userName: 'Alice', role: 'participant' });
    await wait(120);
    const mark = a.inbox.length;

    server.setModule({ manifest: { title: 'NoDefault' }, beats: [{ id: 'b-one', component: 'card', opts: { title: 'FIRST_CONTENT_BEAT' } }] });
    await wait(200);

    expect('no content pushed → client stays on branding', lastType(a.inbox, mark) === null, String(lastType(a.inbox, mark)));
    expect('currentBeat stays -1 (no auto-show)', server.store.get('module/current') === -1, String(server.store.get('module/current')));
    a.ws.close();
  } finally { await server.close(); }
});

test('DEF-1 — show_default (Home) re-shows the title after advancing; clear (STOP) → branding', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await connect(url, { userId: 'u1', userName: 'Alice', role: 'participant' });
    await wait(120);

    server.setModule(MODULE);          // auto-shows title
    await wait(150);

    // Advance to a later CONTENT beat (Start-equivalent).
    let mark = a.inbox.length;
    server.showBeat(0);
    await wait(150);
    expect('advanced to first content beat', /FIRST_CONTENT_BEAT/.test(lastContent(a.inbox, mark) || ''), (lastContent(a.inbox, mark) || '').slice(0, 60));
    expect('module/current === 0 after Start', server.store.get('module/current') === 0, String(server.store.get('module/current')));

    // Home → show_default re-shows the TITLE beat. Drive via the control op path.
    mark = a.inbox.length;
    server.showDefault();
    await wait(150);
    expect('Home re-shows the TITLE beat', /MODULE_TITLE_PAGE/.test(lastContent(a.inbox, mark) || ''), (lastContent(a.inbox, mark) || '').slice(0, 60));
    expect('module/current back at title (index 2)', server.store.get('module/current') === 2, String(server.store.get('module/current')));

    // STOP → clear returns the client to branding (t:'clear', not content).
    mark = a.inbox.length;
    server.clear('all');
    await wait(150);
    expect('STOP sends a t:clear (branding) to the client', lastType(a.inbox, mark) === 'clear', String(lastType(a.inbox, mark)));
    a.ws.close();
  } finally { await server.close(); }
});
