/*
 * Plan 0904 V2 — THE ARCHIVE: the room's `record` drives it, `transcriptDir` is its home, retention is
 * enforced, and it never lands in a code tree (R3, R11).
 *
 *   T0904-09   record:"30d" persists the WHOLE entry (extRef, startedAt, asrMs, campaignId…) to
 *              transcriptDir/transcripts-<UTC date>.jsonl; record:"none" writes nothing; a 31-day-old
 *              file is removed at startup and a 29-day-old one is kept; welcome.transcriptPersisting
 *              (and the retention) match `record`.
 *   T0904-25   consentShownTs is written once per ref (and stays "once" across a restart); campaignId
 *              rides on every line.
 *   T0904-09b  a transcriptDir inside the code tree is refused at startup; recording without a
 *              transcriptDir is refused.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { useStubAsr, mkCap, connect, speak, until, wait, SECRET } from './_0904-voice.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const day = (offsetDays) => new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);
const lines = (f) => existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

test('T0904-09 — record drives the archive: per-day files, the whole entry, retention at startup', async () => {
  useStubAsr();
  const dir = mkdtempSync(join(tmpdir(), 'ap-0904-arch-'));
  const old = join(dir, `transcripts-${day(31)}.jsonl`), recent = join(dir, `transcripts-${day(29)}.jsonl`), other = join(dir, 'notes.txt');
  writeFileSync(old, '{"old":true}\n'); writeFileSync(recent, '{"recent":true}\n'); writeFileSync(other, 'not ours');
  let s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET, record: '30d', transcriptDir: dir, campaignId: 'camp-1' });
  try {
    expect(!existsSync(old), 'a 31-day-old day file is removed at startup');
    expect(existsSync(recent), 'a 29-day-old day file is kept');
    expect(existsSync(other), 'a file that is not a day file is never touched');
    const c = await connect(s.url(), { cap: mkCap({ ref: 'vtt:w1:u1', nonce: 'arch-1' }).token });
    expect(c.welcome.transcriptPersisting === true && c.welcome.transcriptRetention === '30d', 'welcome says it is recorded, and for how long', JSON.stringify({ p: c.welcome.transcriptPersisting, r: c.welcome.transcriptRetention }));
    speak(c, 1, { startedAt: Date.now() - 900, endedAt: Date.now() });
    const f = join(dir, `transcripts-${day(0)}.jsonl`);
    await until(() => lines(f).length >= 1, 'archived line');
    const L = lines(f)[0];
    for (const k of ['seq', 'kind', 'userId', 'userName', 'trust', 'text', 'ts', 'sessionId', 'extRef', 'startedAt', 'endedAt', 'durationMs', 'asrMs', 'recognizer', 'codec', 'source', 'campaignId']) {
      expect(L[k] !== undefined, 'the archived line carries ' + k, JSON.stringify(L));
    }
    expect(L.extRef === 'vtt:w1:u1' && L.campaignId === 'camp-1' && L.source === 'tap', 'with the right values', JSON.stringify(L));
    c.ws.close();
  } finally { await s.close(); }
  // record:"none" — nothing written, and the consent surface says so.
  const dir2 = mkdtempSync(join(tmpdir(), 'ap-0904-none-'));
  s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET, record: 'none', transcriptDir: dir2 });
  try {
    const c = await connect(s.url(), { cap: mkCap({ ref: 'vtt:w1:u2', nonce: 'arch-2' }).token });
    expect(c.welcome.transcriptPersisting === false, 'record:none ⇒ transcriptPersisting false', JSON.stringify(c.welcome.transcriptPersisting));
    speak(c, 1);
    await until(() => s.getInbox().items.length >= 1, 'entry in the ring');
    await wait(150);
    expect(readdirSync(dir2).length === 0, 'record:none writes nothing', JSON.stringify(readdirSync(dir2)));
    c.ws.close();
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); rmSync(dir2, { recursive: true, force: true }); }
});

test('T0904-25 — consentShownTs once per ref (across a restart); campaignId on every line', async () => {
  useStubAsr();
  const dir = mkdtempSync(join(tmpdir(), 'ap-0904-consent-'));
  const f = join(dir, `transcripts-${day(0)}.jsonl`);
  let s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET, record: '30d', transcriptDir: dir, campaignId: 'camp-9' });
  try {
    const a = await connect(s.url(), { cap: mkCap({ ref: 'vtt:w1:a', nonce: 'cs-a' }).token });
    const b = await connect(s.url(), { cap: mkCap({ ref: 'vtt:w1:b', nonce: 'cs-b' }).token });
    const shown = Date.now() - 5000;
    a.ws.send(JSON.stringify({ t: 'voice_consent', shownTs: shown }));
    b.ws.send(JSON.stringify({ t: 'voice_consent', shownTs: shown + 1 }));
    await wait(80);
    speak(a, 1); await until(() => lines(f).length >= 1, 'a1');
    speak(a, 2); await until(() => lines(f).length >= 2, 'a2');
    speak(b, 1); await until(() => lines(f).length >= 3, 'b1');
    const L = lines(f);
    const la = L.filter((x) => x.extRef === 'vtt:w1:a'), lb = L.filter((x) => x.extRef === 'vtt:w1:b');
    expect(la[0].consentShownTs === shown && la[1].consentShownTs === undefined, 'consentShownTs on the first line for a ref only', JSON.stringify(la.map((x) => x.consentShownTs)));
    expect(lb[0].consentShownTs === shown + 1, 'each ref gets its own', JSON.stringify(lb[0]));
    expect(L.every((x) => x.campaignId === 'camp-9'), 'campaignId on every line');
    a.ws.close(); b.ws.close();
  } finally { await s.close(); }
  s = await createServer({ port: 0, voiceEnabled: true, capSecret: SECRET, record: '30d', transcriptDir: dir, campaignId: 'camp-9' });
  try {
    const a = await connect(s.url(), { cap: mkCap({ ref: 'vtt:w1:a', nonce: 'cs-a2' }).token });
    a.ws.send(JSON.stringify({ t: 'voice_consent', shownTs: Date.now() }));
    await wait(80);
    const n0 = lines(f).length;
    speak(a, 1); await until(() => lines(f).length > n0, 'a after restart');
    expect(lines(f).pop().consentShownTs === undefined, 'still once per ref after a restart');
    a.ws.close();
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('T0904-09b — the archive never lands in the code tree, and recording needs a home', async () => {
  let threw = null;
  try { const s = await createServer({ port: 0, record: '30d', transcriptDir: join(REPO, '.transcripts') }); await s.close(); } catch (e) { threw = e; }
  expect(threw && /release|code tree|repo/i.test(threw.message), 'a transcriptDir inside the code tree is refused', threw && threw.message);
  threw = null;
  try { const s = await createServer({ port: 0, record: '30d' }); await s.close(); } catch (e) { threw = e; }
  expect(threw && /transcriptDir/.test(threw.message), 'recording without a transcriptDir is refused', threw && threw.message);
  threw = null;
  try { const s = await createServer({ port: 0, record: true, transcriptDir: tmpdir() }); await s.close(); } catch (e) { threw = e; }
  expect(threw && /record/.test(threw.message), 'record:true (not a retention) is refused', threw && threw.message);
});
