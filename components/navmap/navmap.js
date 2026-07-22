/*!
 * Argus Presenter component: NAVMAP — the system map, plus a SHIP TOKEN ANYONE CAN DRAG.
 *
 * Scoped deliberately: this does NOT modify the shared `map` component. It delegates rendering
 * to `map` and adds one draggable token on top, so if this is wrong only navmap beats suffer.
 *
 * WHY map/markers AND NOT map/tokens: app/permissions.mjs grants `participant` write on
 * `map/markers` (add/remove) but NOT on arbitrary paths, and `map/view` is controller-only.
 * Adding a new permitted path is a server change, which needs a full restart. Riding the
 * already-permitted markers slice with a well-known id gives EVERY seat drag rights today,
 * with no server change and no restart. Re-adding the same id overwrites it, so the marker map
 * behaves as a single shared token.
 *
 * Position is emitted on DROP, not during the drag: map.js renders a radar ping for every
 * marker add, and streaming at pointer rate would carpet the map in pings.
 *
 * opts = <map opts> + { tokenLabel?, tokenPx?, tokenPy?, tokenId? }
 */
(function () {
  'use strict';
  function render(root, opts) {
    opts = opts || {};
    var reg = window.ApComponents;
    var mapFactory = reg && reg.get && reg.get('map');
    if (!mapFactory) { root.textContent = 'navmap: base map component unavailable'; return { destroy: function () { root.innerHTML = ''; } }; }

    var handle = mapFactory(root, opts) || {};
    var Argus = window.Argus;
    var content = root.querySelector('.ap-map-content');
    if (!content) return handle;                       // base map changed shape — degrade to a plain map

    var ID = opts.tokenId || 'ship-ad';
    var label = opts.tokenLabel || 'AD';
    var pos = { px: (typeof opts.tokenPx === 'number' ? opts.tokenPx : 0.654),
                py: (typeof opts.tokenPy === 'number' ? opts.tokenPy : 0.345) };
    var scale = 1, subs = [], dragging = false;

    var tok = document.createElement('div');
    tok.className = 'ap-navmap-token';
    tok.setAttribute('title', 'drag to set course');
    tok.innerHTML = '<div class="ap-navmap-ship"></div><div class="ap-navmap-label"></div>';
    tok.querySelector('.ap-navmap-label').textContent = label;
    content.appendChild(tok);

    function place() {
      tok.style.left = (pos.px * 100) + '%';
      tok.style.top = (pos.py * 100) + '%';
      tok.style.transform = 'translate(-50%,-50%) scale(' + (1 / (scale || 1)) + ')';
    }
    place();

    function frac(ev) {
      var r = content.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { px: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)),
               py: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)) };
    }
    function emit() {
      if (!Argus || !Argus.op) return;
      Argus.op('map/markers', 'add', { id: ID, px: pos.px, py: pos.py, name: label, ship: true });
    }

    // Drag is open to EVERY role by design (Bruce, S210): the table moves the ship.
    tok.addEventListener('pointerdown', function (ev) {
      dragging = true; tok.classList.add('is-dragging');
      try { tok.setPointerCapture(ev.pointerId); } catch (e) {}
      ev.stopPropagation(); ev.preventDefault();       // don't let the map pan / drop a click marker
    });
    tok.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      var f = frac(ev); if (!f) return;
      pos = f; place(); ev.stopPropagation(); ev.preventDefault();
    });
    function end(ev) {
      if (!dragging) return;
      dragging = false; tok.classList.remove('is-dragging');
      try { tok.releasePointerCapture(ev.pointerId); } catch (e) {}
      emit();                                          // broadcast ONCE, on drop
      ev.stopPropagation();
    }
    tok.addEventListener('pointerup', end);
    tok.addEventListener('pointercancel', end);

    if (Argus && Argus.subscribeState) {
      subs.push(Argus.subscribeState('map/view', function (p, v) {
        if (v && v.scale) { scale = v.scale; place(); }
      }));
      subs.push(Argus.subscribeState('map/markers', function (p, v) {
        if (v && v.id === ID && !dragging) { pos = { px: v.px, py: v.py }; place(); }
      }));
    }

    return {
      setView: handle.setView, view: handle.view,
      destroy: function () {
        subs.forEach(function (u) { try { u(); } catch (e) {} });
        if (handle.destroy) handle.destroy(); else root.innerHTML = '';
      }
    };
  }
  if (window.ApComponents) window.ApComponents.register('navmap', render);
})();
