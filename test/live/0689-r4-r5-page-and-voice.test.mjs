/*
 * Plan 0689 R4 + R5 — the pushed PAGE end to end, and the two smaller owed surfaces.
 *
 * ⭐⭐ THE ONE RENDER PATH, PROVED. `sendComponentTo` already sent `{t:'content', html: assemble(…)}`
 * — the exact message `pushContent` sends. A page is therefore a third `desc.kind` beside
 * `component`, not a second mechanism, and this test asserts the property that makes it worth
 * having: the page is assembled PER VIEWER, so a `visibility:'gm'` mount never leaves the server
 * for a participant. `kind:'content'` sends one string to everybody and could not do that.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('0689 R5 — a pushed PAGE reaches real clients, stamped per viewer, with GM-only mounts stripped', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const player = await connectUser(browser, server, { userId: 'p1', userName: 'Player' });
    const gm = await connectUser(browser, server, { userId: 'gm', userName: 'GM', role: 'presenter' });
    await until(() => server.presence().length === 2 && server.presence().some((u) => u.role === 'presenter'),
      { label: '2 connected incl presenter role' });

    const pushed = server.pushPage('all', '<h1 id="hdr">Approach vector</h1><div id="roll"></div><div id="secret"></div>', {
      mounts: [
        { at: '#roll', component: 'dice', opts: { dice: '2d6', promptId: 'r1', label: 'Pilot check' } },
        // ⛔ THE FORBIDDEN CASE: a GM-only region inside an authored page. It must not be in the
        //    participant's BYTES — hiding it client-side is not OPSEC.
        { at: '#secret', component: 'card', visibility: 'gm', opts: { title: 'GM only', body: 'The dockhand is an informant.', promptId: 's1' } },
      ],
      contentId: 'page-1',
    });
    expect('the page was delivered to both clients', pushed === 2, String(pushed));

    await waitContentFrame(player); await waitContentFrame(gm);
    await new Promise((r) => setTimeout(r, 500));

    const p = await contentFrame(player).evaluate(() => ({ text: document.body.textContent, hdr: !!document.querySelector('#hdr'), dice: !!document.querySelector('#roll .ap-dice') }));
    const g = await contentFrame(gm).evaluate(() => ({ text: document.body.textContent, dice: !!document.querySelector('#roll .ap-dice'), card: !!document.querySelector('#secret .ap-card, #secret *') }));

    expect('the authored heading rendered for the player', p.hdr, JSON.stringify(p).slice(0, 200));
    expect('the dice component mounted inside the authored page', p.dice, JSON.stringify(p).slice(0, 200));
    expect('⛔ the GM-only mount is NOT in the player\'s bytes', !/informant/.test(p.text), 'LEAK: ' + p.text.slice(0, 160));
    expect('the GM sees the authored page AND the GM-only mount', g.dice && /informant/.test(g.text), g.text.slice(0, 160));

    // ⭐ RECONNECT FIDELITY: the descriptor is remembered, so a late joiner lands on the page.
    const late = await connectUser(browser, server, { userId: 'p2', userName: 'Late' });
    await waitContentFrame(late);
    await new Promise((r) => setTimeout(r, 400));
    const l = await contentFrame(late).evaluate(() => ({ hdr: !!document.querySelector('#hdr'), text: document.body.textContent }));
    expect('a late joiner gets the same page', l.hdr, JSON.stringify(l).slice(0, 160));
    expect('and the GM-only mount is stripped for them too', !/informant/.test(l.text), 'LEAK: ' + l.text.slice(0, 160));
  } finally { await browser.close(); await server.close(); }
});

test('0689 R4a — raw pushContent is exactly the caller\'s bytes (and therefore hosts nothing)', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const u = await connectUser(browser, server, { userId: 'p1', userName: 'Player' });
    await until(() => server.presence().length === 1, { label: '1 connected' });
    const n = server.pushContent('all', '<h1 id="raw">Raw</h1><div data-ap-component="dice"></div>', 'raw-1');
    expect('the raw page was delivered', n === 1, String(n));
    await waitContentFrame(u);
    await new Promise((r) => setTimeout(r, 300));
    const probe = await contentFrame(u).evaluate(() => ({ raw: !!document.querySelector('#raw'), registry: typeof window.ApComponents, dice: !!document.querySelector('.ap-dice') }));
    expect('the authored bytes rendered verbatim', probe.raw, JSON.stringify(probe));
    // ⭐ STATED, NOT LAMENTED: this is the measurement behind the tool's raw:true warning.
    expect('⛔ and it carries NO component registry, so nothing could mount into it', probe.registry === 'undefined' && !probe.dice, JSON.stringify(probe));
  } finally { await browser.close(); await server.close(); }
});

test('0689 R4b — voiceRelease puts a `voice_release` FRAME on the wire, and never a `voice_enable`', async () => {
  const server = await createServer({ port: 0, voiceEnabled: true });
  const url = server.url().replace('http', 'ws');
  const seen = [];
  const ws = new WebSocket(url);
  try {
    await new Promise((resolve) => {
      ws.on('message', (b, bin) => { if (bin) return; try { seen.push(JSON.parse(b.toString())); } catch {} });
      ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', userId: 'p1', userName: 'Player', role: 'participant' })); resolve(); });
    });
    await wait(250);
    const told = server.voiceRelease('all');
    expect('the release reached the connected client', told === 1, String(told));
    await wait(300);

    const types = seen.map((m) => m.t);
    expect('a voice_release frame is on the wire', types.includes('voice_release'), types.join(','));
    /*
     * ⛔⛔ THE SAFETY PROPERTY, ASSERTED AS AN ABSENCE RATHER THAN ASSUMED. "It must remain
     * IMPOSSIBLE to force a mic on." Releasing a request Argus made is not that — and the proof is
     * that this call puts NOTHING on the wire that could start capture.
     */
    expect('⛔ and NO voice_enable frame — a release can only ever stop capture', !types.includes('voice_enable'), types.join(','));

    // The positive control, so the absence above is a measurement and not an accident of wiring.
    server.voiceEnable('all');
    await wait(300);
    expect('voiceEnable DOES put voice_enable on the same wire (the check is live)', seen.map((m) => m.t).includes('voice_enable'), seen.map((m) => m.t).join(','));
  } finally { try { ws.close(); } catch {} await server.close(); }
});

