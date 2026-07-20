#!/usr/bin/env node
/*
 * mcp/server.mjs — MCP stdio server exposing the Argus Presenter tool surface.
 * Wraps the framework-agnostic tools in mcp/tools.mjs with the official SDK.
 * Deploy: `cd mcp && npm i` then register this script as an MCP server.
 * (Not run by the headless tests — those exercise tools.mjs handlers directly.)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

const transport = new StdioServerTransport();
await server.connect(transport);
