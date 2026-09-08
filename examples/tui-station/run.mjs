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
import { spawn } from 'node:child_process';
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
const { stationView, occupantView } = await import(join(PLUGIN, 'station-view.mjs'));
const { renderStationText } = await import(join(PLUGIN, 'render-station-text.mjs'));
const { renderRoundText } = await import(join(PLUGIN, 'render-round-text.mjs'));
const { dispatch } = await import(join(PLUGIN, 'text-dispatch.mjs'));
const { trafficFor, visibleTo } = await import(join(PLUGIN, 'tui-session.mjs'));
const { chooseAction, lineFor, askOccupant } = await import(join(PLUGIN, 'station-occupant.mjs'));
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
/* ⛔⛔ AUDIENCE IS ROUTED HERE, and it is the whole reason `trafficFor` puts a `to` on every entry.
   A room line goes to the shared log; a private one goes to that USER's own branch, which the engine
   read-scopes so it never leaves the server for anyone else. ⇒ a refusal reaches the seat that
   earned it and no one else — writing it to the shared log would publish every mistyped word to the
   whole crew, which is exactly what makes a console one nobody types honestly at.
   ⚠ `to` is a SEAT and the scoping is by USER, so a seat with no known user falls back to the room:
   ⛳ that is a demo simplification, and E16d's read-scoped prefix is where it is done properly. */
const users = new Map();          // seat → userId, learned from what people type
const append = (entry) => {
  const key = String(seq += 1).padStart(5, '0');
  const user = entry && entry.to ? users.get(entry.to) : null;
  if (entry && entry.to && user) server.set(`private/${user}/tui/log/${key}`, entry);
  /* ⛔⛔ AN UNADDRESSABLE PRIVATE LINE IS NOT A PUBLIC ONE. This fell through to the SHARED log when
     a seat had no connected user, which published exactly the entries `to` exists to keep private —
     and it fires for every occupant that is not a person, since a model or a script maps to no
     userId at all. ⚠ MEASURED the first time a model held the gunner seat: its receipt, naming the
     key written and the fields left unfilled, went to the whole crew. ⇒ park it on a branch keyed by
     SEAT, which no viewer's `private/{self}` scope can ever match, so the record survives for the
     seat's own pane to claim later without the room seeing it. A fallback that widens an audience is
     never the safe default. */
  else if (entry && entry.to) server.set(`private/seat:${entry.to}/tui/log/${key}`, entry);
  else server.set(`shared/tui/log/${key}`, entry);
};
const say = (text, to = null) => append({ v: 1, kind: 'render', seat: null, to, text, id: null });

/* ⛔ THE STORE OWNS THE STATE, AND THIS LOOP ONLY READS IT. `createStore`'s op hook belongs to the
   server, so a demo watches by polling — which is exactly what E16d plans for the same reason. */
const seen = new Set();
/* ⛔⛔ A SEAT BELONGS TO A PERSON, NOT TO THE PROCESS. `seat` was a single module-global, so `/seat
   engineer` re-seated EVERY player at once and `/next` drew one viewer's board to whoever asked —
   which makes "the stations talk to each other" untestable, because there was only ever one station
   occupied by everybody. The mount's `seat` opt is static and identical for all viewers, so it can
   only ever be the DEFAULT; the moment a player says `/seat`, their choice is theirs alone. */
const seatByUser = new Map();
const seatOf = (userId, sent) => (userId && seatByUser.has(userId)) ? seatByUser.get(userId)
  : String(sent || seat);
