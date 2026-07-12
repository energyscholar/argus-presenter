// F3 — per-item lock: another user's lock blocks edit; owner + presenter may edit.
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';

const disabled = () => {
  const inp = document.querySelector('[data-id="a"] [data-field="text"]');
  const rm = document.querySelector('[data-id="a"] .ap-crud-remove');
  return { field: inp.disabled, remove: rm.disabled };
};

test('F3 — an item locked by ANOTHER user blocks this user\'s edit', async () => {
  const r = await drive({
    component: 'crud',
    opts: { id: 'p', userId: 'u1', fields: [{ name: 'text' }], items: { a: { text: 'x', lock: 'u2' } } },
    probe: disabled,
  });
  expect('field disabled when locked by another', r.probe.field === true, JSON.stringify(r.probe));
  expect('remove disabled when locked by another', r.probe.remove === true, JSON.stringify(r.probe));
});

test('F3 — the lock OWNER may edit their locked item', async () => {
  const r = await drive({
    component: 'crud',
    opts: { id: 'p', userId: 'u1', fields: [{ name: 'text' }], items: { a: { text: 'x', lock: 'u1' } } },
    probe: disabled,
  });
  expect('owner can edit their locked item', r.probe.field === false, JSON.stringify(r.probe));
});

test('F3 — a PRESENTER overrides another user\'s lock', async () => {
  const r = await drive({
    component: 'crud',
    opts: { id: 'p', userId: 'gm', viewerRole: 'presenter', fields: [{ name: 'text' }], items: { a: { text: 'x', lock: 'u2' } } },
    probe: disabled,
  });
  expect('presenter can edit despite another user\'s lock', r.probe.field === false, JSON.stringify(r.probe));
});

test('F3 — clicking lock on an unlocked item emits a lock op', async () => {
  const r = await drive({
    component: 'crud',
    opts: { id: 'p', userId: 'u1', fields: [{ name: 'text' }], items: { a: { text: 'x' } } },
    actions: [{ click: '[data-id="a"] .ap-crud-lock-btn' }, { wait: 100 }],
  });
  const lock = r.messages.find((m) => m.type === 'op' && m.verb === 'lock' && m.path === 'crud/p/items/a');
  expect('lock op emitted with owner', lock && lock.value.by === 'u1', JSON.stringify(r.messages.filter((m) => m.type === 'op')));
});
