#!/usr/bin/env node
/*
 * mcp/server.mjs — MCP stdio server exposing the Argus Presenter tool surface.
 * Wraps the framework-agnostic tools in mcp/tools.mjs with the official SDK.
 * Deploy: `cd mcp && npm i` then register this script as an MCP server.
 * (Not run by the headless tests — those exercise tools.mjs handlers directly.)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer as createHttpServer } from 'node:http';
import { z } from 'zod';
import { activeTools } from './tools.mjs';

// Minimal JSON-schema-property -> zod converter (top-level props only).
function zshape(input) {
  const shape = {};
  const props = (input && input.properties) || {};
  const required = new Set((input && input.required) || []);
  for (const [k, s] of Object.entries(props)) {
    let z1;
    switch (s.type) {
      case 'string': z1 = z.string(); break;
      case 'number': z1 = z.number(); break;
      case 'boolean': z1 = z.boolean(); break;
      case 'array': z1 = z.array(z.any()); break;
      case 'object': z1 = z.record(z.any()); break;
      default: z1 = z.any();
    }
    if (s.description) z1 = z1.describe(s.description);
    shape[k] = required.has(k) ? z1 : z1.optional();
  }
  return shape;
}

const server = new McpServer({ name: 'argus-presenter', version: '0.1.0' });
// Plan 0473 P0: conditional registration — voice-capture tools appear ONLY when
// PRESENTER_VOICE_ENABLED is set; core (text/session/inbox) tools are always present.
for (const t of activeTools()) {
  server.tool(t.name, t.description, zshape(t.input), async (args) => {
    const result = await t.handler(args || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });
}

/* ── REACHABLE MCP (Plan 0658 §10c) ────────────────────────────────────────────────────────────
 *
 * ⭐⭐ WHY. `mcp/tools.mjs` keeps the presenter IN PROCESS (`let server = null; createServer(...)`),
 *   so an MCP client owns its own instance and CANNOT drive one on another machine. Measured
 *   2026-08-19: a second client answered "presenter not started" while a presenter was demonstrably
 *   serving. That made remote participation impossible — the agent had to be on the box.
 *
 * ⭐ THE EARLIER GENERATION ALREADY SOLVED THIS and we regressed. It held
 *   `activeBase = process.env.VTT_URL` and an `attach` tool taking a URL — the MCP there was a thin
 *   HTTP CLIENT of a running server, never its owner. This restores that property from the other
 *   side: the server that OWNS the presenter becomes reachable, so any client can drive it.
 *
 * ⛔ IT IS A CONTROL SURFACE, SO IT IS FENCED. Bind defaults to the tailnet address (never 0.0.0.0),
 *   and a bearer token is REQUIRED — an unauthenticated control port on a box with a public tunnel
 *   is the S241 incident with extra steps.
 *
 * stdio remains the default: absent PRESENTER_MCP_HTTP nothing changes for existing clients.
 */
const HTTP_PORT = Number(process.env.PRESENTER_MCP_HTTP || 0);
if (!HTTP_PORT) {
  await server.connect(new StdioServerTransport());
} else {
  const TOKEN = process.env.PRESENTER_MCP_TOKEN || '';
  if (!TOKEN) { console.error('⛔ PRESENTER_MCP_HTTP set without PRESENTER_MCP_TOKEN — refusing to open an unauthenticated control port'); process.exit(2); }
  let BIND = process.env.PRESENTER_MCP_BIND || '';
  if (!BIND) {
    try { const { execFileSync } = await import('node:child_process');
          BIND = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split('\n')[0]; }
    catch { BIND = '127.0.0.1'; }
  }
  /* ⭐ STATELESS. A session-ful transport wants one transport instance PER session, kept in a map;
   *   sharing a single one made calls fail with "Mcp-Session-Id header is required" as soon as a
   *   second client — or the same client after a restart — showed up. Every call here is independent
   *   and bearer-gated, so there is nothing a session would carry that we need. */
  /* ⭐ PLAIN JSON-RPC OVER HTTP, NOT THE SDK TRANSPORT.
   *   `StreamableHTTPServerTransport` is built around per-session transport instances; a single
   *   long-lived one answered 500 with nothing logged, and the stateless mode wants a fresh
   *   transport per request — i.e. a different server lifecycle than a supervised process that owns
   *   a presenter. We control both ends of this hop, and what matters is the TOOL CONTRACT, not the
   *   transport, so this speaks the same `tools/list` / `tools/call` JSON-RPC directly against the
   *   same `activeTools()` table the stdio server uses. One table, two transports.
   */
  const TOOLS = new Map(activeTools().map((t) => [t.name, t]));
  const send = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  createHttpServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET') return send(res, 200, { ok: true, tools: TOOLS.size });   // health
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const chunks = []; for await (const c of req) chunks.push(c);
    let m; try { m = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
    catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    const reply = (result) => send(res, 200, { jsonrpc: '2.0', id: m.id ?? null, result });
    const fail = (code, message) => send(res, 200, { jsonrpc: '2.0', id: m.id ?? null, error: { code, message } });
    try {
      if (m.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'argus-presenter', version: '0.1.0' } });
      if (String(m.method || '').startsWith('notifications/')) { res.writeHead(202); return res.end(); }
      if (m.method === 'tools/list') return reply({ tools: [...TOOLS.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.input })) });
      if (m.method === 'tools/call') {
        const t = TOOLS.get(m.params?.name);
        if (!t) return fail(-32602, `unknown tool: ${m.params?.name}`);
        const out = await t.handler(m.params?.arguments || {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      }
      return fail(-32601, `unknown method: ${m.method}`);
    } catch (e) { return fail(-32000, String((e && e.message) || e)); }
  }).listen(HTTP_PORT, BIND, () => console.error(`mcp http on http://${BIND}:${HTTP_PORT} (bearer-gated, ${TOOLS.size} tools)`));

  /* ⭐ AUTOSTART: a supervised MCP process should come back serving, not waiting to be asked. */
  if (process.env.PRESENTER_AUTOSTART === '1') {
    const start = activeTools().find((t) => t.name === 'presenter_start');
    if (start) {
      try { const r = await start.handler({ profile: process.env.PRESENTER_PROFILE || 'rpg', tunnel: false, voice: /^(1|true|on|yes)$/i.test(String(process.env.PRESENTER_VOICE_ENABLED || '')) });
            console.error('autostart:', JSON.stringify(r)); }
      catch (e) { console.error('autostart FAILED:', e && e.message); }
    }
  }
}