function pump() {
  const inbox = server.store.get('shared/tui/in') || {};
  for (const [id, v] of Object.entries(inbox)) {
    if (seen.has(id) || !v || typeof v !== 'object') continue;
    seen.add(id);
    const line = String(v.text || '');
    const who = seatOf(v.user, v.seat);
    if (v.user) users.set(who, v.user);

    /* ⭐ META IS THE CLIENT'S OWN QUESTION, answered here because this demo IS the client's console.
       `trafficFor` deliberately returns nothing for it — it is not the crew's traffic. */
    const r = dispatch({ line, seat: who, viewOf, seats: SEATS });
    if (r.intent && r.intent.round) { say(renderRoundText(round, SEATS, { me: who }), who); continue; }
    if (r.intent && r.intent.look) { say(renderStationText(viewOf(who)), who); continue; }
    if (r.intent && r.intent.seat) {
      /* ⛔ THEIRS ALONE. Also re-key `users`, or a private line for the seat they LEFT would still
         be routed to them while their new seat's refusals went to the room. */
      const from = who, to = r.intent.seat;
      if (v.user) { seatByUser.set(v.user, to); users.set(to, v.user); if (users.get(from) === v.user) users.delete(from); }
      else seat = to;                                   // an anonymous console keeps the old behaviour
      say(`seat: ${to}`, to); say(renderStationText(viewOf(to)), to); continue;
    }
    if (r.intent && r.intent.next) {
      const n = nextStop(ORDER, at, who);
      at = n.index; round.askOpen = n.askOpen;
      say(n.done ? '⛳ the round is out of stops.'
        : `── ${n.stop.id} · ${n.stop.anySeat ? 'any seat' : `asking ${n.stop.asks}`} ──`);
      /* ⛔ THE ASKER'S OWN BOARD, never the process's. */
      say(renderStationText(viewOf(who)), who);
      runNpcs();
      /* ⛔ NEVER BARE `void` ON AN ASYNC CALL: a rejection here is swallowed and the seat simply
         never answers, which reads exactly like a model still thinking. Silence must be reported. */
      runAiSeats().catch((e) => say(`  ⛔ the seat failed: ${e && e.message ? e.message : e}`));
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
/* ⭐⭐⭐ THE SCRIPTED SEATS — "some very simple stupid script that handles unoccupied stations".
   ⛔⛔ AND IT GOES THROUGH THE SAME DOOR A PERSON TYPES AT. `chooseAction` picks from what the seat
   is offering and `lineFor` turns that choice into the LINE a player would type; that line is then
   dispatched exactly as a typed one is. A script with its own route into the game would be a second
   interface, and this plugin has retired two already.
   ⛳ It is deliberately stupid: it takes the open stop and nothing else. `annotate` is never
   auto-taken, because a script has nothing to say and inventing speech for a crew member is the one
   thing an occupant must not do. */
const npc = new Set(String(flag('--npc', '') || '').split(',').map((x) => x.trim()).filter(Boolean));
for (const n of npc) {
  if (!SEATS.includes(n)) { console.error(`⛔ --npc names "${n}", which has no desk row.`); process.exit(2); }
}
function runNpcs() {
  for (const code of npc) {
    /* ⭐ `'*'` IS EVERY SEAT — the Actions Step asks the whole crew, so a scripted occupant is asked
       there too. A bare `!==` silently excluded them from the one step that includes everyone. */
    if (round.askOpen !== '*' && round.askOpen !== code) continue;
    const choice = chooseAction(occupantFor(code));
    const line = lineFor(choice);
    if (!line) { say(`  ${code} (npc): ${choice.why}`); continue; }
    const r = dispatch({ line, seat: code, viewOf, seats: SEATS });
    for (const e of trafficFor({ line, seat: code, result: r, id: `npc-${Date.now()}` })) append(e);
    for (const e of r.effects) {
      const seg = e.path.split('/');
      if (seg[2] === 'declare') round.declarations[seg[3]] = e.value;
    }
  }
}
/* ⭐⭐⭐ A REAL MODEL IN A SEAT — the goal's last clause, and the ONLY new thing here is `ask`.
   Everything else is the path a scripted seat already walks: a station-shaped view in, one line
   out, dispatched exactly as a typed one. ⛔⛔ IT IS HANDED `view.text` AND NOTHING ELSE — not the
   traffic log, not the other seats' boards, not the ship document. The slice IS the filter, and it
   is applied BEFORE the wire rather than trusted to a prompt that says "do not look".

   ⛔⛔ AND IT IS NOT A CLIENT WITH ROLE `ai`. `app/permissions.mjs` puts 'ai' in OVERRIDE_ROLES,
   which returns true from every write check and every read check — an occupant seated that way
   would read every other seat's private branch and write anything, while every `never[]` clause in
   the plugin still passed its own tests. An occupant is a PARTICIPANT. Here it does not connect at
   all: it is dispatched in-process, so it holds no credential to misuse. */
const aiSeats = new Set(String(flag('--ai', '') || '').split(',').map((x) => x.trim()).filter(Boolean));
for (const n of aiSeats) {
  if (!SEATS.includes(n)) { console.error(`⛔ --ai names "${n}", which has no desk row.`); process.exit(2); }
  if (npc.has(n)) { console.error(`⛔ "${n}" is named to both --npc and --ai; one seat, one occupant.`); process.exit(2); }
}
const AI_MODEL = String(flag('--ai-model', 'claude-haiku-4-5-20251001'));

/* ⛔ THE PROMPT CARRIES NO GAME RULES. Every verb, field and refusal the model may use is already
   printed on the board it is given; restating them here would create a second, drifting copy of the
   grammar — which is the failure this plugin has retired twice. */
function askModel(boardText) {
  return new Promise((resolve, reject) => {
    const prompt = `You are the crew member seated at this station aboard a starship.\n`
      + `This is your station board. It lists every action you may take and the words for them.\n\n`
      + `${boardText}\n\n`
      + `The "Actions" block is your menu: each row gives a code and the word you type to take it, `
      + `and any field it needs is named on the row. The round is asking YOU right now, so take one `
      + `of those actions.\n\n`
      + `Reply with EXACTLY ONE LINE: the line you would type at this station now, using only the `
      + `words shown above. No explanation, no quotes, no preamble.`;
    const child = spawn('claude', ['-p', '--model', AI_MODEL], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const kill = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timed out after 60s')); }, 60000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(kill); reject(e); });
    child.on('close', (code) => {
      clearTimeout(kill);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.trim().slice(0, 200)}`));
      resolve(out);
    });
    child.stdin.end(prompt);
  });
}

/* ⭐ THE TABLE IS NOT HELD. A model takes seconds; the round is appended to when it answers, and
   until then the log says the seat is thinking — which is what a human seat looks like too. */
async function runAiSeats() {
  for (const code of aiSeats) {
    if (round.askOpen !== '*' && round.askOpen !== code) continue;
    say(`  ${code} is thinking\u2026`);
    /* ⛔⛔ `occupantView`, NEVER THE RAW VIEW. `stationView()` returns structure and has NO `text`;
       `occupantView(view, render)` is what carries the rendered board. Passing the raw view here
       handed the first live model an empty string, which it answered with a question that was
       then broadcast to the crew as speech. The plugin now refuses this shape by name. */
    const r = await askOccupant({ view: occupantView(occupantFor(code), renderStationText),
      ask: askModel, seat: code, viewOf, seats: SEATS, dispatch });
    if (!r.line) { say(`  ${code}: ${r.why}`); continue; }
    for (const e of trafficFor({ line: r.line, seat: code, result: r.result, id: `ai-${Date.now()}` })) append(e);
    for (const e of (r.result.effects || [])) {
      const seg = e.path.split('/');
      if (seg[2] === 'declare') round.declarations[seg[3]] = e.value;
    }
  }
}

const occupantFor = (code) => stationView({
  stationCode: code, projection, desk: deskOf(code), round, stops: STOPS });

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
console.log(`  seat ${seat} · hull ${hull}${npc.size ? ` · npc ${[...npc].join(' ')}` : ''}${typeof crit === 'string' ? ` · damaged ${crit}` : ''}`);
console.log('  ⛔ local and throwaway. Ctrl-C to stop.\n');

process.on('SIGINT', () => { clearInterval(timer); server.close?.(); process.exit(0); });
void visibleTo;
