/*
 * Plan 0471 INV-COMPONENTS — the safety net for the C3 default-DENY read flip.
 * Every one of the 14 components must still RENDER (non-blank) for a PARTICIPANT.
 * A blank render ⇒ the read policy stripped state the component needs ⇒ a MISSING
 * allow rule (add it). Each component is pushed to a fresh participant page.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, connectUser, waitContentFrame, contentFrame, until, wait } from '../../harness/multi.mjs';

const IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';

const COMPONENTS = [
  ['card', { title: 'Dr. Lee', subtitle: 'Analyst', body: 'Reads every dashboard.', promptId: 'card1' }],
  ['choice', { prompt: 'Demo?', promptId: 'ch1', options: [{ label: 'Yes', value: 'yes', style: 'ok' }, { label: 'No', value: 'no', style: 'danger' }] }],
  ['crud', { id: 'plan', config: 'shared-list', title: 'Flight plan', fields: [{ name: 'text', label: 'Step' }] }],
  ['dice', { label: 'Confidence roll', dice: '2d6+2', target: 8, promptId: 'd1' }],
  ['form', { title: 'Intake', promptId: 'f1', fields: [{ name: 'name', label: 'Name', validate: 'required' }] }],
  ['image', { src: IMG, caption: 'Site map', frame: true }],
  ['map', { controllable: false, label: 'Map' }],
  ['narration', { speaker: 'Guide', text: 'The doors open onto a studio.', cta: 'Continue', promptId: 'n1' }],
  ['poll-results', { prompt: 'Ship it?', promptId: 'pr1', options: [{ label: 'Yes', value: 'yes', style: 'ok' }, { label: 'No', value: 'no', style: 'danger' }] }],
  ['scene', { layout: 'stack', items: [{ component: 'narration', opts: { text: 'Public intel.', promptId: 's1' } }] }],
  ['slider', { prompt: 'Reactor output', promptId: 'sl1', min: 0, max: 100, step: 5, value: 20, unit: '%' }],
  ['stepper', { promptId: 'st1', showProgress: true, steps: [{ component: 'narration', opts: { text: 'Step one.', promptId: 'stn1' } }] }],
  ['svg-reactive', { label: 'Core', watch: 'lvl', min: 0, max: 100, value: 20 }],
  ['text-input', { prompt: 'Comments?', promptId: 'ti1', placeholder: 'Type…', validate: 'required', submitLabel: 'Send' }],
];

test('INV-COMPONENTS — all 14 components render (non-blank) for a participant under default-deny read', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    for (const [component, opts] of COMPONENTS) {
      const page = await connectUser(browser, server, { userId: 'p-' + component, userName: 'P ' + component });
      await until(() => server.presence().some((u) => u.userId === 'p-' + component), { label: component + ' connected' });
      server.pushComponent('all', component, opts);
      await waitContentFrame(page);
      // Re-fetch the frame fresh each poll + swallow transient frame-detach (iframe re-mount
      // churn — the documented E1/E3/E4-class flake), until the component reports a populated DOM.
      let info = { kids: 0, ap: false, txt: 0 };
      await until(async () => {
        try {
          const f = contentFrame(page); if (!f) return false;
          info = await f.evaluate(() => ({
            kids: document.body.querySelectorAll('*').length,
            ap: !!document.body.querySelector('[class*="ap-"], svg, img, input, button'),
            txt: document.body.textContent.trim().length,
          }));
          return info.kids >= 3 && info.ap;
        } catch { return false; }   // detached/navigating frame → retry
      }, { label: component + ' non-blank', timeout: 6000 });
      expect(component + ' renders non-blank for a participant', info.kids >= 3 && info.ap, JSON.stringify(info));
      await page.close();
    }
  } finally { await browser.close(); await server.close(); }
});
