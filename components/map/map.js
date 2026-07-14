/*!
 * Argus Presenter component: MAP (interactive, shared) — v1 80% framework.
 * "Slide + laser pointer": a pan/zoomable surface. STORE-NATIVE (Plan 0435 E1-E4):
 * the PRESENTER controls pan/zoom (controllable:true) via op('map/view','set'),
 * mirrored to all viewers who subscribeState('map/view'). Peer clicks are
 * op('map/markers','add') (attributed markers); the laser pointer is an ephemeral
 * op('map/pointer/{self}','set'). No bespoke relay.
 *
 * DOMAIN-NEUTRAL CORE: ships NO domain art. Default content is a plain grid.
 * Domain visuals come from PRESETS registered by plugins (window.ApMapPresets);
 * a content module selects one via opts.preset, or supplies opts.image / opts.svg
 * directly. Core is plugin-agnostic — it never names a specific plugin.
 *
 * Designed for the full set (per-user cursors, click broadcast, tokens, layers)
 * WITHOUT building them: view is {x,y,scale}; content is a transformed layer;
 * pointer is a separate overlay; all messages go through the bridge.
 *
 * opts = { controllable?:bool, image?, svg?, preset?, label?, laser?:bool,
 *          cursors?:'all'|'off', x?,y?,scale? }
 * Patterns: State (view), Observer (emit/receive), Command-ready (message types).
 *
 * ANCHORING (Plan 0457 T2): markers + cursors are CONTENT-anchored — wire px/py
 * are fractions of the untransformed .ap-map-content box, elements live inside
 * .ap-map-content and counter-scale, so they stay pinned under pan/zoom. Legacy
 * pointer values (no name/laser field) still drive the single viewport dot.
 */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  function svgEl(t, a) { var e = document.createElementNS(NS, t); if (a) for (var k in a) e.setAttribute(k, a[k]); return e; }

  // Map preset registry (plugins register domain SVG providers here). Core owns
  // the registry but ships NO presets — domain art lives in plugins.
  var PRESETS = (window.ApMapPresets = window.ApMapPresets || (function () {
    var m = {};
    return { register: function (n, f) { m[n] = f; return this; }, get: function (n) { return m[n]; }, all: function () { return Object.keys(m); } };
  })());

  // Neutral default: a plain coordinate grid (domain-agnostic). Same -400..400
  // viewBox convention as presets so .ap-map-svg centering applies uniformly.
  function neutralGrid() {
    var svg = svgEl('svg', { viewBox: '-400 -400 800 800', class: 'ap-map-svg' });
    for (var i = -400; i <= 400; i += 80) {
      svg.appendChild(svgEl('line', { x1: i, y1: -400, x2: i, y2: 400, class: 'ap-map-grid-line' }));
      svg.appendChild(svgEl('line', { x1: -400, y1: i, x2: 400, y2: i, class: 'ap-map-grid-line' }));
    }
    svg.appendChild(svgEl('circle', { cx: 0, cy: 0, r: 5, class: 'ap-map-grid-dot' }));
    return svg;
  }

  function render(root, opts) {
    opts = opts || {};
    var Argus = window.Argus, controllable = !!opts.controllable;
    var cursorsMode = opts.cursors === 'off' ? 'off' : 'all';
    var view = { x: opts.x || 0, y: opts.y || 0, scale: opts.scale || 1 };
    function selfId() { return (Argus && Argus.identity && Argus.identity().userId) || 'anon'; }
    function selfName() { return (Argus && Argus.identity && Argus.identity().userName) || selfId(); }

    root.innerHTML = '';
    var wrap = document.createElement('div'); wrap.className = 'ap-map';
    if (opts.label) wrap.appendChild(Object.assign(document.createElement('div'), { className: 'ap-prompt', textContent: opts.label }));
    var viewport = document.createElement('div'); viewport.className = 'ap-map-viewport';
    var content = document.createElement('div'); content.className = 'ap-map-content';
    var presetFn = opts.preset && PRESETS.get(opts.preset);
    if (opts.image) { var im = document.createElement('img'); im.src = opts.image; im.className = 'ap-map-img'; content.appendChild(im); }
    else if (opts.svg) { var holder = document.createElement('div'); holder.innerHTML = opts.svg; var node = holder.querySelector('svg') || holder.firstElementChild; if (node) { node.classList.add('ap-map-svg'); content.appendChild(node); } else content.appendChild(neutralGrid()); }
    else if (presetFn) { content.appendChild(presetFn(svgEl)); }
    else content.appendChild(neutralGrid());
    var pointer = document.createElement('div'); pointer.className = 'ap-map-pointer'; pointer.style.display = 'none';
    viewport.appendChild(content); viewport.appendChild(pointer); wrap.appendChild(viewport); root.appendChild(wrap);

    // T4 (Plan 0457): when the map is THE pushed content (mounted directly on the
    // .ap-root host), lift the host's readable-column cap so the map fills the
    // display (full width, full height minus only the label bar).
    if (root.classList && root.classList.contains('ap-root')) root.classList.add('ap-fullbleed');

    // T1 (Plan 0457): styled tooltips. Content authors bake `data-tip` text into the
    // supplied svg/image overlay DOM; the component drives ONE shared floating panel.
    var tip = document.createElement('div'); tip.className = 'ap-map-tip'; tip.style.display = 'none';
    viewport.appendChild(tip);
    function hideTip() { tip.style.display = 'none'; }
    function fillTip(text) {
      tip.textContent = '';
      String(text).split('\n').forEach(function (line) {
        var d = document.createElement('div'); d.className = 'ap-map-tip-line'; d.textContent = line; tip.appendChild(d);
      });
    }
    function placeTip(e) {
      var r = viewport.getBoundingClientRect();
      var x = e.clientX - r.left + 14, y = e.clientY - r.top + 18;
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      if (x + tw > r.width - 4) x = e.clientX - r.left - 14 - tw;   // flip left near the right edge
      if (y + th > r.height - 4) y = e.clientY - r.top - 18 - th;   // flip above near the bottom edge
      if (x < 4) x = 4; if (y < 4) y = 4;
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }
    // Walk the supplied overlay DOM once; wire every [data-tip] node. A native SVG
    // <title> child on the same node is removed (no double tooltip); its text is
    // kept as aria-label for a11y.
    (function wireTips() {
      var nodes = content.querySelectorAll('[data-tip]');
      Array.prototype.forEach.call(nodes, function (n) {
        for (var c = n.firstElementChild; c; c = c.nextElementSibling) {
          if (c.tagName && String(c.tagName).toLowerCase() === 'title') { n.setAttribute('aria-label', c.textContent); n.removeChild(c); break; }
        }
        n.addEventListener('mouseenter', function (e) { fillTip(n.getAttribute('data-tip')); tip.style.display = 'block'; placeTip(e); });
        n.addEventListener('mousemove', function (e) { if (tip.style.display !== 'none') placeTip(e); });
        n.addEventListener('mouseleave', hideTip);
      });
    })();

    // T2 (Plan 0457): content-anchored elements (markers, cursors). Positioned by
    // content fraction × untransformed content size; counter-scaled so apparent
    // size is constant under zoom (element center sits exactly on the anchor).
    var anchored = [];
    function counterScale() { return 'translate(-50%, -50%) scale(' + (1 / (view.scale || 1)) + ')'; }
    function anchor(el, px, py) {
      el.style.left = (px * 100) + '%'; el.style.top = (py * 100) + '%';
      el.style.transform = counterScale();
      content.appendChild(el); anchored.push(el);
    }
    function unanchor(el) {
      var i = anchored.indexOf(el); if (i >= 0) anchored.splice(i, 1);
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    // Inverse of the current view transform: event coords -> content-box fraction.
    function contentFrac(cx, cy) {
      var r = content.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { px: (cx - r.left) / r.width, py: (cy - r.top) / r.height };
    }

    function apply() {
      content.style.transform = 'translate(' + view.x + 'px, ' + view.y + 'px) scale(' + view.scale + ')';
      hideTip();   // pan/zoom start hides the tooltip
      for (var i = 0; i < anchored.length; i++) anchored[i].style.transform = counterScale();
    }
    apply();

    // T4 (Plan 0457): size the content box from the art's INTRINSIC aspect
    // (SVG viewBox / image natural size) instead of a forced square, and start
    // ZOOM-TO-FIT (contain, centered) unless the module pinned an explicit view.
    function intrinsicSize() {
      var node = content.firstElementChild;
      var w = 0, h = 0;
      if (node) {
        var tag = node.tagName ? String(node.tagName).toLowerCase() : '';
        if (tag === 'svg') {
          var vb = node.viewBox && node.viewBox.baseVal;
          if (vb && vb.width && vb.height) { w = vb.width; h = vb.height; }
          else { w = parseFloat(node.getAttribute('width')) || 0; h = parseFloat(node.getAttribute('height')) || 0; }
        } else if (tag === 'img') { w = node.naturalWidth || 0; h = node.naturalHeight || 0; }
      }
      if (!w || !h) { w = 800; h = 800; }   // legacy square convention as fallback
      if (node) { node.style.width = w + 'px'; node.style.height = h + 'px'; }
      content.style.width = w + 'px'; content.style.height = h + 'px';
      return { w: w, h: h };
    }
    var hasExplicitView = opts.x != null || opts.y != null || opts.scale != null;
    var viewTouched = hasExplicitView;   // a live view (op/snapshot/drag) must not be refit later
    function zoomToFit() {
      // clientWidth/Height = the padding box content coords are relative to
      // (getBoundingClientRect would include the 1px border and skew centering).
      var vw = viewport.clientWidth, vh = viewport.clientHeight;
      if (!vw || !vh) return;
      var sz = intrinsicSize();
      var s = Math.min(vw / sz.w, vh / sz.h) || 1;
      view.scale = s;
      view.x = (vw - sz.w * s) / 2;
      view.y = (vh - sz.h * s) / 2;
      apply();
    }
    intrinsicSize();
    if (!hasExplicitView) zoomToFit();
    // Images know their natural size only after load: re-measure, refit if untouched.
    var imgNode = content.querySelector('img.ap-map-img');
    if (imgNode && !imgNode.complete) imgNode.addEventListener('load', function () {
      intrinsicSize(); if (!viewTouched) zoomToFit();
    });

    var lastView = 0, lastPtr = 0;
    function emitView(final) { if (!controllable || !Argus || !Argus.op) return; var n = Date.now(); if (!final && n - lastView < 66) return; lastView = n; Argus.op('map/view', 'set', { x: view.x, y: view.y, scale: view.scale }); }   // E1: store op (perm: presenter)

    // E3 pointer emission (shared mousetrack) — CONTENT-space fractions (T2).
    // Presenter emits when opts.laser !== false (laser feature); every other user
    // emits when opts.cursors !== 'off' (multi-cursor feature).
    function emitPointer(e) {
      var n = Date.now(); if (n - lastPtr < 66) return; lastPtr = n;
      if (!Argus || !Argus.op) return;
      var f = contentFrac(e.clientX, e.clientY); if (!f) return;
      var v = { px: f.px, py: f.py, name: selfName() };
      if (controllable) v.laser = true;
      Argus.op('map/pointer/' + selfId(), 'set', v);
    }
    if (controllable ? (opts.laser !== false) : (cursorsMode !== 'off')) viewport.addEventListener('mousemove', emitPointer);

    if (controllable) {
      var drag = false, sx = 0, sy = 0, ox = 0, oy = 0;
      viewport.addEventListener('mousedown', function (e) { drag = true; viewTouched = true; sx = e.clientX; sy = e.clientY; ox = view.x; oy = view.y; e.preventDefault(); });
      window.addEventListener('mousemove', function (e) { if (!drag) return; view.x = ox + (e.clientX - sx); view.y = oy + (e.clientY - sy); apply(); emitView(); });
      window.addEventListener('mouseup', function () { if (drag) { drag = false; emitView(true); } });
      viewport.addEventListener('wheel', function (e) { e.preventDefault(); viewTouched = true; view.scale = Math.max(0.3, Math.min(6, view.scale * (e.deltaY < 0 ? 1.1 : 0.9))); apply(); emitView(); }, { passive: false });
    }

    // Clicks are PEER-TO-PEER (the core feature): ANY user clicks -> ALL users see
    // a marker + the clicker's NAME. Users signal each other, not just teacher->student.
    var dnX = 0, dnY = 0, moved = false;
    viewport.addEventListener('mousedown', function (e) { dnX = e.clientX; dnY = e.clientY; moved = false; });
    viewport.addEventListener('mousemove', function (e) { if (Math.abs(e.clientX - dnX) > 4 || Math.abs(e.clientY - dnY) > 4) moved = true; });
    viewport.addEventListener('click', function (e) {   // E2: peer click -> store marker op (perm: any)
      if (moved || !Argus || !Argus.op) return;
      var f = contentFrac(e.clientX, e.clientY); if (!f) return;
      var mv = {
        id: 'mk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        px: f.px, py: f.py,
        name: (Argus.identity && Argus.identity().userName) || '?'
      };
      if (controllable) mv.laser = true;   // presenter ping uses the laser accent (T5; same field pattern as T2 pointers)
      Argus.op('map/markers', 'add', mv);
    });

    // T5 (Plan 0457): radar ping — 3 staggered expanding rings around a bright
    // center dot + the clicker's name tag. Lifetime ~5 s (full strength ~4 s,
    // fade over the last ~1 s, removed ~5.2 s). Content-anchored + counter-scaled
    // (T2). Ring color = the per-user tint; a presenter ping (laser) uses the
    // laser accent. CSS-only animation; only the two existing timers, retimed.
    function showClick(px, py, name, laser) {
      var col = laser ? '#ff4d4d' : tint(name || '?');
      var mk = document.createElement('div'); mk.className = 'ap-map-click';
      var core = document.createElement('div'); core.className = 'ap-map-click-core';
      for (var i = 0; i < 3; i++) {
        var ring = document.createElement('div'); ring.className = 'ap-map-click-ring';
        ring.style.borderColor = col; ring.style.animationDelay = (i * 0.4) + 's';
        core.appendChild(ring);
      }
      var dot = document.createElement('div'); dot.className = 'ap-map-click-dot';
      dot.style.borderColor = col; dot.style.background = col;
      core.appendChild(dot);
      var lab = document.createElement('div'); lab.className = 'ap-map-click-name';
      lab.textContent = name || '?'; lab.style.color = col;
      mk.appendChild(core); mk.appendChild(lab); anchor(mk, px, py);
      setTimeout(function () { mk.classList.add('is-fading'); }, 4000);
      setTimeout(function () { unanchor(mk); }, 5200);
    }

    // Legacy single-dot pointer (old wire format: {px,py} only, viewport fraction).
    function showPointer(pt) { var r = viewport.getBoundingClientRect(); pointer.style.display = 'block'; pointer.style.left = (pt.px * r.width) + 'px'; pointer.style.top = (pt.py * r.height) + 'px'; }

    // T2 multi-cursor: one content-anchored element per userId, tint from a stable
    // uid hash, name tag, idle-fade 3 s / remove 6 s, self suppressed. The
    // presenter's cursor (value.laser) keeps the distinct laser dot styling.
    var cursorEls = {};   // uid -> { el, idleT, killT }
    function tint(uid) {
      var h = 0; for (var i = 0; i < uid.length; i++) h = (h * 131 + uid.charCodeAt(i)) % 100000;
      return 'hsl(' + Math.round((h * 137.508) % 360) + ', 75%, 62%)';
    }
    function removeCursor(uid) {
      var c = cursorEls[uid]; if (!c) return;
      clearTimeout(c.idleT); clearTimeout(c.killT); unanchor(c.el); delete cursorEls[uid];
    }
    function showCursor(uid, v) {
      if (cursorsMode === 'off' || uid === selfId()) return;
      var c = cursorEls[uid];
      if (!c) {
        var el = document.createElement('div');
        el.className = 'ap-map-cursor' + (v.laser ? ' is-laser' : '');
        el.setAttribute('data-uid', uid);
        var dot = document.createElement('div');
        dot.className = v.laser ? 'ap-map-cursor-laser' : 'ap-map-cursor-dot';
        if (!v.laser) dot.style.background = tint(uid);
        el.appendChild(dot);
        var nm = document.createElement('div'); nm.className = 'ap-map-cursor-name';
        nm.textContent = v.name || uid; if (!v.laser) nm.style.color = tint(uid);
        el.appendChild(nm);
        anchor(el, v.px, v.py);
        c = cursorEls[uid] = { el: el };
      } else {
        c.el.style.left = (v.px * 100) + '%'; c.el.style.top = (v.py * 100) + '%';
        c.el.style.transform = counterScale();
      }
      c.el.classList.remove('is-idle');
      clearTimeout(c.idleT); clearTimeout(c.killT);
      c.idleT = setTimeout(function () { c.el.classList.add('is-idle'); }, 3000);
      c.killT = setTimeout(function () { removeCursor(uid); }, 6000);
    }

    var subs = [];
    if (Argus && Argus.subscribeState) {
      // E1 view mirror · E2 peer markers · E3 pointer/cursors (all store-native now).
      subs.push(Argus.subscribeState('map/view', function (p, v) { if (v) { viewTouched = true; view.x = v.x; view.y = v.y; view.scale = v.scale; apply(); } }));
      subs.push(Argus.subscribeState('map/markers', function (p, v) { if (v) showClick(v.px, v.py, v.name, v.laser); }));
      subs.push(Argus.subscribeState('map/pointer', function (p, v) {
        if (p === 'map/pointer') return;                       // whole-subtree diffs are not produced by emitters
        var uid = p.slice('map/pointer/'.length);
        if (!v) { removeCursor(uid); return; }
        if (v.name == null && !v.laser) { showPointer(v); return; }   // legacy wire format -> single viewport dot
        showCursor(uid, v);
      }));
    }
    // E4: seed the current view from the connection snapshot (late joiners mirror it).
    var off = Argus ? Argus.onMessage(function (m) {
      if (m.type === 'snapshot' && m.state && m.state.map && m.state.map.view) {
        var v = m.state.map.view; viewTouched = true; view.x = v.x; view.y = v.y; view.scale = v.scale; apply();
      }
    }) : null;

    return { setView: function (v) { viewTouched = true; Object.assign(view, v); apply(); }, view: function () { return view; }, destroy: function () { if (off) off(); subs.forEach(function (u) { u(); }); if (root.classList) root.classList.remove('ap-fullbleed'); root.innerHTML = ''; } };
  }
  if (window.ApComponents) window.ApComponents.register('map', render);
})();
