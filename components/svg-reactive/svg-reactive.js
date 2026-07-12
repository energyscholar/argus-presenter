/*!
 * Argus Presenter component: SVG-REACTIVE
 * An animated SVG (radial energy gauge) that reacts LIVE to a watched input —
 * e.g. a slider on the same surface. Demonstrates programmatic, structured SVG
 * change driven by the form library (Bruce's requested pattern).
 *
 * opts = { label?, watch: promptId, min=0, max=100, value?, userId?,... }
 * Reacts to in-page 'change' messages whose promptId === watch (Argus.subscribe).
 * Patterns: Observer (subscribe to sibling), State.
 *
 * GOTCHA internalized: CSS var() does NOT resolve inside SVG *presentation
 * attributes* (stroke="var(--x)" fails). Colors come from CSS classes instead.
 */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs) { var e = document.createElementNS(NS, tag); if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }

  function render(root, opts) {
    opts = opts || {};
    var Argus = window.Argus, A = window.ApA11y;
    var min = opts.min != null ? opts.min : 0, max = opts.max != null ? opts.max : 100;
    var value = opts.value != null ? opts.value : min, watch = opts.watch || null;
    var cx = 100, cy = 118, R = 82, len = Math.PI * R;

    root.innerHTML = '';
    var wrap = document.createElement('div'); wrap.className = 'ap-svgreactive';
    if (opts.label) { var l = document.createElement('div'); l.className = 'ap-prompt'; l.textContent = opts.label; wrap.appendChild(l); }

    var svg = el('svg', { viewBox: '0 0 200 150', class: 'ap-svgr-svg', role: 'img' });
    function arcPath(r) { return 'M ' + (cx - r) + ' ' + cy + ' A ' + r + ' ' + r + ' 0 0 1 ' + (cx + r) + ' ' + cy; }
    var bg = el('path', { d: arcPath(R), class: 'ap-svgr-bg' });
    var arc = el('path', { d: arcPath(R), class: 'ap-svgr-arc' }); arc.setAttribute('stroke-dasharray', String(len));
    var glow = el('circle', { cx: cx, cy: cy, r: 12, class: 'ap-svgr-glow' });
    var core = el('circle', { cx: cx, cy: cy, r: 8, class: 'ap-svgr-core' });
    core.appendChild(el('animate', { attributeName: 'opacity', values: '0.55;1;0.55', dur: '2s', repeatCount: 'indefinite' }));
    var txt = el('text', { x: cx, y: cy - 16, 'text-anchor': 'middle', class: 'ap-svgr-text' });
    svg.appendChild(bg); svg.appendChild(arc); svg.appendChild(glow); svg.appendChild(core); svg.appendChild(txt);
    wrap.appendChild(svg); root.appendChild(wrap);

    function update(v) {
      value = v;
      var f = Math.max(0, Math.min(1, (v - min) / (max - min)));
      arc.style.strokeDashoffset = String(len * (1 - f));
      var r = 8 + f * 20;
      core.setAttribute('r', String(r)); glow.setAttribute('r', String(r + 10));
      glow.style.opacity = String(0.12 + f * 0.4);
      txt.textContent = String(Math.round(v));
      svg.setAttribute('data-value', String(Math.round(v)));      // for tests + SR
      svg.setAttribute('aria-label', (opts.label || 'Level') + ': ' + Math.round(v));
    }
    update(value);

    // 'change' events carry their payload as msg.value = { promptId, value }.
    var off = (Argus && watch) ? Argus.subscribe(function (m) {
      if (m.type === 'change' && m.value && m.value.promptId === watch && m.value.value != null) update(Number(m.value.value));
    }) : null;

    return { update: update, destroy: function () { if (off) off(); root.innerHTML = ''; } };
  }
  if (window.ApComponents) window.ApComponents.register('svg-reactive', render);
})();
