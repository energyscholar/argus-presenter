/*
 * Plan 0692 T7 — ⭐ THE URL CONTRACT, ONE ASSERTION PER PARAMETER, INCLUDING THE NEGATIVES.
 *
 * ⭐ THE THING BRUCE ASKED FOR BY NAME: "continue to support URL variables on login, without
 *   breaking what we have." Every parameter in the table below works today and is load-bearing;
 *   plan 0692 extends the PRECEDENCE at the bottom (storage fills a gap) and changes nothing at the
 *   top (a URL parameter always wins). This file is what stops a later refactor from quietly
 *   inverting that.
 *
 *      ?userId= / ?u=        caller-supplied identity — HONOURED off a seat link, DISCARDED on one
 *      ?name=   / ?n=        caller-supplied display name
 *      ?role=                the privilege axis only; sticky via localStorage
 *      ?stationUID= / ?station=  seat provisioning (the derivation, pinned by t79)
 *      ?token=               control credential
 *      ?cap=                 signed guest capability
 *
 * ⛔ IT IS A BROWSER TEST BECAUSE THE CONTRACT IS A CLIENT ONE. What the page PUTS ON THE WIRE from
 *   its own reading of the query string is the thing under test; a raw socket sending a
 *   hand-written hello would be testing the fixture, not the page. t79 (test/unit/) pins the
 *   server half and is untouched by this plan.
 *
 * ⛔ EVERY PARAMETER GETS A NEGATIVE. "?u= is honoured" passes just as well when nothing reads the
 *   URL at all and the id happens to match; the assertion that carries the meaning is the one that
 *   says what did NOT happen.
 *
 * ⚠ localStorage IS PER-ORIGIN AND THE ORIGIN IS THE PORT. Each createServer({port:0}) is a
 *   different origin with a different store, so a "the same browser remembers" assertion must stay
 *   on ONE server. That is why these are long tests rather than many short ones.
 */
import { test, check, expect } from '../../harness/test.mjs';
import { createServer, slugForSeat } from '../../app/server.mjs';
import { launch, wait, until, waitContentFrame } from '../../harness/multi.mjs';
import { mintCapability } from '../../lib/capability.mjs';
import { makePluginsDir, withPlugins, stationManifest } from '../unit/_0514-fixtures.mjs';

const NS = 'argus-presenter';

/** Everything the page believes about who it is, read from its own hook. */
const ident = (page) => page.evaluate(() => ({
  userId: window.__apIdentity.userId(),
  userName: window.__apIdentity.userName(),
  named: window.__apIdentity.named(),
  canRename: window.__apIdentity.canRename(),
  hint: window.__apIdentity.hint(),
  who: (document.getElementById('who') || {}).textContent || '',
  storedUid: (function(){ try { return localStorage.getItem('argus-presenter:uid'); } catch(e){ return 'THREW'; } })(),
  storedName: (function(){ try { return localStorage.getItem('argus-presenter:name'); } catch(e){ return 'THREW'; } })(),
}));

