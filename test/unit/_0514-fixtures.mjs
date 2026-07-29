/*
 * _0514-fixtures.mjs — shared scaffolding for the Plan 0514 station tests.
 *
 * Registers NO tests (the leading underscore + this note; cf. _bridge-harness.mjs). It builds
 * THROWAWAY plugin trees in a temp dir and points PRESENTER_PLUGINS_DIR at them, so a test can
 * assert what a DIFFERENT deployment does — a teaching deployment with no stations at all, two
 * plugins fighting over the registry, a plugin whose server module throws — without touching the
 * installed plugin or inventing a createServer option for it.
 *
 * The env var (rather than an option) is deliberate: it mirrors PRESENTER_MODULES_DIR, and it
 * keeps the 0488 surface-coverage contract honest — a new createServer option would have to be
 * reachable from an MCP tool, and "where the plugins live" is deployment wiring, not a session
 * capability an agent should drive.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The REAL, installed plugin tree — what a live deployment actually runs. */
export const REAL_PLUGINS = join(ROOT, 'plugins');

/**
 * Build a temp plugins dir. `plugins` = { <pluginName>: { <relFile>: string|object } }.
 * Returns the absolute directory.
 */
export function makePluginsDir(plugins) {
  const dir = mkdtempSync(join(tmpdir(), 'ap-0514-'));
  for (const [name, files] of Object.entries(plugins)) {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, name, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    }
  }
  return dir;
}

/** Run `fn` with PRESENTER_PLUGINS_DIR pointed at `dir`, restoring it afterwards no matter what. */
export async function withPlugins(dir, fn) {
  const prev = process.env.PRESENTER_PLUGINS_DIR;
  process.env.PRESENTER_PLUGINS_DIR = dir;
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.PRESENTER_PLUGINS_DIR; else process.env.PRESENTER_PLUGINS_DIR = prev; }
}

/** A minimal well-formed station manifest, so a test can vary ONE thing at a time. */
export function stationManifest(over = {}) {
  return Object.assign({
    name: 'fixture',
    requires: [], components: [], presets: {}, fieldSchemas: {},
    stationSelectorLabel: 'Post',
    stationDefaultUid: 2,
    stations: [
      { stationUid: 1, stationCode: 'alpha', stationLabel: 'Alpha', group: 'One', icon: 'A', color: '#111', maxOccupants: 1, sortOrder: 1 },
      { stationUid: 2, stationCode: 'beta', stationLabel: 'Beta', group: 'Two', icon: 'B', color: '#222', maxOccupants: null, sortOrder: 2 },
    ],
  }, over);
}

// ── live websocket helpers ────────────────────────────────────────────────────────────────────
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Connect, hello with `hello`, and collect every frame. Resolves once the welcome has landed. */
export function connect(WebSocket, url, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const frames = [];
    ws.on('message', (b) => { try { frames.push(JSON.parse(b.toString())); } catch (e) {} });
    ws.on('open', () => {
      ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello)));
      setTimeout(() => resolve({ ws, frames, send: (m) => ws.send(JSON.stringify(m)), clear: () => { frames.length = 0; } }), 140);
    });
  });
}

/** Last frame of type `t`. */
export function last(conn, t) { return [...conn.frames].reverse().find((f) => f.t === t); }
