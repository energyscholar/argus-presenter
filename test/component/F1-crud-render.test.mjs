// F1 — crud renders items from a state slice and re-renders on crud/{id} diffs.
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';

test('F1 — crud renders seeded items; diffs add/remove rows', async () => {
  const r = await drive({
    component: 'crud',
    opts: { id: 'plan', title: 'Flight plan', fields: [{ name: 'text', label: 'Step' }], items: { a: { text: 'refuel' }, b: { text: 'plot course' } } },
    actions: [
      { host: { type: 'diff', diff: { 'crud/plan/items/c': { text: 'depart' } } } }, { wait: 150 },
      { host: { type: 'diff', diff: { 'crud/plan/items/a': null } } }, { wait: 150 },
    ],
    probe: () => {
      const rows = [...document.querySelectorAll('.ap-crud-item')].map((el) => ({ id: el.getAttribute('data-id'), text: el.querySelector('[data-field="text"]').value }));
      return { rows, count: rows.length };
    }
  });
  const texts = r.probe.rows.map((x) => x.text).sort();
  expect('after add+remove, 2 rows', r.probe.count === 2, JSON.stringify(r.probe.rows));
  expect('rows are the seeded b + added c (a removed)', JSON.stringify(texts) === JSON.stringify(['depart', 'plot course']), JSON.stringify(texts));
});
