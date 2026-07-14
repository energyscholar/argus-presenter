/*
 * KBD-1 (Plan 0456 P1) — keyboard transport on the control page.
 * One document-level keydown handler: Space/ArrowRight → Next, ArrowLeft → Prev,
 * Escape → close the settings overlay if open (takes precedence) else STOP,
 * digits 1–9 → first beat of section N. Keys route through the EXISTING buttons /
 * beat-jump path, and are ignored while typing (input/textarea/select/contenteditable).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';

const MODULE = {
  title: 'Keyboard demo',
  beats: [
    { id: 'b1', component: 'card', opts: { title: 'One', promptId: 'p1' } },
    { id: 'b2', component: 'card', opts: { title: 'Two', promptId: 'p2' } },
    { id: 'b3', component: 'card', opts: { title: 'Three', promptId: 'p3' } },
    { id: 'b4', component: 'card', opts: { title: 'Four', promptId: 'p4' } },
  ],
  sections: [
    { title: 'Sec 1', beatIds: ['b1', 'b2'] },
    { title: 'Sec 2', beatIds: ['b3', 'b4'] },
  ],
};

test('KBD1 — keyboard transport: arrows/Space/digit jump/Escape + typing guard', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const ctl = await browser.newPage();
    ctl.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
    await ctl.goto(`${server.url()}/control?userId=op&role=presenter`, { waitUntil: 'domcontentloaded' });
    await ctl.waitForFunction(() => typeof window.__control === 'function' && window.__gm && typeof window.__gm.setModule === 'function');
    await until(() => server.presence().some((u) => u.role === 'presenter'), { label: 'presenter connected' });

    // Load the SAME module server-side and into the panel (enables the transport buttons).
    server.setModule(MODULE);
    await ctl.evaluate((m) => window.__gm.setModule(m), MODULE);

    const cur = () => ctl.evaluate(() => window.__gm.cur());
    const atBeat = (i, label) => until(async () => (await cur()) === i && server.store.get('module/current') === i, { label });

    server.showBeat(0);
    await atBeat(0, 'panel+server at beat 0');

    // ArrowRight → Next.
    await ctl.keyboard.press('ArrowRight');
    await atBeat(1, 'ArrowRight advanced to beat 1');
    expect('ArrowRight advances curBeat', (await cur()) === 1);

    // Space → Next.
    await ctl.keyboard.press(' ');
    await atBeat(2, 'Space advanced to beat 2');
    expect('Space advances curBeat', (await cur()) === 2);

    // ArrowLeft → Prev.
    await ctl.keyboard.press('ArrowLeft');
    await atBeat(1, 'ArrowLeft went back to beat 1');
    expect('ArrowLeft goes back', (await cur()) === 1);

    // Digit 1 → first beat of section 1 (jump from inside section 2).
    server.showBeat(3);
    await atBeat(3, 'panel+server at beat 3 (section 2)');
    await ctl.keyboard.press('1');
    await atBeat(0, 'digit 1 jumped to section 1 first beat');
    expect('digit 1 jumps to section 1 first beat', (await cur()) === 0);

    // Typing guard: keydown with target=input does nothing.
    await ctl.focus('#pc-component');
    await ctl.keyboard.press('ArrowRight');
    await ctl.keyboard.press(' ');
    await wait(300);
    expect('keys ignored while typing in an input', (await cur()) === 0 && server.store.get('module/current') === 0,
      'cur=' + (await cur()) + ' server=' + server.store.get('module/current'));
    await ctl.evaluate(() => document.activeElement && document.activeElement.blur());

    // Escape with the config overlay OPEN → closes it, does NOT stop.
    await ctl.click('#led-btn');
    await ctl.waitForSelector('#ap-config.open', { timeout: 3000 });
    const labelBefore = await ctl.$eval('#pvlabel', (el) => el.textContent);
    expect('showing content before Escape (not idle)', labelBefore !== 'idle', labelBefore);
    await ctl.keyboard.press('Escape');
    await until(async () => !(await ctl.evaluate(() => document.getElementById('ap-config').classList.contains('open'))),
      { label: 'config closed by Escape' });
    await wait(300);
    const labelAfterClose = await ctl.$eval('#pvlabel', (el) => el.textContent);
    expect('Escape with config open closed it WITHOUT stopping', labelAfterClose !== 'idle', labelAfterClose);

    // Escape with the config CLOSED → STOP (clear → idle branding).
    await ctl.keyboard.press('Escape');
    await until(async () => (await ctl.$eval('#pvlabel', (el) => el.textContent)) === 'idle',
      { label: 'Escape fired STOP (display cleared to idle)' });
    expect('Escape with config closed fires STOP', (await ctl.$eval('#pvlabel', (el) => el.textContent)) === 'idle');

    await ctl.close();
  } finally { await browser.close(); await server.close(); }
});
