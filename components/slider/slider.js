/*!
 * Argus Presenter component: SLIDER
 * Continuous/discrete value via ARIA slider pattern. Keyboard (arrows, Home/End,
 * PageUp/Down) + pointer drag. Emits 'change'{value} live (for reactive views)
 * and 'answer'{value} on commit (release/key). Accessible: role=slider,
 * aria-valuemin/max/now + aria-valuetext.
 *
 * opts = { prompt, promptId, min=0, max=100, step=1, value?, unit?, userId?,... }
 * Patterns: State (current value), Observer (emits).
 */
(function () {
  'use strict';
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function render(root, opts) {
    opts = opts || {};
    var A = window.ApA11y, Argus = window.Argus;
    var pid = opts.promptId || (A ? A.uid('slider') : 'slider');
    var min = opts.min != null ? opts.min : 0, max = opts.max != null ? opts.max : 100, step = opts.step || 1;
    var unit = opts.unit || '';
    var value = clamp(opts.value != null ? opts.value : min, min, max);

    root.innerHTML = '';
    var wrap = document.createElement('div'); wrap.className = 'ap-slider';
    var label = document.createElement('div'); label.className = 'ap-prompt'; label.id = pid + '-label'; label.textContent = opts.prompt || 'Select a value:';
    var row = document.createElement('div'); row.className = 'ap-slider-row';
    var track = document.createElement('div'); track.className = 'ap-slider-track';
    var fill = document.createElement('div'); fill.className = 'ap-slider-fill';
    var thumb = document.createElement('div'); thumb.className = 'ap-slider-thumb';
    thumb.setAttribute('role', 'slider'); thumb.tabIndex = 0;
    thumb.setAttribute('aria-labelledby', pid + '-label');
    thumb.setAttribute('aria-valuemin', String(min)); thumb.setAttribute('aria-valuemax', String(max));
    var valEl = document.createElement('div'); valEl.className = 'ap-slider-value'; valEl.setAttribute('aria-hidden', 'true');
    track.appendChild(fill); track.appendChild(thumb); row.appendChild(track); row.appendChild(valEl);

    function pct(v) { return (v - min) / (max - min) * 100; }
    function setValue(v, emitChange) {
      v = clamp(Math.round(v / step) * step, min, max);
      value = parseFloat(v.toFixed(6));
      var p = pct(value);
      fill.style.width = p + '%'; thumb.style.left = p + '%';
      var text = value + (unit ? ' ' + unit : '');
      thumb.setAttribute('aria-valuenow', String(value)); thumb.setAttribute('aria-valuetext', text);
      valEl.textContent = text;
      if (emitChange !== false && Argus) Argus.emit('change', { promptId: pid, value: value });
    }
    function commit() { if (Argus) Argus.answer(pid, value, unit ? { unit: unit } : undefined); }

    thumb.addEventListener('keydown', function (e) {
      var big = (max - min) / 10 || step * 10, d = 0;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') d = step;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') d = -step;
      else if (e.key === 'PageUp') d = big;
      else if (e.key === 'PageDown') d = -big;
      else if (e.key === 'Home') { e.preventDefault(); setValue(min); commit(); return; }
      else if (e.key === 'End') { e.preventDefault(); setValue(max); commit(); return; }
      else return;
      e.preventDefault(); setValue(value + d); commit();
    });

    function fromClientX(cx) { var r = track.getBoundingClientRect(); return min + clamp((cx - r.left) / r.width, 0, 1) * (max - min); }
    function onDown(e) {
      e.preventDefault(); thumb.focus();
      var move = function (ev) { var cx = ev.touches ? ev.touches[0].clientX : ev.clientX; setValue(fromClientX(cx)); };
      var up = function () {
        document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
        document.removeEventListener('touchmove', move); document.removeEventListener('touchend', up); commit();
      };
      move(e);
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      document.addEventListener('touchmove', move, { passive: false }); document.addEventListener('touchend', up);
    }
    track.addEventListener('mousedown', onDown);
    track.addEventListener('touchstart', onDown, { passive: false });

    wrap.appendChild(label); wrap.appendChild(row); root.appendChild(wrap);
    setValue(value, false);
    return { value: function () { return value; }, set: function (v) { setValue(v); }, destroy: function () { root.innerHTML = ''; } };
  }
  if (window.ApComponents) window.ApComponents.register('slider', render);
})();
