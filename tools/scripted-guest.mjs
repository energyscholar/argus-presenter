/*
 * Plan 0687 R5 — A SCRIPTED GUEST.
 *
 * ⛔ Gate B names a scripted guest and a scripted agent client, and NOTHING BUILT THEM. They are a
 * deliverable, not an assumption: without them the gate cannot be executed at all.
 *
 * This is a headless participant on a real websocket. It says what a script tells it to say, at the
 * pace the script sets, and reports what it saw. It is deliberately NOT a test helper hiding in
 * test/: a rehearsal you can only run from the suite is a rehearsal nobody runs before a session.
 *
 * ⭐ It is a GUEST, not an operator: it connects the way an unverified person does (optionally with
 * a signed ?cap= token), and it never asserts a role. Whatever authority it ends up with is the
 * server's verdict, and the report says which one it got — so "the guest could do X" is an
 * observation from the wire, not a claim from the script.
 *
 * Usage, in-process:
 *     import { runScriptedGuest } from '../tools/scripted-guest.mjs';
 *     const r = await runScriptedGuest({ url, name: 'Guest A', script: [{ say: 'hello' }] });
 *
 * Usage, from a shell:
 *     node tools/scripted-guest.mjs http://127.0.0.1:3000 --name "Guest A" --say "hello" --say "again"
 *     node tools/scripted-guest.mjs http://127.0.0.1:3000 --script ./a-script.json
 *
 * Script steps (each an object, run in order):
 *     { say: "text" }        type a line into the room; it lands in the unified inbox
 *     { wait: 250 }          pause, in ms
 *     { roll: "2d6" }        roll through the room's own roller
 *     { close: true }        hang up early
 */
import { WebSocket } from 'ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} opts
 * @param {string} opts.url          http(s) base url of the room
 * @param {string} [opts.name]       display name to ask for (the server may override it)
 * @param {string} [opts.userId]     user id to ask for (the server may derive its own)
 * @param {string} [opts.cap]        a signed guest capability token, if the room issued one
 * @param {Array}  [opts.script]     steps, as above
 * @param {number} [opts.settleMs]   how long to keep listening after the last step
 * @returns {Promise<{ok:boolean, role:string|null, said:string[], frames:object[], refusals:object[]}>}
 */
export async function runScriptedGuest({ url, name = 'Scripted Guest', userId = null, cap = null, script = [], settleMs = 250 } = {}) {
  if (!url) throw new Error('runScriptedGuest: url is required');
  const wsUrl = url.replace(/^http/, 'ws') + (cap ? ('/?cap=' + encodeURIComponent(cap)) : '');
  const ws = new WebSocket(wsUrl);
  const frames = [];
  const said = [];
  ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) { frames.push({ t: '<unparseable>', bytes: buf.length }); } });

  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ t: 'hello', userId: userId || ('guest-' + Math.random().toString(36).slice(2, 8)), userName: name, ...(cap ? { cap } : {}) }));
  await sleep(80);

  for (const step of script) {
    if (step == null) continue;
    if (typeof step.wait === 'number') { await sleep(step.wait); continue; }
    if (typeof step.say === 'string') { ws.send(JSON.stringify({ t: 'chat', text: step.say })); said.push(step.say); await sleep(40); continue; }
    if (typeof step.roll === 'string') { ws.send(JSON.stringify({ t: 'roll', expr: step.roll })); await sleep(40); continue; }
    if (step.close) break;
  }
  await sleep(settleMs);

  // The role the SERVER decided on, read off the welcome frame — never what the script asked for.
  const welcome = frames.find((f) => f.t === 'welcome' || f.t === 'hello_ok' || f.role);
  const report = {
    ok: true,
    role: (welcome && welcome.role) || null,
    said,
    frames,
    // Anything the server refused, kept as evidence: a guest that was silently ignored and a guest
    // that was told no look identical from the outside unless the refusals are collected.
    refusals: frames.filter((f) => f && (f.ok === false || f.t === 'denied' || f.t === 'error')),
  };
  try { ws.close(); } catch (e) { /* hanging up is not a result */ }
  return report;
}

// ---- CLI -----------------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const url = argv[0];
  if (!url || url.startsWith('-')) {
    console.error('usage: node tools/scripted-guest.mjs <url> [--name N] [--cap TOKEN] [--say TEXT ...] [--script file.json]');
    process.exit(2);
  }
  const flag = (n) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : null; };
  const says = argv.reduce((acc, a, i) => (a === '--say' ? [...acc, { say: argv[i + 1] }] : acc), []);
  let script = says;
  const file = flag('script');
  if (file) script = JSON.parse((await import('fs')).readFileSync(file, 'utf8'));
  const r = await runScriptedGuest({ url, name: flag('name') || 'Scripted Guest', cap: flag('cap'), script });
  console.log(JSON.stringify({ role: r.role, said: r.said, refusals: r.refusals, frameKinds: r.frames.map((f) => f.t) }, null, 2));
}
