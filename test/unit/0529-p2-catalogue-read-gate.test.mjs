/*
 * Plan 0529 P2 — THE CONTENT CATALOGUE IS CONTROL-ONLY, AND FAILS CLOSED (SECURITY-CRITICAL).
 *
 * THE SHAPE OF THE BUG. Every per-beat visibility rule this system has runs on the SOCKET path:
 * a participant is sent a beat when it is presented, and only the slice their role may see. None
 * of that machinery is anywhere near `GET /api/modules/<id>`. That route opens the authored file
 * and returns it whole — every beat, including the ones nobody has been shown yet and the ones
 * addressed to a single seat. On a deployment reachable from the internet (which is the ordinary
 * state of this one — the launcher raises a public ingress) anybody holding the url could read
 * the ending before the room did, and `GET /api/modules` handed them the list of ids to try.
 *
 * WHAT THIS PHASE CHANGES. The four catalogue READS now require the SAME control credential the
 * write already required — no new scheme, no second store: `x-control-token` or `?token=`,
 * matched against CONTROL_TOKEN or the roleSeed+rolePassword hash.
 *
 * WHY FAIL CLOSED, WHICH IS THE PART WORTH ARGUING WITH. Most read gates on this server are
 * "ungated ⇒ open", and for them that is right: an ungated deployment is a LAN/test posture and
 * the worst case is a peer seeing the roster. It is wrong here for the same reason it was wrong
 * for the durable log: "no credential configured" is not "no gate to apply", it is "nothing to
 * verify against", and the only safe answer to an unverifiable request for unrevealed content is
 * no. An operator who wants a catalogue starts the server with a credential.
 *
 * HOW THESE TESTS AVOID PASSING TRIVIALLY. A 403 is easy to produce by accident — a typo in a
 * route, a missing file, a server that never started would all give one. So every refusal here is
 * paired with the SAME request succeeding under a credential against the SAME server and the SAME
 * fixture directory, and the success asserts the actual content came back (a beat body, a module
 * count). t02 goes further: it boots the identical fixture directory BOTH ways and shows the
 * material is genuinely on disk and genuinely reachable — the ungated refusal is a policy, not an
 * empty shelf.
 *
 * NAMES: invented and obviously fictional throughout (plan 0529 §0 / guard t0531-01).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const MOD_A = 'cat-alpha', MOD_B = 'cat-beta', SERIES = 'cat-run';
const TOKEN = 'cat-gate-token';

// The beat body that must NEVER come back to an anonymous caller. It stands in for the thing that
// actually leaks: authored material the room has not reached yet.
const UNREVEALED = 'the door was never locked';

const deck = (title, ids) => ({
  manifest: { title },
  beats: ids.map((i) => ({ id: i, component: 'card', opts: { title: 'Beat ' + i, body: UNREVEALED } })),
});

/*
 * ⛔ modules/*.json is gitignored and has no version history, so no fixture is written into the
 * repo's own modules/. Each boot gets a private temp directory, handed over by the env var
 * createServer reads exactly once at construction.
 */
function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0529-p2-'));
  writeFileSync(join(dir, MOD_A + '.json'), JSON.stringify(deck('Alpha Chapter', ['a1', 'a2'])));
  writeFileSync(join(dir, MOD_B + '.json'), JSON.stringify(deck('Beta Chapter', ['b1'])));
  writeFileSync(join(dir, SERIES + '.series.json'), JSON.stringify({
    manifest: { title: 'A Two-Part Run', summary: 'alpha then beta' },
    moduleIds: [MOD_A, MOD_B],
  }));
  return dir;
}
async function boot(dir, opts) {
  const prev = process.env.PRESENTER_MODULES_DIR;
  process.env.PRESENTER_MODULES_DIR = dir;
  try { return await createServer(Object.assign({ port: 0 }, opts || {})); }
  finally { if (prev === undefined) delete process.env.PRESENTER_MODULES_DIR; else process.env.PRESENTER_MODULES_DIR = prev; }
}
/** Fetch returning {status, text, json} — never throws on a non-2xx, so a 403 body is readable. */
async function get(url, headers) {
  const r = await fetch(url, headers ? { headers } : undefined);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, text, json };
}

/** The four routes this phase gates, as suffixes to a server url. */
const ROUTES = ['/api/modules', '/api/modules/' + MOD_A, '/api/series', '/api/series/' + SERIES];

