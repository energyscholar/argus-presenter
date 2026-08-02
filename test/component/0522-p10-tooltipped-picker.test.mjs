/*
 * Plan 0522 P10 — TOOLTIPPED MODULE PICKER.
 *
 * The option label used to be `title — N beats/M sec ⚠w (ERR)`. The counts were on every row and
 * discriminated nothing: a GM scanning the list at 20:05 is looking for a NAME. So the label
 * becomes the title, and the reference material — beats/sections counts and the module's
 * `manifest.summary` — moves into the option's `title=` tooltip. The summary is new information
 * on that surface: `#mod-info` only reveals it AFTER a module is selected, which is too late to
 * choose by.
 *
 * ⚠ The line P10 must not cross: a tooltip does not exist on touch input and never appears at all
 * for a list the GM is only arrowing through. So NOTHING ACTIONABLE may move into it. The ⚠ and
 * (ERR) markers stay in the label a human reads — t27 asserts that on `textContent`, never on the
 * tooltip, because a module that fails to parse must be findable AND visibly broken without a
 * hover. (I4 — nothing vanishes silently.)
 *
 *   t26 — the label is the title and NOT the counts; counts and summary appear in `title=`.
 *   t27 — the ⚠ and (ERR) markers remain in the LABEL TEXT.
 *
 * ⛔ modules/*.json is gitignored and has no version history. Every fixture here lives in a temp
 * directory this suite creates and removes; the repo's modules/ is never read or written.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, wait } from '../../harness/multi.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Plan 0529 P2: the content catalogue is control-credentialed and FAILS CLOSED, so a test
// that drives the GM panel must run a gated server and hand the page a token — exactly as a
// real deployment does. Nothing else about these tests changed.
const CTL_TOKEN = 'ap-test-control-token';

const CLEAN = 'p10-clean';     // valid: 3 beats, 2 sections, a manifest.summary — the t26 subject
const WARNED = 'p10-warned';   // trips V3-unknown-component ⇒ warn ≥ 1 — the t27 ⚠ subject

const CLEAN_TITLE = 'P10 Quiet Deck';
const WARNED_TITLE = 'P10 Noisy Deck';
const CLEAN_SUMMARY = 'Three beats about ice, silence and nothing else.';

const PATIENT = 90000;

const beat = (id, comp) => ({ id, component: comp || 'card', promptId: 'pr-' + id, opts: { title: 'Beat ' + id } });

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0522-p10-'));
  writeFileSync(join(dir, CLEAN + '.json'), JSON.stringify({
    manifest: { title: CLEAN_TITLE, summary: CLEAN_SUMMARY, defaultBeatId: 'c1' },
    beats: [beat('c1'), beat('c2'), beat('c3')],
    // Two sections, covering every beat, so the module carries no structural warnings.
    sections: [{ id: 's1', title: 'One', beatIds: ['c1', 'c2'] }, { id: 's2', title: 'Two', beatIds: ['c3'] }],
  }));
  writeFileSync(join(dir, WARNED + '.json'), JSON.stringify({
    manifest: { title: WARNED_TITLE, summary: 'A deck with something wrong in it.' },
    beats: [beat('w1'), beat('w2', 'no-such-component')],
  }));
  const prev = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_MODULES_DIR = dir;                       // read once, inside createServer
  let server;
  try { server = await createServer({ port: 0, controlToken: CTL_TOKEN }); }
  finally { if (prev === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prev; }
  return { dir, server };
}

async function openControl(browser, server) {
  const pg = await browser.newPage();
  pg.setDefaultTimeout(PATIENT);
  pg.on('pageerror', (e) => console.log('CTRL PAGEERR', e.message));
  await pg.goto(`${server.url()}/control?userId=op&role=presenter&token=${CTL_TOKEN}`, { waitUntil: 'domcontentloaded', timeout: PATIENT });
  await pg.waitForFunction(() => window.__gm && document.getElementById('mod-select').options.length > 1, { timeout: PATIENT });
  return pg;
}

/** Every option, as the DOM holds it: the label a human reads and the tooltip they must hover for. */
const options = (pg) => pg.evaluate(() => Array.from(document.getElementById('mod-select').options)
  .map((o) => ({ value: o.value, label: o.textContent, tip: o.title, tipAttr: o.getAttribute('title') })));

