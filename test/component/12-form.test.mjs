// Rep 12 — FORM (multi-field, coordinated submit). Empty blocked; valid emits answer{fields}.
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';

test('rep 12 — form: validation + multi-field submit', async () => {
  const opts = {
    title: 'Attendee Intake', promptId: 'intake',
    fields: [
      { name: 'name', label: 'Name', validate: 'required' },
      { name: 'email', label: 'Email', validate: ['required', 'email'] },
      { name: 'role', label: 'Role', type: 'select', options: [{ label: 'Instructor', value: 'instructor' }, { label: 'Student', value: 'student' }] }
    ]
  };

  const r0 = await drive({ component: 'form', opts, actions: [{ click: '.ap-form-submit' }] });
  expect('empty form submit blocked', !r0.messages.some((m) => m.type === 'answer'), JSON.stringify(r0.messages.map((m) => m.type)));

  const r = await drive({
    component: 'form', opts, shot: 'form.png',
    actions: [
      { type: { sel: '#intake-name', text: 'Sam' } },
      { type: { sel: '#intake-email', text: 'sam@example.com' } },
      { click: '.ap-form-submit' }
    ]
  });
  const a = r.messages.find((m) => m.type === 'answer' && m.promptId === 'intake');
  expect('form emitted answer with name', a && a.value && a.value.name === 'Sam', JSON.stringify(a));
  expect('email captured', a && a.value.email === 'sam@example.com', JSON.stringify(a && a.value));
  expect('select role captured (default instructor)', a && a.value.role === 'instructor', JSON.stringify(a && a.value));
});