test('0689 R4c — spotlightHolders rides on presenter_status AND presenter_attendance', async () => {
  const { coreTools, _resetForTests } = await import('../../mcp/tools.mjs');
  const TOOL = Object.fromEntries(coreTools.map((t) => [t.name, t]));
  _resetForTests();
  const start = await TOOL.presenter_start.handler({ port: 0, tunnel: false, voice: false });
  try {
    expect('the presenter started', start.ok !== false, JSON.stringify(start).slice(0, 200));
    const before = await TOOL.presenter_status.handler({});
    expect('status carries spotlightHolders even when empty', Array.isArray(before.spotlightHolders) && before.spotlightHolders.length === 0, JSON.stringify(before.spotlightHolders));

    await TOOL.presenter_spotlight.handler({ userId: 'p1', granted: true });
    const after = await TOOL.presenter_status.handler({});
    const att = await TOOL.presenter_attendance.handler({});
    expect('presenter_status now names the holder', after.spotlightHolders.includes('p1'), JSON.stringify(after.spotlightHolders));
    expect('presenter_attendance names it too — the roster and the grant list are one answer', Array.isArray(att.spotlightHolders) && att.spotlightHolders.includes('p1'), JSON.stringify(att.spotlightHolders));
    expect('attendance still carries its own roster shape', Object.prototype.hasOwnProperty.call(att, 'summary'), Object.keys(att).join(','));

    await TOOL.presenter_spotlight.handler({ userId: 'p1', granted: false });
    const revoked = await TOOL.presenter_status.handler({});
    expect('a revoke removes it — the read is live, not a cache', !revoked.spotlightHolders.includes('p1'), JSON.stringify(revoked.spotlightHolders));
  } finally { await TOOL.presenter_stop.handler({ tunnel: false }); }
});
