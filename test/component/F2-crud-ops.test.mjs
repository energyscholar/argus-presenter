// F2 — crud emits store ops for create / update / delete.
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';

const ops = (msgs) => msgs.filter((m) => m.type === 'op');

test('F2 — add emits an add op with the field values', async () => {
  const r = await drive({
    component: 'crud',
    opts: { id: 'plan', userId: 'u1', userName: 'U1', fields: [{ name: 'text', label: 'Step' }] },
    actions: [{ type: { sel: '[data-add="text"]', text: 'depart' } }, { click: '.ap-crud-add-btn' }, { wait: 100 }],
  });
  const add = ops(r.messages).find((m) => m.verb === 'add' && m.path === 'crud/plan/items');
  expect('add op emitted', !!add, JSON.stringify(ops(r.messages)));
  expect('add carries the field value + id', add && add.value.text === 'depart' && !!add.value.id, JSON.stringify(add && add.value));
});

test('F2 — editing a field emits a merge op', async () => {
  const r = await drive({
    component: 'crud',
    opts: { id: 'plan', userId: 'u1', fields: [{ name: 'text', label: 'Step' }], items: { a: { text: 'refuel' } } },
    actions: [{ type: { sel: '[data-id="a"] [data-field="text"]', text: 'X' } }, { key: 'Tab' }, { wait: 100 }],
  });
  const merge = ops(r.messages).find((m) => m.verb === 'merge' && m.path === 'crud/plan/items/a');
  expect('merge op emitted for the edited item', !!merge, JSON.stringify(ops(r.messages)));
  expect('merge carries the field', merge && typeof merge.value.text === 'string', JSON.stringify(merge && merge.value));
});

test('F2 — remove emits a remove op with the item id', async () => {
  const r = await drive({
    component: 'crud',
    opts: { id: 'plan', userId: 'u1', fields: [{ name: 'text', label: 'Step' }], items: { a: { text: 'refuel' } } },
    actions: [{ click: '[data-id="a"] .ap-crud-remove' }, { wait: 100 }],
  });
  const rm = ops(r.messages).find((m) => m.verb === 'remove' && m.path === 'crud/plan/items');
  expect('remove op emitted', !!rm, JSON.stringify(ops(r.messages)));
  expect('remove targets item a', rm && rm.value === 'a', JSON.stringify(rm && rm.value));
});
