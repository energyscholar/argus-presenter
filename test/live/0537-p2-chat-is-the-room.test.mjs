/*
 * 0537 P2 — CHAT IS THE ROOM, and `/gm …` is the way out of it.
 *
 * Two claims, and they only mean something together:
 *   R1  an ordinary chat line from participant A reaches participant B (chat is the room)
 *   R2  a `/gm …` line from A reaches the GM and reaches NEITHER B nor the public `chat` slice
 *   R3  the sender is TOLD it went privately — a message that silently vanishes from the room is
 *       the invisible-GO defect in a new coat, and "it worked" and "it was swallowed" look identical
 *
 * ⛓ R2 is asserted THREE ways on purpose: B's socket, B's snapshot on a fresh connect, and the
 * store slice itself. A read-permission bug that leaks only through the reconnect snapshot would
 * pass a live-diff-only test, and the snapshot path is a different function (state.mjs filterNode)
 * from the diff path (server.mjs broadcastDiff).
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { WebSocket } from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function openWs(url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on('message', (b, bin) => { if (bin) return; try { inbox.push(JSON.parse(b.toString())); } catch {} });
    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); resolve({ ws, inbox }); });
  });
}
// Did this socket ever see a diff touching `prefix` whose value carries `text`?
const sawText = (inbox, prefix, text) => inbox.some((m) =>
  m.t === 'host' && m.msg && m.msg.type === 'diff' && m.msg.diff &&
  Object.keys(m.msg.diff).some((p) => p.indexOf(prefix) === 0 && m.msg.diff[p] && m.msg.diff[p].text === text));

test('0537 P2 — a peer sees ordinary chat; /gm reaches the GM alone, and the sender is told so', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await openWs(url, { userId: 'a', role: 'participant', userName: 'Ana' });
    const b = await openWs(url, { userId: 'b', role: 'participant', userName: 'Bo' });
    const gm = await openWs(url, { userId: 'gm', role: 'presenter', userName: 'GM' });
    await wait(250);

    // ---- R1: an ordinary line is the room's ----
    a.ws.send(JSON.stringify({ t: 'chat', text: 'anyone else cold?', id: 'a-open' }));
    await wait(400);
    expect(sawText(b.inbox, 'chat/', 'anyone else cold?'), 'peer participant B received A\'s chat line',
      JSON.stringify(b.inbox.filter((m) => m.t === 'host').slice(-3)));
    expect(sawText(gm.inbox, 'chat/', 'anyone else cold?'), 'the GM received it too');

    // ---- R2: `/gm …` leaves the room ----
    a.ws.send(JSON.stringify({ t: 'chat', text: '/gm I am going to try the airlock', id: 'a-aside' }));
    await wait(400);
    const SECRET = 'I am going to try the airlock';

    // (i) the GM got it, on the gm slice
    expect(sawText(gm.inbox, 'gm/asides/', SECRET), 'the GM received the private aside',
      JSON.stringify(gm.inbox.filter((m) => m.t === 'host').slice(-3)));
    // (ii) B saw NOTHING of it — not on gm/, and not smuggled onto chat/
    expect(!sawText(b.inbox, 'gm/', SECRET), 'peer B did NOT receive the aside');
    expect(!sawText(b.inbox, 'chat/', SECRET), 'the aside did NOT leak onto the public chat slice');
    // (iii) the public store slice itself is clean — not merely undelivered
    const publicChat = JSON.stringify(server.store.get('chat') || {});
    expect(publicChat.indexOf(SECRET) === -1, 'the aside is absent from the public chat slice', publicChat);
    // (iv) …and it IS in the gm slice, so this is secrecy, not loss
    expect(JSON.stringify(server.store.get('gm') || {}).indexOf(SECRET) !== -1, 'the aside IS stored, under gm');

    // (v) the SNAPSHOT path is filtered too — a fresh participant must not find it on connect.
    const late = await openWs(url, { userId: 'late', role: 'participant', userName: 'Late' });
    await wait(300);
    const snap = late.inbox.find((m) => m.t === 'snapshot');
    expect(!!snap, 'the late joiner got a snapshot');
    const snapText = JSON.stringify(snap && snap.state || {});
    expect(snapText.indexOf(SECRET) === -1, 'the aside is NOT in a participant snapshot', snapText.slice(0, 400));
    expect(snapText.indexOf('anyone else cold?') !== -1, 'but the ordinary chat line IS — the room has a history');
    late.ws.close();

    // ---- R3: the sender was told ----
    const receipt = a.inbox.find((m) => m.t === 'chat_private');
    expect(receipt && receipt.ok === true, 'the sender got a private-delivery receipt', JSON.stringify(receipt));
    expect(receipt && receipt.text === SECRET, 'the receipt quotes what was sent privately', JSON.stringify(receipt));
    // an empty `/gm` is refused, and SAYS it was refused rather than dropping silently
    a.ws.send(JSON.stringify({ t: 'chat', text: '/gm', id: 'a-empty' }));
    await wait(300);
    const refusal = a.inbox.filter((m) => m.t === 'chat_private').pop();
    expect(refusal && refusal.ok === false && refusal.reason === 'empty', 'a bare /gm is refused OUT LOUD', JSON.stringify(refusal));

    a.ws.close(); b.ws.close(); gm.ws.close();
  } finally { await server.close(); }
});

/*
 * ⛓ THE REGRESSION THIS EXISTS FOR, and it is not hypothetical — it happened while writing P2.3.
 *
 * The `chat_private` receipt handler was first placed in presenter.html's `else if` chain, which
 * runs from ~line 430 to ~531 INSIDE the `AP-VOICE:BEGIN..END` markers. The server DELETES that
 * whole block when voice is off, and voice is off BY DEFAULT. Result: the server sent the receipt,
 * the raw-socket test above went green, and a real browser rendered nothing at all — the exact
 * "a private message is indistinguishable from a lost one" failure P2.3 was written to prevent,
 * reintroduced by the fix for it.
 *
 * The test above could not catch it: a raw WebSocket never loads the page. This one reads the
 * SERVED BYTES with voice off, which is the artifact a participant's browser actually receives.
 */
test('0537 P2 — the /gm receipt handler survives the voice strip (chat is NOT voice)', async () => {
  const server = await createServer({ port: 0, voiceEnabled: false });
  try {
    const page = await (await fetch(server.url() + '/?role=participant&userId=u1')).text();
    // ⚠ The control checks for the voice CODE (`APVoice`), not for the fence-marker token. The
    // marker must not appear in an OFF page at all — T-BARGE-IN already guards that, and it caught
    // this handler's own explanatory comment when the comment spelled the marker out. Two guards,
    // two different things: T-BARGE-IN says the fence token is gone, this one says the code is.
    expect(page.indexOf('APVoice') === -1, 'voice really is stripped from this page (guard is meaningful)');
    expect(page.indexOf("m.t === 'chat_private'") !== -1,
      'the chat_private handler IS in the served page with voice OFF — it must not live inside the voice block');
    expect(page.indexOf('sent privately to the facilitator') !== -1,
      'and so is the text that tells the sender it went privately');
    // The sibling it belongs beside, as a control: if THIS vanished the page would be broken in
    // an obvious way, so its presence tells us we are reading a real page and not an error body.
    expect(page.indexOf("m.t === 'chat_listeners'") !== -1, 'control: the chat_listeners handler is present too');
  } finally { await server.close(); }
});
