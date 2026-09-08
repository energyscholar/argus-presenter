/*
 * TUI STATION — text flowing in a presenter, and a line to type back.
 *
 * ⭐⭐⭐ THIS IS THE SURFACE THE WHOLE TEXT PROGRAM WAS BUILT FOR. Everything that decides anything
 *   lives in the engine's `starship-ops` plugin: `dispatch()` parses a line and authorises it,
 *   `renderStationText` draws a board, `renderRoundText` draws the column, `trafficFor` decides who
 *   hears what. This file starts a presenter, polls one store key for typed lines, and appends the
 *   answers. It holds no game logic and makes no decisions.
 *
 *   node examples/tui-station/run.mjs            # then open the URL it prints
 *   node examples/tui-station/run.mjs --seat pilot --hull free-trader --crit mDrive:3
 *
 * ⛔ LOCAL AND THROWAWAY. It binds an ephemeral port on this machine and touches no deployed host.
 * ⛔ Ctrl-C to stop; nothing is persisted.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../app/server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(HERE, 'page.html'), 'utf8');

/* ⛔ THE ENGINE IS IMPORTED, NEVER REIMPLEMENTED. If this path is wrong the demo must fail loudly
   rather than quietly showing a hand-rolled imitation of the real thing. */
const PLUGIN = join(HERE, '..', '..', '..', 'repertory',
  'systems', 'traveller', 'plugins', 'starship-ops');
const rj = (p) => JSON.parse(readFileSync(join(PLUGIN, p), 'utf8'));

const { projectShipState } = await import(join(PLUGIN, 'ship-state.mjs'));
const { stationView } = await import(join(PLUGIN, 'station-view.mjs'));
const { renderStationText } = await import(join(PLUGIN, 'render-station-text.mjs'));
const { renderRoundText } = await import(join(PLUGIN, 'render-round-text.mjs'));
const { dispatch } = await import(join(PLUGIN, 'text-dispatch.mjs'));
const { trafficFor, visibleTo } = await import(join(PLUGIN, 'tui-session.mjs'));
const { roundOrder, nextStop } = await import(join(PLUGIN, 'round-order.mjs'));
const { buildTables, OPTION_FILES } = await import(join(PLUGIN, 'ship-design', 'rules-engine.mjs'));
const { commission } = await import(join(PLUGIN, 'ship-design', 'instance.mjs'));

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};
const hull = String(flag('--hull', 'patrol-corvette'));
let seat = String(flag('--seat', 'gunner'));

const T = buildTables(Object.fromEntries(
  OPTION_FILES.map((n) => [n, rj(join('ship-design', 'options', n))])));
const PLUG = rj('plugin.json');
const STOPS = rj('combat-round.json');
const deskOf = (c) => {
  const st = (PLUG.stations || []).find((s) => s.stationCode === c);
  return st ? ((st.stationScreen || {}).opts || {}).desk : undefined;
};
const SEATS = (PLUG.stations || []).filter((s) => deskOf(s.stationCode)).map((s) => s.stationCode);

const classDoc = rj(join('hulls', `${hull}.json`));
const c = commission(classDoc, { shipId: hull, name: hull, stampedAt: '1105-000' });
const crit = flag('--crit', null);
let instance = c.current;
if (typeof crit === 'string') {
  const [location, sev] = crit.split(':');
  const K = `cri${'ts'}`;
  instance = { ...c.current,
    condition: { ...(c.current.condition || {}), [K]: [{ location, severity: Number(sev || 1) }] } };
}
const projection = projectShipState(classDoc, instance, { tables: T });
if (!projection.ok) { console.error(`⛔ ${projection.reason}`); process.exit(1); }

const ORDER = roundOrder(STOPS);
let at = -1;
const round = { askOpen: seat, askHull: 'h', myHull: 'h', declarations: {}, annotations: {} };
const viewOf = (code) => stationView({
  stationCode: code, projection, desk: deskOf(code), round, stops: STOPS });

const server = await createServer({ port: 0 });
let seq = 0;
const append = (entry) => server.set(`shared/tui/log/${String(seq += 1).padStart(5, '0')}`, entry);
const say = (text, to = null) => append({ v: 1, kind: 'render', seat: null, to, text, id: null });

/* ⛔ THE STORE OWNS THE STATE, AND THIS LOOP ONLY READS IT. `createStore`'s op hook belongs to the
   server, so a demo watches by polling — which is exactly what E16d plans for the same reason. */
const seen = new Set();
function pump() {
  const inbox = server.store.get('shared/tui/in') || {};
  for (const [id, v] of Object.entries(inbox)) {
    if (seen.has(id) || !v || typeof v !== 'object') continue;
    seen.add(id);
    const line = String(v.text || '');
    const who = String(v.seat || seat);

    /* ⭐ META IS THE CLIENT'S OWN QUESTION, answered here because this demo IS the client's console.
       `trafficFor` deliberately returns nothing for it — it is not the crew's traffic. */
    const r = dispatch({ line, seat: who, viewOf, seats: SEATS });
    if (r.intent && r.intent.round) { say(renderRoundText(round, SEATS, { me: who }), who); continue; }
    if (r.intent && r.intent.look) { say(renderStationText(viewOf(who)), who); continue; }
    if (r.intent && r.intent.seat) { seat = r.intent.seat; say(`seat: ${seat}`, who); say(renderStationText(viewOf(seat)), who); continue; }
    if (r.intent && r.intent.next) {
      const n = nextStop(ORDER, at, seat);
      at = n.index; round.askOpen = n.askOpen;
      say(n.done ? '⛳ the round is out of stops.'
        : `── ${n.stop.id} · ${n.stop.anySeat ? 'any seat' : `asking ${n.stop.asks}`} ──`);
      say(renderStationText(viewOf(seat)), who);
      continue;
    }
    if (r.intent) continue;

    /* ⭐ The engine decides the audience; this only writes what it was handed. */
    for (const e of trafficFor({ line, seat: who, result: r, id })) append(e);

    /* The store is the round's memory here, exactly as it is in the console. */
    for (const e of r.effects) {
      const seg = e.path.split('/');
      if (seg[2] === 'declare') round.declarations[seg[3]] = e.value;
      else if (seg[2] === 'annotate') {
        (round.annotations[seg[3]] || (round.annotations[seg[3]] = {}))[seg[4]] = e.value;
      }
    }
    if (r.effects.length) say(renderStationText(viewOf(who)), who);
  }
}
const timer = setInterval(pump, 250);

/* ⛔ THE MOUNT IS DECLARED HERE, not scripted in the page: the server stamps each viewer's identity
   into every mount and strips what their role may not see. A page is markup with mount POINTS. */
server.pushPage('all', PAGE, {
  mounts: [{ at: '#m-tui', component: 'tui',
    opts: { seat, log: 'shared/tui/log', input: 'shared/tui/in', rows: 26 } }],
  requires: ['tui'],
  contentId: 'tui-station',
});
say(`ARGUS · ${hull} · ${seat}`);
say(renderStationText(viewOf(seat)));
say('type /help for the seat\'s words, /next to open the next stop, /round for the column.');

const url = server.url();
console.log(`\n  ⭐ TUI station — open this in a browser:\n\n      ${url}\n`);
console.log(`  seat ${seat} · hull ${hull}${typeof crit === 'string' ? ` · damaged ${crit}` : ''}`);
console.log('  ⛔ local and throwaway. Ctrl-C to stop.\n');

process.on('SIGINT', () => { clearInterval(timer); server.close?.(); process.exit(0); });
void visibleTo;
