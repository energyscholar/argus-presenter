/*!
 * Argus Presenter — result bridge
 * Zero-dependency. The ONE channel a pushed interactive component uses to send
 * results back out. Works in two contexts automatically:
 *   1. Embedded (component runs inside an iframe on the presenter/harness):
 *      postMessage to the parent window, tagged with source === NS.
 *   2. Standalone (component runs at top level, e.g. a direct test page):
 *      dispatch a CustomEvent on window so a same-page listener catches it.
 *
 * Message shape (see docs/patterns/result-protocol.md):
 *   { source:'argus-presenter', type, value, promptId?, channel?, contentId?, ts }
 *
 * Design intent: this mirrors Plan 0433 F8 (postMessage + promptId correlation)
 * so components built here drop straight into the standalone Presenter later.
 */
(function (global) {
  'use strict';
  var NS = 'argus-presenter';

  // Identity stamped on every message. The host (presenter shell) sets these on
  // the wrapper per user; components never invent them. Multi-user by default:
  //   userId/userName — WHO acted (participant identity, from the host)
  //   channel         — which display/panel (one per connected user)
  //   contentId       — which pushed content instance (a given ask/poll)
  var ctx = { channel: null, contentId: null, userId: null, userName: null };
  var opSeq = 0;   // per-page op counter (component -> unique-ish opId; server namespaces by conn)

  function send(msg) {
    msg.source = NS;
    if (msg.channel == null && ctx.channel != null) msg.channel = ctx.channel;
    if (msg.contentId == null && ctx.contentId != null) msg.contentId = ctx.contentId;
    if (msg.userId == null && ctx.userId != null) msg.userId = ctx.userId;
    if (msg.userName == null && ctx.userName != null) msg.userName = ctx.userName;
    if (!msg.ts) msg.ts = Date.now();
    // In-page bus: same-page sibling components can react (Observer). Always fires,
    // independent of the outbound host channel — enables reactive scenes.
    try { global.dispatchEvent(new CustomEvent(NS + ':local', { detail: msg })); } catch (e) {}
    var embedded = false;
    try { embedded = !!(global.parent && global.parent !== global); } catch (e) { embedded = false; }
    if (embedded) {
      // '*' target here; the SHELL is responsible for validating event.origin
      // and msg.source before trusting a message. Documented in result-protocol.md.
      try { global.parent.postMessage(msg, '*'); return; } catch (e) { /* fall through */ }
    }
    try { global.dispatchEvent(new CustomEvent(NS + ':message', { detail: msg })); } catch (e) {}
  }

  var Argus = {
    NS: NS,

    /** Configure identity the host wants stamped on outgoing messages. */
    configure: function (opts) {
      if (!opts) return;
      if ('channel' in opts) ctx.channel = opts.channel;
      if ('contentId' in opts) ctx.contentId = opts.contentId;
      if ('userId' in opts) ctx.userId = opts.userId;
      if ('userName' in opts) ctx.userName = opts.userName;
    },
    identity: function () { return { userId: ctx.userId, userName: ctx.userName, channel: ctx.channel }; },

    /** Fire-and-forget event. type is a short string, value any JSON-safe data. */
    emit: function (type, value) { send({ type: type, value: value }); },

    /**
     * OP PROTOCOL (Plan 0435). Dispatch a path-addressed op to the core store via
     * the host relay: { type:'op', path, verb, value, opId }. verb ∈
     * set|merge|add|remove|lock|unlock|clear. Returns the client opId (the server
     * namespaces it by connection, S5). Identity (userId) is stamped by send().
     */
    op: function (path, verb, value) {
      var opId = (ctx.userId || 'anon') + ':' + (++opSeq) + ':' + Math.random().toString(36).slice(2, 8);
      send({ type: 'op', path: path, verb: verb, value: value, opId: opId });
      return opId;
    },

    /** Answer a correlated prompt. promptId ties the answer to a specific ask(). */
    answer: function (promptId, value, extra) {
      var m = { type: 'answer', promptId: promptId, value: value };
      if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) m[k] = extra[k];
      send(m);
    },

    /** Signal the component is mounted and ready (host can start a timer, etc.). */
    ready: function (promptId, meta) { send({ type: 'ready', promptId: promptId || null, value: meta || null }); },

    /**
     * COMPONENT SIDE. Receive messages FROM the host (e.g. live poll updates,
     * state changes). Host messages carry source === 'argus-host'. Returns an
     * unsubscribe fn. Works embedded (parent postMessage) and standalone
     * (window.postMessage-to-self, or an 'argus-presenter:host' CustomEvent).
     */
    onMessage: function (handler) {
      function onWin(ev) { var d = ev && ev.data; if (d && d.source === 'argus-host') handler(d, ev); }
      function onLocal(ev) { var d = ev && ev.detail; if (d && d.source === 'argus-host') handler(d, ev); }
      global.addEventListener('message', onWin);
      global.addEventListener('argus-presenter:host', onLocal);
      return function () { global.removeEventListener('message', onWin); global.removeEventListener('argus-presenter:host', onLocal); };
    },

    /**
     * COMPONENT SIDE (OP PROTOCOL). Subscribe to STATE DIFFS for a path prefix.
     * Filters host messages to type==='diff' and invokes handler(path, value, msg)
     * for each changed path at/under `prefix` (segment-aware; '' = all). Returns an
     * unsubscribe fn. A value of null in a diff means the path was removed.
     */
    subscribeState: function (prefix, handler) {
      return Argus.onMessage(function (d) {
        if (!d || d.type !== 'diff' || !d.diff) return;
        for (var p in d.diff) {
          if (!Object.prototype.hasOwnProperty.call(d.diff, p)) continue;
          if (prefix && !(p === prefix || p.indexOf(prefix + '/') === 0)) continue;
          handler(p, d.diff[p], d);
        }
      });
    },

    /**
     * COMPONENT SIDE. Subscribe to the in-page bus — react to sibling components'
     * emits/answers on the same surface (e.g. an SVG reacting to a slider). Returns
     * an unsubscribe fn. handler(msg).
     */
    subscribe: function (handler) {
      function h(ev) { handler(ev.detail, ev); }
      global.addEventListener(NS + ':local', h);
      return function () { global.removeEventListener(NS + ':local', h); };
    },

    /**
     * HOST SIDE. Subscribe to component messages. Returns an unsubscribe fn.
     * handler(msg, event). Filters on source === NS. In production the host
     * should ALSO check event.origin against an allowlist before calling this.
     */
    listen: function (handler) {
      function onWin(ev) {
        var d = ev && ev.data;
        if (d && d.source === NS) handler(d, ev);
      }
      function onLocal(ev) {
        var d = ev && ev.detail;
        if (d && d.source === NS) handler(d, ev);
      }
      global.addEventListener('message', onWin);
      global.addEventListener(NS + ':message', onLocal);
      return function () {
        global.removeEventListener('message', onWin);
        global.removeEventListener(NS + ':message', onLocal);
      };
    }
  };

  // UMD-ish exposure
  if (typeof module !== 'undefined' && module.exports) module.exports = Argus;
  global.Argus = Argus;
})(typeof window !== 'undefined' ? window : this);
