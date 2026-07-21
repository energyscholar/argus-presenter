/*!
 * Argus Presenter component: SCENE (Composite)
 * Lays out MANY child components on one surface. A scene is itself a component,
 * so it assembles/pushes exactly like any other — enabling multi-component
 * interfaces and plugin-authored composite screens.
 *
 * opts = {
 *   title?, layout:'stack'|'rows'|'grid', gap?, columns?, areas?,
 *   userId?, userName?, channel?,           // inherited by children unless overridden
 *   items: [ { component, opts, id?, region?, span? } ]
 * }
 * Patterns: Composite (scene contains components), Factory (registry mount).
 */
(function () {
  'use strict';
  // Visibility contract: item.visibility 'all' (default) | 'gm' (GM/presenter only).
  // Defense-in-depth on the client; the server ALSO strips before sending (real OPSEC).
  function sees(vis, role) { return (!vis || vis === 'all') ? true : (role === 'gm' || role === 'presenter'); }

  function render(root, spec) {
    spec = spec || {};
    var role = spec.viewerRole || null;
    var items = (spec.items || []).filter(function (it) { return role ? sees(it.visibility, role) : true; });
    var layout = spec.layout || 'stack';
    root.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.className = 'ap-scene ap-scene--' + layout;
    if (spec.gap) wrap.style.setProperty('--ap-scene-gap', spec.gap);
    if (layout === 'grid') {
      if (spec.columns) wrap.style.gridTemplateColumns = spec.columns;
      if (spec.areas) wrap.style.gridTemplateAreas = spec.areas;
    }

    if (spec.title) {
      var h = document.createElement('div');
      h.className = 'ap-scene-title';
      h.textContent = spec.title;
      root.appendChild(h);
    }

    var handles = [];
    items.forEach(function (item, i) {
      var cell = document.createElement('div');
      cell.className = 'ap-scene-cell';
      if (item.region) cell.style.gridArea = item.region;
      if (item.span) cell.style.setProperty('grid-column', 'span ' + item.span);
      wrap.appendChild(cell);

      var opts = Object.assign({}, item.opts || {});
      // Plan 0482 A3: viewerRole inherits to children exactly as userId does. Without it a
      // nested scene rendered with role=null and its sees() filter passed EVERYTHING — the
      // client-side defense-in-depth silently evaporated one level down.
      ['userId', 'userName', 'channel', 'viewerRole'].forEach(function (k) { if (opts[k] == null && spec[k] != null) opts[k] = spec[k]; });
      var handle = window.ApComponents ? window.ApComponents.mount(item.component, cell, opts) : null;
      handles.push({ id: item.id || (item.component + '-' + i), component: item.component, handle: handle });
    });

    root.appendChild(wrap);

    return {
      handles: handles,
      get: function (id) { var f = handles.find(function (x) { return x.id === id; }); return f && f.handle; },
      destroy: function () { handles.forEach(function (x) { if (x.handle && x.handle.destroy) x.handle.destroy(); }); root.innerHTML = ''; }
    };
  }

  if (window.ApComponents) window.ApComponents.register('scene', render);
})();
