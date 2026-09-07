/*
 * lib/occupant.mjs — A SCRIPTED (or, later, model-driven) OCCUPANT connects to a station over
 * the ORDINARY PARTICIPANT WIRE — the exact {t:'hello'}/{t:'op'} protocol any browser page uses
 * (app/wire-actions.mjs). No engine privilege, no second interface (0751 R-029/R-030): human and
 * AI share one door. DOMAIN-FREE (this repo is PUBLIC, R-180): `ns`, `station` and the script
 * table are all supplied by the CALLER — nothing plugin-specific lives here.
 *
 * Promoted from test/live/_0720-band-b-client.mjs's HeadlessClient shape — same frame handling,
 * because that shape already IS "a client that speaks the wire protocol and keeps the state cache
 * a mounted component would keep" (that file's own header). This module adds the one thing that
 * file deliberately does not have: a decision loop.
 *
 * R-257 (0751): "a station does not, and SHOULD NOT, know whether a human or an AI is seated at
 * it." This module builds NOTHING the server treats specially — it is a WebSocket client that
 * happens to answer on a timer instead of a keypress. Nothing here, and nothing on the server
 * side this run touches, branches on occupant kind.
 */
import { WebSocket } from 'ws';

function setPath(root, path, value) {
  const parts = String(path).split('/').filter(Boolean);
  let o = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}
function delPath(root, path) {
  const parts = String(path).split('/').filter(Boolean);
  let o = root;
  for (let i = 0; i < parts.length - 1; i++) { o = o && o[parts[i]]; if (o == null || typeof o !== 'object') return; }
  delete o[parts[parts.length - 1]];
}

export class Occupant {
  constructor(ws, hello) {
    this.ws = ws; this.hello = hello;
    this.userId = null; this.userName = null; this.role = null;
    this._state = {}; this._seq = 0; this._diffHandlers = [];
  }

  /** The client's own view of a path — the cache, NOT the server. Only ever used to BUILD a write. */
  state(path, dflt) {
    let o = this._state;
    for (const p of String(path).split('/').filter(Boolean)) {
      if (o == null || typeof o !== 'object') return dflt;
      o = o[p];
    }
    return o === undefined ? dflt : o;
  }

  /** Send one store op, exactly as `{t:'op'}` from a browser (app/wire-actions.mjs → handleOp). */
  op(path, verb, value) {
    this.ws.send(JSON.stringify({ t: 'op', path, verb, value, opId: (this.userId || 'occ') + ':' + (++this._seq) }));
  }

  /** fn(path, value, by) fires on every diff segment. Returns an unsubscribe function. */
  onDiff(fn) { this._diffHandlers.push(fn); return () => { const i = this._diffHandlers.indexOf(fn); if (i >= 0) this._diffHandlers.splice(i, 1); }; }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

/** Connect and resolve once the server has sent BOTH `welcome` and the initial `snapshot`/`resync`. */
export function connectOccupant(url, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(String(url).replace(/^http/, 'ws'));
    const occ = new Occupant(ws, hello);
    let gotWelcome = false, converged = false;
    const settle = () => { if (gotWelcome && converged) resolve(occ); };
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('message', (d, isBin) => {
      if (isBin) return;
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.t === 'welcome') { occ.userId = m.userId; occ.userName = m.userName; occ.role = m.role; gotWelcome = true; settle(); return; }
      if (m.t === 'snapshot') { occ._state = JSON.parse(JSON.stringify(m.state || {})); converged = true; settle(); return; }
      if (m.t === 'resync') { converged = true; settle(); return; }
      if (m.t === 'host' && m.msg && m.msg.type === 'diff' && m.msg.diff) {
        for (const p of Object.keys(m.msg.diff)) {
          const v = m.msg.diff[p];
          if (v === null) delPath(occ._state, p); else setPath(occ._state, p, JSON.parse(JSON.stringify(v)));
          for (const fn of occ._diffHandlers.slice()) { try { fn(p, v, m.msg.by); } catch { /* one handler's throw must not break another's turn */ } }
        }
      }
    });
  });
}

/**
 * runScript(occupant, {ns, station, script, intervalMs=100}) — component E15, DEMO level: the
 * generic deterministic decision loop. Polls `${ns}/askOpen`/`${ns}/phase`/`${ns}/round` every
 * `intervalMs` (100 ms — the cadence test/live/rig.mjs's own inline §C1 rule already used,
 * measured); when THIS station is the one asked, and it has not already answered THIS round, looks
 * up `script[`${phase}/${station}`]` and — after that row's own `delayMs` (default 300, matching
 * the measured ~410 ms end-to-end figure) — writes `${ns}/declare/${station}` with the row's
 * `text`/`fields`, `npc:true`, and this occupant's own identity. NEVER derives from a model — a
 * table lookup only (R-017/R-027: this is not a software adjudicator, it only ANSWERS an ask, the
 * way a human at that seat would). Returns `stop()`; calling it clears the poll timer ONLY — it
 * does not retract any declaration already written (an occupant stopped or disconnected leaves its
 * declaration standing, the same as a human player closing their laptop).
 */
export function runScript(occupant, { ns, station, script, intervalMs = 100 }) {
  // ⚠ FOUND WHILE ITERATING (E15d): a plain `null` sentinel here is a fencepost bug, not a style
  // choice — `${ns}/round` defaults to `null` (via `occupant.state(path, null)`) for any caller
  // that never writes a round at all (this run's own unit tests included), so `actedRound === round`
  // read `null === null` on the VERY FIRST tick and skipped forever, before `actedRound` was ever
  // assigned. It looked plausible and answered nothing. A Symbol can never equal a real round
  // value (null included), so the first tick always proceeds; the anti-double-answer check still
  // works normally on every tick after that, once `actedRound` holds a real round value.
  let actedRound = Symbol('unacted');
  const timer = setInterval(() => {
    const askOpen = occupant.state(`${ns}/askOpen`, null);
    if (askOpen !== station) return;
    if (occupant.state(`${ns}/declare/${station}`, null)) return;
    const round = occupant.state(`${ns}/round`, null);
    if (actedRound === round) return;
    const phase = occupant.state(`${ns}/phase`, null);
    const row = script[`${phase}/${station}`];
    if (!row) return;
    actedRound = round;
    setTimeout(() => {
      occupant.op(`${ns}/declare/${station}`, 'set', {
        text: row.text, fields: row.fields || {}, at: Date.now(),
        by: occupant.userId, byName: occupant.userName || occupant.userId, npc: true, round,
      });
    }, row.delayMs != null ? row.delayMs : 300);
  }, intervalMs);
  return () => clearInterval(timer);
}
