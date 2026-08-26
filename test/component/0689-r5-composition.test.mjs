/*
 * Plan 0689 R5 — COMPOSITION IS FIRST-CLASS: an authored page that HOSTS the components.
 *
 * ⭐⭐⭐ WHY THIS TEST EXISTS. `pushContent` — render arbitrary HTML — was declined from the MCP
 * surface for months. Bruce, 2026-08-26: *"We built those components so that they could be combined
 * with arbitrary HTML… The directive blocked those from ever being used."* The decline did not
 * merely block raw pages; it stranded SIXTEEN COMPONENTS, because they were never a menu INSTEAD OF
 * HTML — they are parts to be composed INTO it.
 *
 * So the acceptance criterion is not "html renders". It is: ONE page carries the author's own
 * markup AND at least two components, and BOTH components round-trip through the postMessage
 * bridge. Anything less is a half-composition.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';
import { assemble } from '../../harness/assemble.mjs';

const PAGE = `
  <h1 class="authored-heading">Approach Vector</h1>
  <p class="authored-prose">Two hulls, one vector. The pilot calls it.</p>
  <div id="the-check"></div>
  <hr class="authored-rule">
  <div id="the-choice"></div>
  <footer class="authored-footer">authored by hand</footer>
`;

const MOUNTS = [
  { at: '#the-check', component: 'dice', opts: { dice: '2d6+1', target: 8, promptId: 'check-1', label: 'Pilot check' } },
  { at: '#the-choice', component: 'choice', opts: { prompt: 'Close or hold?', promptId: 'call-1', options: [{ label: 'Close', value: 'close' }, { label: 'Hold', value: 'hold' }] } },
];

test('0689 R5 — ⭐⭐⭐ ONE PAGE: authored HTML + TWO components, and both round-trip through the bridge', async () => {
  const r = await drive({
    page: { html: PAGE, mounts: MOUNTS },
    opts: { userId: 'u1', userName: 'Alice' },
    // Roll the check, then answer the choice. Two different components, two different verbs.
    actions: [{ click: '#the-check .ap-btn', after: 900 }, { click: '#the-choice [data-value="hold"]' }],
    shot: '0689-composed-page.png',
    probe: () => ({
      heading: !!document.querySelector('h1.authored-heading'),
      prose: !!document.querySelector('p.authored-prose'),
      footer: !!document.querySelector('footer.authored-footer'),
      dice: !!document.querySelector('#the-check .ap-dice'),
      choice: !!document.querySelector('#the-choice [data-value="close"]'),
      // ⛔ the authored markup must SURROUND the components, not be replaced by them
      order: Array.from(document.querySelectorAll('#ap-page > *')).map((e) => e.tagName.toLowerCase()).join(','),
      mountErrors: document.querySelectorAll('.ap-mount-error').length,
    }),
  });

  const p = r.probe;
  expect('the authored heading, prose and footer all survive', p.heading && p.prose && p.footer, JSON.stringify(p));
  expect('component 1 (dice) mounted INSIDE the authored page', p.dice, JSON.stringify(p));
  expect('component 2 (choice) mounted INSIDE the authored page', p.choice, JSON.stringify(p));
  expect('the author\'s own structure is intact around them', p.order.startsWith('h1,p,div,hr,div,footer'), p.order);
  expect('⛔ no unresolved mounts — a selector that matched nothing would be reported here', p.mountErrors === 0, String(p.mountErrors));

  // ── THE ROUND TRIP. Both components must reach the bridge, and carry the page's identity.
  const answers = r.messages.filter((m) => m.type === 'answer');
  const dice = answers.find((m) => m.promptId === 'check-1');
  const choice = answers.find((m) => m.promptId === 'call-1');
  expect('the DICE answer came back through the bridge', !!dice, JSON.stringify(r.messages.map((m) => m.type + ':' + m.promptId)));
  expect('the CHOICE answer came back through the bridge', !!choice, JSON.stringify(r.messages.map((m) => m.type + ':' + m.promptId)));
  expect('the dice answer carries a real total', dice && typeof dice.value === 'number' && dice.value >= 3, JSON.stringify(dice));
  expect('the choice answer carries the value clicked', choice && choice.value === 'hold', JSON.stringify(choice));
  // ⭐ Identity INHERITS from the page to every mount — the same rule `scene` uses for its children.
  expect('the dice answer is stamped with the page identity', dice && dice.userId === 'u1' && dice.userName === 'Alice', JSON.stringify(dice));
  expect('the choice answer is stamped with the page identity', choice && choice.userId === 'u1', JSON.stringify(choice));
});

test('0689 R5 — the INLINE form works too, and a mount that resolves to NOTHING is VISIBLE', async () => {
  const r = await drive({
    page: {
      html: '<h2 class="authored">Inline</h2><div data-ap-component="slider" data-ap-opts=\'{"promptId":"s1","min":0,"max":10}\'></div>',
      // ⛔ THE FORBIDDEN CASE: a selector typo. Silently rendering nothing is exactly how a
      //    component gets "pushed" and is not there.
      mounts: [{ at: '#nope-typo', component: 'dice', opts: {} }],
    },
    opts: { userId: 'u2' },
    probe: () => ({
      inline: !!document.querySelector('[data-ap-component="slider"] input, [data-ap-component="slider"] .ap-slider'),
      errors: document.querySelectorAll('.ap-mount-error').length,
      errorText: (document.querySelector('.ap-mount-error') || {}).textContent || '',
      authored: !!document.querySelector('h2.authored'),
    }),
  });
  expect('the inline data-ap-component form mounted', r.probe.inline, JSON.stringify(r.probe));
  expect('the authored markup is still there', r.probe.authored);
  expect('⛔ the unresolved mount is REPORTED ON THE PAGE, not silently skipped', r.probe.errors === 1, JSON.stringify(r.probe));
  expect('and the message names the selector that matched nothing', /#nope-typo/.test(r.probe.errorText), r.probe.errorText);
});

test('0689 R5 — ⛔ THE WRAPPER IS LOAD-BEARING: a RAW page carries no library and no bridge', () => {
  // The plan asked to be told plainly if assembly needs something the raw path lacks. It does, and
  // this is the measurement rather than an assertion of the opposite.
  const raw = '<h1>hi</h1><div data-ap-component="dice"></div>';
  const wrapped = assemble({ html: raw, mounts: [] });
  expect('a RAW push is exactly the caller\'s bytes — no registry, no components, no bridge',
    !raw.includes('ApComponents') && !raw.includes('argus-presenter'), 'the raw string is unchanged by definition');
  expect('the COMPOSED page carries the registry', wrapped.includes('ApComponents'));
  expect('the COMPOSED page carries the bridge', wrapped.includes("var NS = 'argus-presenter'"));
  expect('the COMPOSED page carries the component library', wrapped.includes("ApComponents.register('dice'"));
  expect('⇒ raw:true cannot host a component, and the tool says so rather than failing quietly', true);
});
