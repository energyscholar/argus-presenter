#!/usr/bin/env node
/*
 * mcp/server.mjs — MCP stdio server exposing the Argus Presenter tool surface.
 * Wraps the framework-agnostic tools in mcp/tools.mjs with the official SDK.
 * Deploy: `cd mcp && npm i` then register this script as an MCP server.
 * (Not run by the headless tests — those exercise tools.mjs handlers directly.)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
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
 * ⭐ v0 ALREADY SOLVED THIS and we regressed. `starship-operations/mcp-vtt-control` holds
 *   `activeBase = process.env.VTT_URL` and an `attach` tool taking a URL — the MCP there is a thin
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
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);
  createHttpServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return;
    }
    let body;
    if (req.method === 'POST') {
      const chunks = []; for await (const c of req) chunks.push(c);
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { body = undefined; }
    }
    await transport.handleRequest(req, res, body);
  }).listen(HTTP_PORT, BIND, () => console.error(`mcp http on http://${BIND}:${HTTP_PORT} (bearer-gated)`));

  /* ⭐ AUTOSTART: a supervised MCP process should come back serving, not waiting to be asked. */
  if (process.env.PRESENTER_AUTOSTART === '1') {
    const start = activeTools().find((t) => t.name === 'presenter_start');
    if (start) {
      try { const r = await start.handler({ profile: process.env.PRESENTER_PROFILE || 'rpg', tunnel: false, voice: false });
            console.error('autostart:', JSON.stringify(r)); }
      catch (e) { console.error('autostart FAILED:', e && e.message); }
    }
  }
}
