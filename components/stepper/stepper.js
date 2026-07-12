/*!
 * Argus Presenter component: STEPPER / FLOW
 * Sequences content through ordered steps (scene beats / curriculum steps). Each
 * step is itself a component (Composite over the registry). Advances on the
 * step's own 'continue'/'answer' or a Next button; emits 'step'{index} and
 * 'flow-complete'. Progress dots for orientation.
 *
 * opts = {
 *   steps: [ { component, opts, advanceOn?:'continue'|'answer'|'button', next? } ],
 *   promptId?, showProgress?:true, nextLabel?
 * }
 * Patterns: State machine, Composite, Observer.
 */
(function () {
  'use strict';
  function render(root, opts) {
    opts = opts || {};
    var Argus = window.Argus, A = window.ApA11y, pid = opts.promptId || (A ? A.uid('flow') : 'flow');
    var steps = opts.steps || [];
    var idx = 0, current = null;

    root.innerHTML = '';
    var wrap = document.createElement('div'); wrap.className = 'ap-stepper';
    var progress = document.createElement('div'); progress.className = 'ap-stepper-progress';
    var stage = document.createElement('div'); stage.className = 'ap-stepper-stage';
    var controls = document.createElement('div'); controls.className = 'ap-stepper-controls';
    var nextBtn = document.createElement('button'); nextBtn.type = 'button'; nextBtn.className = 'ap-btn ap-btn--primary ap-stepper-next';
    controls.appendChild(nextBtn);

    var dots = steps.map(function (_, i) { var d = document.createElement('span'); d.className = 'ap-stepper-dot'; progress.appendChild(d); return d; });
    if (opts.showProgress !== false) wrap.appendChild(progress);
    wrap.appendChild(stage); wrap.appendChild(controls);
    root.appendChild(wrap);

    var offBus = Argus ? Argus.subscribe(function (m) {
      var step = steps[idx]; if (!step) return;
      var adv = step.advanceOn || 'button';
      if ((adv === 'continue' && m.type === 'continue') || (adv === 'answer' && m.type === 'answer')) {
        // only advance on the current step's own event
        var mp = m.value && m.value.promptId; var op = (step.opts && step.opts.promptId);
        if (m.promptId === op || mp === op || !op) go(idx + 1);
      }
    }) : null;

    function renderStep() {
      if (current && current.destroy) current.destroy();
      var step = steps[idx];
      stage.innerHTML = '';
      var host = document.createElement('div'); stage.appendChild(host);
      current = window.ApComponents ? window.ApComponents.mount(step.component, host, Object.assign({}, step.opts)) : null;
      dots.forEach(function (d, i) { d.classList.toggle('is-active', i === idx); d.classList.toggle('is-done', i < idx); });
      var last = idx >= steps.length - 1;
      nextBtn.textContent = last ? (opts.doneLabel || 'Finish') : (step.next || opts.nextLabel || 'Next');
      nextBtn.style.display = (step.advanceOn && step.advanceOn !== 'button') ? 'none' : '';
      if (Argus) Argus.emit('step', { promptId: pid, index: idx, component: step.component });
    }
    function go(n) {
      if (n >= steps.length) { if (Argus) Argus.emit('flow-complete', { promptId: pid }); nextBtn.disabled = true; nextBtn.style.display = ''; nextBtn.textContent = opts.completeLabel || 'Complete ✓'; return; }
      idx = n; renderStep();
    }
    nextBtn.addEventListener('click', function () { go(idx + 1); });
    renderStep();

    return { go: go, index: function () { return idx; }, destroy: function () { if (offBus) offBus(); if (current && current.destroy) current.destroy(); root.innerHTML = ''; } };
  }
  if (window.ApComponents) window.ApComponents.register('stepper', render);
})();
