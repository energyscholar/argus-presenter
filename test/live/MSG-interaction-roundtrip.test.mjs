/*
 * MSG — INTERACTION ROUND-TRIP across every answering component.
 *
 * WHY THIS EXISTS: the transport was covered (C3 op-roundtrip, C5 client-op-relay,
 * C4 snapshot-on-hello) but NOTHING drove a real UI control through to the store.
 * The `form` component shipped fully broken inside the sandboxed content frame —
 * `sandbox="allow-scripts"` has no `allow-forms`, so the browser silently blocks
 * <form> submission and the component's submit handler never fires. No user could
 * ever see the warning (it is logged inside an opaque-origin frame).
 *
 * INVARIANT ENCODED: for every component that calls Argus.answer(), driving its
 * REAL control must land a value at answers/<promptId>/<userId> in the store.
 * A component that cannot deliver its answer is broken, however well it renders.
 *
 * Add a component: append one row to CASES. The driver runs INSIDE the frame.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, contentFrame, waitContentFrame, until } from '../../harness/multi.mjs';

const USER = 'rt-user';

/* Each case: the component, opts (must carry promptId), and a driver that performs
 * the genuine user interaction inside the content frame. */
const CASES = [
  {
    component: 'choice', promptId: 'rt-choice', ready: '.ap-choice-opt',
    opts: { prompt: 'Pick one', options: [{ label: 'Alpha', value: 'alpha' }, { label: 'Beta', value: 'beta' }] },
    drive: () => { document.querySelector('.ap-choice-opt').click(); },
  },
  {
    component: 'text-input', promptId: 'rt-text', ready: '.ap-textfield',
    opts: { prompt: 'Say something', submitLabel: 'Send' },
    drive: () => {
      const i = document.querySelector('.ap-input');
      i.value = 'hello';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      const b = document.querySelector('button');
      if (b) b.click();
      else i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    },
  },
  {
    component: 'dice', promptId: 'rt-dice', ready: '.ap-dice',
    opts: { label: 'Roll it', dice: '2d6', target: 8 },
    drive: () => { document.querySelector('.ap-btn').click(); },
  },
  {
    component: 'slider', promptId: 'rt-slider', ready: '.ap-slider-thumb',
    opts: { prompt: 'How much?', min: 0, max: 10, value: 3 },
    // Custom widget: a focusable .ap-slider-thumb driven by keydown -> setValue() + commit().
    // There is NO <input type=range> and no button — driving it as a range input is a test bug.
    drive: () => {
      const t = document.querySelector('.ap-slider-thumb');
      t.focus();
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    },
  },
  {
    // REGRESSION GUARD: this is the one that was silently dead.
    component: 'form', promptId: 'rt-form', ready: '.ap-form-submit',
    opts: {
      title: 'Details',
      fields: [
        { name: 'who', label: 'Name', type: 'text' },
        { name: 'pick', label: 'Choose', type: 'select', options: [{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }] },
      ],
    },
    drive: () => {
      document.querySelector('input.ap-input').value = 'Ada';
      const s = document.querySelector('select.ap-input');
      if (s) s.value = 'two';
      document.querySelector('.ap-form-submit').click();
    },
  },
];

test('MSG — every answering component delivers its answer to the store', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  const blocked = [];   // silent-failure guard: sandbox/CSP refusals anywhere in the run
  try {
    const page = await connectUser(browser, server, { userId: USER, userName: 'RT' });
    page.on('console', (m) => {
      const t = m.text();
      if (/blocked|sandbox|refused|denied|not allowed/i.test(t)) blocked.push(t.slice(0, 140));
    });
    await until(() => server.presence().some((u) => u.userId === USER), { label: 'user registered' });

    for (const c of CASES) {
      server.pushComponent('all', c.component, { ...c.opts, promptId: c.promptId });
      await waitContentFrame(page);
      // Re-query the frame every read: a push swaps the iframe. Waiting on
      // "body has children" is NOT enough — the PREVIOUS component satisfies it,
      // so the driver would fire against stale DOM. Wait for this component's own marker.
      await until(async () => {
        const f = contentFrame(page);
        if (!f) return false;
        try { return await f.evaluate((sel) => !!document.querySelector(sel), c.ready); }
        catch { return false; }
      }, { timeout: 8000, label: `${c.component} rendered (${c.ready})` });

      const f = contentFrame(page);
      try { await f.evaluate(c.drive); } catch (e) { /* driver failure surfaces as a missing answer */ }

      let landed;
      try {
        await until(() => server.store.get(`answers/${c.promptId}/${USER}`) !== undefined,
          { timeout: 3000, label: `${c.component} answer reached the store` });
        landed = true;
      } catch { landed = false; }

      const value = server.store.get(`answers/${c.promptId}/${USER}`);
      expect(`${c.component}: interaction reaches answers/${c.promptId}/${USER}`,
        landed, landed ? JSON.stringify(value) : 'NO ANSWER — component cannot deliver its result');
    }

    // Any sandbox/CSP refusal is a silent-failure smell even if a value landed.
    expect('no sandbox/CSP refusals during interaction', blocked.length === 0, blocked.join(' | ') || 'clean');
  } finally { await browser.close(); await server.close(); }
});
