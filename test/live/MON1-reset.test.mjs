/*
 * MON-1 — "reset to default" retarget. A user given a per-user display override can be
 * returned to following the ROLE/default display via control action `reset_user`. This is
 * DISTINCT from clear(userId), which BLANKS the user to branding. Here alice has a role
 * display (DEFAULT-ALL) AND a per-user override (OVERRIDE); reset_user drops the override
 * so she reverts to the role display, NOT to branding/blank.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, waitContentFrame, contentFrame, until } from '../../harness/multi.mjs';
import { WebSocket } from 'ws';

// Raw ws that authenticates `hello` (used as the presenter control client).
function rawConn(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws }); });
  });
}

test('MON-1 — reset_user retargets a user to the role display, not branding', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  const browser = await launch();
  try {
    // alice = a browser-rendered participant; presenter = a raw control ws.
    const alice = await connectUser(browser, server, { userId: 'alice', userName: 'Alice' });
    const presenter = await rawConn(url, { userId: 'gm', userName: 'GM', role: 'presenter' });
    await until(() => server.presence().length === 2 && server.presence().some((u) => u.userId === 'alice'),
      { label: 'alice + presenter connected' });

    // Role display FIRST (displayByRole.participant = DEFAULT-ALL), then the per-user override.
    server.pushContent('all', '<b id="who">DEFAULT-ALL</b>', 'def');
    server.pushContent('alice', '<b id="who">OVERRIDE</b>', 'ov');

    // alice currently sees the per-user override.
    await waitContentFrame(alice);
    await until(async () => {
      const f = contentFrame(alice); if (!f) return false;
      const t = await f.evaluate(() => document.body.textContent).catch(() => '');
      return /OVERRIDE/.test(t);
    }, { label: 'alice sees OVERRIDE', timeout: 5000 });
    {
      const f = contentFrame(alice);
      const t = await f.evaluate(() => document.body.textContent).catch(() => '');
      expect('alice sees the per-user override', /OVERRIDE/.test(t), t.slice(0, 80));
    }

    // Presenter resets alice to default.
    presenter.ws.send(JSON.stringify({ t: 'control', action: 'reset_user', args: { userId: 'alice' } }));

    // The per-user override is gone server-side; role display remains.
    await until(() => server.presence().some((u) => u.userId === 'alice' && /DEFAULT-ALL/.test(u.display || '')),
      { label: 'server presence shows alice on role display', timeout: 5000 }).catch(() => {});

    // alice's rendered content reverts to the role display, NOT branding/blank.
    await until(async () => {
      const f = contentFrame(alice); if (!f) return false;
      const t = await f.evaluate(() => document.body.textContent).catch(() => '');
      return /DEFAULT-ALL/.test(t) && !/OVERRIDE/.test(t);
    }, { label: 'alice reverts to DEFAULT-ALL', timeout: 5000 });

    const f = contentFrame(alice);
    const finalText = await f.evaluate(() => document.body.textContent).catch(() => '');
    expect('alice follows the role display after reset_user', /DEFAULT-ALL/.test(finalText) && !/OVERRIDE/.test(finalText), finalText.slice(0, 80));

    presenter.ws.close();
  } finally { await browser.close(); await server.close(); }
});
