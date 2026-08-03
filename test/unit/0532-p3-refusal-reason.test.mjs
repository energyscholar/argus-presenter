/*
 * Plan 0532 P3 — THE CATALOGUE'S TWO REFUSALS ARE DIFFERENT REFUSALS, AND SAY SO.
 *
 * 0529 P2 made the content catalogue fail closed, which is right and is not touched here. The cost
 * nobody priced: an operator who starts the server with no credential gets no list and no reason —
 * a blank control with nothing on it to act on. This phase makes the refusal legible.
 *
 * WHAT IS ASSERTED, AND WHY EACH ASSERTION EXISTS.
 *
 *  1. THE UNCONFIGURED REFUSAL NAMES THE FIX. Not "forbidden": the body says a credential is
 *     required, that this server has none, and which knob to turn. A 403 with no body is the thing
 *     the operator could not act on.
 *
 *  2. THE TWO CASES CARRY DIFFERENT MACHINE-READABLE CODES. The control page has to branch, and
 *     branching on prose is how a message becomes load-bearing by accident.
 *
 *  3. ⛓ THE CONFIGURED REFUSAL IS BYTE-IDENTICAL whether the caller sent NOTHING or sent a WRONG
 *     credential, and it never names the configuration. This is the assertion that stops the new
 *     legibility from becoming a probe: if a stranger could tell "this box uses a rolePassword"
 *     from "this box uses a controlToken" — or tell a gated box from an ungated one by the shape of
 *     the refusal alone — the message would be leaking the very thing the gate exists to protect.
 *     ⚠ On an UNGATED server the long message IS returned to an anonymous caller (0529 P2's own
 *     t0529-p2-02 pins that). It is safe THERE and only there: a server with no credential has no
 *     secret about its credential, and there is no request that would have succeeded.
 *
 *  4. ⛔ FAIL-CLOSED IS UNCHANGED. Every route still refuses, and the refusal still carries none of
 *     the content — checked against a beat body that must never appear in a refusal.
 *
 * NAMES: invented and obviously fictional throughout (plan 0529 §0 / guard t0531-01).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const MOD = 'legible-alpha', SERIES = 'legible-run';
const TOKEN = 'legible-gate-token';
const UNREVEALED = 'the corridor was already open';

const deck = (title, ids) => ({
  manifest: { title },
  beats: ids.map((i) => ({ id: i, component: 'card', opts: { title: 'Beat ' + i, body: UNREVEALED } })),
});

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0532-p3-'));
  writeFileSync(join(dir, MOD + '.json'), JSON.stringify(deck('Alpha Chapter', ['a1', 'a2'])));
  writeFileSync(join(dir, SERIES + '.series.json'), JSON.stringify({
    manifest: { title: 'A One-Part Run' }, moduleIds: [MOD],
  }));
  return dir;
}
async function boot(dir, opts) {
  const prev = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_MODULES_DIR = dir;
  try { return await createServer(Object.assign({ port: 0 }, opts || {})); }
  finally { if (prev === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prev; }
}
async function get(url, headers) {
  const r = await fetch(url, headers ? { headers } : undefined);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, text, json };
}

const ROUTES = ['/api/modules', '/api/modules/' + MOD, '/api/series', '/api/series/' + SERIES];

test('t0532-p3-01 — an UNCONFIGURED server refuses with a reason code AND a message naming what to configure', async () => {
  const dir = fixtureDir();
  const server = await boot(dir, {});
  try {
    for (const route of ROUTES) {
      const r = await get(server.url() + route);
      expect(`${route} still fails closed`, r.status === 403, `${r.status} ${r.text.slice(0, 120)}`);
      expect(`${route} carries the machine-readable reason`,
        r.json && r.json.reason === 'server-has-no-credential', JSON.stringify(r.json));
      // The message must be actionable, not merely present: it names a specific knob.
      expect(`${route} names what to configure`,
        r.json && /rolePassword/.test(String(r.json.error)) && /controlToken/.test(String(r.json.error)),
        JSON.stringify(r.json && r.json.error));
      expect(`${route} still leaks no content`, !r.text.includes(UNREVEALED), r.text.slice(0, 200));
    }
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('t0532-p3-02 — a CONFIGURED server refuses identically for "sent none" and "sent wrong", and never names its configuration', async () => {
  const dir = fixtureDir();
  const byToken = await boot(dir, { controlToken: TOKEN });
  try {
    for (const route of ROUTES) {
      const none = await get(byToken.url() + route);
      const wrong = await get(byToken.url() + route, { 'x-control-token': 'not-the-token' });
      expect(`${route}: both are 403`, none.status === 403 && wrong.status === 403,
        `${none.status}/${wrong.status}`);
      // ⛓ Byte-identical. A caller must not be able to learn anything by varying what it sends.
      expect(`${route}: "sent none" and "sent wrong" are BYTE-IDENTICAL`, none.text === wrong.text,
        `${none.text} !== ${wrong.text}`);
      expect(`${route}: the reason is the CALLER-fault code`,
        none.json && none.json.reason === 'credential-not-accepted', JSON.stringify(none.json));
      // It must not describe the server. Naming the scheme in force would turn the refusal into
      // a configuration probe for anyone who can reach the box.
      expect(`${route}: the refusal does not name the configuration`,
        !/rolePassword|controlToken|none configured/i.test(none.text), none.text.slice(0, 200));
      expect(`${route}: still no content`, !none.text.includes(UNREVEALED), none.text.slice(0, 200));
    }
  } finally { await byToken.close(); }

  // The OTHER carrier, to prove point 3 across schemes: a rolePassword deployment's refusal must be
  // byte-identical to a controlToken deployment's, or the shape itself is a disclosure.
  const bySeed = await boot(dir, { roleSeed: 'salted', rolePassword: 'open-sesame' });
  const byToken2 = await boot(dir, { controlToken: TOKEN });
  try {
    const a = await get(bySeed.url() + '/api/modules');
    const b = await get(byToken2.url() + '/api/modules');
    expect('a rolePassword box and a controlToken box refuse with the SAME bytes', a.text === b.text,
      `${a.text} !== ${b.text}`);
  } finally { await bySeed.close(); await byToken2.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('t0532-p3-03 — a CREDENTIALED read is unaffected: same 200, same content, and no reason field', async () => {
  // The control. Everything above is about refusals; this is the assertion that stops the phase
  // having quietly broken the path that works.
  const dir = fixtureDir();
  const server = await boot(dir, { controlToken: TOKEN });
  try {
    const one = await get(server.url() + '/api/modules/' + MOD, { 'x-control-token': TOKEN });
    expect('the credentialed read is still 200', one.status === 200, `${one.status} ${one.text.slice(0, 120)}`);
    expect('and still carries the beat body', one.json && one.json.module
      && one.json.module.beats[0].opts.body === UNREVEALED, JSON.stringify(one.json && one.json.id));
    expect('and carries no refusal reason', !one.text.includes('"reason"'), one.text.slice(0, 200));

    const list = await get(server.url() + '/api/modules', { 'x-control-token': TOKEN });
    expect('the credentialed list is still a list', Array.isArray(list.json) && list.json.some((m) => m.id === MOD),
      JSON.stringify(list.json));
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
