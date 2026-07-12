/*
 * C1 — Argus.op(path,verb,value) dispatches { type:'op', path, verb, value, opId }
 * with server-authoritative-ready identity stamped by the bridge.
 */
import { test, expect } from '../../harness/test.mjs';
import { loadBridge } from './_bridge-harness.mjs';

test('C1 — Argus.op emits a well-formed op message', () => {
  const { Argus, outbound } = loadBridge();
  Argus.configure({ userId: 'u1', userName: 'Alice' });
  const opId = Argus.op('map/markers', 'add', { id: 'm1', px: 0.5, py: 0.4 });

  const msg = outbound.find((m) => m.type === 'op');
  expect(!!msg, 'an op message was dispatched', JSON.stringify(outbound));
  expect(msg.path === 'map/markers' && msg.verb === 'add', 'path+verb carried', JSON.stringify(msg));
  expect(msg.value && msg.value.id === 'm1', 'value carried');
  expect(typeof msg.opId === 'string' && msg.opId.length > 0, 'opId is a non-empty string', msg.opId);
  expect(opId === msg.opId, 'op() returns the opId it sent');
  expect(msg.source === 'argus-presenter', 'tagged with the bridge namespace');
  expect(msg.userId === 'u1', 'identity stamped for the server to authorize');
});

test('C1 — each op gets a distinct opId', () => {
  const { Argus } = loadBridge();
  Argus.configure({ userId: 'u1' });
  const a = Argus.op('a', 'set', 1);
  const b = Argus.op('a', 'set', 2);
  expect(a !== b, 'distinct opIds', `${a} vs ${b}`);
});
