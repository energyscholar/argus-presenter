/*
 * A RENAME MUST REACH THE CONTENT FRAME.
 *
 * Found live 2026-08-26: a player left, renamed himself to "Booga", rejoined — and every screen
 * still read "ralph". Identity is stamped into the assembled page ONCE, at push time; the `renamed`
 * frame moved the top-frame label and the roster and told the stage nothing. Worse, a page that
 * publishes its own name into shared state then wrote the STALE one, so the whole room saw it.
 *
 * ⛔ This is a STATION bug, not a game bug — a station label must track a rename.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, waitContentFrame, wait, until } from '../../harness/multi.mjs';

const PAGE = `<div id="lbl">?</div><script>
  (function () {
    function paint(){ document.getElementById('lbl').textContent = (Argus.identity()||{}).userName || '?'; }
    window.addEventListener('argus-presenter:identity', paint);
    window.addEventListener('argus-presenter:state', paint);
    paint();
  })();
</script>`;

test('0692 t-rename — a rename reaches the STAGE, not just the top frame', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const p = await connectUser(browser, server, { userId: 'u-test1', userName: 'ralph' });
    await wait(400);
    server.pushPage('u-test1', PAGE);
    await wait(900);
    const f = await waitContentFrame(p);

    const before = await f.evaluate(() => document.getElementById('lbl').textContent);
    expect('the stage starts with the pushed name', before === 'ralph', before);

    // rename over the wire, exactly as the Settings editor does
    await p.evaluate(() => window.__apIdentity.setName('Booga'));   // the same call the Settings editor makes
    await until(async () => server.presence().some((u) => u.userName === 'Booga'),
                { label: 'server accepted the rename', timeout: 4000 });

    let after = null;
    await until(async () => {
      after = await f.evaluate(() => document.getElementById('lbl').textContent);
      return after === 'Booga';
    }, { label: 'the STAGE learns the new name', timeout: 4000 }).catch(() => {});
    expect('⭐ the stage shows the NEW name, not the pushed one', after === 'Booga', String(after));

    const id = await f.evaluate(() => Argus.identity());
    expect('Argus.identity() inside the frame is updated', id.userName === 'Booga', JSON.stringify(id));
    expect('...and the userId is untouched — a rename moves the LABEL', id.userId === 'u-test1', JSON.stringify(id));
  } finally { await browser.close(); await server.close(); }
});
