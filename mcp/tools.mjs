/*
 * mcp/tools.mjs — the Argus Presenter tool surface (how an AI drives the presenter).
 * Framework-agnostic: each tool has {name, description, input (JSON schema), handler}.
 * server.mjs wraps these with the official MCP SDK; tests exercise the handlers directly.
 *
 * A single presenter server instance is managed here (start/stop). Every component +
 * poll capability is reachable through this surface — "tie everything to MCP".
 */
import { createServer } from '../app/server.mjs';
import { assemble } from '../harness/assemble.mjs';

let server = null;
const need = () => { if (!server) throw new Error('presenter not started — call presenter_start first'); return server; };

export const tools = [
  {
    name: 'presenter_start',
    description: 'Start the Argus Presenter server. Returns the URL participants/presenter open.',
    input: { type: 'object', properties: { port: { type: 'number', description: 'Port (0 = random)' } } },
    handler: async ({ port = 0 } = {}) => { if (server) return { url: server.url(), already: true }; server = await createServer({ port }); return { url: server.url() }; }
  },
  {
    name: 'presenter_stop',
    description: 'Stop the presenter server.',
    input: { type: 'object', properties: {} },
    handler: async () => { if (server) { await server.close(); server = null; } return { stopped: true }; }
  },
  {
    name: 'presenter_status',
    description: 'Server URL + connected users (presence).',
    input: { type: 'object', properties: {} },
    handler: async () => (server ? { running: true, url: server.url(), presence: server.presence() } : { running: false })
  },
  {
    name: 'push_component',
    description: 'Assemble a component (or a scene) and push it to a target (userId | "all" | role).',
    input: {
      type: 'object',
      required: ['component'],
      properties: {
        component: { type: 'string', description: 'Component or "scene"' },
        opts: { type: 'object', description: 'Component options (scene spec for "scene")' },
        target: { type: 'string', description: 'userId | all | participant | presenter | ai', default: 'all' },
        theme: { type: 'string', default: 'argus' },
        requires: { type: 'array', items: { type: 'string' }, description: 'Plugin deps the content needs; assembler bundles only that closure', default: [] }
      }
    },
    handler: async ({ component, opts = {}, target = 'all', theme = 'argus', requires = [] }) => {
      const n = need().pushComponent(target, component, opts, theme, requires);  // role-aware (OPSEC strip) + dep-driven bundling
      return { pushed: n, component, target };
    }
  },
  {
    name: 'open_poll',
    description: 'Open a poll — pushes a choice to participants and (optionally) a live results display.',
    input: {
      type: 'object',
      required: ['promptId', 'prompt', 'options'],
      properties: {
        promptId: { type: 'string' }, prompt: { type: 'string' },
        options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: {}, style: { type: 'string' } } } },
        target: { type: 'string', default: 'participant' },
        resultsTarget: { type: 'string', description: 'Where to show live results, e.g. "presenter"' }
      }
    },
    handler: async (args) => need().openPoll(args)
  },
  {
    name: 'get_poll',
    description: 'Current tally + per-user votes for a poll.',
    input: { type: 'object', required: ['promptId'], properties: { promptId: { type: 'string' } } },
    handler: async ({ promptId }) => need().getPoll(promptId)
  },
  {
    name: 'close_poll',
    description: 'Close a poll (further votes ignored). Returns the final tally.',
    input: { type: 'object', required: ['promptId'], properties: { promptId: { type: 'string' } } },
    handler: async ({ promptId }) => need().closePoll(promptId)
  },
  {
    name: 'reload_clients',
    description: 'Hot-reload connected clients (swap code without dropping them).',
    input: { type: 'object', properties: { target: { type: 'string', default: 'all' }, delay: { type: 'number', default: 0 } } },
    handler: async ({ target = 'all', delay = 0 } = {}) => ({ reloaded: need().reloadClients(target, delay) })
  },
  {
    name: 'presenter_debug',
    description: 'Debug snapshot: presence, connections, current state, and the (role-redacted) op/log tail.',
    input: { type: 'object', properties: { role: { type: 'string', default: 'presenter', description: 'Viewer role for log redaction' } } },
    handler: async ({ role = 'presenter' } = {}) => need().debugDump(role)
  },
  {
    name: 'presenter_health',
    description: 'Health check: status (green/degraded), per-connection liveness (stale detection), op throughput, error rate, state/op-log size.',
    input: { type: 'object', properties: { staleMs: { type: 'number', default: 10000, description: 'A connection idle longer than this is stale' } } },
    handler: async ({ staleMs = 10000 } = {}) => need().health({ staleMs })
  },
  {
    name: 'present_module',
    description: 'Load a content module (deck of beats) and show the first beat. beats = [{component, opts, requires?}].',
    input: { type: 'object', required: ['beats'], properties: { title: { type: 'string' }, beats: { type: 'array', items: { type: 'object' } } } },
    handler: async ({ title, beats }) => { const s = need(); s.setModule({ title, beats }); return { module: s.showBeat(0) ? { shown: 0, ...s.getModule() && { beats: beats.length } } : { beats: beats.length } }; }
  },
  {
    name: 'next_beat',
    description: 'Advance the current content module to the next beat (all viewers follow).',
    input: { type: 'object', properties: {} },
    handler: async () => ({ beat: need().nextBeat() })
  },
  {
    name: 'append_beat',
    description: 'Append a beat to the current content module (AI co-author). beat = {component, opts, requires?}.',
    input: { type: 'object', required: ['beat'], properties: { beat: { type: 'object' } } },
    handler: async ({ beat }) => need().appendBeat(beat)
  },
  {
    name: 'presenter_bell',
    description: 'Ring a gentle chime + show a persistent banner on connected displays — a pure notifier (fire-and-forget, no acknowledgement). Use when you want the human — who keeps the tab in the background while you work — to bring it forward. For an eyes-on / not-AFK handshake instead, use presenter_verify_watching.',
    input: { type: 'object', properties: {
      message: { type: 'string', default: 'Ready to start?', description: 'Banner text shown on the display' },
      target: { type: 'string', default: 'all', description: 'userId | all | participant | presenter | ai' }
    } },
    handler: async ({ message = 'Ready to start?', target = 'all' } = {}) => ({ chimed: need().chime({ message, target }) })
  },
  {
    name: 'presenter_verify_watching',
    description: 'On-demand eyes-on handshake: chime + banner WITH a CONFIRM ("I\'m watching") button the viewer must click — proves eyes-on / not AFK. The banner persists until confirmed; poll presenter_check_ack to see who confirmed. Set bell:false to ask SILENTLY (banner only, no audio).',
    input: { type: 'object', properties: {
      message: { type: 'string', default: 'Ready to start?', description: 'Banner text shown on the display' },
      target: { type: 'string', default: 'all', description: 'userId | all | participant | presenter | ai' },
      ackId: { type: 'string', default: 'ready', description: 'Correlation id for this eyes-on request (used by presenter_check_ack)' },
      bell: { type: 'boolean', default: true, description: 'Play the audible chime. bell:false = silent ask (banner only).' }
    } },
    handler: async ({ message = 'Ready to start?', target = 'all', ackId = 'ready', bell = true } = {}) => ({ chimed: need().chime({ message, target, requireAck: true, ackId, bell }), requireAck: true, ackId })
  },
  {
    name: 'presenter_check_ack',
    description: 'Check the eyes-on acknowledgement for an ackId: who has confirmed they are watching (with timestamps) and who is still pending (the AFK signal). Poll this after presenter_verify_watching and wait until acked before presenting.',
    input: { type: 'object', properties: { ackId: { type: 'string', default: 'ready', description: 'The ackId passed to presenter_verify_watching' } } },
    handler: async ({ ackId = 'ready' } = {}) => need().getAck(ackId)
  },
  {
    name: 'presenter_attendance',
    description: 'Passive/continuous room liveness: roster + summary of connected users. Per user: idleSec (seconds since their last DELIBERATE interaction — the headline number), status (active/idle/afk from thresholds), connectedSec, eyes-on age, current display, ip, socketId. The AI is a controller → UNREDACTED view. Poll on demand (no push). Fresh/reconnected users read afk until they interact.',
    input: { type: 'object', properties: {
      activeSec: { type: 'number', default: 30, description: 'idle < this ⇒ active' },
      afkSec: { type: 'number', default: 120, description: 'idle ≥ this ⇒ afk (between ⇒ idle)' }
    } },
    handler: async ({ activeSec = 30, afkSec = 120 } = {}) => need().attendance({ activeSec, afkSec, viewerRole: 'ai' })
  },
  {
    name: 'presenter_raf',
    description: 'RAF metrics from the op-log: peer-catalysis ratio (peer-visible peer actions), teacher-dependency (AI/GM-catalyzed), interaction-graph density (peer->peer response edges).',
    input: { type: 'object', properties: { windowMs: { type: 'number', default: 5000, description: 'Response window for peer->peer interaction edges' } } },
    handler: async ({ windowMs = 5000 } = {}) => need().raf({ windowMs })
  }
];

export function toolMap() { const m = {}; for (const t of tools) m[t.name] = t; return m; }
export function _resetForTests() { server = null; }
export function _server() { return server; }
