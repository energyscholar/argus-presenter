/*!
 * example plugin — MAP presets (domain art). Registers the top-down city-grid
 * provider with the core map's preset registry (window.ApMapPresets). Core ships
 * NO domain art; this is where domain visuals live.
 */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  function svgEl(t, a) { var e = document.createElementNS(NS, t); if (a) for (var k in a) e.setAttribute(k, a[k]); return e; }

  function cityGrid() {
    var svg = svgEl('svg', { viewBox: '-400 -400 800 800', class: 'ap-map-svg' });
    var blocks = [['Market', 55, 4], ['Harbor', 85, 7], ['Uptown', 115, 7.5], ['Downtown', 150, 5], ['Midtown', 225, 18], ['Riverside', 285, 15], ['Eastgate', 335, 11], ['Westgate', 375, 11]];
    blocks.forEach(function (b) { svg.appendChild(svgEl('circle', { cx: 0, cy: 0, r: b[1], class: 'ap-map-ring', fill: 'none' })); });
    svg.appendChild(svgEl('circle', { cx: 0, cy: 0, r: 24, class: 'ap-map-plaza' }));
    blocks.forEach(function (b, i) {
      var ang = i * 0.8 + 0.3, x = Math.round(b[1] * Math.cos(ang)), y = Math.round(b[1] * Math.sin(ang));
      svg.appendChild(svgEl('circle', { cx: x, cy: y, r: b[2], class: 'ap-map-block' }));
      var label = svgEl('text', { x: x + b[2] + 5, y: y + 4, class: 'ap-map-block-label' }); label.textContent = b[0]; svg.appendChild(label);
    });
    return svg;
  }

  // Register-if-registry-present; create the registry defensively if the core map
  // hasn't (allows the plugin to load standalone in tests).
  var reg = (window.ApMapPresets = window.ApMapPresets || (function () {
    var m = {};
    return { register: function (n, f) { m[n] = f; return this; }, get: function (n) { return m[n]; }, all: function () { return Object.keys(m); } };
  })());
  reg.register('city-grid', cityGrid);
})();
