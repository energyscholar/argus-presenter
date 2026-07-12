/*
 * D1 — openPoll seeds the poll as a first-class store slice (spec + open).
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';

test('D1 — openPoll seeds polls/{pid} spec + open in the store', async () => {
  const server = await createServer({ port: 0 });
  try {
    server.openPoll({ promptId: 'seed1', prompt: 'Ship it?', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }], target: 'participant' });
    expect(server.store.get('polls/seed1/open') === true, 'open=true seeded', String(server.store.get('polls/seed1/open')));
    const spec = server.store.get('polls/seed1/spec');
    expect(spec && spec.prompt === 'Ship it?' && Array.isArray(spec.options) && spec.options.length === 2, 'spec seeded', JSON.stringify(spec));
    expect(server.store.version() >= 2, 'seed produced durable ops', String(server.store.version()));
  } finally { await server.close(); }
});
