/*
 * 0537 P3 — THE SERVER ROLLS.
 *
 * The claim is not "dice work". It is that a roll is ONE event with ONE outcome, produced somewhere
 * no client can reach, and that the record of it can always distinguish a roll from a claim.
 *
 *   S1  a participant asks; EVERY participant sees the same roll, with the same numbers
 *   S2  `success` is computed by the SERVER from the target that arrived with the request —
 *       a client cannot assert it, and cannot assert the total either
 *   S3  `entry:'rolled'` vs `entry:'manual'` — a typed-in result is ALLOWED but always MARKED
 *   S4  the `rolls` slice holds the structured record and is readable by all roles
 *   S5  a bad spec is REFUSED out loud, never silently rolled as something else
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
const rollsOf = (inbox) => inbox.filter((m) => m.t === 'roll').map((m) => m.roll);

test('0537 P3 — one roll, one outcome: every participant sees the same numbers, computed server-side', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await openWs(url, { userId: 'a', role: 'participant', userName: 'Ana' });
    const b = await openWs(url, { userId: 'b', role: 'participant', userName: 'Bo' });
    const gm = await openWs(url, { userId: 'gm', role: 'presenter', userName: 'Facilitator' });
    await wait(250);

    // ---- S1/S2: A asks for a check. The target rides the request, so the server always has it. ----
    a.ws.send(JSON.stringify({ t: 'roll', spec: '2d6+2', target: 8, label: 'Gunnery' }));
    await wait(400);

    const ra = rollsOf(a.inbox), rb = rollsOf(b.inbox), rg = rollsOf(gm.inbox);
    expect(ra.length === 1 && rb.length === 1 && rg.length === 1,
      'exactly ONE roll event reached each of the three clients', `a=${ra.length} b=${rb.length} gm=${rg.length}`);
    // ⛓ THE POINT. Not "everyone got a roll" — everyone got THE SAME roll. A client-side roller
    // passes the first and fails this one, which is why it is asserted on the numbers themselves.
    expect(JSON.stringify(ra[0]) === JSON.stringify(rb[0]), 'A and B received the IDENTICAL record',
      `${JSON.stringify(ra[0])} vs ${JSON.stringify(rb[0])}`);
    expect(JSON.stringify(ra[0]) === JSON.stringify(rg[0]), 'and so did the facilitator');

    const r = ra[0];
    expect(r.rolls.length === 2 && r.rolls.every((d) => d >= 1 && d <= 6), '2d6 produced two d6 faces', JSON.stringify(r.rolls));
    expect(r.total === r.rolls[0] + r.rolls[1] + 2, 'total = the faces plus the modifier', JSON.stringify(r));
    expect(r.target === 8 && r.success === (r.total >= 8), 'success is the SERVER\'s comparison against the target', JSON.stringify(r));
    expect(r.entry === 'rolled', 'a server roll is marked `rolled`', r.entry);
    expect(r.who === 'a' && r.whoName === 'Ana', 'attributed to the server-authoritative identity', JSON.stringify(r));
    expect(r.label === 'Gunnery', 'the label survives', String(r.label));

    // ---- S4: the structured record is in the store, and participants may READ it ----
    const slice = server.store.get('rolls') || {};
    expect(Object.keys(slice).length === 1, 'one record in the `rolls` slice', JSON.stringify(Object.keys(slice)));
    expect(JSON.stringify(slice[r.id]) === JSON.stringify(r), 'the stored record IS the broadcast record');
    expect(server.store.perms.canRead({ role: 'participant', userId: 'b' }, 'rolls/' + r.id) === true,
      'a participant may READ the roll log — a roll nobody else can see is a claim');
    // ⛔ …and may NOT write it. This is what makes the log trustworthy at all.
    expect(server.store.perms.can({ role: 'participant', userId: 'b' }, { path: 'rolls/' + r.id, verb: 'set' }) === false,
      'a participant may NOT write the roll log');

    // ---- S3: a hand-entered result is allowed, and is MARKED ----
    b.ws.send(JSON.stringify({ t: 'roll', spec: '2d6', target: 8, total: 11, label: 'physical dice' }));
    await wait(400);
    const manual = rollsOf(a.inbox)[1];
    expect(!!manual, 'the manual entry reached the other participant too');
    expect(manual.entry === 'manual', 'a typed-in result is marked `manual`', manual.entry);
    expect(manual.total === 11 && manual.rolls.length === 0, 'it carries the claimed total and NO faces', JSON.stringify(manual));
    // ⛓ Even here the server does the comparison — the claim is the total, never the verdict.
    expect(manual.success === true, 'success is STILL server-computed for a manual entry', JSON.stringify(manual));

    // ---- S2, PROPERLY. ----
    // ⚠ The assertions above compare `success` to `total >= target`, and a break test proved that
    // is NOT a test: with `success` hardcoded to `true` the whole file still passed, because on
    // 2d6+2 vs 8 the honest answer is `true` most of the time anyway. A gate you have only seen
    // pass is untested. These two are DETERMINISTIC — a constant of either polarity fails one of
    // them, whatever the dice do.
    a.ws.send(JSON.stringify({ t: 'roll', spec: '2d6', target: 99 }));          // unreachable
    await wait(300);
    a.ws.send(JSON.stringify({ t: 'roll', spec: '2d6', target: -99 }));         // unmissable
    await wait(300);
    const all = rollsOf(a.inbox);
    const impossible = all[all.length - 2], certain = all[all.length - 1];
    expect(impossible.target === 99 && impossible.success === false,
      'ALWAYS false: 2d6 cannot reach 99', JSON.stringify(impossible));
    expect(certain.target === -99 && certain.success === true,
      'ALWAYS true: 2d6 cannot miss -99', JSON.stringify(certain));
    // …and the same both ways for a hand-entered total, where the number is not the server's.
    b.ws.send(JSON.stringify({ t: 'roll', spec: '2d6', target: 8, total: 3 }));
    await wait(300);
    const lowManual = rollsOf(a.inbox).pop();
    expect(lowManual.entry === 'manual' && lowManual.total === 3 && lowManual.success === false,
      'a manual total BELOW the target is a FAILURE — the client supplies the number, never the verdict',
      JSON.stringify(lowManual));

    // ---- S5: a bad spec is refused, out loud ----
    a.ws.send(JSON.stringify({ t: 'roll', spec: 'not-dice', target: 8 }));
    await wait(300);
    const refused = a.inbox.filter((m) => m.t === 'roll_refused').pop();
    expect(refused && refused.reason === 'bad-spec', 'an unparseable spec is REFUSED, not guessed', JSON.stringify(refused));
    const beforeRefusal = rollsOf(b.inbox).length;
    expect(beforeRefusal === 5, 'and no phantom roll was broadcast to anyone (5 real rolls so far)', String(beforeRefusal));

    a.ws.close(); b.ws.close(); gm.ws.close();
  } finally { await server.close(); }
});

test('0537 P3 — `/roll` from the chat input reaches the same one roller', async () => {
  const server = await createServer({ port: 0 });
  const url = server.url().replace('http', 'ws');
  try {
    const a = await openWs(url, { userId: 'a', role: 'participant', userName: 'Ana' });
    const b = await openWs(url, { userId: 'b', role: 'participant', userName: 'Bo' });
    await wait(250);

    a.ws.send(JSON.stringify({ t: 'chat', text: '/roll 3d6+1 12 Engineering under fire', id: 'c1' }));
    await wait(400);
    const r = rollsOf(b.inbox)[0];
    expect(!!r, 'the chat command produced a roll the OTHER participant saw');
    expect(r.spec === '3d6+1' && r.rolls.length === 3, 'spec parsed from the command line', JSON.stringify(r));
    expect(r.target === 12 && r.label === 'Engineering under fire', 'target and label parsed', JSON.stringify(r));
    expect(r.success === (r.total >= 12), 'still the server\'s comparison');

    // `= N` is the manual form, and it stays marked.
    a.ws.send(JSON.stringify({ t: 'chat', text: '/roll 2d6 8 = 9 by hand', id: 'c2' }));
    await wait(400);
    const m2 = rollsOf(b.inbox)[1];
    expect(m2 && m2.entry === 'manual' && m2.total === 9, '`= N` records a manual total', JSON.stringify(m2));
    expect(m2.label === 'by hand', 'and the trailing words are still the label', String(m2 && m2.label));

    // ⛔ A `/roll` must NOT also become a chat line: one event, one record. Two representations,
    // not two events — and never a prose copy that something could later parse.
    const chat = JSON.stringify(server.store.get('chat') || {});
    expect(chat.indexOf('/roll') === -1, 'the command did not also land in the room\'s chat', chat);

    a.ws.close(); b.ws.close();
  } finally { await server.close(); }
});
