/*
 * Plan 0941 §2 / §4 — speech OUT over the resumable voice link, driven in Node against a LOCAL server.
 *
 *   T0941-T1  a link whose capability scope includes `observe` receives {t:'speak', text}; a link holding
 *             only ['speak'] receives NOTHING — for target 'all' and when addressed by its own id. A
 *             connection without a capability (an ordinary page) is unchanged: it still receives speech.
 *   T0941-T4  an utterance delivered through the link is recorded for loopback dedupe: the same words,
 *             recognised from that link's microphone within the window, are flagged echo and are not
 *             delivered as a turn. Control: the same recognition with nothing spoken is NOT flagged.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { createVoiceLink } from '../../lib/voice-link.mjs';
import { WebSocket } from 'ws';
import { useStubAsr, mkCap, until, wait, connect, speak as sendSeg, SECRET } from './_0904-voice.mjs';

function openLink(s, scope, nonce) {
  const frames = [];
  const link = createVoiceLink({ wsUrl: s.url().replace('http', 'ws'), cap: mkCap({ scope, nonce, ref: 'ext:w:' + nonce }).token,
    WebSocketImpl: WebSocket, onFrame: (m) => frames.push(m) });
  return { link, frames, said: () => frames.filter((f) => f.t === 'speak') };
}

test('T0941-T1 — speech reaches an observe-scoped link only; a speak-only link hears nothing', async () => {
  useStubAsr();
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET });
  const obs = openLink(s, ['speak', 'type', 'observe'], 't1-obs');
  const spk = openLink(s, ['speak'], 't1-spk');
  const page = await connect(s.url(), { userId: 'host', userName: 'Host' });
  const pageSaid = () => page.frames.filter((f) => f.t === 'speak');
  try {
    await until(() => obs.link.state === 'live' && spk.link.state === 'live' && page.welcome, 'all connected');
    const n = s.speak('first line to everyone');
    await until(() => obs.said().length === 1 && pageSaid().length === 1, 'the observe link and the page heard it');
    await wait(150);
    expect(JSON.stringify(obs.said()[0]) === JSON.stringify({ t: 'speak', text: 'first line to everyone' }), 'the observe link got the frame', JSON.stringify(obs.said()));
    expect(spk.said().length === 0, 'the speak-only link received NOTHING', JSON.stringify(spk.said()));
    expect(n === 2, 'speak() counts the two recipients, not the speak-only link', String(n));

    const toSpk = s.speak('addressed to the speak-only link', 'guest:t1-spk');
    const toObs = s.speak('addressed to the observe link', 'guest:t1-obs');
    await until(() => obs.said().length === 2, 'the addressed line reached the observe link');
    await wait(150);
    expect(toSpk === 0 && spk.said().length === 0, 'addressing the speak-only link by id still reaches nothing', JSON.stringify({ toSpk, f: spk.said() }));
    expect(toObs === 1 && obs.said()[1].text === 'addressed to the observe link', 'target semantics unchanged for the observe link', JSON.stringify({ toObs, f: obs.said() }));
    expect(pageSaid().length === 1, 'an id-addressed line did not leak to the page', JSON.stringify(pageSaid()));
  } finally { obs.link.close(); spk.link.close(); try { page.ws.close(); } catch (e) {} await s.close(); }
});

const LINE = 'the outer hatch is now sealed';

async function heardFromLink(spokeFirst) {
  useStubAsr({ AP_ASR_STUB_TEXT: LINE });
  const s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET });
  const nonce = spokeFirst ? 't4-echo' : 't4-ctl';
  const results = [];
  const link = createVoiceLink({ wsUrl: s.url().replace('http', 'ws'), cap: mkCap({ scope: ['speak', 'type', 'observe'], nonce, ref: 'ext:w:' + nonce }).token,
    WebSocketImpl: WebSocket, onResult: (r) => results.push(r) });
  try {
    await until(() => link.state === 'live', 'live');
    if (spokeFirst) { const n = s.speak(LINE); expect(n === 1, 'the line was delivered through the link', String(n)); }
    sendSeg({ ws: link._socket() }, 1);
    await until(() => results.find((r) => r.seq === 1), 'the segment was recognised');
    await wait(100);
    return s.getInbox().items.filter((i) => i.userId === 'guest:' + nonce);
  } finally { link.close(); await s.close(); }
}

test('T0941-T4 — speech delivered via the link is deduped when its own mic hears it back', async () => {
  const echoed = await heardFromLink(true);
  expect(echoed.length === 1 && echoed[0].text === LINE, 'the loopback was recognised from the link', JSON.stringify(echoed.map((e) => e.text)));
  expect(echoed[0].echo === true, 'the loopback is flagged echo:true', JSON.stringify(echoed[0]));
  const control = await heardFromLink(false);
  expect(control.length === 1 && control[0].echo !== true, 'control: with nothing spoken, the same words are NOT an echo', JSON.stringify(control));
});
