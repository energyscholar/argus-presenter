/*
 * CTRL-auth — control.html authenticates against a GATED server.
 *
 * Regression from the P5.5 auth gate: `npm start` defaults the server to GATED (presenter
 * role needs the seeded password hash). control.html connects as role:'presenter' but,
 * opened as its own tab, carries no credential — the server silently DOWNGRADES it to
 * participant. pushPresence only feeds control roles, so control sees NO users and cannot
 * push content. This test proves the new green-dot settings panel's inline password unlock
 * fixes it: unlock → hash sha256(seed+pw) in-browser → reconnect → presence arrives → users render.
 *
 * Screenshots (MANDATORY): test/screenshots/CTRL-locked.png (config open, locked, no users),
 * test/screenshots/CTRL-unlocked.png (presenter granted, users list populated).
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');

test('CTRL-auth — gated: control downgraded (no users) → password unlock → presenter → users visible', async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await createServer({ port: 0, rolePassword: 'password' });   // GATED
  const browser = await launch();
  try {
    // A participant USER so there IS someone for control to see.
    const userPage = await browser.newPage();
    userPage.on('pageerror', (e) => console.log('USER PAGEERR', e.message));
    await userPage.goto(`${server.url()}/?userId=u1&name=U1`, { waitUntil: 'domcontentloaded' });
    await userPage.waitForSelector('#led.on', { timeout: 5000 });
    await until(() => server.presence().some((u) => u.userId === 'u1' && u.role === 'participant'),
      { label: 'server sees u1 as participant' });

    // The CONTROL page, opened directly — NO token. It requests role:'presenter' but the
    // gated server downgrades it to participant.
    const ctl = await browser.newPage();
    ctl.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
    await ctl.goto(`${server.url()}/control?userId=ctl&name=Ctl`, { waitUntil: 'domcontentloaded' });
    await ctl.waitForSelector('#led.on', { timeout: 5000 });   // socket opens (downgraded, not rejected)
    await until(async () => (await ctl.evaluate(() => window.__ctlAuth.gated())) === true,
      { timeout: 5000, label: 'control learned server is gated (/api/auth)' });
    await until(async () => (await ctl.evaluate(() => window.__ctlAuth.role())) === 'participant',
      { timeout: 5000, label: 'control was downgraded to participant (welcome.role)' });

    // 1) Downgraded: server sees ctl as participant, and control received NO presence → no users.
    await until(() => server.presence().some((u) => u.userId === 'ctl' && u.role === 'participant'),
      { label: 'server sees ctl as participant (downgraded)' });
    await wait(200);
    const usersBefore = await ctl.evaluate(() => window.__gm.users().length);
    expect(usersBefore === 0, 'control sees NO users while downgraded (presence not fed)', usersBefore);
    const listEmptyBefore = await ctl.evaluate(() => document.getElementById('users').children.length);
    expect(listEmptyBefore === 0, '#users list is empty while locked', listEmptyBefore);

    // Open the config panel (locked state → password unlock revealed) and screenshot.
    await ctl.click('#led-btn');
    await ctl.waitForSelector('#ap-config.open', { timeout: 3000 });
    await ctl.waitForFunction(() =>
      getComputedStyle(document.getElementById('cfg-authgroup')).display !== 'none',
      { timeout: 3000 });
    const unlockVisible = await ctl.evaluate(() =>
      getComputedStyle(document.getElementById('cfg-authgroup')).display !== 'none');
    expect(unlockVisible, 'password unlock is shown when gated + downgraded');
    await ctl.screenshot({ path: path.join(SHOTS, 'CTRL-locked.png') });

    // 2) Enter the correct password and unlock → reconnect with token.
    await ctl.type('#cfg-pw', 'password');
    await ctl.click('#cfg-go');

    // 3) Control is now presenter (client + server) AND the presence feed now arrives →
    //    control's user list includes u1.
    await until(async () => (await ctl.evaluate(() => window.__ctlAuth.role())) === 'presenter',
      { timeout: 8000, label: 'control role → presenter after unlock' });
    await until(() => server.presence().some((u) => u.userId === 'ctl' && u.role === 'presenter'),
      { timeout: 8000, label: 'server sees ctl as presenter after unlock' });
    await until(async () => (await ctl.evaluate(() => window.__gm.users().some((u) => u.userId === 'u1'))) === true,
      { timeout: 8000, label: 'control now receives presence and sees u1' });

    const su = server.presence().find((u) => u.userId === 'ctl');
    expect(su && su.role === 'presenter', 'server treats ctl as presenter (control role)', su && su.role);
    const seesU1 = await ctl.evaluate(() => window.__gm.users().some((u) => u.userId === 'u1'));
    expect(seesU1, 'control user list includes u1 (presence received → rendered)');
    // The rendered #users DOM reflects it too.
    await ctl.waitForFunction(() => document.getElementById('users').children.length > 0, { timeout: 5000 });
    const listCount = await ctl.evaluate(() => document.getElementById('users').children.length);
    expect(listCount > 0, '#users DOM list is populated after unlock', listCount);
    await ctl.screenshot({ path: path.join(SHOTS, 'CTRL-unlocked.png') });
  } finally { await browser.close(); await server.close(); }
});
