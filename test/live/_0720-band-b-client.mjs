/*
 * Plan 0720 BAND B — the headless client used by the plumbing proofs (B3, B6, B8).
 *
 * ⛔ BAND B IS "NO PIXELS, NO COMPONENTS". So this is the whole client: a WebSocket that speaks
 * the op protocol and keeps the same state cache a mounted component would keep. It exists so a
 * claim about the SHARED STORE can be made without a browser in the loop — and so the store's
 * word, not a local variable, is what every assertion reads.
 *
 * What a real client actually receives, in order, on connecting (app/wire-actions.mjs `hello`):
 *   1. { t:'welcome',  userId, userName, socketId, role, … }
 *   2. { t:'snapshot', state, version }            ← the whole visible tree, ONE frame, role-filtered
 *      (or { t:'resync', from, to, count } + N diff frames, when the op-log can still replay)
 *   3. { t:'ping', ts }
 * and thereafter, per store write anyone makes:
 *      { t:'host', msg:{ source:'argus-host', type:'diff', diff:{ '<path>': <value> }, by, version } }
 *
 * `_state` here folds those exactly as lib/bridge.js does in a component: a diff key is a FULL
 * slash-path and a value of null means the path was removed.
 *
 * ⛔ DOMAIN-FREE. This repo is public (PSS t0531-01) — no campaign vocabulary in any fixture.
 */
import { WebSocket } from 'ws';

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a predicate until true, or throw. Used instead of a fixed sleep so a slow box does not flake. */
export async function poll(pred, label, { timeout = 5000 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { last = await pred(); } catch (e) { last = false; }
    if (last) return true;
    await wait(10);
  }
  throw new Error('timeout waiting for ' + label);
}

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

export class HeadlessClient {
  constructor(ws, hello) {
    this.ws = ws;
    this.hello = hello;
    this.userId = hello.userId;
    this.frames = [];          // every non-binary frame, in arrival order
    this.diffFrames = [];      // just the t:'host' type:'diff' ones
    this.diffPaths = [];       // flattened {path, value, by, version}
    this.snapshots = [];       // {state, version}
    this._state = {};          // the cache a component would hold
    this._seq = 0;
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
    this.ws.send(JSON.stringify({ t: 'op', path, verb, value, opId: this.userId + ':' + (++this._seq) }));
  }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

/** Connect and resolve once the server has sent BOTH `welcome` and the initial `snapshot`/`resync`. */
export function connect(url, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(String(url).replace(/^http/, 'ws'));
    const c = new HeadlessClient(ws, hello);
    let gotWelcome = false, converged = false;
    const settle = () => { if (gotWelcome && converged) resolve(c); };
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))));
    ws.on('message', (d, isBin) => {
      if (isBin) return;
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      c.frames.push(m);
      if (m.t === 'welcome') { gotWelcome = true; settle(); return; }
      if (m.t === 'snapshot') {
        c.snapshots.push({ state: m.state, version: m.version });
        c._state = JSON.parse(JSON.stringify(m.state || {}));
        converged = true; settle(); return;
      }
      if (m.t === 'resync') { converged = true; settle(); return; }
      if (m.t === 'host' && m.msg && m.msg.type === 'diff' && m.msg.diff) {
        c.diffFrames.push(m.msg);
        for (const p of Object.keys(m.msg.diff)) {
          const v = m.msg.diff[p];
          c.diffPaths.push({ path: p, value: v, by: m.msg.by, version: m.msg.version });
          if (v === null) delPath(c._state, p); else setPath(c._state, p, JSON.parse(JSON.stringify(v)));
        }
      }
    });
  });
}
