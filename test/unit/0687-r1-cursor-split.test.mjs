/*
 * Plan 0687 R1 — THE CURSOR SPLIT.  ⛔ G9: signals with different meanings never share one number.
 *
 * Before this run there was ONE `situationCursors: Map<key, number>` carrying two semantics: a
 * digest READ position (jumps to the head) and a PVS DELIVERY position (advances entry by entry).
 * One /api/situation read therefore zeroed the delivery backlog for that key.
 *
 * These tests are about the SHAPE of the record, not about who may write it (that is R2): a
 * delivery consumer's position is a PAIR, the two halves move for different reasons, and every
 * aggregate reads the half that answers its own question.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { CursorBook, isDeliveryKey, DELIVERY_PREFIX } from '../../lib/delivery-cursors.mjs';

const PVS_KEY = 'pvs:argusmon';
const say = (s, text) => s._emitInboxForTest({ kind: 'voice', userId: 'bruce', userName: 'Bruce', role: 'presenter', text });

test('0687 R1 — a delivery key and a read key are DIFFERENT NAMESPACES, and the book knows which is which', async () => {
  expect(isDeliveryKey(PVS_KEY), 'a pvs: key is a delivery key');
  expect(!isDeliveryKey('mcp-stdio'), 'an ordinary consumer id is NOT a delivery key');
  expect(!isDeliveryKey(null) && !isDeliveryKey(undefined), 'a missing key is never a delivery key (fail-safe)');
  expect(DELIVERY_PREFIX === 'pvs:', 'the namespace is the one the PVS consumer keys already use', DELIVERY_PREFIX);
});

test('0687 R1 — a delivery record is a PAIR; `sent` and `acked` move for different reasons', async () => {
  const book = new CursorBook();
  book.baselineDelivery('pvs:x', 0);
  book.markSent('pvs:x', 5);
  expect(book.delivery('pvs:x').sent === 5, 'sent advanced', String(book.delivery('pvs:x').sent));
  expect(book.delivery('pvs:x').acked === 0, '⛔ acked did NOT move when bytes were sent', String(book.delivery('pvs:x').acked));
  book.ackDelivery('pvs:x', 3);
  expect(book.delivery('pvs:x').acked === 3, 'an ack moves acked', String(book.delivery('pvs:x').acked));
  expect(book.delivery('pvs:x').sent === 5, 'and leaves sent alone', String(book.delivery('pvs:x').sent));
  book.ackDelivery('pvs:x', 1);
  expect(book.delivery('pvs:x').acked === 3, 'an ack never walks backwards (a late duplicate is harmless)', String(book.delivery('pvs:x').acked));
});

test('0687 R1 — reading a record NEVER creates one (no side effect on a question)', async () => {
  const book = new CursorBook();
  expect(book.delivery('pvs:ghost').sent === 0 && book.delivery('pvs:ghost').acked === 0, 'an unknown key reads as zeroed');
  expect(!book.hasDelivery('pvs:ghost'), '⛔ and asking did not bring it into existence');
  expect(book.minAcked() === null, 'with NO delivery consumer, minAcked is null — not 0');
});

test('0687 R1 — the two aggregates are namespace-aware and answer DIFFERENT questions', async () => {
  const book = new CursorBook();
  book.setReadPosition('mcp-stdio', 8);          // a digest reader, caught up to 8
  book.baselineDelivery('pvs:a', 0);
  book.markSent('pvs:a', 9);                     // handed everything over
  book.ackDelivery('pvs:a', 2);                  // ... but confirmed almost nothing
  expect(book.maxTransportBacklog(10) === 2, 'FLOOR question: the furthest-behind HANDOVER is the reader at 8', String(book.maxTransportBacklog(10)));
  expect(book.maxUnackedBacklog(10) === 8, 'REDELIVERY question: 8 turns are unconfirmed', String(book.maxUnackedBacklog(10)));
  expect(book.maxTransportBacklog(10) !== book.maxUnackedBacklog(10),
    '⛔ the two numbers genuinely differ — this is the G9 violation the split removes');
});

test('0687 R1 — a digest READ moves the read position and touches NO delivery record', async () => {
  const s = await createServer({ port: 0 });
  try {
    s.pvsStart({ consumer: 'argusmon' });
    say(s, 'one'); say(s, 'two');
    await s.situation({ consumerId: 'mcp-stdio' });      // an unrelated digest read, jumps to head
    const b = s.pvsBacklog({ consumer: 'argusmon' });
    expect(b.count >= 1, "⛔ the other consumer's read did not consume the delivery backlog", String(b.count));
    expect(b.acked === 0, 'the delivery record is untouched', String(b.acked));
  } finally { await s.close(); }
});

test('0687 R1 — the book round-trips WHOLE (G2) and refuses garbage rather than guessing', async () => {
  const book = new CursorBook();
  book.setReadPosition('r', 4); book.baselineDelivery('pvs:d', 1); book.markSent('pvs:d', 7); book.ackDelivery('pvs:d', 3);
  const back = CursorBook.fromJSON(JSON.parse(JSON.stringify(book.toJSON())));
  expect(back.readPosition('r') === 4, 'read position survived', String(back.readPosition('r')));
  expect(back.delivery('pvs:d').sent === 7 && back.delivery('pvs:d').acked === 3, 'BOTH halves survived, as a pair',
    JSON.stringify(back.delivery('pvs:d')));
  const junk = CursorBook.fromJSON({ read: { a: 'nope', b: -1 }, delivery: { 'pvs:z': { sent: 'x' }, 'pvs:y': null } });
  expect(junk.readPosition('a') === 0 && junk.readPosition('b') === 0, 'a nonsense read position is ABSENT, never guessed');
  expect(!junk.hasDelivery('pvs:z') && !junk.hasDelivery('pvs:y'), 'a nonsense delivery record is ABSENT, never guessed');
});
