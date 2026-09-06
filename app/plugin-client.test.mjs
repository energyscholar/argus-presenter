/*
 * plugin-client.test.mjs — the engine's own thin shell-out, tested standalone.
 *
 * Stubs PRESENTER_LIFECYCLE_CLI at a tiny FIXTURE script (a temp .mjs this test writes itself,
 * NOT the real tools/package-lifecycle.mjs) so this suite is isolated from repertory's own
 * process boundary. Three cases: a clean success reply, a non-zero-exit (unreachable) CLI, and
 * cliPath left undefined (mirroring PRESENTER_LIFECYCLE_CLI unset).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyLoad, lifecycleCliConfigured } from './plugin-client.mjs';

function writeFixture(dir, body) {
  const p = join(dir, 'fixture-cli.mjs');
  writeFileSync(p, body, 'utf8');
  return p;
}

test('t0768-01 — a clean reply from the fixture CLI is parsed and returned as-is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ap-plugin-client-'));
  try {
    const cliPath = writeFixture(dir, `
      process.stdout.write(JSON.stringify({
        ok: true, action: 'verify-load', id: 'high-and-dry', version: '1.0.0',
        customer: 'acct-1', ownsBase: true, baseIntact: true, refusal: null
      }));
    `);
    const result = verifyLoad({ id: 'high-and-dry', version: '1.0.0', customer: 'acct-1', cliPath });
    assert.deepEqual(result, {
      ok: true, action: 'verify-load', id: 'high-and-dry', version: '1.0.0',
      customer: 'acct-1', ownsBase: true, baseIntact: true, refusal: null
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('t0768-02 — a non-zero exit from the fixture CLI fails open, named E-LIFECYCLE-UNREACHABLE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ap-plugin-client-'));
  try {
    const cliPath = writeFixture(dir, `process.exitCode = 1;`);
    const result = verifyLoad({ id: 'high-and-dry', version: '1.0.0', customer: 'acct-1', cliPath });
    assert.deepEqual(result, {
      ok: false, failedOpen: true, ownsBase: null, baseIntact: null, refusal: 'E-LIFECYCLE-UNREACHABLE'
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('t0768-03 — cliPath undefined (PRESENTER_LIFECYCLE_CLI unset) loads UNGATED', () => {
  const prior = process.env.PRESENTER_LIFECYCLE_CLI;
  delete process.env.PRESENTER_LIFECYCLE_CLI;
  try {
    const result = verifyLoad({ id: 'high-and-dry', version: '1.0.0', customer: 'acct-1', cliPath: undefined });
    assert.deepEqual(result, { ok: true, ungated: true, ownsBase: null, baseIntact: null, refusal: null });
    assert.equal(lifecycleCliConfigured(), false);
  } finally {
    if (prior !== undefined) process.env.PRESENTER_LIFECYCLE_CLI = prior;
  }
});

test('t0768-04 — a malformed reply from the fixture CLI is named E-LIFECYCLE-BAD-REPLY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ap-plugin-client-'));
  try {
    const cliPath = writeFixture(dir, `process.stdout.write('not json');`);
    const result = verifyLoad({ id: 'high-and-dry', version: '1.0.0', customer: 'acct-1', cliPath });
    assert.deepEqual(result, { ok: false, ownsBase: null, baseIntact: null, refusal: 'E-LIFECYCLE-BAD-REPLY' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('t0768-05 — lifecycleCliConfigured() reflects PRESENTER_LIFECYCLE_CLI presence', () => {
  const prior = process.env.PRESENTER_LIFECYCLE_CLI;
  try {
    process.env.PRESENTER_LIFECYCLE_CLI = '/tmp/does-not-need-to-exist-for-this-check.mjs';
    assert.equal(lifecycleCliConfigured(), true);
    delete process.env.PRESENTER_LIFECYCLE_CLI;
    assert.equal(lifecycleCliConfigured(), false);
  } finally {
    if (prior !== undefined) process.env.PRESENTER_LIFECYCLE_CLI = prior;
    else delete process.env.PRESENTER_LIFECYCLE_CLI;
  }
});
