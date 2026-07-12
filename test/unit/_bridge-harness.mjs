/*
 * Load lib/bridge.js in Node with a minimal fake `window` so its client API can be
 * unit-tested. Standalone mode (parent === self) => send() dispatches an
 * 'argus-presenter:message' CustomEvent we can capture; host messages are injected
 * by dispatching an 'argus-presenter:host' event with { source:'argus-host', ... }.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadBridge() {
  const src = readFileSync(join(ROOT, 'lib', 'bridge.js'), 'utf8');
  const listeners = {};
  const win = {
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
    dispatchEvent: (e) => { (listeners[e.type] || []).slice().forEach((f) => f(e)); return true; },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  };
  win.parent = win;          // parent === self => standalone (not embedded)
  // eslint-disable-next-line no-new-func
  const boot = new Function('window', 'module', src + '\n;return window.Argus;');
  const Argus = boot(win, { exports: {} });
  // Capture outbound messages (source === 'argus-presenter').
  const outbound = [];
  win.addEventListener('argus-presenter:message', (e) => outbound.push(e.detail));
  // Helper to inject a host message (e.g. a server diff).
  const injectHost = (msg) => win.dispatchEvent(new win.CustomEvent('argus-presenter:host', { detail: Object.assign({ source: 'argus-host' }, msg) }));
  return { Argus, outbound, injectHost, win };
}