test('0522 t26 — the option LABEL is the title; counts and summary live in title=', async () => {
  const { dir, server } = await boot();
  const browser = await launch();
  try {
    const ctl = await openControl(browser, server);
    const opts = await options(ctl);
    const clean = opts.find((o) => o.value === CLEAN);

    expect('the fixture module is in the picker at all', !!clean, JSON.stringify(opts));

    // The label. Asserted as EQUALITY, not containment: a label that still carried the counts
    // would contain the title too, and containment would pass on the old format.
    expect('the label is exactly the title', clean.label === CLEAN_TITLE, JSON.stringify(clean));
    expect('the label carries NO beat count', !/\bbeats?\b/i.test(clean.label) && !/\b3\b/.test(clean.label), JSON.stringify(clean));
    expect('the label carries NO section count', !/\bsec\b/i.test(clean.label) && !/\bsections?\b/i.test(clean.label), JSON.stringify(clean));
    expect('…and no em-dash separator is left behind', clean.label.indexOf('—') === -1, JSON.stringify(clean));

    // The tooltip. It is a real attribute on the element, not a property default.
    expect('the option has a title= ATTRIBUTE', typeof clean.tipAttr === 'string' && clean.tipAttr.length > 0, JSON.stringify(clean));
    expect('the tooltip carries the beat count', /\b3 beats\b/.test(clean.tip), JSON.stringify(clean));
    expect('the tooltip carries the section count', /\b2 sections\b/.test(clean.tip), JSON.stringify(clean));
    expect('the tooltip carries manifest.summary', clean.tip.indexOf(CLEAN_SUMMARY) >= 0, JSON.stringify(clean));

    // The summary reaching the browser at all is P10's server-side half: /api/modules never sent
    // it before, and a tooltip cannot show what the API withholds.
    const api = await ctl.evaluate((t) => fetch('/api/modules', { cache: 'no-store', headers: { 'x-control-token': t } }).then((r) => r.json()), CTL_TOKEN);
    const row = api.find((m) => m.id === CLEAN);
    expect('/api/modules now carries `summary` for the picker to show', row && row.summary === CLEAN_SUMMARY, JSON.stringify(row));
    expect('…and still carries the counts it always did', row && row.beats === 3 && row.sections === 2, JSON.stringify(row));

    // The placeholder is untouched — I4: the picker must always have something to fall back to.
    expect('the placeholder option is still first and still empty-valued',
      opts[0].value === '' && /select a module/i.test(opts[0].label), JSON.stringify(opts[0]));
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('0522 t27 — ⚠ and (ERR) markers stay in the LABEL, not in the tooltip', async () => {
  const { dir, server } = await boot();
  const browser = await launch();
  try {
    const ctl = await openControl(browser, server);

    // ── ⚠ — the real path, end to end: a module on disk that trips a validation warning.
    const warned = (await options(ctl)).find((o) => o.value === WARNED);
    expect('the warned module is in the picker', !!warned, JSON.stringify(await options(ctl)));
    expect('the ⚠ marker is in the LABEL a GM reads', warned.label.indexOf('⚠') >= 0, JSON.stringify(warned));
    expect('…with its count, and after the title', /^P10 Noisy Deck ⚠[1-9]/.test(warned.label), JSON.stringify(warned));
    expect('…and the module is still identifiable by NAME', warned.label.indexOf(WARNED_TITLE) === 0, JSON.stringify(warned));

    // ── (ERR) — driven through the client's own list-render path with a synthetic response.
    //
    // ⚠ DECLARED: listModules() FILTERS `error` rows out of /api/modules (`.filter(m => !m.error)`),
    // so no module on disk, however broken, can produce an (ERR) row today — the marker's only
    // possible source is a response shape the server can still emit (moduleSummary is shared with
    // /api/series/:id) or will emit again. The branch is therefore exercised by stubbing the
    // fetch and calling the page's OWN refresh, not by asserting on a file. That is the whole
    // reason this half exists: an unreachable branch is exactly the one that rots silently, and
    // if it ever fires it must fire into the LABEL.
    await ctl.evaluate((warnedId) => {
      window.__stub = [
        { id: 'p10-broken', title: 'P10 Broken Deck', beats: 0, sections: 0, warn: 0, summary: null, error: 'Unexpected token } in JSON at position 12' },
        { id: warnedId, title: 'P10 Noisy Deck', beats: 2, sections: 0, warn: 1, summary: 'A deck with something wrong in it.' },
      ];
      const real = window.fetch.bind(window);
      window.fetch = function (u) {
        if (typeof u === 'string' && u.split('?')[0] === '/api/modules')
          return Promise.resolve({ json: () => Promise.resolve(window.__stub) });
        return real.apply(null, arguments);
      };
    }, WARNED);
    await ctl.evaluate(() => document.getElementById('mod-refresh').click());
    await ctl.waitForFunction(() => Array.from(document.getElementById('mod-select').options).some((o) => o.value === 'p10-broken'),
      { timeout: PATIENT });
    await wait(200);

    const broken = (await options(ctl)).find((o) => o.value === 'p10-broken');
    expect('the broken module is LISTED — it does not vanish (I4)', !!broken, JSON.stringify(await options(ctl)));
    expect('the (ERR) marker is in the LABEL TEXT, not merely in the tooltip', broken.label.indexOf('(ERR)') >= 0, JSON.stringify(broken));
    expect('…and it is still findable by name', broken.label.indexOf('P10 Broken Deck') === 0, JSON.stringify(broken));
    expect('the failure is legible with NO hover at all: title + marker and nothing else',
      broken.label === 'P10 Broken Deck (ERR)', JSON.stringify(broken));
    expect('the detailed parse error is what went to the tooltip', /Unexpected token/.test(broken.tip), JSON.stringify(broken));

    // Same rebuild, same code path: the ⚠ marker survives it too.
    const w2 = (await options(ctl)).find((o) => o.value === WARNED);
    expect('the ⚠ marker survives a rebuild and stays in the label', w2 && w2.label === 'P10 Noisy Deck ⚠1', JSON.stringify(w2));
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
