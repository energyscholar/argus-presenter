/*
 * G2 — the scene-item strip is expressed via the permission model
 * (canSeeVisibility), not an ad-hoc literal in the server.
 */
import { test, expect } from '../../harness/test.mjs';
import { createPermissions } from '../../app/permissions.mjs';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('G2 — canSeeVisibility gates gm items to controllers', () => {
  const P = createPermissions();
  expect(P.canSeeVisibility('participant', 'all') === true, 'all visible to participant');
  expect(P.canSeeVisibility('participant', undefined) === true, 'untagged visible to participant');
  expect(P.canSeeVisibility('participant', 'gm') === false, 'gm hidden from participant');
  expect(P.canSeeVisibility('presenter', 'gm') === true, 'gm visible to presenter');
  expect(P.canSeeVisibility('ai', 'gm') === true, 'gm visible to ai');
});

test('G2 — server no longer strips via an ad-hoc visibility literal', () => {
  const src = readFileSync(join(ROOT, 'app', 'server.mjs'), 'utf8');
  expect(!/it\.visibility === 'all'/.test(src), 'no ad-hoc visibility literal in server (moved to perms)');
  expect(/canSeeVisibility/.test(src), 'server uses the permission model for visibility');
});
