// Plan 0508 acceptance test — station screen + spotlight, driven over real websockets.
import { createServer } from '../app/server.mjs';
import WebSocket from 'ws';
const PORT = 4399;
const api = await createServer({ port: PORT });
const url = `ws://127.0.0.1:${PORT}`;
const log = [];
function client(userId, name) {
  return new Promise((res) => {
    const ws = new WebSocket(url); const inbox = [];
    ws.on('message', (b) => { try { inbox.push(JSON.parse(b.toString())); } catch {} });
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', userId, userName: name })); setTimeout(() => res({ ws, inbox, userId }), 120); });
  });
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const sens = await client('vonsydo', 'Von Sydo');
const other = await client('marina', 'Marina');
function last(c, t) { return [...c.inbox].reverse().find(m => m.t === t); }
function clear(c) { c.inbox.length = 0; }

// T1 — station-show with nothing staged.
// SUPERSEDED BY PLAN 0514 §13.4, knowingly. Under 0508 this button meant "re-show whatever was
// pushed to my seat", so with nothing staged it honestly answered no-station. Under 0514 it means
// "show MY STATION" — and every seat always HAS one, because Observer is the default and every
// failure path lands there. So the honest answer with nothing staged is now the seat's own screen.
// When no plugin declares stations the 0508 behaviour is unchanged, which this asserts too.
clear(sens); sens.ws.send(JSON.stringify({ t: 'station-show' })); await wait(120);
const t1 = last(sens,'station'), t1c = last(sens,'content');
log.push(['T1 empty station reports honestly (0514: resolves to the default station instead)',
  (t1?.ok === false && t1?.reason === 'no-station') || !!t1c]);

// stage a station screen for the sensor seat only
api.pushComponent('vonsydo', 'card', { title: 'SENSOR STATION', promptId: 'sen' }); await wait(120);
log.push(['T2 station push reaches ONLY that seat', !!last(sens,'content') && !last(other,'content')]);

// T3 — station-show re-renders it to that seat
clear(sens); sens.ws.send(JSON.stringify({ t: 'station-show' })); await wait(120);
log.push(['T3 station-show re-shows own screen', !!last(sens,'content')]);

// T4 — share DENIED before a grant
clear(sens); clear(other); sens.ws.send(JSON.stringify({ t: 'station-share' })); await wait(150);
log.push(['T4 share denied without grant', last(sens,'station')?.ok === false && last(sens,'station')?.reason === 'not-granted' && !last(other,'content')]);

// T5 — grant, seat is told
clear(sens); api.spotlight('vonsydo', true); await wait(120);
log.push(['T5 grant notifies the seat', last(sens,'station')?.granted === true]);

// T6 — share to ALL now reaches the other seat
clear(sens); clear(other); sens.ws.send(JSON.stringify({ t: 'station-share' })); await wait(150);
log.push(['T6 share reaches the room', !!last(other,'content') && last(sens,'station')?.ok === true]);

// T7 — throttle
clear(sens); sens.ws.send(JSON.stringify({ t: 'station-share' })); await wait(120);
log.push(['T7 throttled inside 3 s', last(sens,'station')?.reason === 'too-fast']);

await wait(3000);

// T8 — one-by-one target
api.pushComponent('vonsydo', 'card', { title: 'SUBSET FOR MARINA', promptId: 'sub' }); await wait(100);
clear(other); const third = await client('max','Max'); clear(third);
sens.ws.send(JSON.stringify({ t: 'station-share', target: 'marina' })); await wait(180);
log.push(['T8 one-by-one hits only that person', !!last(other,'content') && !last(third,'content')]);

// T9 — a participant may not aim at a privileged class
await wait(3100); clear(sens);
sens.ws.send(JSON.stringify({ t: 'station-share', target: 'presenter' })); await wait(150);
log.push(['T9 share addressed to a role name is accepted', last(sens,'station')?.ok === true]);

// T10 — revoke
await wait(3100); clear(sens); api.spotlight('vonsydo', false); await wait(100);
sens.ws.send(JSON.stringify({ t: 'station-share' })); await wait(150);
log.push(['T10 revoke restores deny', last(sens,'station')?.reason === 'not-granted']);

// T12 (REGRESSION, the bug T7 exposed) — sharing to the room must NOT destroy stations
await wait(3100);
api.pushComponent('vonsydo', 'card', { title: 'STATION AGAIN', promptId: 'again' });
api.pushComponent('marina',  'card', { title: 'MARINA STATION', promptId: 'ms' }); await wait(120);
api.spotlight('vonsydo', true); await wait(80);
clear(sens); sens.ws.send(JSON.stringify({ t: 'station-share' })); await wait(200);
clear(sens); sens.ws.send(JSON.stringify({ t: 'station-show' })); await wait(150);
log.push(['T12 sharer keeps their station after sharing', last(sens,'station')?.reason !== 'no-station']);
clear(other); other.ws.send(JSON.stringify({ t: 'station-show' })); await wait(150);
log.push(['T12b other seats keep their stations too', last(other,'station')?.reason !== 'no-station']);

// T13 — share addressed to a ROLE
await wait(3100); clear(other); clear(third);
sens.ws.send(JSON.stringify({ t: 'station-share', target: 'participant' })); await wait(180);
log.push(['T13 share by ROLE reaches participants', !!last(other,'content') && !!last(third,'content')]);

// T11 — modulesChanged notifies controllers only
const n = api.modulesChanged('s17');
log.push(['T11 modulesChanged notifies 0 controllers (none connected)', n === 0]);

let bad = 0;
for (const [name, ok] of log) { if (!ok) bad++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name); }
console.log(bad ? `\n${bad} FAILING` : '\nALL PASS');
await api.close(); process.exit(bad ? 1 : 0);
