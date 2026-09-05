/*
 * Plan 0760 / E5b — MCP LOAD PARITY: `present_module(moduleId)` must carry manifest + sections too.
 *
 * The human path (`GET /api/modules/<id>` → `set_module` control message → `api.setModule`) hands
 * the WHOLE parsed module file — manifest, sections, beats — into `setModule`, which keeps every
 * key it is given (`Object.assign({}, module, {...})`). The MCP path (`present_module({moduleId})`)
 * reads the same file via `readModuleById` but only forwarded `title` and `beats` into its own
 * `setModule` call, silently dropping `manifest` and `sections` on the floor even though the
 * function under it was always willing to keep them. This test diffs what `server.getModule()`
 * returns after each path loads the SAME on-disk module file — the diff must be empty.
 *
 * Unit tier: no browser, `port: 0`, `tunnel: false`.
 *
 * ⛔ DOMAIN-FREE FIXTURE: the module is picked PROGRAMMATICALLY from whatever real content already
 * lives under `modules/` (first file with a non-empty manifest AND non-empty sections, skipping
 * `_archive` and `*.series.json`) — never a hard-coded id, never a fixture written to disk. Reading
 * `modules/*.json` is read-only here; `MODULES_DIR` is a module-top-level const in mcp/tools.mjs
 * fixed at first import in this whole test PROCESS, so pointing PRESENTER_MODULES_DIR at a temp dir
 * from inside this file would not reliably repoint it once another file in the suite has already
 * imported mcp/tools.mjs first.
 */
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { test, expect } from '../../harness/test.mjs';
import { toolMap, _server } from '../../mcp/tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = join(HERE, '..', '..', 'modules');

/** First on-disk module with a non-empty manifest AND non-empty sections — never hard-coded. */
function findFixtureModule() {
  let names = [];
  try { names = readdirSync(MODULES_DIR); } catch { return null; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    if (name.endsWith('.series.json')) continue;
    const id = name.slice(0, -'.json'.length);
    const file = join(MODULES_DIR, name);
    let parsed;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    const manifestKeys = parsed && parsed.manifest ? Object.keys(parsed.manifest).length : 0;
    const sectionsKeys = parsed && parsed.sections ? Object.keys(parsed.sections).length : 0;
    if (manifestKeys > 0 && sectionsKeys > 0) return { id, file };
  }
  return null;
}

test('0760 — present_module(moduleId) carries manifest + sections exactly as the human load path does', async () => {
  const fixture = findFixtureModule();
  expect(!!fixture, 'a real module on disk has a non-empty manifest AND non-empty sections to test parity against — none found under modules/ (a vacuous pass here would hide the very defect this test exists to catch)');

  const T = toolMap();
  await T.presenter_start.handler({ port: 0, tunnel: false });
  const server = _server();
  try {
    // Human path: the control page hands the WHOLE parsed file straight to api.setModule.
    server.setModule(JSON.parse(readFileSync(fixture.file, 'utf8')));
    const human = server.getModule();

    // MCP path: the same on-disk module, loaded by id.
    await T.present_module.handler({ moduleId: fixture.id });
    const mcp = server.getModule();

    expect(JSON.stringify(mcp.manifest) === JSON.stringify(human.manifest),
      'manifest differs between MCP and human load paths',
      JSON.stringify({ human: human.manifest, mcp: mcp.manifest }));
    expect(JSON.stringify(mcp.sections) === JSON.stringify(human.sections),
      'sections differs between MCP and human load paths',
      JSON.stringify({ human: human.sections, mcp: mcp.sections }));
  } finally {
    await T.presenter_stop.handler({});
  }
});