/** Open `path` on `server` and wait until the page has resolved its identity AND said hello. */
async function open(browser, server, path, { page = null } = {}) {
  const p = page || await browser.newPage();
  if (!page) p.on('pageerror', (e) => console.log('0692 PAGEERR', e.message));
  await p.goto(server.url() + path, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__apIdentity && document.getElementById('led').classList.contains('on'), { timeout: 20000 });
  await wait(150);   // let the welcome land
  return p;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * AC1 · AC2 · AC4 · AC6 · AC11 — ONE BROWSER, ONE SERVER, THE WHOLE STICKINESS STORY.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0692 AC1/AC2/AC4/AC6 — the identity is minted once and reused; the name is remembered and changeable', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  let page = null;
  try {
    /* ── AC1 — no stored uid ⇒ one is minted, STORED, and sent. ────────────────────────────── */
    page = await open(browser, server, '/');
    const a = await ident(page);
    check('AC1 — a uid was minted in the browser\'s own format', /^u-[a-z0-9]{8}$/.test(a.userId), a.userId);
    check('⛔ AC1 — and it is NOT the old per-load `anon-` id', !/^anon-/.test(a.userId), a.userId);
    check('AC1 — it was written to localStorage', a.storedUid === a.userId, `${a.storedUid} vs ${a.userId}`);
    check('AC1 — the server seated it under exactly that id',
      server.presence().some((p) => p.userId === a.userId), JSON.stringify(server.presence().map((p) => p.userId)));

    /* ── AC4 — absent both `?name=` and a stored name ⇒ UNNAMED, and NOT the literal 'Guest'. ─ */
    check('⛔ AC4 — a fresh visitor is UNNAMED', a.named === false, JSON.stringify(a));
    check('⛔ AC4 — and is NOT called the literal `Guest`', a.userName !== 'Guest', a.userName);
    check('AC4 — the readout says what to do about it', /Set a name to join/.test(a.who), a.who);
    check('⚠ ...and still carries the parenthesised id t0529-p3 waits on', /\(/.test(a.who), a.who);

    /* ── AC1 — A RELOAD SENDS THE SAME uid. This is the whole point. ───────────────────────── */
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__apIdentity && document.getElementById('led').classList.contains('on'), { timeout: 20000 });
    await wait(150);
    const b = await ident(page);
    check('⭐ AC1 — a RELOAD comes back as the SAME identity', b.userId === a.userId, `${a.userId} → ${b.userId}`);
    check('⭐ AC1 — so the roster holds ONE row for this browser, not two',
      server.presence().filter((p) => p.userId === a.userId).length === 1,
      JSON.stringify(server.presence().map((p) => p.userId)));

    /* ── T2/AC6 — setting a name. The label moves; the key does not. ───────────────────────── */
    const ok = await page.evaluate(() => window.__apIdentity.setName('Bob'));
    check('a name can be set', ok === true, String(ok));
    await until(() => server.presence().some((p) => p.userName === 'Bob'), { label: 'Bob on the roster' });
    const c = await ident(page);
    check('AC6 — the name is stored', c.storedName === 'Bob', String(c.storedName));
    check('⛔ AC6 — and the userId did NOT move', c.userId === a.userId, `${a.userId} → ${c.userId}`);
    const rn = await page.evaluate(() => window.__apRenamed || null);
    check('⛔ the server\'s receipt names the SAME userId', rn && rn.userId === a.userId, JSON.stringify(rn));

    await page.evaluate(() => window.__apIdentity.setName('Conan'));
    await until(() => server.presence().some((p) => p.userName === 'Conan'), { label: 'Conan on the roster' });
    check('AC6 — renaming twice in one session works',
      server.presence().some((p) => p.userId === a.userId && p.userName === 'Conan'),
      JSON.stringify(server.presence().map((p) => [p.userId, p.userName])));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__apIdentity && document.getElementById('led').classList.contains('on'), { timeout: 20000 });
    await wait(150);
    const d = await ident(page);
    check('⭐ AC6 — the LAST name survives a reload', d.userName === 'Conan', d.userName);
    check('AC6 — and so does the identity', d.userId === a.userId, d.userId);
    check('AC6 — a named visitor is named', d.named === true, JSON.stringify(d));

    /* ── AC2 — `?userId=` OVERRIDES the stored uid, and does NOT overwrite it. ─────────────── */
    await page.goto(server.url() + '/?userId=explicit-caller-id', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__apIdentity && document.getElementById('led').classList.contains('on'), { timeout: 20000 });
    await wait(150);
    const e = await ident(page);
    check('AC2 — `?userId=` wins over the stored uid', e.userId === 'explicit-caller-id', e.userId);
    check('⛔ AC2 — and the browser\'s OWN identity was NOT overwritten', e.storedUid === a.userId, `${e.storedUid} vs ${a.userId}`);
    check('AC2 — the stored NAME still applies (the two are independent)', e.userName === 'Conan', e.userName);

    /* ── AC4 — `?name=` wins over a stored name, and the negative: the stored one does NOT. ── */
    await page.goto(server.url() + '/?n=Link%20Name', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__apIdentity && document.getElementById('led').classList.contains('on'), { timeout: 20000 });
    await wait(150);
    const f = await ident(page);
    check('⭐ AC4 — `?n=` WINS over the stored name', f.userName === 'Link Name', f.userName);
    check('⛔ AC4 — the stored name did NOT win', f.userName !== 'Conan', f.userName);
    check('⛔ AC4 — and the URL name did not overwrite what is stored', f.storedName === 'Conan', String(f.storedName));
    check('AC2 — with no `?userId=`, the browser is back to its OWN identity', f.userId === a.userId, f.userId);

    /* ── T5 — the placeholder is neutral and derived from the uid. ─────────────────────────── */
    check('⛔ T5 — the default hint is `Guest <last four of the uid>`, and nothing else',
      f.hint === 'Guest ' + a.userId.slice(-4), f.hint);
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
    await server.close();
  }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * AC11 — localStorage THROWING ON READ *AND* ON WRITE.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0692 AC11 — a browser with no usable storage still works, just without stickiness', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  let page = null;
  try {
    page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    /* ⛔ BOTH SIDES. A read-only failure is the easy half; the write is where a naive
       `localStorage.setItem(...)` outside a try/catch takes the whole script down mid-boot, and
       everything after it — the socket, the stage, the config panel — never runs. */
    await page.evaluateOnNewDocument(() => {
      const boom = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 }; },
      });
    });
    await page.goto(server.url() + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__apIdentity && document.getElementById('led').classList.contains('on'), { timeout: 20000 });
    await wait(200);
    const a = await ident(page);
    check('AC11 — the page still loads and still has an identity', /^u-[a-z0-9]{8}$/.test(a.userId), a.userId);
    check('AC11 — reading storage threw, and was absorbed', a.storedUid === 'THREW', String(a.storedUid));
    check('AC11 — the socket still connected and the server still sees it',
      server.presence().some((p) => p.userId === a.userId), JSON.stringify(server.presence().map((p) => p.userId)));
    /* Naming still works for the session — only the REMEMBERING is lost. */
    const ok = await page.evaluate(() => window.__apIdentity.setName('Ephemeral'));
    check('AC11 — a name can still be set (the write throws and is absorbed)', ok === true, String(ok));
    await until(() => server.presence().some((p) => p.userName === 'Ephemeral'), { label: 'Ephemeral on the roster' });
    check('⛔ AC11 — and NOTHING threw out of the page', errors.length === 0, errors.join(' · '));
    /* The stickiness is what is lost, and it is lost honestly: a reload is a new identity. */
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__apIdentity && document.getElementById('led').classList.contains('on'), { timeout: 20000 });
    const b = await ident(page);
    check('AC11 — with no storage, a reload is a NEW identity — degraded, not broken',
      /^u-[a-z0-9]{8}$/.test(b.userId), b.userId);
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
    await server.close();
  }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * AC7 · AC8 — THE SOFT GATE. Sees everything, writes nothing.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0692 AC7/AC8 — an unnamed visitor SEES everything and WRITES nothing; a named one writes normally', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  let page = null;
  try {
    page = await open(browser, server, '/');
    const a = await ident(page);
    expect(a.named === false, 'the visitor starts unnamed', JSON.stringify(a));

    /* ── AC7 — THE STAGE RENDERS. A passive audience member is never blocked. ──────────────── */
    server.pushComponent('all', 'card', { title: 'Visible To Everyone', body: 'even before you have a name' });
    const frame = await waitContentFrame(page, { timeout: 10000 });
    check('⭐ AC7 — the stage renders for an UNNAMED visitor', !!frame, 'a content frame mounted');

    /* ── AC7 — but `op` and `answer` are DROPPED. ⛔ POSTED FROM INSIDE THE SANDBOXED CONTENT
     *   FRAME, which is where a real component's writes come from. Posting from the page's own
     *   window instead would be sent back by the relay's `e.source !== frame.contentWindow` guard
     *   and would prove NOTHING about the gate — the write would be missing for the wrong reason.
     *   (Found the hard way: the first draft of this test "passed" the drop assertions with the
     *   gate never once consulted.) */
    const probe = () => frame.evaluate(() => {
      parent.postMessage({ source: 'argus-presenter', type: 'op', path: 'shared/gate/probe', verb: 'set', value: 'WROTE', opId: 'gate-' + Date.now() }, '*');
      parent.postMessage({ source: 'argus-presenter', type: 'answer', promptId: 'gate-p', value: 'VOTED' }, '*');
    });
    await probe();
    await wait(500);
    check('⛔ AC7 — the `op` was DROPPED', server.store.get('shared/gate/probe') === undefined,
      JSON.stringify(server.store.get('shared/gate/probe')));
    check('⛔ AC7 — the `answer` was DROPPED', server.store.get('answers/gate-p') === undefined,
      JSON.stringify(server.store.get('answers/gate-p')));
    const nudges = await page.evaluate(() => window.__apNameNudges || 0);
    check('⭐ AC7 — the GATE is what dropped them: the visitor was told why, both times',
      nudges === 2, String(nudges));
    const echo = await page.evaluate(() => (document.getElementById('ap-echo') || {}).textContent || '');
    check('AC7 — the prompt says to set a name', /Set a name to join/.test(echo), echo);

    /* ── AC8 — NAME YOURSELF, AND THE SAME WRITES FLOW. Same page, same socket, same frame. ─── */
    await page.evaluate(() => window.__apIdentity.setName('Writer'));
    await until(() => server.presence().some((p) => p.userName === 'Writer'), { label: 'Writer on the roster' });
    await probe();
    await until(() => server.store.get('shared/gate/probe') === 'WROTE', { label: 'the op landed', timeout: 8000 });
    check('⭐ AC8 — a NAMED visitor\'s `op` flows', server.store.get('shared/gate/probe') === 'WROTE',
      JSON.stringify(server.store.get('shared/gate/probe')));
    await until(() => !!(server.store.get('answers/gate-p') || {})[a.userId], { label: 'the answer landed', timeout: 8000 });
    check('⭐ AC8 — and so does the `answer`', (server.store.get('answers/gate-p') || {})[a.userId] === 'VOTED',
      JSON.stringify(server.store.get('answers/gate-p')));
    check('⛔ AC8 — and naming did NOT change the userId that the write is attributed to',
      (await ident(page)).userId === a.userId, (await ident(page)).userId);
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
    await server.close();
  }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * AC13 / T7 — ⭐ THE URL CONTRACT ITSELF. One assertion per parameter, and a negative for each.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0692 AC13/T7 — every URL parameter still means what it meant, and the seat link still derives', async () => {
  const CAP_SECRET = 'cap-secret-0692';
  const dir = makePluginsDir({ fixture: { 'plugin.json': stationManifest() } });
  await withPlugins(dir, async () => {
    const server = await createServer({ port: 0, capSecret: CAP_SECRET, controlToken: 'the-control-token' });
    const browser = await launch();
    let page = null;
    try {
      page = await browser.newPage();
      page.on('pageerror', (e) => console.log('0692 T7 PAGEERR', e.message));

      /* ── ?userId= — HONOURED off a seat link. Negative: the page did not mint its own. ────── */
      await open(browser, server, '/?userId=param-userId', { page });
      let s = await ident(page);
      check('?userId= is honoured off a seat link', s.userId === 'param-userId', s.userId);
      check('⛔ ...and the page did NOT mint one instead', !/^u-/.test(s.userId), s.userId);
      check('⛔ ...and the caller\'s id was not written into the browser\'s own store',
        s.storedUid !== 'param-userId', String(s.storedUid));

      /* ── ?u= — the short form, same rule. Negative: it is not read as a NAME. ─────────────── */
      await open(browser, server, '/?u=param-u', { page });
      s = await ident(page);
      check('?u= is honoured off a seat link', s.userId === 'param-u', s.userId);
      check('⛔ ...and ?u= is an ID, never a name', s.userName !== 'param-u', s.userName);

      /* ── ?name= / ?n= — the LABEL. Negative: naming does not become the id. ───────────────── */
      await open(browser, server, '/?userId=n-probe&name=Long%20Form', { page });
      s = await ident(page);
      check('?name= sets the display name', s.userName === 'Long Form', s.userName);
      check('⛔ ...and does NOT become the userId (`userId = slug(name)` is forbidden)',
        s.userId === 'n-probe', s.userId);
      await open(browser, server, '/?userId=n-probe2&n=Short%20Form', { page });
      s = await ident(page);
      check('?n= sets the display name too', s.userName === 'Short Form', s.userName);
      check('⛔ ...and still does not touch the id', s.userId === 'n-probe2', s.userId);

      /* ── ?role= — the PRIVILEGE axis, and AC12: it still beats a stored role. ────────────── */
      await page.evaluate((ns) => { try { localStorage.setItem(ns + ':role', 'participant'); } catch (e) {} }, NS);
      await open(browser, server, '/?userId=role-probe&name=R&role=presenter&token=the-control-token', { page });
      let role = await page.evaluate(() => window.__apConfig && window.__apConfig.role());
      check('AC12 — ?role= wins over a stored role', role === 'presenter', String(role));
      check('⛔ AC12 — the stored `participant` did NOT win', role !== 'participant', String(role));
      /* And the negative on the OTHER side: a stored role is still honoured when the URL is silent. */
      await page.evaluate((ns) => { try { localStorage.setItem(ns + ':role', 'presenter'); } catch (e) {} }, NS);
      await open(browser, server, '/?userId=role-probe2&name=R2&token=the-control-token', { page });
      role = await page.evaluate(() => window.__apConfig && window.__apConfig.role());
      check('AC12 — with no ?role=, the STORED role is still used (unchanged behaviour)', role === 'presenter', String(role));
      await page.evaluate((ns) => { try { localStorage.removeItem(ns + ':role'); } catch (e) {} }, NS);

      /* ── ?token= — the control credential. Negative: the WRONG token does not grant. ─────── */
      await open(browser, server, '/?userId=tok-probe&name=T&role=presenter&token=wrong-token', { page });
      role = await page.evaluate(() => window.__apConfig && window.__apConfig.role());
      check('⛔ ?token= is verified, not assumed: a wrong one is downgraded to participant',
        role === 'participant', String(role));

      /* ── ?stationUID= — ⛔⛔ THE SEAT-LINK DERIVATION, AND IT IS UNTOUCHABLE (t79). ───────── */
      await open(browser, server, '/?stationUID=1&n=Bex%20Orrow&userId=asked-for-this', { page });
      s = await ident(page);
      const DERIVED = 'alpha-' + slugForSeat('Bex Orrow');
      check('⛔⛔ a seat link DERIVES <stationCode>-<slug(name)>', s.userId === DERIVED, s.userId);
      check('⛔⛔ ...and DISCARDS the ?userId= the link asked for', s.userId !== 'asked-for-this', s.userId);
      check('⛔⛔ ...and does not use the browser\'s stored uid either', !/^u-/.test(s.userId), s.userId);
      check('⛔ F3 — renaming is DISABLED on a seat link (the link IS the identity)',
        s.canRename === false, JSON.stringify(s));
      const seatRow = await page.evaluate(() => ({
        offered: window.__apNameEditor.offered(),
        visible: window.__apNameEditor.visible(),
        readout: window.__apNameEditor.readout(),
      }));
      check('⛔ F3 — the ✎ Change control is not offered on a seat link', seatRow.offered === false, JSON.stringify(seatRow));
      check('⛔ F13 — but the name row is SHOWN, and says who you are', seatRow.visible === true, JSON.stringify(seatRow));
      check('F13 — the seat-link name reads as the link gave it', seatRow.readout === 'Bex Orrow', seatRow.readout);

      /* ⚠ A seat link with NO name keeps the 0525 §5 wording, verbatim. ⛔ And the stored name
         must NOT leak into it — that would derive a different seat id per browser. */
      await page.evaluate((ns) => { try { localStorage.setItem(ns + ':name', 'Sticky Name'); } catch (e) {} }, NS);
      await open(browser, server, '/?stationUID=1', { page });
      const noName = await page.evaluate(() => window.__apNameEditor.readout());
      s = await ident(page);
      check('⚠ a seat link with no name still reads NAME UNKNOWN (0525 §5)', noName === 'NAME UNKNOWN', noName);
      check('⛔ ...and the STORED name did not leak into the seat derivation',
        s.userId === 'alpha-' + slugForSeat(''), s.userId);
      await page.evaluate((ns) => { try { localStorage.removeItem(ns + ':name'); } catch (e) {} }, NS);

      /* ── ?station= — cosmetic, but its PRESENCE marks a seat link. Negative: its VALUE is
       *   never matched, so it cannot silently seat you somewhere else. ───────────────────── */
      await open(browser, server, '/?station=alpha&n=Cosmetic&userId=also-discarded', { page });
      s = await ident(page);
      check('?station= marks the link as a seat link (derives from the DEFAULT station)',
        s.userId === 'beta-' + slugForSeat('Cosmetic'), s.userId);
      check('⛔ ...its VALUE is never matched — `?station=alpha` did NOT seat at alpha',
        s.userId.indexOf('alpha-') !== 0, s.userId);
      check('⛔ ...and it discards ?userId= as well', s.userId !== 'also-discarded', s.userId);

      /* ── ?cap= — the signed guest capability, forwarded and VERIFIED server-side. ────────── */
      const cap = mintCapability({ v: 1, sid: 'g-0692', role: 'participant', scope: ['speak', 'type'],
        name: 'Token Named', exp: Math.floor(Date.now() / 1000) + 600, nonce: 'n-0692-t7' }, CAP_SECRET);
      await open(browser, server, '/?cap=' + encodeURIComponent(cap) + '&userId=not-the-token-id', { page });
      s = await ident(page);
      check('?cap= is forwarded and the TOKEN\'s identity is what lands', s.userName === 'Token Named', s.userName);
      check('⛔ ...and the client-claimed ?userId= did not override it', s.userId !== 'not-the-token-id', s.userId);
      /* ⛔ A `?cap=` guest's name belongs to the SIGNED TOKEN, so renaming is refused — in the
         page (no field offered) AND in the server (test/unit/0692-t2, the raw-socket case). A
         client may not widen what its token said (0472 P4). */
      check('⛔ a guest is not offered a rename', (await ident(page)).canRename === false, 'canRename');
      const capOffered = await page.evaluate(() => window.__apNameEditor.offered());
      check('⛔ ...and the ✎ control is not painted either', capOffered === false, String(capOffered));
      const capSet = await page.evaluate(() => window.__apIdentity.setName('Self Promoted'));
      await wait(250);
      check('⛔ ...so setting a name over a token identity is refused, and stores nothing',
        capSet === false && server.presence().every((p) => p.userName !== 'Self Promoted'),
        `${capSet} · ${JSON.stringify(server.presence().map((p) => p.userName))}`);

      /* ── ⛔ THE ONE THAT IS NOT A PARAMETER: no parameters at all. ───────────────────────── */
      await open(browser, server, '/', { page });
      s = await ident(page);
      check('with NO parameters the browser uses its own stored identity', /^u-[a-z0-9]{8}$/.test(s.userId), s.userId);
      check('⛔ ...and is unnamed, not `Guest`', s.named === false && s.userName !== 'Guest', JSON.stringify(s));
    } finally {
      if (page) await page.close().catch(() => {});
      await browser.close().catch(() => {});
      await server.close();
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * AC3 — t79's rule, asserted from the page that has to obey it.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
test('0692 AC3 — the seat link reloads back into the SAME seat, whatever this browser remembers', async () => {
  const dir = makePluginsDir({ fixture: { 'plugin.json': stationManifest() } });
  await withPlugins(dir, async () => {
    const server = await createServer({ port: 0 });
    const browser = await launch();
    let page = null;
    try {
      const DERIVED = 'alpha-' + slugForSeat('Bex Orrow');
      page = await open(browser, server, '/?stationUID=1&n=Bex%20Orrow');
      let s = await ident(page);
      check('AC3 — the seat link derives', s.userId === DERIVED, s.userId);
      /* Give the browser a persistent identity of its own, then reload the seat link. The stored
         uid must lose to the derivation — otherwise plan 0692's stickiness would have BROKEN the
         thing that was already sticky. */
      await page.evaluate(() => { try { localStorage.setItem('argus-presenter:uid', 'u-deadbeef'); } catch (e) {} });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__apIdentity && document.getElementById('led').classList.contains('on'), { timeout: 20000 });
      await wait(150);
      s = await ident(page);
      check('⭐ AC3 — a reload of the seat link comes back to the SAME seat', s.userId === DERIVED, s.userId);
      check('⛔ AC3 — the stored uid did NOT win over the derivation', s.userId !== 'u-deadbeef', s.userId);
      check('⭐ AC3 — and the roster holds ONE row for that seat',
        server.presence().filter((p) => p.userId === DERIVED).length === 1,
        JSON.stringify(server.presence().map((p) => p.userId)));
    } finally {
      if (page) await page.close().catch(() => {});
      await browser.close().catch(() => {});
      await server.close();
    }
  });
});
