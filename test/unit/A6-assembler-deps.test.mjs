/*
 * A6 — the assembler is dependency-driven. No `requires` ⇒ ZERO plugin bytes;
 * a content module that requires a plugin bundles core + exactly that closure.
 *
 * ⭐ Plan 0569 M2 — `example` is a TEST FIXTURE, not a shipped plugin. This repo ships none.
 */
import { test, expect } from '../../harness/test.mjs';
import { assemble } from '../../harness/assemble.mjs';
import { resolveClosure } from '../../harness/plugins.mjs';
import { withFixturePlugins } from '../fixtures/plugins.mjs';

const countOf = (hay, needle) => hay.split(needle).length - 1;

test('A6 — pure-core assemble has ZERO plugin bytes', () => {
  const html = assemble({ component: 'choice', opts: { prompt: 'x', options: [{ label: 'Y', value: 'y' }] } });
  expect(countOf(html, 'ap-weather') === 0, 'no weather component in pure core', String(countOf(html, 'ap-weather')));
  expect(countOf(html, 'cityGrid') === 0, 'no cityGrid in pure core', String(countOf(html, 'cityGrid')));
  // Core is still there.
  expect(html.includes('ApComponents'), 'core registry present');
});

test('A6 — requires:[example] bundles core + exactly that closure', async () => {
  await withFixturePlugins(() => {
    const html = assemble({ component: 'map', opts: { preset: 'city-grid' }, requires: ['example'] });
    expect(countOf(html, 'cityGrid') >= 1, 'fixture preset bundled', String(countOf(html, 'cityGrid')));
    expect(html.includes('ap-weather'), 'fixture weather component bundled');
  });
});

test('A6 — resolveClosure: [] -> pure core; [example] -> only example', async () => {
  await withFixturePlugins(() => {
    expect(JSON.stringify(resolveClosure([])) === '[]', 'empty requires -> pure core');
    expect(JSON.stringify(resolveClosure(['example'])) === JSON.stringify(['example']), 'closure is exactly example', JSON.stringify(resolveClosure(['example'])));
    expect(JSON.stringify(resolveClosure(['nope-unknown'])) === '[]', 'unknown plugin name ignored (S9)');
  });
});
