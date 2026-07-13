/*
 * P5.5 — AUTH-ROLE. The presenter role is password-gated by a seeded hash ("keep honest
 * people honest"). A participant opens Config and clicks Presenter: instead of switching
 * immediately, an inline password field appears. A WRONG password is denied (stays
 * participant + "wrong password" shown); the correct password (`password`) grants presenter.
 * The plaintext never leaves the browser — only sha256(seed+password) travels as the token.
 *
 * Screenshots (MANDATORY): test/screenshots/P5_5-pw-prompt.png (pw field revealed),
 * P5_5-denied.png (wrong password → error, still participant),
 * P5_5-granted.png (correct password → presenter).
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');

test('P5.5 — presenter password gate: prompt → denied (wrong) → granted (correct)', async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await createServer({ port: 0, rolePassword: 'password' });
  const browser = await launch();
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('PAGEERR', e.message));
    // No role= → participant. Server is gated (rolePassword set).
    await page.goto(`${server.url()}/?userId=u1&name=U1`, { waitUntil: 'domcontentloaded' });

    // Connected as participant (client + server), and the client learned it's gated.
    await page.waitForSelector('#led.on', { timeout: 5000 });
    await until(async () => (await page.evaluate(() => window.__apConfig.gated())) === true,
      { timeout: 5000, label: 'client learned server is gated (/api/auth)' });
    await until(() => server.presence().some((u) => u.userId === 'u1' && u.role === 'participant'),
      { label: 'server sees u1 as participant' });

    // 1) Open Config, click Presenter → the password field is REVEALED (no switch yet).
    await page.click('#led-btn');
    await page.waitForSelector('#ap-config.open', { timeout: 3000 });
    await page.click('#cfg-role-presenter');
    await page.waitForFunction(() =>
      getComputedStyle(document.getElementById('cfg-role-pwgroup')).display !== 'none',
      { timeout: 3000 });
    const pwVisible = await page.evaluate(() =>
      getComputedStyle(document.getElementById('cfg-role-pwgroup')).display !== 'none');
    expect(pwVisible, 'password field appears when a gated user clicks Presenter');
    // Not switched yet — still participant on both sides.
    const roleAtPrompt = await page.evaluate(() => window.__apConfig.role());
    expect(roleAtPrompt === 'participant', 'still participant while prompt is open (no premature switch)', roleAtPrompt);
    await page.screenshot({ path: path.join(SHOTS, 'P5_5-pw-prompt.png') });

    // 2) WRONG password → Unlock → denied: error shown, still participant.
    await page.type('#cfg-role-pw', 'nope');
    await page.click('#cfg-role-go');
    await page.waitForFunction(() =>
      /wrong password/i.test(document.getElementById('cfg-role-msg').textContent),
      { timeout: 8000 });
    const msg = await page.evaluate(() => document.getElementById('cfg-role-msg').textContent);
    expect(/wrong password/i.test(msg), 'wrong-password error shown', msg);
    const roleDenied = await page.evaluate(() => window.__apConfig.role());
    expect(roleDenied === 'participant', 'client role reverts to participant on deny', roleDenied);
    const su1 = server.presence().find((u) => u.userId === 'u1');
    expect(su1 && su1.role === 'participant', 'server keeps u1 as participant after wrong password', su1 && su1.role);
    await page.screenshot({ path: path.join(SHOTS, 'P5_5-denied.png') });

    // 3) CORRECT password → Unlock → granted presenter (client + server).
    await page.evaluate(() => { document.getElementById('cfg-role-pw').value = ''; });
    await page.type('#cfg-role-pw', 'password');
    await page.click('#cfg-role-go');
    await until(async () => (await page.evaluate(() => window.__apConfig.role())) === 'presenter',
      { timeout: 8000, label: 'client role → presenter after correct password' });
    await until(() => server.presence().some((u) => u.userId === 'u1' && u.role === 'presenter'),
      { timeout: 8000, label: 'server sees u1 as presenter after correct password' });
    const roleGranted = await page.evaluate(() => window.__apConfig.role());
    expect(roleGranted === 'presenter', 'client __apConfig.role() === presenter', roleGranted);
    const su2 = server.presence().find((u) => u.userId === 'u1');
    expect(su2 && su2.role === 'presenter', 'server treats u1 as presenter (control role)', su2 && su2.role);
    await page.screenshot({ path: path.join(SHOTS, 'P5_5-granted.png') });
  } finally { await browser.close(); await server.close(); }
});
