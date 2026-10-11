/*
 * Plan 0941 §1 / T2 — ONE speech implementation. Every page that speaks imports lib/speak.mjs; no page
 * builds its own utterance. The file is served with the voice-client CORS so another origin can import it.
 *
 *   T0941-T2    presenter.html and voice.html import /lib/speak.mjs; `SpeechSynthesisUtterance` appears in
 *               exactly one file under app/ and lib/ — lib/speak.mjs.
 *   T0941-T2s   GET /lib/speak.mjs is JavaScript, with access-control-allow-origin for a listed origin only.
 *   T0941-A2    the name is not /lib/voice-*: a voice-OFF page may load it without loading voice code.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('T0941-T2 — every speaking page imports lib/speak.mjs; one file builds an utterance', () => {
  expect(existsSync(join(ROOT, 'lib', 'speak.mjs')), 'lib/speak.mjs exists');
  const page = read('app/presenter.html'), voice = read('app/voice.html');
  expect(/import\(\s*'\/lib\/speak\.mjs'\s*\)/.test(page), 'presenter.html imports /lib/speak.mjs');
  expect(/from\s+'\/lib\/speak\.mjs'/.test(voice), 'voice.html imports /lib/speak.mjs');
  const owners = [];
  for (const dir of ['app', 'lib']) for (const f of readdirSync(join(ROOT, dir))) {
    if (!/\.(html|mjs|js)$/.test(f) || /\.test\./.test(f)) continue;
    if (/SpeechSynthesisUtterance/.test(read(dir + '/' + f))) owners.push(dir + '/' + f);
  }
  expect(owners.join(',') === 'lib/speak.mjs', 'only lib/speak.mjs names SpeechSynthesisUtterance', owners.join(','));
});

test('T0941-T2s — /lib/speak.mjs is served as JavaScript with CORS for a listed origin only', async () => {
  const listed = 'https://listed.example';
  const s = await createServer({ port: 0, voiceClientOrigins: [listed] });
  try {
    const ok = await fetch(s.url() + '/lib/speak.mjs', { headers: { origin: listed } });
    const body = await ok.text();
    expect(ok.status === 200 && /javascript/.test(ok.headers.get('content-type') || ''), 'served as JavaScript', ok.status + ' ' + ok.headers.get('content-type'));
    expect(/export function createSpeaker/.test(body), 'the body is the speech module');
    expect(ok.headers.get('access-control-allow-origin') === listed, 'a listed origin may import it', String(ok.headers.get('access-control-allow-origin')));
    const other = await fetch(s.url() + '/lib/speak.mjs', { headers: { origin: 'https://other.example' } });
    await other.text();
    expect(!other.headers.get('access-control-allow-origin'), 'an unlisted origin may not', String(other.headers.get('access-control-allow-origin')));
  } finally { await s.close(); }
});
