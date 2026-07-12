/*!
 * Argus Presenter component: DICE / CHECK
 * Rolls dice (NdS+M), animates, optional target for success/failure. Emits
 * 'answer'{total, rolls, success}. GM skill check == teaching knowledge check.
 *
 * opts = { dice?:'2d6+1', count?, sides?, modifier?, target?, label?, auto?, promptId? }
 * Patterns: State, Observer.
 */
(function () {
  'use strict';
  function parse(s) { var m = String(s || '2d6').match(/^(\d*)d(\d+)([+-]\d+)?$/i); return m ? { count: +(m[1] || 1), sides: +m[2], mod: +(m[3] || 0) } : { count: 2, sides: 6, mod: 0 }; }
  function render(root, opts) {
    opts = opts || {};
    var Argus = window.Argus, A = window.ApA11y, pid = opts.promptId || (A ? A.uid('dice') : 'dice');
    var spec = opts.count ? { count: opts.count, sides: opts.sides || 6, mod: opts.modifier || 0 } : parse(opts.dice);
    var target = opts.target != null ? opts.target : null;
    root.innerHTML = '';
    var wrap = document.createElement('div'); wrap.className = 'ap-dice';
    if (opts.label) wrap.appendChild(Object.assign(document.createElement('div'), { className: 'ap-prompt', textContent: opts.label }));
    var rowEl = document.createElement('div'); rowEl.className = 'ap-dice-row';
    var dice = [];
    for (var i = 0; i < spec.count; i++) { var d = document.createElement('div'); d.className = 'ap-die'; d.textContent = '?'; rowEl.appendChild(d); dice.push(d); }
    var result = document.createElement('div'); result.className = 'ap-dice-result'; result.setAttribute('aria-live', 'polite'); result.setAttribute('data-total', '');
    var modLabel = spec.mod ? (spec.mod > 0 ? '+' + spec.mod : String(spec.mod)) : '';
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ap-btn ap-btn--primary';
    btn.textContent = opts.rollLabel || ('Roll ' + spec.count + 'd' + spec.sides + modLabel + (target != null ? ' (need ' + target + '+)' : ''));

    function rollOnce() { return 1 + Math.floor(Math.random() * spec.sides); }
    function roll() {
      btn.disabled = true;
      var reduced = A ? A.reducedMotion : false, ticks = reduced ? 1 : 8, t = 0;
      var iv = setInterval(function () {
        var rolls = dice.map(function (d) { var v = rollOnce(); d.textContent = String(v); return v; });
        if (++t >= ticks) {
          clearInterval(iv);
          var total = rolls.reduce(function (a, b) { return a + b; }, 0) + spec.mod;
          var success = target != null ? total >= target : null;
          result.textContent = 'Total: ' + total + (target != null ? '  vs ' + target + '+  —  ' + (success ? 'SUCCESS' : 'FAILURE') : '');
          result.setAttribute('data-total', String(total));
          result.className = 'ap-dice-result' + (success === true ? ' is-success' : success === false ? ' is-failure' : '');
          if (Argus) Argus.answer(pid, total, { rolls: rolls, mod: spec.mod, target: target, success: success });
          if (A) A.announce(result.textContent);
          btn.disabled = false; btn.textContent = opts.rerollLabel || 'Roll again';
        }
      }, reduced ? 0 : 55);
    }
    btn.addEventListener('click', roll);
    wrap.appendChild(rowEl); wrap.appendChild(result); wrap.appendChild(btn);
    root.appendChild(wrap);
    if (opts.auto) roll();
    return { roll: roll, destroy: function () { root.innerHTML = ''; } };
  }
  if (window.ApComponents) window.ApComponents.register('dice', render);
})();
