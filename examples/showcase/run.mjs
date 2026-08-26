/*
 * Component showcase — every component mounted into ONE authored page, beside bound HTML controls.
 * Domain-free by construction: this is a toolkit test, not content.
 *
 * Run: node examples/showcase/run.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, launch, connectUser, waitContentFrame, wait,
         shot, act, reporter } from '../_lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(HERE, 'page.html'), 'utf8');
const ok = reporter();

const MOUNTS = [
  { at: '#m-card', component: 'card', opts: { title: 'A card', subtitle: 'title, body, badges',
      body: 'Cards carry a heading, a body and optional badges.', badges: ['demo', 'toolkit'] } },
  { at: '#m-narration', component: 'narration', opts: { text: 'Narration renders spoken or read-aloud text.', speaker: 'Narrator' } },
  { at: '#m-prose', component: 'prose', opts: { title: 'Prose', html: '<p>Server-sanitised HTML: <strong>bold</strong>, <em>italic</em>, lists.</p><ul><li>one</li><li>two</li></ul>' } },
  { at: '#m-choice', component: 'choice', opts: { prompt: 'Pick a colour', promptId: 'demo-poll',
      options: [{ label: 'Red', value: 'r' }, { label: 'Blue', value: 'b' }, { label: 'Green', value: 'g' }] } },
  { at: '#m-results', component: 'poll-results', opts: { prompt: 'Live tally', promptId: 'demo-poll',
      options: [{ label: 'Red', value: 'r' }, { label: 'Blue', value: 'b' }, { label: 'Green', value: 'g' }],
      tally: { r: 2, b: 1, g: 0 }, count: 3 } },
  { at: '#m-text', component: 'text-input', opts: { prompt: 'Your call sign', promptId: 'demo-text', placeholder: 'e.g. Kestrel' } },
  { at: '#m-slider', component: 'slider', opts: { prompt: 'Confidence', promptId: 'demo-slider', min: 0, max: 100, value: 60, unit: '%' } },
  { at: '#m-form', component: 'form', opts: { title: 'A form', promptId: 'demo-form', submitLabel: 'Submit',
      fields: [{ name: 'name', label: 'Name', type: 'text' }, { name: 'dept', label: 'Department', type: 'select',
        options: [{ label: 'Ops', value: 'ops' }, { label: 'Eng', value: 'eng' }] }] } },
  { at: '#m-dice', component: 'dice', opts: { count: 2, sides: 6, modifier: 1, label: 'Roll 2D+1', promptId: 'demo-dice' } },
  /* ⛔ stepper is a COMPOSITE: each step MOUNTS ANOTHER COMPONENT — {component, opts} — it does
     not take {title, body}. A wrong shape renders the literal text "Unknown component: undefined",
     which is >20 bytes and sailed straight through a byte-count assertion. */
  { at: '#m-stepper', component: 'stepper', opts: { promptId: 'demo-step', showProgress: true, steps: [
      { component: 'card', opts: { title: 'Step one', body: 'Composite: each step is a component.' } },
      { component: 'card', opts: { title: 'Step two', body: 'Advance with the button.' } },
      { component: 'card', opts: { title: 'Done', body: 'Flow complete.' } } ] } },
  { at: '#m-crud', component: 'crud', opts: { id: 'demo', title: 'Shared list', fields: [{ name: 'text', label: 'Item' }] } },
  { at: '#m-navmap', component: 'navmap', opts: { tokenId: 'demo-token', tokenLabel: 'You', tokenPx: 0.4, tokenPy: 0.5 } },
  { at: '#m-svg', component: 'svg-reactive', opts: { label: 'Reactive gauge', min: 0, max: 10, value: 5, watch: 'shared/demo/level' } },
];


const server = await createServer({ port: 0 });
const browser = await launch();
try {
  const A = await connectUser(browser, server, { userId: 'ann', userName: 'Ann' });
  const B = await connectUser(browser, server, { userId: 'ben', userName: 'Ben' });
  await wait(400);
  server.set('shared/demo', { theme: 'calm', level: 4, ready: false });
  server.set('crud/demo/items/i1', { text: 'seeded row' });
  server.pushPage('all', PAGE, { mounts: MOUNTS });
  await wait(1600);
  const f = await waitContentFrame(A);

  const report = await f.evaluate(() => {
    const ids = ['m-card','m-narration','m-prose','m-choice','m-results','m-text','m-slider',
                 'm-form','m-dice','m-stepper','m-crud','m-navmap','m-svg'];
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      out[id] = el ? { html: el.innerHTML.length, text: (el.innerText || '').trim().slice(0, 40) } : null;
    }
    const banner = document.querySelector('.ap-mount-error');
    return { out, banner: banner ? banner.textContent : null, errors: (window.__apErrors || []).slice(0, 5) };
  });

  ok('no unresolved mounts', report.banner === null, String(report.banner));
  ok('no page script errors', report.errors.length === 0, JSON.stringify(report.errors));

  /* ⛔ A BYTE COUNT IS NOT EVIDENCE OF SUCCESS — an error message is bytes too. A wrong `stepper`
     option shape rendered the literal text "Unknown component: undefined" and sailed straight
     through a length assertion. Reject what the registry prints when a name does not resolve. */
  const BAD = /Unknown component|No component registered/;
  const empty = [], broken = [];
  for (const [id, v] of Object.entries(report.out)) {
    if (!v || v.html < 20) empty.push(id);
    if (v && BAD.test(v.text)) broken.push(id + ': ' + v.text);
    console.log(`  ${id.padEnd(12)} ${v ? String(v.html).padStart(5) + ' bytes' : 'MISSING'}`);
  }
  ok('every mount rendered real content', empty.length === 0, empty.join(','));
  ok('no mount rendered a component-not-found message', broken.length === 0, broken.join(' | '));

  await A.bringToFront();
  await act(f, 'select[data-ap-bind="shared/demo/theme"]', (el) => {
    el.value = 'alert'; el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await wait(700);
  ok('a bound select reaches the server on a 13-mount page',
     server.store.get('shared/demo/theme') === 'alert');
  const fb = await waitContentFrame(B);
  const bEcho = await fb.evaluate(() => document.getElementById('echo').textContent);
  ok("and the other viewer's copy followed", /theme=alert/.test(bEcho), bEcho);

  await shot(A, 'showcase.png', { bound: 25000 });
} finally {
  await browser.close(); await server.close();
}
process.exit(ok.done());
