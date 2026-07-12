/*
 * Rep 15 (F4) — shared-CRUD (shared-list): two users edit and it propagates; a
 * presenter lock blocks another user's edit. End-to-end through the store.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';

const rowText = async (page) => contentFrame(page).$$eval('.ap-crud-item [data-field="text"]', (els) => els.map((e) => e.value));
const fieldDisabled = async (page) => contentFrame(page).$eval('.ap-crud-item [data-field="text"]', (el) => el.disabled).catch(() => null);

test('rep 15 — shared-list: user A add propagates to B; presenter lock blocks B', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const A = await connectUser(browser, server, { userId: 'a', userName: 'A' });
    const B = await connectUser(browser, server, { userId: 'b', userName: 'B' });
    const P = await connectUser(browser, server, { userId: 'gm', userName: 'GM', role: 'presenter' });
    await until(() => server.presence().length === 3 && server.presence().some((u) => u.role === 'presenter'), { label: '3 incl presenter' });

    server.pushComponent('all', 'crud', { id: 'plan', config: 'shared-list', title: 'Flight plan', fields: [{ name: 'text', label: 'Step' }] });
    await waitContentFrame(A); await waitContentFrame(B); await waitContentFrame(P);
    await new Promise((r) => setTimeout(r, 400));

    // User A adds an item.
    await contentFrame(A).evaluate(() => { document.querySelector('[data-add="text"]').value = 'refuel'; document.querySelector('.ap-crud-add-btn').click(); });

    // It propagates to B.
    await until(async () => (await rowText(B)).includes('refuel'), { label: 'B sees A\'s item', timeout: 5000 });
    expect('user A add propagates to user B', (await rowText(B)).includes('refuel'), JSON.stringify(await rowText(B)));
    expect('server store holds the item', Object.values(server.store.get('crud/plan/items') || {}).some((it) => it.text === 'refuel'));

    // Presenter locks the item.
    await until(async () => (await contentFrame(P).$$eval('.ap-crud-item', (e) => e.length)) >= 1, { label: 'presenter sees the item' });
    await contentFrame(P).evaluate(() => { document.querySelector('.ap-crud-item .ap-crud-lock-btn').click(); });

    // B's edit is now blocked (field disabled by the presenter lock).
    await until(async () => (await fieldDisabled(B)) === true, { label: 'B blocked by lock', timeout: 5000 });
    expect('presenter lock blocks user B\'s edit', (await fieldDisabled(B)) === true, String(await fieldDisabled(B)));
  } finally { await browser.close(); await server.close(); }
});