test('t0529-p2-01 — on a GATED server the four catalogue reads refuse anonymous and serve a credentialed caller', async () => {
  const dir = fixtureDir();
  const server = await boot(dir, { controlToken: TOKEN });
  try {
    for (const route of ROUTES) {
      const anon = await get(server.url() + route);
      expect(`anonymous ${route} is refused`, anon.status === 403, `${anon.status} ${anon.text.slice(0, 120)}`);
      // The refusal must not leak what it is refusing. A 403 that still names the modules has
      // given away the catalogue it exists to withhold.
      expect(`the refusal of ${route} leaks no content`,
        !anon.text.includes(UNREVEALED) && !anon.text.includes(MOD_A),
        anon.text.slice(0, 200));

      const wrong = await get(server.url() + route, { 'x-control-token': 'not-the-token' });
      expect(`a WRONG credential on ${route} is refused`, wrong.status === 403, String(wrong.status));

      // Header form — what control.html and creator.html send.
      const hdr = await get(server.url() + route, { 'x-control-token': TOKEN });
      expect(`x-control-token on ${route} is accepted`, hdr.status === 200, `${hdr.status} ${hdr.text.slice(0, 120)}`);

      // Query form — the SAME credential, the other carrier (?token=), already used by the
      // overlay/unlock path. Both must work or half the surfaces would 403.
      const qs = await get(server.url() + route + (route.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN));
      expect(`?token= on ${route} is accepted`, qs.status === 200, `${qs.status} ${qs.text.slice(0, 120)}`);
    }

    // ⛓ NOT JUST A 200 — the CONTENT. A gate that quietly started serving empty lists would pass
    // every status assertion above while breaking the GM's desk exactly as badly as a 403 does.
    const list = (await get(server.url() + '/api/modules', { 'x-control-token': TOKEN })).json;
    expect('the credentialed list carries both modules', Array.isArray(list)
      && list.some((m) => m.id === MOD_A) && list.some((m) => m.id === MOD_B), JSON.stringify(list));

    const one = (await get(server.url() + '/api/modules/' + MOD_A, { 'x-control-token': TOKEN })).json;
    expect('the credentialed module read carries the beat body', one && one.module
      && one.module.beats.length === 2 && one.module.beats[0].opts.body === UNREVEALED, JSON.stringify(one && one.id));

    const series = (await get(server.url() + '/api/series', { 'x-control-token': TOKEN })).json;
    expect('the credentialed series list carries the series', Array.isArray(series)
      && series.some((s) => s.id === SERIES && s.count === 2), JSON.stringify(series));

    const sOne = (await get(server.url() + '/api/series/' + SERIES, { 'x-control-token': TOKEN })).json;
    expect('the credentialed series read resolves its modules in order', sOne && sOne.modules
      && sOne.modules.length === 2 && sOne.modules[0].id === MOD_A && sOne.modules[1].id === MOD_B,
      JSON.stringify(sOne && sOne.modules));

    // The gate is on the CATALOGUE, not on the whole server. A participant must still be able to
    // ask whether the server is gated at all — that route is how the audience page decides whether
    // to show an unlock prompt, and breaking it would break the player surface.
    const auth = await get(server.url() + '/api/auth');
    expect('/api/auth stays open (the audience page needs it, and it carries no content)',
      auth.status === 200 && auth.json && auth.json.gated === true, `${auth.status} ${auth.text.slice(0, 120)}`);
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('t0529-p2-02 — an UNGATED server fails closed on all four, and the same fixture proves the content was really there', async () => {
  const dir = fixtureDir();

  // (a) UNGATED — no controlToken, no rolePassword. Every catalogue read is refused, and the
  //     refusal says WHY, because an operator staring at a blank picker must be able to tell
  //     "you configured no credential" apart from "your token is wrong".
  const open = await boot(dir, {});
  try {
    for (const route of ROUTES) {
      const r = await get(open.url() + route);
      expect(`ungated ${route} FAILS CLOSED`, r.status === 403, `${r.status} ${r.text.slice(0, 120)}`);
      expect(`the ungated refusal of ${route} explains the configuration fault`,
        r.json && /credential/i.test(String(r.json.error)) && /none configured/i.test(String(r.json.error)),
        JSON.stringify(r.json));
      expect(`ungated ${route} leaks no content`, !r.text.includes(UNREVEALED), r.text.slice(0, 200));
    }
    // Presenting a token to an ungated server changes nothing — there is nothing to verify it
    // against, so guessing a credential must not open the door.
    const guessed = await get(open.url() + '/api/modules', { 'x-control-token': TOKEN });
    expect('a guessed token does not open an ungated server', guessed.status === 403, String(guessed.status));
  } finally { await open.close(); }

  // (b) THE SAME DIRECTORY, GATED. This is what stops (a) passing on an empty shelf: the identical
  //     fixture, read by a credentialed caller, returns the material. So (a)'s 403 is a decision.
  const gated = await boot(dir, { controlToken: TOKEN });
  try {
    const one = (await get(gated.url() + '/api/modules/' + MOD_A, { 'x-control-token': TOKEN })).json;
    expect('the very content refused when ungated IS served when credentialed',
      one && one.module && one.module.beats[0].opts.body === UNREVEALED, JSON.stringify(one && one.id));
  } finally { await gated.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('t0529-p2-03 — a rolePassword deployment gates the catalogue with the SAME credential (no second auth scheme)', async () => {
  // The other half of the one credential. A deployment gated by roleSeed+rolePassword (the unlock
  // box on the control page) must gate the catalogue too — and must accept the hash the browser
  // computes. Plan 0471 H1 exists because a rolePassword-only deployment had once left a whole
  // endpoint open: the check was written against CONTROL_TOKEN alone and nobody noticed the other
  // branch. Asserting both carriers here is what stops that recurring.
  const dir = fixtureDir();
  const seed = 'salted', pw = 'open-sesame';
  const { createHash } = await import('crypto');
  const roleHash = createHash('sha256').update(seed + pw).digest('hex');
  const server = await boot(dir, { roleSeed: seed, rolePassword: pw });
  try {
    const anon = await get(server.url() + '/api/modules/' + MOD_A);
    expect('rolePassword deployment refuses an anonymous catalogue read', anon.status === 403, String(anon.status));

    const ok = await get(server.url() + '/api/modules/' + MOD_A, { 'x-control-token': roleHash });
    expect('the role hash is accepted on the catalogue', ok.status === 200, `${ok.status} ${ok.text.slice(0, 120)}`);
    expect('and it returns the module', ok.json && ok.json.module && ok.json.module.beats.length === 2,
      JSON.stringify(ok.json && ok.json.id));

    // The PASSWORD is not the credential — the hash is. Sending the plaintext must fail, or the
    // gate would be advertising the secret it protects.
    const plain = await get(server.url() + '/api/modules/' + MOD_A, { 'x-control-token': pw });
    expect('the plaintext password is NOT a credential', plain.status === 403, String(plain.status));
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
