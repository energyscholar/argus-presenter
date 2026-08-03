/*
 * Plan 0532 P1 — THE PARTIAL-INSTALL GUARD.
 *
 * The deployment ran for months with 8 of one plugin's 24 files installed. The manifest declared
 * thirteen station artworks; none of them was on disk. Nothing crashed — `resolveStationScreen()`
 * logs `screen-file-missing` and degrades that station to the generic placeholder, which is the
 * right behaviour and also the reason the gap was invisible. **A partial copy looks exactly like
 * a complete one.**
 *
 * The install itself is a script in the content repo, which copies and then proves the copy
 * (`tools/install-system-plugins.sh`, byte-for-byte plus this same manifest check). This test is
 * the other half: it makes the same defect RED on the presenter side, where the plugin directory
 * is gitignored and no reviewer can see it in a diff.
 *
 * ── SCOPE, so it can be judged rather than trusted ────────────────────────────────────────────
 *   IN  : every plugin that IS installed. For each, every file its own manifest names must exist.
 *         The manifest's claims are the specification; the disk either meets them or it does not.
 *   OUT : whether a given plugin *ought* to be installed. This repo is public and domain-free —
 *         it cannot know which content a deployment has a right to. `t0514-00` covers the one
 *         plugin the 0514 suite needs.
 *   ⚠ A deployment with no plugins passes vacuously, and that is correct rather than convenient:
 *     there is nothing to be incomplete. The count is asserted non-negatively and REPORTED, so a
 *     reader can see whether the check had anything to bite on.
 */
import { test, expect } from '../../harness/test.mjs';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { pluginNames, pluginDir, readManifest } from '../../harness/plugins.mjs';

test('t0532-02 — every installed plugin has every file its OWN manifest declares', () => {
  const missing = [];
  let declared = 0;
  let plugins = 0;

  for (const name of pluginNames()) {
    const man = readManifest(name);
    if (!man) continue;
    plugins += 1;
    const dir = pluginDir(name);

    // (a) a server module, if declared — one path segment, per pluginServerModule().
    for (const rel of [man.server].filter((s) => typeof s === 'string' && s)) {
      declared += 1;
      if (!isFile(join(dir, rel))) missing.push(`${name}/${rel} (server)`);
    }

    // (b) every station screen file. This is the exact class of file that was absent.
    for (const st of man.stations || []) {
      const rel = st && st.stationScreen && st.stationScreen.svgFile;
      if (typeof rel !== 'string' || !rel) continue;
      declared += 1;
      if (!isFile(join(dir, ...rel.split('/')))) missing.push(`${name}/${rel} (station ${st.stationUid})`);
    }
  }

  expect(missing.length === 0,
    `${missing.length} of ${declared} manifest-declared file(s) across ${plugins} installed plugin(s) are NOT on disk — `
    + 'the install is partial. Re-run the content repo\'s install script, which copies AND verifies.',
    '\n  ' + missing.join('\n  '));

  // Reported, not asserted upward: a clean clone legitimately has nothing installed.
  expect(declared >= 0, `${declared} declared file(s) checked across ${plugins} installed plugin(s)`, String(declared));
});

function isFile(p) { return existsSync(p) && statSync(p).isFile(); }
