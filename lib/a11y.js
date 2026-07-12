/*!
 * Argus Presenter — accessibility helpers (zero-dependency).
 * Small, reusable primitives so every component gets keyboard + SR support
 * without re-deriving it each time. This is the anti-brittleness layer.
 */
(function (global) {
  'use strict';

  var _id = 0;
  function uid(prefix) { return (prefix || 'ap') + '-' + (Date.now().toString(36)) + '-' + (_id++); }

  var reducedMotion = false;
  try { reducedMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  /**
   * Roving-tabindex arrow navigation over a set of elements (radio/toolbar/listbox
   * style). Follows the ARIA APG radio pattern: arrows move + select; only the
   * active item is tabbable. Returns {select(i), destroy()}.
   *
   * opts: { orientation:'horizontal'|'vertical'|'both', loop:true,
   *         selectOnMove:true, onSelect(index,el) }
   */
  function rovingGroup(container, items, opts) {
    opts = opts || {};
    var orient = opts.orientation || 'both';
    var loop = opts.loop !== false;
    var selectOnMove = opts.selectOnMove !== false;
    var current = 0;

    function tabindexes() {
      for (var i = 0; i < items.length; i++) items[i].tabIndex = (i === current ? 0 : -1);
    }
    function select(i, focus) {
      if (i < 0 || i >= items.length) return;
      current = i;
      tabindexes();
      if (focus !== false) items[i].focus();
      if (opts.onSelect) opts.onSelect(i, items[i]);
    }
    function move(delta) {
      var n = items.length, i = current + delta;
      if (loop) i = (i + n) % n; else i = Math.max(0, Math.min(n - 1, i));
      select(i, true);
    }
    function onKey(e) {
      var k = e.key;
      var nextKeys = orient === 'vertical' ? ['ArrowDown'] : orient === 'horizontal' ? ['ArrowRight'] : ['ArrowRight', 'ArrowDown'];
      var prevKeys = orient === 'vertical' ? ['ArrowUp'] : orient === 'horizontal' ? ['ArrowLeft'] : ['ArrowLeft', 'ArrowUp'];
      if (nextKeys.indexOf(k) >= 0) { e.preventDefault(); move(1); }
      else if (prevKeys.indexOf(k) >= 0) { e.preventDefault(); move(-1); }
      else if (k === 'Home') { e.preventDefault(); select(0, true); }
      else if (k === 'End') { e.preventDefault(); select(items.length - 1, true); }
    }
    container.addEventListener('keydown', onKey);
    items.forEach(function (el, i) {
      el.addEventListener('click', function () { select(i, false); });
      el.addEventListener('focus', function () { if (!selectOnMove) current = i; });
    });
    tabindexes();
    return { select: select, get index() { return current; }, destroy: function () { container.removeEventListener('keydown', onKey); } };
  }

  /** Trap Tab focus within a container (for modals). Returns { release() }. */
  function trapFocus(container) {
    var SEL = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';
    function onKey(e) {
      if (e.key !== 'Tab') return;
      var f = Array.prototype.filter.call(container.querySelectorAll(SEL), function (el) { return el.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    container.addEventListener('keydown', onKey);
    return { release: function () { container.removeEventListener('keydown', onKey); } };
  }

  /** Announce a message to screen readers via a shared polite live region. */
  function announce(msg) {
    var r = document.getElementById('ap-live');
    if (!r) {
      r = document.createElement('div');
      r.id = 'ap-live';
      r.setAttribute('aria-live', 'polite');
      r.setAttribute('aria-atomic', 'true');
      r.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;';
      document.body.appendChild(r);
    }
    r.textContent = '';
    // rAF so repeated identical messages still re-announce
    global.requestAnimationFrame(function () { r.textContent = msg; });
  }

  var A11y = { uid: uid, reducedMotion: reducedMotion, rovingGroup: rovingGroup, trapFocus: trapFocus, announce: announce };
  if (typeof module !== 'undefined' && module.exports) module.exports = A11y;
  global.ApA11y = A11y;
})(typeof window !== 'undefined' ? window : this);
