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
 * opts = { controllable?:bool, image?, svg?, preset?, label?, laser?:bool, x?,y?,scale? }
 * Patterns: State (view), Observer (emit/receive), Command-ready (message types).
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
    var view = { x: opts.x || 0, y: opts.y || 0, scale: opts.scale || 1 };

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

    function apply() { content.style.transform = 'translate(' + view.x + 'px, ' + view.y + 'px) scale(' + view.scale + ')'; }
    apply();

    var lastView = 0, lastPtr = 0;
    function emitView(final) { if (!controllable || !Argus || !Argus.op) return; var n = Date.now(); if (!final && n - lastView < 66) return; lastView = n; Argus.op('map/view', 'set', { x: view.x, y: view.y, scale: view.scale }); }   // E1: store op (perm: presenter)

    if (controllable) {
      var drag = false, sx = 0, sy = 0, ox = 0, oy = 0;
      viewport.addEventListener('mousedown', function (e) { drag = true; sx = e.clientX; sy = e.clientY; ox = view.x; oy = view.y; e.preventDefault(); });
      window.addEventListener('mousemove', function (e) { if (!drag) return; view.x = ox + (e.clientX - sx); view.y = oy + (e.clientY - sy); apply(); emitView(); });
      window.addEventListener('mouseup', function () { if (drag) { drag = false; emitView(true); } });
      viewport.addEventListener('wheel', function (e) { e.preventDefault(); view.scale = Math.max(0.3, Math.min(6, view.scale * (e.deltaY < 0 ? 1.1 : 0.9))); apply(); emitView(); }, { passive: false });
      // Shared laser pointer: DEFAULT ON (opts.laser !== false) for easy testing.
      // The on/off toggle will live in the presenter page's control panel (by the LED).
      if (opts.laser !== false) viewport.addEventListener('mousemove', function (e) {   // E3: pointer -> ephemeral store op (perm: self)
        var n = Date.now(); if (n - lastPtr < 66) return; lastPtr = n;
        var r = viewport.getBoundingClientRect();
        if (Argus && Argus.op) Argus.op('map/pointer/' + ((Argus.identity && Argus.identity().userId) || 'anon'), 'set', { px: (e.clientX - r.left) / r.width, py: (e.clientY - r.top) / r.height });
      });
    }

    // Clicks are PEER-TO-PEER (the core feature): ANY user clicks -> ALL users see
    // a marker + the clicker's NAME. Users signal each other, not just teacher->student.
    var dnX = 0, dnY = 0, moved = false;
    viewport.addEventListener('mousedown', function (e) { dnX = e.clientX; dnY = e.clientY; moved = false; });
    viewport.addEventListener('mousemove', function (e) { if (Math.abs(e.clientX - dnX) > 4 || Math.abs(e.clientY - dnY) > 4) moved = true; });
    viewport.addEventListener('click', function (e) {   // E2: peer click -> store marker op (perm: any)
      if (moved || !Argus || !Argus.op) return;
      var r = viewport.getBoundingClientRect();
      Argus.op('map/markers', 'add', {
        id: 'mk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        px: (e.clientX - r.left) / r.width, py: (e.clientY - r.top) / r.height,
        name: (Argus.identity && Argus.identity().userName) || '?'
      });
    });

    function showClick(px, py, name) {
      var r = viewport.getBoundingClientRect();
      var mk = document.createElement('div'); mk.className = 'ap-map-click';
      mk.style.left = (px * r.width) + 'px'; mk.style.top = (py * r.height) + 'px';
      var dot = document.createElement('div'); dot.className = 'ap-map-click-dot';
      var lab = document.createElement('div'); lab.className = 'ap-map-click-name'; lab.textContent = name || '?';
      mk.appendChild(dot); mk.appendChild(lab); viewport.appendChild(mk);
      setTimeout(function () { mk.classList.add('is-fading'); }, 2500);
      setTimeout(function () { if (mk.parentNode) mk.parentNode.removeChild(mk); }, 4000);
    }

    function showPointer(pt) { var r = viewport.getBoundingClientRect(); pointer.style.display = 'block'; pointer.style.left = (pt.px * r.width) + 'px'; pointer.style.top = (pt.py * r.height) + 'px'; }

    var subs = [];
    if (Argus && Argus.subscribeState) {
      // E1 view mirror · E2 peer markers · E3 pointer/laser (all store-native now).
      subs.push(Argus.subscribeState('map/view', function (p, v) { if (v) { view.x = v.x; view.y = v.y; view.scale = v.scale; apply(); } }));
      subs.push(Argus.subscribeState('map/markers', function (p, v) { if (v) showClick(v.px, v.py, v.name); }));
      subs.push(Argus.subscribeState('map/pointer', function (p, v) { if (v) showPointer(v); }));
    }
    // E4: seed the current view from the connection snapshot (late joiners mirror it).
    var off = Argus ? Argus.onMessage(function (m) {
      if (m.type === 'snapshot' && m.state && m.state.map && m.state.map.view) {
        var v = m.state.map.view; view.x = v.x; view.y = v.y; view.scale = v.scale; apply();
      }
    }) : null;

    return { setView: function (v) { Object.assign(view, v); apply(); }, view: function () { return view; }, destroy: function () { if (off) off(); subs.forEach(function (u) { u(); }); root.innerHTML = ''; } };
  }
  if (window.ApComponents) window.ApComponents.register('map', render);
})();
