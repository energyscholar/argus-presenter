/*
 * Plan 0575 PHASE 5 — THE FLEET, PAINTED.
 *
 * ⭐ PLAN §5 SAYS THE PIXEL FOR THIS PHASE IS "name PAINTED on both". A hull's name reaching the
 * glass is the end of the longest chain in this plugin — deployment file → fleet loader →
 * commission → identity write → snapshot → onMessage → `#apShipName` — and it is the exact chain
 * whose LAST arrow was skipped in 0574 P0a, which is why that commit shipped broken.
 *
 * ⛔ ONE BROWSER, ONE SERVER, SEQUENTIAL. 6.4 GB and no swap.
 *
 * ⛔ NO CAMPAIGN VALUES ARE WRITTEN DOWN. The names are read from the gitignored fleet file and
 * compared against what the glass shows — the test knows that they must MATCH, never what they are.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until, wait } from '../../harness/multi.mjs';
import { assertResources } from '../../harness/resources.mjs';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadShipPluginModule, withFleet, TWO_HULLS } from '../unit/_0514-fixtures.mjs';

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
async function shoot(page, name) {
  try {
    mkdirSync(SHOTS, { recursive: true });
    const file = join(SHOTS, name);
    await page.screenshot({ path: file });
    console.log(`      [shot] ${file}`);
    return file;
  } catch (e) { console.log(`      [shot] FAILED ${name} — ${e && e.message}`); return null; }
}

async function seat(browser, server, uid, name) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 800 });
  await p.goto(`${server.url()}/?stationUID=${uid}&n=${encodeURIComponent(name)}`, { waitUntil: 'domcontentloaded' });
  await wait(1200);
  await p.evaluate(() => document.getElementById('cfg-station')?.click());
  await wait(1500);
  return p;
}

const frameOf = (p) => p.frames().find((f) => f !== p.mainFrame()) || null;

/** The dressed-on ship name, as DRAWN: its text and its bounding box. */
const dressedName = (p) =>
  frameOf(p).evaluate(() => {
    const el = document.querySelector('#apShipName');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { text: (el.textContent || '').trim(), box: [Math.round(r.width), Math.round(r.height)] };
  });

const bandOf = (p) =>
  frameOf(p).evaluate(() => {
    const b = document.querySelector('.ap-alertband');
    return b ? { state: b.getAttribute('data-alert'), label: b.getAttribute('data-alert-label') } : null;
  });

test('t0575-02p — ⭐ THE HULL A SEAT IS ON IS THE HULL WHOSE NAME IT WEARS, AND WHOSE ALERT IT SHOWS', async () => {
  /* ⛔ 0581 PHASE F — the `else` branch below used to `expect(true, '…reported')` on a one-hull
     deployment, so the SEPARATION half of this painted test never ran on a clean clone. It now
     commissions two hulls, and the branch is gone. */
  await withFleet(TWO_HULLS, async () => {
  const mod = await loadShipPluginModule('ship-machine.mjs');
  const fleet = mod.loadFleet();
  const server = await createServer({ port: 0 });
  let browser = null;
  try {
    if (!server.stations().stations.length) { expect('skipped — no station plugin on this deployment', true, 'skipped'); return; }
    if (!fleet.ships.length) { expect('skipped — this deployment commissions no ships', true, 'skipped'); return; }
    const primary = fleet.ships.find((s) => s.shipId === fleet.primaryShipId) || fleet.ships[0];
    const other = fleet.ships.find((s) => s.shipId !== primary.shipId) || null;

    assertResources({ needMB: 900, label: '0575 P5 painted fleet' });
    browser = await launch();
    const cap = await seat(browser, server, 1, 'Captain Probe');

    // ── the name reached the glass, and it is the PRIMARY's ────────────────────────────────
    const nm = await dressedName(cap);
    console.log(`      [painted] dressed name ${JSON.stringify(nm)}`);
    expect('the ship-name anchor exists on the station art', !!nm, JSON.stringify(nm));
    expect('⭐ and it is DRESSED with a name, not the em-dash placeholder',
      nm && nm.text.length > 1 && nm.text !== '—', JSON.stringify(nm));
    expect('⭐⭐ the name on the glass IS the primary hull the deployment declared',
      nm && primary.name && nm.text === primary.name, `${nm && nm.text} vs ${primary.name}`);
    expect('⛔ NON-ZERO BOUNDING BOX — it is painted, not merely in the DOM',
      nm && nm.box[0] > 0 && nm.box[1] > 0, JSON.stringify(nm && nm.box));
    if (other && other.name) {
      expect('⛔ and it is NOT the other hull’s name', nm.text !== other.name, `${nm.text} vs ${other.name}`);
    }
    await shoot(cap, 'p5-station-wears-the-PRIMARY-hull-name.png');

    // ── ⛔⛔ THE SEPARATION, ON THE GLASS. Move the OTHER hull to battle stations. This seat is
    //    not on it, so its band must not react — the singleton failure, if it were still here,
    //    would light this screen up red.
    if (other) {
      const before = await bandOf(cap);
      await server.callPluginTool('ship_event', { event: 'battle-stations', shipId: other.shipId });
      await wait(1500);
      const after = await bandOf(cap);
      console.log(`      [painted] other hull at battle stations; this seat's band ${JSON.stringify(after)}`);
      expect('⛔⛔ THE OTHER HULL WENT RED AND THIS SEAT DID NOT',
        after && after.state !== 'action' && after.state === (before && before.state),
        `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      await shoot(cap, 'p5-other-hull-at-battle-stations-this-seat-UNAFFECTED.png');
    } else {
      expect('⛔ the fixture fleet really commissioned a second hull — no silent skip here',
        false, JSON.stringify(fleet.ships.map((s) => s.shipId)));
    }

    // ── and the seat's OWN hull still obeys, so the check above is not "nothing works" ──────
    await server.callPluginTool('ship_event', { event: 'general-quarters', shipId: primary.shipId });
    await until(async () => { const b = await bandOf(cap); return b && b.state === 'elevated'; },
      { timeout: 8000, label: 'this seat’s OWN hull moves it' });
    const own = await bandOf(cap);
    console.log(`      [painted] own hull at general quarters ${JSON.stringify(own)}`);
    expect('⭐ CONTROL: this seat DOES follow its own hull', own && own.state === 'elevated', JSON.stringify(own));
    await shoot(cap, 'p5-own-hull-at-general-quarters-this-seat-FOLLOWS.png');
  } finally { if (browser) await browser.close(); await server.close(); }
  });
});
