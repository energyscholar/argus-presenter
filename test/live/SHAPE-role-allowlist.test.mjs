/*
 * SHAPE-A2 — the role set is CLOSED.
 * RED TODAY: only presenter/ai are gated (app/server.mjs:547); any other string is taken
 * verbatim, and 'gm' is a privileged READ role (app/permissions.mjs:34-37). So `?role=gm`
 * returns the GM slice. At a friendly table that is not an attack — it is one curious
 * player spoiling the adventure.
 * END STATE: roles are allowlisted at the identity seam; anything else is downgraded to
 * participant and logged loudly.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, until } from '../../harness/multi.mjs';

test('SHAPE-A2 — forged roles are downgraded to participant', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    await connectUser(browser, server, { userId: 'curious', userName: 'Curious', role: 'gm' });
    await connectUser(browser, server, { userId: 'odd', userName: 'Odd', role: 'wizard' });
    await until(() => server.presence().length === 2, { label: 'both connected' });

    const roleOf = (id) => (server.presence().find((u) => u.userId === id) || {}).role;
    expect('role "gm" is downgraded to participant', roleOf('curious') === 'participant',
      'got role=' + roleOf('curious'));
    expect('an unknown role is downgraded to participant', roleOf('odd') === 'participant',
      'got role=' + roleOf('odd'));
  } finally { await browser.close(); await server.close(); }
});
