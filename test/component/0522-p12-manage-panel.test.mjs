/*
 * Plan 0522 P12 (R12) — the MANAGE MODULES panel, in a browser.
 *
 * The server-side rules are covered by test/unit/0522-p12-manage-modules.test.mjs. This suite
 * covers the two things only a rendered page can prove:
 *
 *   t32c — the panel is a SEPARATE surface (/manage), not a control on /control. R12: curating
 *          is between-sessions work and the picker is in-session work, and the surface that ran
 *          95% of a live session must not grow a control whose whole purpose is making modules
 *          disappear.
 *          Retiring from the panel MOVES the file, proved on disk rather than by the UI's report.
 *   t33b — a symlinked module REFUSES VISIBLY. Not "the click does nothing": the row states the
 *          reason on screen and its controls are disabled. A silent no-op leaves an operator
 *          believing they curated something they did not.
 *
 * ⚠ ONE test, ONE browser, on purpose. Both concerns share a fixture and could have been two
 * `test()` blocks — but a second `launch()` here measurably tipped `t24` (0522-p9-sticky) over
 * its 90 s wait: that test drives three pages at once and its waits poll on requestAnimationFrame,
 * which Chrome pauses in a BACKGROUNDED tab, so it is sensitive to how many browsers the suite
 * has running. Splitting this file would buy nothing and cost an unrelated test its determinism.
 *
 * ⛔ §ANNEAL E — the fixture catalogue is a mkdtempSync directory wired in through
 * PRESENTER_MODULES_DIR. The repo's own modules/ is never read or written. Port 0.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch } from '../../harness/multi.mjs';
import { mkdtempSync, rmSync, writeFileSync, existsSync, symlinkSync, readFileSync } from 'fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'os';
import { join } from 'path';

const PATIENT = 90000;
const TOKEN = 'p12-panel-token';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const deck = (title, extra = {}) => ({
  manifest: Object.assign({ title, kind: 'demo' }, extra),
  beats: [{ id: 'a', component: 'card', opts: { title: 'A' } }],
});

/** Server + fixture dir + one REAL symlink into a file the fixture owns. */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0522-p12ui-'));
  const outside = mkdtempSync(join(tmpdir(), 'ap-0522-p12ui-target-'));
  writeFileSync(join(dir, 'plain.json'), JSON.stringify(deck('Plain Deck')));
  writeFileSync(join(dir, 'junk.json'), JSON.stringify(deck('Junk Deck', { status: 'working' })));
  const target = join(outside, 'src.json');
  writeFileSync(target, JSON.stringify(deck('Linked Deck'), null, 2));
  symlinkSync(target, join(dir, 'linked.json'));
  const prev = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_MODULES_DIR = dir;
  let server;
  try { server = await createServer({ port: 0, controlToken: TOKEN }); }
  finally { if (prev === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prev; }
  return { dir, outside, target, server,
    cleanup: async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); } };
}

/** Every rendered row, as the operator sees it. */
const rows = (pg) => pg.evaluate(() => Array.from(document.querySelectorAll('#rows tr')).map((tr) => {
  const sel = tr.querySelector('select.status');
  const btn = tr.querySelector('button');
  return {
    id: sel ? sel.getAttribute('data-id') : (btn && btn.getAttribute('data-id')),
    text: tr.textContent,
    status: sel ? sel.value : null,
    statusDisabled: sel ? sel.disabled : null,
    retireDisabled: btn ? btn.disabled : null,
    reason: (tr.querySelector('.reason') || {}).textContent || '',
  };
}));

