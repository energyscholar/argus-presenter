/*
 * INTER — MULTI-USER INTERACTIVITY: two real users, real UI, distinct answers.
 *
 * WHY: component answer-delivery is proven for ONE user (MSG-interaction-roundtrip) and
 * cross-client propagation is proven for PROGRAMMATIC writes (MSG-distributed-integrity).
 * Nothing had ever exercised two users driving real controls concurrently. "Choose Role"
 * (a `form` with a name field + a seat select) is the first such interaction in the product.
 *
 * INVARIANT ENCODED: concurrent answers from different users land SEPARATELY, keyed by
 * userId, with neither overwriting nor cross-contaminating the other — and each user's
 * own submission is the one recorded against them.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';

const PID = 'stations';
const SEATS = [
  { label: 'Captain', value: 'captain' },
  { label: 'Sensors', value: 'sensors' },
  { label: 'Gunner', value: 'gunner' },
];
const FORM = {
  title: 'TAKE STATIONS', promptId: PID, submitLabel: 'Take station',
  fields: [
    { name: 'pcName', label: 'Character name', type: 'text', validate: 'required' },
    { name: 'seat', label: 'Station', type: 'select', options: SEATS },
  ],
};

/** Drive the real form UI inside a client's content frame. */
const takeStation = async (page, pcName, seat) => {
  const f = contentFrame(page);
  await f.evaluate((n, s) => {
    document.querySelector('input.ap-input').value = n;
    document.querySelector('select.ap-input').value = s;
    document.querySelector('.ap-form-submit').click();
  }, pcName, seat);
};

test('INTER — two users take different stations concurrently; answers stay separate', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const vonsydo = await connectUser(browser, server, { userId: 'vonsydo', userName: 'Von Sydo' });
    const marina  = await connectUser(browser, server, { userId: 'marina',  userName: 'Marina' });
    await until(() => {
      const ids = server.presence().map((u) => u.userId);
      return ids.includes('vonsydo') && ids.includes('marina');
    }, { label: 'both users connected' });

    server.pushComponent('all', 'form', FORM);
    await waitContentFrame(vonsydo); await waitContentFrame(marina);
    for (const p of [vonsydo, marina]) {
      await until(async () => {
        const f = contentFrame(p);
        if (!f) return false;
        try { return await f.evaluate(() => !!document.querySelector('.ap-form-submit')); }
        catch { return false; }
      }, { timeout: 8000, label: 'form rendered for both' });
    }

    // Both submit — different names, different seats.
    await takeStation(vonsydo, 'Von Sydo', 'sensors');
    await takeStation(marina, 'Marina', 'gunner');

    await until(() => server.store.get(`answers/${PID}/vonsydo`) !== undefined
                   && server.store.get(`answers/${PID}/marina`) !== undefined,
      { timeout: 5000, label: 'both answers reached the store' });

    const v = server.store.get(`answers/${PID}/vonsydo`);
    const m = server.store.get(`answers/${PID}/marina`);

    expect('Von Sydo recorded with HIS name', v && v.pcName === 'Von Sydo', JSON.stringify(v));
    expect('Von Sydo recorded on HIS seat',   v && v.seat === 'sensors',    JSON.stringify(v));
    expect('Marina recorded with HER name',   m && m.pcName === 'Marina',   JSON.stringify(m));
    expect('Marina recorded on HER seat',     m && m.seat === 'gunner',     JSON.stringify(m));
    // The failure this guards: one submission overwriting or contaminating the other.
    expect('answers did not cross-contaminate', v.seat !== m.seat && v.pcName !== m.pcName,
      `${JSON.stringify(v)} vs ${JSON.stringify(m)}`);

    // A seat map derived from answers must name both users exactly once.
    const all = server.store.get(`answers/${PID}`) || {};
    expect('exactly two seat claims recorded', Object.keys(all).length === 2, JSON.stringify(Object.keys(all)));
  } finally { await browser.close(); await server.close(); }
});
