// Rep 04 — POLL-RESULTS (live display) recomputes from the store vote slice (diffs).
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';

test('rep 04 — poll-results: vote-slice diffs update bars + counts', async () => {
  const opts = {
    prompt: 'Ship it?',
    promptId: 'r4',
    options: [{ label: 'Yes', value: 'yes', style: 'ok' }, { label: 'No', value: 'no', style: 'danger' }],
  };

  const r = await drive({
    component: 'poll-results', opts, shot: 'poll-results.png',
    actions: [{ host: { type: 'diff', diff: { 'polls/r4/votes/u1': 'yes', 'polls/r4/votes/u2': 'yes', 'polls/r4/votes/u3': 'yes', 'polls/r4/votes/u4': 'no', 'polls/r4/votes/u5': 'no' } } }, { wait: 400 }],
    probe: () => {
      const counts = {};
      document.querySelectorAll('.ap-pr-count[data-value]').forEach((el) => { counts[el.getAttribute('data-value')] = el.textContent; });
      const widths = [...document.querySelectorAll('.ap-pr-fill')].map((el) => parseFloat(el.style.width) || 0);
      return { counts, widths, total: document.querySelector('.ap-pr-total').textContent };
    }
  });

  expect('yes count -> 3', r.probe.counts.yes === '3', JSON.stringify(r.probe));
  expect('no count -> 2', r.probe.counts.no === '2', JSON.stringify(r.probe));
  expect('total shows 5 votes', /5 votes/.test(r.probe.total), r.probe.total);
  expect('yes bar wider than no bar', r.probe.widths[0] > r.probe.widths[1], JSON.stringify(r.probe.widths));
  expect('yes bar at 60%', Math.abs(r.probe.widths[0] - 60) < 1, JSON.stringify(r.probe.widths));
});
