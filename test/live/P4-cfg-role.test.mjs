/*
 * P4 — CFG-role. The green-dot Config overlay carries a Role picker: a viewer who
 * arrived as a participant (no ?role= in the URL) can click "Presenter" and become
 * a control role WITHOUT editing the URL. The switch persists to localStorage and
 * re-establishes the socket so a fresh hello carries the new role — verified BOTH
 * client-side (window.__apConfig.role()) and SERVER-side (server.presence()).
 *
 * Screenshots (MANDATORY): test/screenshots/P4-config-open.png (overlay + Role row),
 * P4-role-presenter.png (Presenter selected), P4-config-closed.png (overlay vanished —
 * takedown verified as much as setup). Also a token-gate sub-test: with a control token
 * configured, ?role=presenter needs ?token= to be granted.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');

test('P4 — role picker: participant → presenter via Config overlay (client + server)', async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('PAGEERR', e.message));
    // NOTE: no role= — defaults to participant.
    await page.goto(`${server.url()}/?userId=u1&name=U1`, { waitUntil: 'domcontentloaded' });

    // 1) connected + default participant (client + server).
    await page.waitForSelector('#led.on', { timeout: 5000 });
    const role0 = await page.evaluate(() => window.__apConfig.role());
    expect(role0 === 'participant', 'starts as participant (client)', role0);
    await until(() => server.presence().some((u) => u.userId === 'u1' && u.role === 'participant'),
      { label: 'server sees u1 as participant' });

    // 2) open the Config overlay by clicking the green-dot settings button.
    await page.click('#led-btn');
    await page.waitForSelector('#ap-config.open', { timeout: 3000 });
    const open = await page.evaluate(() => window.__apConfig.open());
    expect(open === true, 'overlay open (hook)');
    const hasRow = await page.evaluate(() =>
      !!document.getElementById('cfg-role-user') && !!document.getElementById('cfg-role-presenter'));
    expect(hasRow, 'Role row present in overlay');
    await page.screenshot({ path: path.join(SHOTS, 'P4-config-open.png') });

    // 3) click Presenter; the socket re-establishes with the new role.
    await page.click('#cfg-role-presenter');
    // client-side role flips synchronously; socket blips then reconnects.
    await until(async () => (await page.evaluate(() => window.__apConfig.role())) === 'presenter',
      { label: 'client role → presenter' });
    // wait for the reconnect to land back on the server as a presenter.
    await until(() => server.presence().some((u) => u.userId === 'u1' && u.role === 'presenter'),
      { timeout: 8000, label: 'server sees u1 as presenter after reconnect' });
    await page.waitForSelector('#led.on', { timeout: 5000 });
    await page.screenshot({ path: path.join(SHOTS, 'P4-role-presenter.png') });

    // 4a) client asserts presenter; 4b) server asserts presenter (control role).
    const role1 = await page.evaluate(() => window.__apConfig.role());
    expect(role1 === 'presenter', 'role() === presenter (client)', role1);
    const su = server.presence().find((u) => u.userId === 'u1');
    expect(su && su.role === 'presenter', 'server treats u1 as presenter (control role)', su && su.role);
    // sel class reflects the choice.
    const selPres = await page.evaluate(() => document.getElementById('cfg-role-presenter').classList.contains('sel'));
    expect(selPres, 'Presenter button shows selected');

    // 5) TAKEDOWN (Bruce: verify the takedown as much as the setup): clicking the
    // settings button again CLOSES the overlay — it must vanish cleanly (.open removed,
    // display:none), not linger. Screenshot the closed state as visual proof.
    await page.click('#led-btn');
    await page.waitForFunction(() => !document.getElementById('ap-config').classList.contains('open'), { timeout: 3000 });
    const closed = await page.evaluate(() => window.__apConfig.open());
    expect(closed === false, 'overlay closed/vanished after second settings click (hook)', String(closed));
    const hidden = await page.evaluate(() => getComputedStyle(document.getElementById('ap-config')).display === 'none');
    expect(hidden, 'overlay is display:none when closed (no lingering panel)');
    await page.screenshot({ path: path.join(SHOTS, 'P4-config-closed.png') });
  } finally { await browser.close(); await server.close(); }
});

test('P4 — token pass-through: control token gates presenter, ?token= grants it', async () => {
  const server = await createServer({ port: 0, controlToken: 'secret' });
  const browser = await launch();
  try {
    // No token → server forces participant despite ?role=presenter.
    const p1 = await browser.newPage();
    await p1.goto(`${server.url()}/?userId=notoken&name=NT&role=presenter`, { waitUntil: 'domcontentloaded' });
    await p1.waitForSelector('#led.on', { timeout: 5000 });
    await until(() => server.presence().some((u) => u.userId === 'notoken'), { label: 'notoken hello landed' });
    await wait(150);
    const nt = server.presence().find((u) => u.userId === 'notoken');
    expect(nt && nt.role === 'participant', 'no token → downgraded to participant', nt && nt.role);

    // Correct token in URL → granted presenter.
    const p2 = await browser.newPage();
    await p2.goto(`${server.url()}/?userId=withtoken&name=WT&role=presenter&token=secret`, { waitUntil: 'domcontentloaded' });
    await p2.waitForSelector('#led.on', { timeout: 5000 });
    await until(() => server.presence().some((u) => u.userId === 'withtoken' && u.role === 'presenter'),
      { label: 'withtoken granted presenter' });
    const wt = server.presence().find((u) => u.userId === 'withtoken');
    expect(wt && wt.role === 'presenter', 'correct token → presenter granted', wt && wt.role);
  } finally { await browser.close(); await server.close(); }
});
