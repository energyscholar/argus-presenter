/*
 * T2 — logging. Server (app/log.mjs): threshold gating + OPSEC redaction of
 * gm-only field VALUES for a participant-scope view. Client (lib/log.mjs):
 * below-threshold suppression via the AP_LOG flag.
 */
import { test, expect } from '../../harness/test.mjs';
import * as L from '../../app/log.mjs';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('T2 server: below-threshold lines suppressed, at/above recorded', () => {
  L.clear(); L.setLevel('warn');
  expect(L.debug('sys', 'noisy') === null, 'debug suppressed at warn threshold');
  expect(L.info('sys', 'chatty') === null, 'info suppressed at warn threshold');
  const w = L.warn('sys', 'kept');
  expect(w !== null && w.level === 'warn', 'warn recorded');
  expect(L.tail(10).length === 1, 'exactly one entry in the ring', String(L.tail(10).length));
});

test('T2 server OPSEC: gm-only field value redacted from participant view, shown to presenter', () => {
  L.clear(); L.setLevel('info');
  const SECRET = 'vote-yes-7f3a';
  L.info('poll', 'vote recorded', { path: 'polls/p1/votes/u2', value: SECRET }, { roles: ['presenter', 'ai'] });

  const pStr = JSON.stringify(L.view('participant'));
  expect(!pStr.includes(SECRET), 'secret VALUE absent from participant log', pStr);
  expect(pStr.includes('[redacted]'), 'participant sees redaction marker');
  expect(pStr.includes('polls/p1/votes/u2') === false, 'field value (even the path field) redacted for non-authorized viewer');
  expect(pStr.includes('poll') && pStr.includes('vote recorded'), 'structural tag/msg still visible');

  const gStr = JSON.stringify(L.view('presenter'));
  expect(gStr.includes(SECRET), 'presenter sees the actual value', gStr);
});

test('T2 client (lib/log.mjs): AP_LOG flag suppresses below-threshold', () => {
  const src = readFileSync(join(ROOT, 'lib', 'log.mjs'), 'utf8');
  const fakeWin = { AP_LOG: 'warn', location: { search: '' }, console: { log() {}, warn() {}, error() {}, info() {}, debug() {}, trace() {} } };
  // eslint-disable-next-line no-new-func
  const boot = new Function('window', src + '\n;return window.ApLog;');
  const ApLog = boot(fakeWin);
  expect(typeof ApLog.log === 'function', 'client ApLog exposed');
  expect(ApLog.debug('sys', 'hidden') === null, 'client debug suppressed at warn');
  const w = ApLog.warn('sys', 'shown');
  expect(w && w.level === 'warn', 'client warn recorded');
  expect(ApLog.ring().length === 1, 'client ring has one entry', String(ApLog.ring().length));
});
