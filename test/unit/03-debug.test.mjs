/*
 * T3 (server/MCP) — debugDump() returns presence + connections + current state +
 * a role-redacted op/log tail; the presenter_debug MCP tool exposes the same.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { toolMap } from '../../mcp/tools.mjs';
import * as L from '../../app/log.mjs';

test('T3 server.debugDump() has presence, connections, state.polls, opLog', async () => {
  L.clear(); L.setLevel('info');
  const server = await createServer({ port: 0 });
  try {
    server.openPoll({ promptId: 'd1', prompt: 'x?', options: [{ label: 'Y', value: 'y' }], target: 'all' });
    const d = server.debugDump('presenter');
    expect(Array.isArray(d.presence), 'presence is an array');
    expect(Array.isArray(d.connections), 'connections is an array');
    expect(d.state && Array.isArray(d.state.polls), 'state.polls is an array');
    expect(d.state.polls.some((p) => p.promptId === 'd1'), 'poll d1 present in state', JSON.stringify(d.state.polls));
    expect(Array.isArray(d.opLog) && d.opLog.some((e) => e.tag === 'poll' && e.msg === 'open'),
      'opLog tail includes the poll-open entry', JSON.stringify(d.opLog.slice(-3)));
  } finally { await server.close(); }
});

test('T3 MCP presenter_debug returns a state snapshot + op-log tail', async () => {
  const T = toolMap();
  await T.presenter_start.handler({ port: 0 });
  try {
    await T.open_poll.handler({ promptId: 'd2', prompt: 'x?', options: [{ label: 'Y', value: 'y' }] });
    const d = await T.presenter_debug.handler({});
    expect(d.state.polls.some((p) => p.promptId === 'd2'), 'MCP debug shows poll d2', JSON.stringify(d.state.polls));
    expect(Array.isArray(d.opLog), 'MCP debug carries an opLog tail');
  } finally { await T.presenter_stop.handler({}); }
});
