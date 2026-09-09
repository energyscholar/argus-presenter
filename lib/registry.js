/*!
 * Argus Presenter — component registry (zero-dependency).
 * Components self-register by name so MANY can coexist on one page and so
 * plugins can add their own. Replaces the single `window.ApComponent`.
 *
 *   ApComponents.register('choice', function(root, opts){ ... return handle; });
 *   var handle = ApComponents.mount('choice', el, opts);
 */
(function (global) {
  'use strict';
  var reg = {};
  /*
   * ── ⛔⛔ THE HANDLE NOBODY KEPT (plan 0720 RUN A / F12) ────────────────────────────────────────
   *
   * Every component returns a handle whose `destroy` unsubscribes and unbinds. It works. It was
   * simply never called on the two paths that matter: `harness/assemble.mjs` mounts and throws the
   * handle away, and a station that re-renders its own region calls `mount` again on the SAME
   * element. The old DOM goes away with the innerHTML; the store subscriptions, the window pointer
   * listeners and the MutationObserver do not, because none of them are owned by the DOM.
   *
   * ⇒ The leak is per RE-PROJECTION, so it is invisible at a glance and compounds over a session:
   * two projections mean every diff runs two reconcilers, one of them painting a detached tree.
   *
   * ⭐ FIXING IT IN THE CALLER WOULD HAVE TO BE REMEMBERED BY EVERY FUTURE CALLER. Fixing it here
   * is structural: the registry remembers what it mounted where, and mounting over something tears
   * that something down first. A caller that keeps its own handle and destroys it (scene, stepper)
   * is unaffected — `destroy` forgets the entry BEFORE invoking it, so a second call is a no-op
   * rather than a double teardown.
   *
   * ⚠ A WeakMap, so a host element that is discarded takes its entry with it. Where WeakMap is
   * absent the registry simply does not track, and behaviour is exactly what it was before.
   */
  var HANDLES = typeof WeakMap === 'function' ? new WeakMap() : null;
  var API = {
    register: function (name, factory) { reg[name] = factory; return API; },
    has: function (name) { return !!reg[name]; },
    get: function (name) { return reg[name]; },
    all: function () { return Object.keys(reg); },
    /*
     * ⭐⭐⭐ THE MOUNT LEDGER — every mount attempt is recorded, and every MISSED one is recorded
     * separately. Since 2026-09-09 the assembler ships only the components a page declares it
     * mounts (`componentDeps`), which turns "I forgot to declare a dependency" into a real
     * failure mode. It used to surface as the words `Unknown component: x` written into a panel
     * nobody was reading, on a board that otherwise looked fine.
     *
     * ⛔ `__apMissing` IS THE SIGNAL THAT A DEPENDENCY IS UNDECLARED. It is the difference between
     * measuring what a board needs and guessing it from a grep of quoted strings — which is how
     * the first componentDeps map was written, and is exactly as reliable as it sounds.
     * ⚠ Recording only; it never changes what mounts. The visible fallback text is unchanged.
     */
    mount: function (name, root, opts) {
      var f = reg[name];
      try {
        (global.__apMounted || (global.__apMounted = [])).push(name);
        if (!f) (global.__apMissing || (global.__apMissing = [])).push(name);
      } catch (e) { /* a diagnostic must never be the reason a mount fails */ }
      if (!f) { if (root) root.textContent = 'Unknown component: ' + name; return null; }
      API.destroy(root);                     // ⛔ mounting OVER something tears that something down
      var h = f(root, opts || {}) || null;
      if (HANDLES && root) HANDLES.set(root, h);
      return h;
    },
    /** The handle `mount` returned for this host, for a caller that did not keep it. */
    handleFor: function (root) { return (HANDLES && root && HANDLES.get(root)) || null; },
    /** Tear down whatever `mount` last put on this host. Idempotent; safe on an unmounted host. */
    destroy: function (root) {
      if (!HANDLES || !root) return false;
      var h = HANDLES.get(root);
      if (!h) return false;
      HANDLES['delete'](root);               // forget FIRST: a re-entrant destroy must not recurse
      if (typeof h.destroy !== 'function') return false;
      try { h.destroy(); } catch (e) { /* a component that throws on teardown must not block the next mount */ }
      return true;
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.ApComponents = API;
})(typeof window !== 'undefined' ? window : this);