test('0522 t32c/t33b — Manage Modules is a separate page; retire MOVES; a symlink refuses visibly', async () => {
  const f = await boot();
  const browser = await launch();
  try {
    const pg = await browser.newPage();
    pg.setDefaultTimeout(PATIENT);
    pg.on('pageerror', (e) => console.log('MANAGE PAGEERR', e.message));
    await pg.goto(`${f.server.url()}/manage?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: PATIENT });
    await pg.waitForFunction(() => document.querySelectorAll('#rows tr').length > 0, { timeout: PATIENT });

    const r = await rows(pg);
    expect('t32c — the panel lists the catalogue', r.length === 3, JSON.stringify(r.map((x) => x.id)));
    expect('t32c — every row carries kind, counts and status', /demo/.test(r[0].text) && r.every((x) => x.status), JSON.stringify(r.map((x) => x.status)));

    // ── t33b — the symlinked row refuses VISIBLY ────────────────────────────────────────────
    const targetBefore = sha(f.target);
    const link = r.find((x) => x.id === 'linked');
    const plain = r.find((x) => x.id === 'plain');
    expect('t33b — the symlink is MARKED on its row', /symlink/i.test(link.text), link.text);
    expect('t33b — the reason is stated in words, not just an icon', /read-only/i.test(link.reason) && /repositor/i.test(link.reason), link.reason);
    expect('t33b — its status control is disabled', link.statusDisabled === true);
    expect('t33b — its retire button is disabled', link.retireDisabled === true);
    expect('t33b — an ordinary module is unaffected: the guard is per-row, not a page-wide lockout',
      plain.statusDisabled === false && plain.retireDisabled === false && !plain.reason, JSON.stringify(plain));

    // Belt and braces: driving past the disabled control still cannot damage the target, because
    // the SERVER is the real guard and the UI is only its visible half.
    const bypass = await pg.evaluate((tok) => fetch('/api/module-admin/linked', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-control-token': tok },
      body: JSON.stringify({ op: 'status', status: 'retired' }),
    }).then((res) => res.status), TOKEN);
    expect('t33b — bypassing the disabled control still hits a server refusal', bypass === 409, 'status=' + bypass);
    expect('t33b — the link target is byte-identical', sha(f.target) === targetBefore);
    expect('t33b — and the link is still in place', existsSync(join(f.dir, 'linked.json')));

    // ── t32c — retire MOVES the file ───────────────────────────────────────────────────────
    // ⚠ Runs BEFORE the control page opens. waitForFunction polls on requestAnimationFrame,
    // which Chrome pauses in a BACKGROUNDED tab — open a second page first and every subsequent
    // wait on this one hangs to the timeout with no failing assertion to explain it.
    const before = sha(join(f.dir, 'junk.json'));
    await pg.evaluate(() => {
      const tr = Array.from(document.querySelectorAll('#rows tr')).find((x) => {
        const b = x.querySelector('button'); return b && b.getAttribute('data-id') === 'junk';
      });
      tr.querySelector('button').click();
    });
    await pg.waitForFunction(() => document.querySelectorAll('#rows tr').length === 2, { timeout: PATIENT });
    const dest = join(f.dir, '_archive', 'junk.json');
    expect('t32c — the file EXISTS at _archive/, byte-identical: moved, never deleted', existsSync(dest) && sha(dest) === before, dest);
    expect('t32c — and the panel says so', /_archive/.test(await pg.evaluate(() => document.getElementById('msg').textContent)));

    // ── t32c — R12: it is NOT on the control page. The absence IS the requirement. ──────────
    // ⚠ Asserted against the SERVED BYTES of /control, not a second rendered page. The control
    // page is static HTML read from disk, so its bytes ARE the artifact here — and a second
    // browser page in this file measurably destabilised t24 (see the header). The markup is
    // stripped of its inline <script> first, because control.html carries its script inline and
    // a raw scan would read the source comments — where "retire" and "retired" both appear —
    // and fail on a page that has no such control at all.
    const controlHtml = await (await fetch(f.server.url() + '/control')).text();
    const markup = controlHtml.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    expect('t32c — the control page markup carries NO retire/archive control',
      !/retire|_archive/i.test(markup), (markup.match(/.{0,60}(retire|_archive).{0,60}/i) || [''])[0]);
    expect('t32c — and it does not embed the panel: /manage is a separate route',
      !/module-admin/.test(controlHtml) && /id="mod-select"/.test(markup), 'sanity: the picker itself is still there');
  } finally { await browser.close(); await f.cleanup(); }
});
