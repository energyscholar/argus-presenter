/*!
 * lib/log.mjs — client-side logger (browser IIFE, inlined by assemble.mjs).
 * Levels error|warn|info|debug|trace, per-subsystem tag, flag-gated by
 * `?log=debug` (query) or a global `AP_LOG`. Keeps a small ring for the debug
 * overlay (T3). Below-threshold lines are suppressed. Mirrors lib/bridge.js UMD.
 */
(function (global) {
  'use strict';
  var LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
  var MAX = 200;
  var ring = [];

  function threshold() {
    var l = 'warn';
    try { var q = new URLSearchParams(global.location.search); if (q.get('log')) l = q.get('log'); } catch (e) {}
    if (global.AP_LOG) l = global.AP_LOG;
    return (l in LEVELS) ? LEVELS[l] : LEVELS.warn;
  }

  function log(level, tag, msg, fields) {
    if ((level in LEVELS ? LEVELS[level] : 99) > threshold()) return null;
    var e = { ts: Date.now(), level: level, tag: tag, msg: String(msg), fields: fields || {} };
    ring.push(e); if (ring.length > MAX) ring.shift();
    try { var c = global.console; if (c) (c[level] || c.log).call(c, '[ap:' + tag + '] ' + msg, fields || ''); } catch (_) {}
    return e;
  }

  var ApLog = {
    log: log,
    ring: function () { return ring.slice(); },
    setMax: function (n) { MAX = n; },
    error: function (t, m, f) { return log('error', t, m, f); },
    warn:  function (t, m, f) { return log('warn',  t, m, f); },
    info:  function (t, m, f) { return log('info',  t, m, f); },
    debug: function (t, m, f) { return log('debug', t, m, f); },
    trace: function (t, m, f) { return log('trace', t, m, f); }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ApLog;
  global.ApLog = ApLog;
})(typeof window !== 'undefined' ? window : this);
