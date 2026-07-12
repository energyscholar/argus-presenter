/*!
 * Plugin example — component: WEATHER
 * Domain panel: metric bars (temperature / humidity / wind …) that update live via
 * host 'weather-update' messages. Demonstrates a plugin adding a domain component
 * that composes in scenes like any core component.
 *
 * opts = { title?, metrics:[{key,label,value}] }
 */
(function () {
  'use strict';
  function render(root, opts) {
    opts = opts || {};
    var Argus = window.Argus;
    var metrics = opts.metrics || [{ key: 'temp', label: 'Temp', value: 64 }, { key: 'humidity', label: 'Humidity', value: 40 }, { key: 'wind', label: 'Wind', value: 20 }];
    root.innerHTML = '';
    var wrap = document.createElement('div'); wrap.className = 'ap-weather';
    if (opts.title) wrap.appendChild(Object.assign(document.createElement('div'), { className: 'ap-prompt', textContent: opts.title }));
    var bars = {};
    function color(fill, v) { fill.classList.toggle('is-low', v < 30); fill.classList.toggle('is-mid', v >= 30 && v < 60); }
    metrics.forEach(function (s) {
      var row = document.createElement('div'); row.className = 'ap-wx-row';
      var lab = document.createElement('div'); lab.className = 'ap-wx-label'; lab.textContent = s.label;
      var track = document.createElement('div'); track.className = 'ap-wx-track';
      var fill = document.createElement('div'); fill.className = 'ap-wx-fill'; fill.style.width = s.value + '%';
      var val = document.createElement('div'); val.className = 'ap-wx-val'; val.setAttribute('data-key', s.key); val.textContent = s.value + '%';
      color(fill, s.value);
      track.appendChild(fill); row.appendChild(lab); row.appendChild(track); row.appendChild(val);
      wrap.appendChild(row); bars[s.key] = { fill: fill, val: val };
    });
    function update(m) { Object.keys(m).forEach(function (k) { if (bars[k]) { var v = m[k]; bars[k].fill.style.width = v + '%'; bars[k].val.textContent = v + '%'; color(bars[k].fill, v); } }); }
    var off = Argus ? Argus.onMessage(function (msg) { if (msg.type === 'weather-update' && msg.metrics) update(msg.metrics); }) : null;
    root.appendChild(wrap);
    return { update: update, destroy: function () { if (off) off(); root.innerHTML = ''; } };
  }
  if (window.ApComponents) window.ApComponents.register('weather', render);
})();
