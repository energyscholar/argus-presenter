/*
 * test/fixtures/plugins.mjs — point the plugin loader at the TEST FIXTURE tree.
 *
 * ⭐ Plan 0569 M2. This repo is PUBLIC and domain-neutral and now ships NO plugins: `plugins/` is
 * an install target only, and real plugins live in `repertory` (private). The engine still has to
 * prove the plugin MECHANISM works, so it carries one invented plugin under
 * test/fixtures/plugins/example/ — a manifest, a component, a preset and a scene.
 *
 * ⛔ Tests couple to plugins BY NAME (`requires: ['example']`), not only by path. That is how five
 * of these tests survived a path-only grep during the move and failed in the full suite: A1, A6,
 * A7 never mention `plugins/example`, they just say `'example'`. Anything that names a plugin must
 * come through here.
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/** Absolute path of the fixture plugin tree. */
export const FIXTURE_PLUGINS = join(dirname(fileURLToPath(import.meta.url)), 'plugins');

/** Absolute path of one fixture plugin's directory (for tests that read its source). */
export const fixturePluginDir = (name) => join(FIXTURE_PLUGINS, name);

/**
 * Run `fn` with PRESENTER_PLUGINS_DIR pointed at the fixtures, restoring it afterwards.
 * pluginsDir() resolves PER CALL, so this is all the redirection anyone needs.
 * Awaits `fn`, so sync and async callers behave identically.
 */
export async function withFixturePlugins(fn) {
  const prev = process.env.PRESENTER_PLUGINS_DIR;
  process.env.PRESENTER_PLUGINS_DIR = FIXTURE_PLUGINS;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PRESENTER_PLUGINS_DIR;
    else process.env.PRESENTER_PLUGINS_DIR = prev;
  }
}
