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

    /*
     * ── SHARED STATE: READ ──────────────────────────────────────────────────────────────────
     * `op` (write) and `subscribeState` (observe) have existed since 0435. The missing third
     * verb was READ — a component could learn that a value CHANGED but never what it IS, so a
     * control mounted onto an existing slice came up blank and stayed blank until someone else
     * moved it. The host already relays a full snapshot into every content frame on load, and
     * folds each diff into it; nothing new crosses the boundary here. This just retains what
     * already arrives so a component can ask.
     *
     * ⛔ The cache is what THIS VIEWER MAY READ, not the store. Reads are default-deny and
     * filtered server-side (app/permissions.mjs), so an absent path means "not visible to you"
     * and never "not set". Do not treat undefined as a value.
     */
    _state: {},
    _stateReady: false,

    /** Current value at `path` ('a/b/c'), or `dflt` if absent/not visible. */
    state: function (path, dflt) {
      var o = Argus._state;
      if (!path) return o;
      var parts = String(path).split('/');
      for (var i = 0; i < parts.length; i++) {
        if (o == null || typeof o !== 'object') return dflt;
        o = o[parts[i]];
      }
      return o === undefined ? dflt : o;
    },

    /*
     * ── SHARED STATE: BIND ──────────────────────────────────────────────────────────────────
     * ⭐ THE CLOSURE. Makes ANY HTML form control a shared, server-authoritative control:
     * select, input (text/number/checkbox/radio/range/color/date), textarea. One call wires
     * both directions — local edit → store op → server → every viewer's diff → their element.
     *
     * This is deliberately NOT a component. A component is a thing we ship; a binding is a
     * property an author can give to markup they wrote five seconds ago. `<select data-ap-bind=
     * "shared/course">` is the whole API from the page's side.
     *
     * Returns an unbind fn.
     *
     * ⚠ THREE HAZARDS, each of which produced a visible bug before it was handled:
     *  1. ECHO — our own op comes back as a diff. Re-setting .value on the element the user is
     *     mid-interaction with is at best a no-op and at worst moves their cursor. We track the
     *     last value WE sent and ignore a diff that matches it.
     *  2. FOCUS STOMP — a remote change landing while this user is typing must not overwrite the
     *     field under their hands. Text-like inputs defer the remote value until blur; discrete
     *     controls (select/checkbox/radio/range) apply immediately, because that is what "shared"
     *     means for them and there is no half-typed state to lose.
     *  3. EVENT CHOICE — 'change' fires on commit, 'input' on every keystroke. Discrete controls
     *     bind 'change' (one op per decision); continuous ones ('range', text) bind 'input' and
     *     THROTTLE, or a slider drag becomes 200 store writes.
     */
    bind: function (elOrSel, path, opts) {
      opts = opts || {};
      var el = typeof elOrSel === 'string' ? global.document.querySelector(elOrSel) : elOrSel;
      if (!el || !path) return function () {};

      var type = (el.type || el.tagName || '').toLowerCase();
      var isCheck = type === 'checkbox';
      var isRadio = type === 'radio';
      var continuous = type === 'range' || opts.event === 'input';
      var textish = /^(text|search|url|email|tel|password|number|textarea)$/.test(type) && !continuous;
      var evName = opts.event || (continuous ? 'input' : 'change');
      var throttleMs = opts.throttle == null ? (continuous ? 80 : 0) : opts.throttle;
      var verb = opts.verb || 'set';

      function readEl() {
        if (isCheck) return !!el.checked;
        if (isRadio) return el.checked ? el.value : undefined;
        if (type === 'number' || type === 'range') { var n = parseFloat(el.value); return isNaN(n) ? null : n; }
        return el.value;
      }
      function writeEl(v) {
        if (v === undefined || v === null) return;
        if (isCheck) { el.checked = !!v; return; }
        if (isRadio) { el.checked = (String(el.value) === String(v)); return; }
        if (String(el.value) !== String(v)) el.value = v;
      }

      var lastSent, pending = null, timer = null, deferred;

      function push() {
        var v = readEl();
        if (v === undefined) return;              // unchecked radio: not this element's business
        lastSent = v;
        Argus.op(path, verb, v);
        if (opts.onSend) try { opts.onSend(v); } catch (e) {}
      }
      function onEdit() {
        if (!throttleMs) return push();
        pending = true;
        if (timer) return;
        timer = global.setTimeout(function () { timer = null; if (pending) { pending = false; push(); } }, throttleMs);
      }
      el.addEventListener(evName, onEdit);

      /*
       * Seed from current shared state.
       *
       * ⛔⛔ THE SNAPSHOT ARRIVES AFTER MOUNT. The host relays it by postMessage when the content
       * frame loads, and postMessage is a task — it cannot be delivered while the page's own
       * bootstrap script is still running. So at bind() time the cache is usually EMPTY, and a
       * control that seeds once, synchronously, comes up showing the markup default while the
       * store says something else. That looks exactly like "binding is broken" and it is not:
       * it is a race, and it resolves a few milliseconds later with nobody watching.
       *
       * ⇒ Seed now IF state is already known, and ALSO seed on the first snapshot that arrives —
       * but never over a value the user has already touched, or a slow snapshot would silently
       * undo their first action.
       */
      var seeded = false, touched = false;
      function seedFrom(v) {
        if (touched || v === undefined) return;
        writeEl(v); seeded = true;
        if (opts.onRemote) try { opts.onRemote(v); } catch (e) {}
      }
      el.addEventListener(evName, function () { touched = true; });

      var seed = Argus.state(path);
      if (seed !== undefined) seedFrom(seed);
      else if (opts.initial !== undefined) writeEl(opts.initial);

      function onStateEvt() {
        if (seeded || touched) return;
        var v = Argus.state(path);
        if (v !== undefined) seedFrom(v);
      }
      global.addEventListener(NS + ':state', onStateEvt);

      function onBlur() { if (deferred !== undefined) { writeEl(deferred); deferred = undefined; } }
      if (textish) el.addEventListener('blur', onBlur);

      var unsub = Argus.subscribeState(path, function (p, v) {
        if (p !== path) return;
        if (lastSent !== undefined && String(v) === String(lastSent)) return;   // hazard 1: our own echo
        if (textish && global.document.activeElement === el) { deferred = v; return; }   // hazard 2
        writeEl(v);
        if (opts.onRemote) try { opts.onRemote(v); } catch (e) {}
      });

      return function () {
        el.removeEventListener(evName, onEdit);
        if (textish) el.removeEventListener('blur', onBlur);
        global.removeEventListener(NS + ':state', onStateEvt);
        if (timer) global.clearTimeout(timer);
        unsub();
      };
    },

    /*
     * ── LOCKS: DATA INTEGRITY FOR A FIELD TWO PEOPLE CAN REACH ─────────────────────────────────
     * The store's `lock` verb writes `<path>/lock = ownerId`, and the server now REFUSES a write
     * to a locked path (or anything under it) from anyone else. These are the client's half.
     *
     * ⛔ Enforcement alone is a bad experience: the user types, and their edit vanishes with no
     *   explanation. A shared control should REFUSE TO LOOK EDITABLE while someone else holds it.
     *   So `bindLocked` disables the element for non-holders and claims on focus.
     */

    /** Who holds the lock governing `path` (this path or an ancestor)? null if free. */
    lockOwner: function (path) {
      var parts = String(path).split('/').filter(Boolean);
      for (var n = parts.length; n > 0; n--) {
        var seg = parts.slice(0, n);
        var base = seg.join('/');
        if (base === 'lock' || base.slice(-5) === '/lock' || seg.indexOf('_locks') >= 0) continue;
        /* Two storage shapes, deliberately (see app/state.mjs): a RECORD keeps its owner at
           <path>/lock; a LEAF keeps it at <parent>/_locks/<leaf>, so locking a scalar cannot
           overwrite the scalar. Check both — a path may be either. */
        var rec = Argus.state(base + '/lock');
        if (typeof rec === 'string' && rec) return rec;
        var leaf = seg[seg.length - 1];
        var parent = seg.slice(0, -1).join('/');
        var lf = Argus.state((parent ? parent + '/' : '') + '_locks/' + leaf);
        if (typeof lf === 'string' && lf) return lf;
      }
      return null;
    },

    /** Do I hold the lock governing `path`? (Free counts as NOT held.) */
    holdsLock: function (path) {
      var me = (Argus.identity() || {}).userId;
      return !!me && Argus.lockOwner(path) === me;
    },

    claim:   function (path) { Argus.op(path, 'lock', {}); },
    release: function (path) { Argus.op(path, 'unlock', null); },

    /**
     * A bound control WITH mutual exclusion. Claims on focus, releases on blur, and stays
     * disabled while anyone else holds it — so two crew cannot both be editing one field.
     *
     * ⚠ A claim is not instant: the op round-trips. The element is therefore not enabled by this
     *   function at all — it is enabled by the DIFF that confirms the claim landed. Enabling
     *   optimistically is how you get two clients both believing they won.
     */
    bindLocked: function (elOrSel, path, opts) {
      opts = opts || {};
      var el = typeof elOrSel === 'string' ? global.document.querySelector(elOrSel) : elOrSel;
      if (!el || !path) return function () {};
      var lockPath = opts.lockPath || path;
      var off = Argus.bind(el, path, opts);

      function paint() {
        var owner = Argus.lockOwner(lockPath);
        var me = (Argus.identity() || {}).userId;
        var mine = owner === me;
        var blocked = !!owner && !mine;
        el.disabled = blocked;
        el.setAttribute('data-ap-lock', blocked ? 'held' : (mine ? 'mine' : 'free'));
        if (blocked) el.setAttribute('title', 'being edited by ' + owner);
        else el.removeAttribute('title');
        if (opts.onLock) try { opts.onLock({ owner: owner, mine: mine, blocked: blocked }); } catch (e) {}
      }
      function onFocus() { if (!Argus.lockOwner(lockPath)) Argus.claim(lockPath); }
      function onBlur()  { if (Argus.holdsLock(lockPath)) Argus.release(lockPath); }

      el.addEventListener('focus', onFocus);
      el.addEventListener('blur', onBlur);
      var un = Argus.subscribeState(lockPath, paint);
      global.addEventListener(NS + ':state', paint);
      paint();

      return function () {
        off(); un();
        el.removeEventListener('focus', onFocus);
        el.removeEventListener('blur', onBlur);
        global.removeEventListener(NS + ':state', paint);
        if (Argus.holdsLock(lockPath)) Argus.release(lockPath);
      };
    },

    /**
     * Bind every `[data-ap-bind]` element on the page in one call — the declarative form, so
     * authored HTML needs no script of its own. `data-ap-bind` is the path; `data-ap-bind-opts`
     * is optional JSON. Returns an unbind-all fn. Idempotent: an element already bound is skipped.
     */
    bindAll: function (root) {
      var scope = root || global.document;
      var offs = [];
      var list = scope.querySelectorAll('[data-ap-bind]');
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (e.__apBound) continue;
        var o = {};
        try { o = JSON.parse(e.getAttribute('data-ap-bind-opts') || '{}'); } catch (err) {}
        e.__apBound = true;
        /* data-ap-lock (present, any value) opts this control into mutual exclusion; a non-empty
           value names the path to lock, so several fields can share one record-level lock. */
        if (e.hasAttribute('data-ap-lock-path') || e.hasAttribute('data-ap-locked')) {
          var lp = e.getAttribute('data-ap-lock-path');
          offs.push(Argus.bindLocked(e, e.getAttribute('data-ap-bind'), Object.assign({}, o, lp ? { lockPath: lp } : {})));
        } else {
          offs.push(Argus.bind(e, e.getAttribute('data-ap-bind'), o));
        }
      }
      return function () { for (var j = 0; j < offs.length; j++) offs[j](); };
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

  /*
   * Keep `Argus._state` current from the messages the host ALREADY sends: a full `snapshot` on
   * frame load (and on reconnect), then a path-keyed `diff` per change. A null value in a diff
   * means the path was removed. Installed at load, before any component runs, so a component's
   * first `Argus.state()` call sees the snapshot rather than racing it.
   */
  (function wireStateCache() {
    function setPath(root, path, v) {
      var parts = String(path).split('/').filter(Boolean);
      if (!parts.length) return;
      var o = root;
      for (var i = 0; i < parts.length - 1; i++) {
        if (typeof o[parts[i]] !== 'object' || o[parts[i]] === null) o[parts[i]] = {};
        o = o[parts[i]];
      }
      var leaf = parts[parts.length - 1];
      if (v === null) { try { delete o[leaf]; } catch (e) {} } else o[leaf] = v;
    }
    Argus.onMessage(function (d) {
      if (!d) return;
      if (d.type === 'snapshot' && d.state && typeof d.state === 'object') {
        Argus._state = d.state; Argus._stateReady = true;
        try { global.dispatchEvent(new CustomEvent(NS + ':state', { detail: { kind: 'snapshot' } })); } catch (e) {}
        return;
      }
      /* ⭐ IDENTITY CAN CHANGE MID-PAGE. The host relays a rename here; without this the frame
         keeps whatever it was stamped with at push time. `configure` is idempotent, and the
         event lets a component re-render its own label without polling. */
      if (d.type === 'identity') {
        Argus.configure({ userId: d.userId != null ? d.userId : ctx.userId,
                          userName: d.userName != null ? d.userName : ctx.userName });
        try { global.dispatchEvent(new CustomEvent(NS + ':identity', { detail: Argus.identity() })); } catch (e) {}
        try { global.dispatchEvent(new CustomEvent(NS + ':state', { detail: { kind: 'identity' } })); } catch (e) {}
        return;
      }
      if (d.type === 'diff' && d.diff) {
        for (var p in d.diff) if (Object.prototype.hasOwnProperty.call(d.diff, p)) setPath(Argus._state, p, d.diff[p]);
        Argus._stateReady = true;
        try { global.dispatchEvent(new CustomEvent(NS + ':state', { detail: { kind: 'diff', diff: d.diff } })); } catch (e) {}
      }
    });
  })();

  // UMD-ish exposure
  if (typeof module !== 'undefined' && module.exports) module.exports = Argus;
  global.Argus = Argus;
})(typeof window !== 'undefined' ? window : this);
