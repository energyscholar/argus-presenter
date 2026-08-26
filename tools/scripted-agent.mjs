/*
 * Plan 0687 R5 — A SCRIPTED AGENT CLIENT.
 *
 * ⛔ Gate B names this and nothing built it. It is a deliverable.
 *
 * This is a headless PVS consumer on a real websocket: it subscribes, collects the turns it is
 * handed, and — ONLY when told to — acks them. The ack policy is the whole point, because the
 * defect this phase exists to fix is the ack that happened by itself:
 *
 *     ack: 'explicit'   (default) ack after taking the turns in — the correct agent
 *     ack: 'never'      read and never confirm — the truncated transfer, on purpose
 *     ack: 'onFrame'    ack the instant bytes arrive — the WRONG agent, kept so a rehearsal can
 *                       demonstrate at-most-once rather than argue about it
 *
 * ⭐ `truncateAfter: N` hangs the socket up mid-conversation, after N turn frames, WITHOUT acking.
 * That is the live 2026-08-25 failure reproduced deliberately: the transport got bytes, the agent
 * never read them. Re-run the client afterwards and the turns must come back.
 *
 * Usage, in-process:
 *     import { runScriptedAgent } from '../tools/scripted-agent.mjs';
 *     const r = await runScriptedAgent({ url, consumer: 'rehearsal', listenMs: 800, ack: 'never' });
 *
 * Usage, from a shell:
 *     node tools/scripted-agent.mjs http://127.0.0.1:3000 --consumer rehearsal --listen 3000
 *     node tools/scripted-agent.mjs http://127.0.0.1:3000 --ack never --truncate-after 1
 */
import { WebSocket } from 'ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const ACK_POLICIES = ['explicit', 'never', 'onFrame'];

/**
 * @param {object} opts
 * @param {string} opts.url            http(s) base url of the room
 * @param {string} [opts.consumer]     cursor id to subscribe under
 * @param {number} [opts.listenMs]     how long to listen before finishing
 * @param {string} [opts.ack]          one of ACK_POLICIES
 * @param {number|null} [opts.truncateAfter]  hang up after this many turn frames, without acking
 * @returns {Promise<{ok:boolean, consumer:string|null, resumeCursor:number|null, sentCursor:number|null,
 *                    turns:object[], acked:number|null, truncated:boolean, frames:object[]}>}
 */
export async function runScriptedAgent({ url, consumer = 'scripted-agent', listenMs = 500, ack = 'explicit', truncateAfter = null } = {}) {
  if (!url) throw new Error('runScriptedAgent: url is required');
  if (!ACK_POLICIES.includes(ack)) throw new Error(`runScriptedAgent: unknown ack policy "${ack}" — one of ${ACK_POLICIES.join(', ')}`);
  const ws = new WebSocket(url.replace(/^http/, 'ws'));
  const frames = [];
  const turns = [];
  let truncated = false;

  ws.on('message', (buf) => {
    let f; try { f = JSON.parse(buf.toString()); } catch (e) { return; }
    frames.push(f);
    if (f.t !== 'turn') return;
    turns.push(f);
    // ⛔ THE WRONG AGENT, on purpose: confirming on frame receipt. The socket got bytes; nothing
    // has read them. Kept here so a rehearsal can SHOW the at-most-once failure.
    if (ack === 'onFrame') ws.send(JSON.stringify({ t: 'pvs_ack', seq: f.seq }));
    if (truncateAfter != null && turns.length >= truncateAfter && !truncated) {
      truncated = true;                       // the transfer that got cut off — no ack, socket gone
      try { ws.close(); } catch (e) { /* the point is that it stopped */ }
    }
  });

  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ t: 'pvs_subscribe', consumer }));
  await sleep(listenMs);

  let acked = null;
  if (ack === 'explicit' && !truncated && turns.length) {
    // The correct order: the turns have been taken in, THEN they are confirmed.
    const highest = turns.reduce((m, t) => (typeof t.seq === 'number' && t.seq > m ? t.seq : m), 0);
    ws.send(JSON.stringify({ t: 'pvs_ack', seq: highest }));
    await sleep(120);
    const receipt = [...frames].reverse().find((f) => f.t === 'pvs_acked');
    acked = receipt && receipt.ok ? receipt.acked : null;
  }

  const sub = frames.find((f) => f.t === 'pvs_subscribed');
  try { ws.close(); } catch (e) { /* already gone in the truncate case */ }
  return {
    ok: true,
    consumer: (sub && sub.consumer) || null,
    resumeCursor: sub ? sub.resumeCursor : null,     // the ACKED position it resumed from
    sentCursor: sub ? sub.sentCursor : null,         // what had merely been handed over before
    turns: turns.map((t) => ({ seq: t.seq, text: t.text, trust: t.trust, mode: t.mode })),
    acked, truncated, frames,
  };
}

// ---- CLI -----------------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const url = argv[0];
  if (!url || url.startsWith('-')) {
    console.error('usage: node tools/scripted-agent.mjs <url> [--consumer ID] [--listen MS] [--ack explicit|never|onFrame] [--truncate-after N]');
    process.exit(2);
  }
  const flag = (n) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : null; };
  const r = await runScriptedAgent({
    url,
    consumer: flag('consumer') || 'scripted-agent',
    listenMs: parseInt(flag('listen') || '500', 10),
    ack: flag('ack') || 'explicit',
    truncateAfter: flag('truncate-after') ? parseInt(flag('truncate-after'), 10) : null,
  });
  console.log(JSON.stringify({ consumer: r.consumer, resumeCursor: r.resumeCursor, sentCursor: r.sentCursor, acked: r.acked, truncated: r.truncated, turns: r.turns }, null, 2));
}
