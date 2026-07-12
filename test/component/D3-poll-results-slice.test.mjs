// D3 — poll-results recomputes the tally from the store vote SLICE (diffs).
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';

test('D3 — poll-results recomputes tally from polls/{pid}/votes diffs', async () => {
  const r = await drive({
    component: 'poll-results',
    opts: { promptId: 'tp', prompt: 'Ship it?', options: [{ label: 'Yes', value: 'yes', style: 'ok' }, { label: 'No', value: 'no', style: 'danger' }] },
    actions: [
      { host: { type: 'diff', diff: { 'polls/tp/votes/u1': 'yes', 'polls/tp/votes/u2': 'yes', 'polls/tp/votes/u3': 'yes', 'polls/tp/votes/u4': 'no', 'polls/tp/votes/u5': 'no' } } },
      { wait: 300 },
    ],
    probe: () => {
      const counts = {};
      document.querySelectorAll('.ap-pr-count[data-value]').forEach((el) => { counts[el.getAttribute('data-value')] = el.textContent; });
      const widths = [...document.querySelectorAll('.ap-pr-fill')].map((el) => parseFloat(el.style.width) || 0);
      return { counts, widths, total: document.querySelector('.ap-pr-total').textContent };
    }
  });
  expect('yes = 3 from slice', r.probe.counts.yes === '3', JSON.stringify(r.probe));
  expect('no = 2 from slice', r.probe.counts.no === '2', JSON.stringify(r.probe));
  expect('total shows 5 votes', /5 votes/.test(r.probe.total), r.probe.total);
  expect('yes bar at 60%', Math.abs(r.probe.widths[0] - 60) < 1, JSON.stringify(r.probe.widths));

  // A changed vote (u4 no->yes) recomputes to 4/1.
  const r2 = await drive({
    component: 'poll-results',
    opts: { promptId: 'tp', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }] },
    actions: [
      { host: { type: 'diff', diff: { 'polls/tp/votes/u1': 'yes', 'polls/tp/votes/u4': 'no' } } }, { wait: 150 },
      { host: { type: 'diff', diff: { 'polls/tp/votes/u4': 'yes' } } }, { wait: 150 },
    ],
    probe: () => { const c = {}; document.querySelectorAll('.ap-pr-count[data-value]').forEach((el) => { c[el.getAttribute('data-value')] = el.textContent; }); return c; }
  });
  expect('change-of-mind recomputes: yes=2 no=0', r2.probe.yes === '2' && r2.probe.no === '0', JSON.stringify(r2.probe));
});
