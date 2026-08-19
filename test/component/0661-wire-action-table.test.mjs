/*
 * 0661 — the wire ACTION TABLE actually dispatches.
 *
 * ⛔ WHY THIS TEST EXISTS. Phase 1 replaced a 410-line `if (m.t === …)` chain with a
 *   `wireActions` table. The dispatch site had been added in an earlier commit with the table
 *   left EMPTY, so `wireActions.get(m.t)` always returned undefined and the call was never
 *   evaluated. Two real faults hid behind that:
 *
 *     1. the dispatch passed `c`, but sat ABOVE the `try` block where `c` is bound;
 *     2. handler bodies close over `req`, which is per-CONNECTION scope, not server scope.
 *
 *   Both throw ReferenceError at call time — straight into the dispatch's `catch`, which logs
 *   at warn and returns. The socket then goes silent with nothing in the default log to find.
 *   The whole suite stayed green because an empty table cannot throw.
 *
 * ⭐ THE INVARIANT: a `hello` frame must produce a `welcome`. It is the cheapest frame that
 *   proves the table was populated, the handler was found, AND the handler ran to completion
 *   through the real dispatch. A green suite over an un-exercised dispatch proves nothing —
 *   this is the test that would have failed on day one.
 */
import { test, check } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('0661 — a hello frame round-trips through the action table (dispatch is not swallowing)', async () => {
  const server = await createServer({ port: 0 });
  const ws = new WebSocket(server.url().replace('http', 'ws') + '/ws');
  const seen = [];
  ws.on('message', (d) => { try { seen.push(JSON.parse(d).t); } catch {} });
  try {
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    ws.send(JSON.stringify({ t: 'hello', role: 'audience', name: 'TableProbe' }));
    for (let i = 0; i < 40 && !seen.includes('welcome'); i++) await settle(50);

    // The handler RAN: it answered on the wire …
    check('hello → welcome: the handler was reached AND ran to completion', seen.includes('welcome'),
          `frames seen: ${JSON.stringify([...new Set(seen)])}`);
    // … and it TOOK EFFECT in server state, which a throw-then-swallow could never do.
    check('the greeter landed in presence() — a swallowed throw could not do this', server.presence().length >= 1,
          `presence=${server.presence().length}`);
  } finally {
    try { ws.close(); } catch {}
    try { await server.close?.(); } catch {}
  }
});
