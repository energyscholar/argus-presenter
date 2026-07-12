/*!
 * Argus Presenter component: CHOICE
 * Single-select from N options (YES/NO, multiple choice, a vote). True ARIA
 * radiogroup semantics + roving tabindex. Emits an answer on every selection
 * change (last-write-wins) so a voter can change their mind before a poll closes.
 *
 * Patterns: Factory (mount), Strategy (per-option style), Observer (bridge emit).
 *
 * opts = {
 *   prompt: string,
 *   options: [{ label, value, style?:'ok'|'danger'|'primary' }],
 *   promptId?: string,        // correlation id (host ask())
 *   value?: any,              // pre-selected value
 *   userId?, userName?, channel?   // stamped by the host via the bridge
 * }
 */
(function () {
  'use strict';

  function render(root, opts) {
    opts = opts || {};
    var A = window.ApA11y, Argus = window.Argus;
    var pid = opts.promptId || (A ? A.uid('choice') : 'choice-' + Date.now());
    var options = (opts.options && opts.options.length) ? opts.options
      : [{ label: 'Yes', value: 'yes', style: 'ok' }, { label: 'No', value: 'no', style: 'danger' }];
    var selectedValue = (opts.value != null) ? opts.value : null;

    root.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'ap-choice';

    var p = document.createElement('div');
    p.className = 'ap-prompt';
    p.id = pid + '-prompt';
    p.textContent = opts.prompt || 'Choose:';

    var group = document.createElement('div');
    group.className = 'ap-choice-options';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-labelledby', pid + '-prompt');

    var status = document.createElement('div');
    status.className = 'ap-choice-status';
    status.setAttribute('aria-live', 'polite');

    var btns = options.map(function (o, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ap-btn ap-choice-opt' + (o.style ? ' ap-btn--' + o.style : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.setAttribute('data-value', String(o.value));
      b.style.setProperty('--i', i);            // stagger hook for entrance anim
      b.textContent = o.label;
      // Enter/Space commit the focused option (arrows already select via roving).
      b.addEventListener('keydown', function (e) {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); roving && roving.select(i, false); }
      });
      group.appendChild(b);
      return b;
    });

    function apply(i) {
      selectedValue = options[i].value;
      for (var j = 0; j < btns.length; j++) {
        var on = j === i;
        btns[j].setAttribute('aria-checked', on ? 'true' : 'false');
        btns[j].classList.toggle('is-selected', on);
      }
      status.textContent = 'Selected: ' + options[i].label;
      if (Argus) Argus.answer(pid, selectedValue, { label: options[i].label });
      if (A) A.announce('Selected ' + options[i].label);
    }

    wrap.appendChild(p);
    wrap.appendChild(group);
    wrap.appendChild(status);
    root.appendChild(wrap);

    // rovingGroup wires click + arrows + Home/End; onSelect === apply (no re-entry).
    var roving = A ? A.rovingGroup(group, btns, { orientation: 'both', selectOnMove: true, onSelect: apply })
      : (function () { btns.forEach(function (b, i) { b.addEventListener('click', function () { apply(i); }); }); return null; })();

    // Pre-selected value?
    if (selectedValue != null) {
      var pi = options.findIndex(function (o) { return o.value === selectedValue; });
      if (pi >= 0) { if (roving) roving.select(pi, false); else apply(pi); }
    }

    return {
      value: function () { return selectedValue; },
      destroy: function () { if (roving) roving.destroy(); root.innerHTML = ''; }
    };
  }

  if (window.ApComponents) window.ApComponents.register('choice', render);
  window.ApChoice = render;
})();
