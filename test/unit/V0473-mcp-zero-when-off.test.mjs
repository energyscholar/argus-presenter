/*
 * T-MCP-ZERO-WHEN-OFF (Plan 0473, P0). Conditional MCP tool registration. When audio-in is OFF,
 * the voice-capture tools (presenter_voice_enable + the presenter_transcript voice-alias) are
 * ABSENT from the registered tool surface ⇒ zero surface clutter + zero selection load. The CORE
 * working-set / inbox tools (presenter_inbox, and the sense/act keys) are ALWAYS present. When ON,
 * all tools are registered.
 *
 * The flag is read from {voiceEnabled} (explicit, for clean test isolation) or PRESENTER_VOICE_ENABLED.
 */
import { test, check as expect } from '../../harness/test.mjs';
import { toolMap, activeTools, coreTools, voiceTools } from '../../mcp/tools.mjs';

const VOICE_TOOL_NAMES = ['presenter_voice_enable', 'presenter_transcript'];
// Plan 0473 P4: the work-queue keys (claim/resolve/defer) + the sense key (situation) are CORE — the
// instrument itself — so they are ALWAYS registered, present even with audio-in OFF.
const CORE_ALWAYS = ['presenter_inbox', 'presenter_start', 'presenter_status',
  'presenter_situation', 'presenter_claim', 'presenter_resolve', 'presenter_defer'];

test('T-MCP-ZERO-WHEN-OFF: voice-capture tools ABSENT when off; core tools present', async () => {
  const off = toolMap({ voiceEnabled: false });
  for (const n of VOICE_TOOL_NAMES) expect(n + ' ABSENT from tool surface when off', !off[n], n);
  for (const n of CORE_ALWAYS) expect(n + ' present when off (core, always on)', !!off[n], n);
  // Structural: the off surface is exactly coreTools (no voice bleed-through).
  expect('off surface count == coreTools count', activeTools({ voiceEnabled: false }).length === coreTools.length,
    activeTools({ voiceEnabled: false }).length + ' vs ' + coreTools.length);
});

test('T-MCP-ZERO-WHEN-OFF: all voice + core tools present when ON', async () => {
  const on = toolMap({ voiceEnabled: true });
  for (const n of VOICE_TOOL_NAMES) expect(n + ' present when ON', !!on[n], n);
  for (const n of CORE_ALWAYS) expect(n + ' present when ON', !!on[n], n);
  expect('on surface count == core + voice', activeTools({ voiceEnabled: true }).length === coreTools.length + voiceTools.length,
    activeTools({ voiceEnabled: true }).length + ' vs ' + (coreTools.length + voiceTools.length));
});

test('T-MCP-ZERO-WHEN-OFF: voiceTools contains exactly the two voice-capture tools; none leak into core', async () => {
  const vNames = voiceTools.map((t) => t.name).sort();
  expect('voiceTools == the two capture tools', JSON.stringify(vNames) === JSON.stringify(VOICE_TOOL_NAMES.slice().sort()), vNames.join(','));
  const coreNames = new Set(coreTools.map((t) => t.name));
  for (const n of VOICE_TOOL_NAMES) expect(n + ' NOT in coreTools', !coreNames.has(n), n);
});
