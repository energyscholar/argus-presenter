/*!
 * Argus Presenter component: FORM (multi-field, coordinated submit)
 * Composes multiple fields (text-input-style) with ONE validate-and-submit.
 * Unlike a scene of independent inputs, a form gathers all fields and emits a
 * single 'answer'{fields:{...}} only when ALL validate. Character sheets, intake
 * forms, multi-part quiz answers.
 *
 * opts = {
 *   title?, promptId?, submitLabel?, fields: [
 *     { name, label, type?, placeholder?, value?, validate?, hint?, options? }
 *   ]
 * }  // type 'select' uses options:[{label,value}]; else text/number/etc.
 * Patterns: Composite (fields), Strategy (validators), State.
 */
(function () {
  'use strict';
  var V = {
    required: function (v) { return v != null && String(v).trim() !== '' ? null : 'Required.'; },
    email: function (v) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : 'Enter a valid email.'; },
    number: function (v) { return v !== '' && !isNaN(Number(v)) ? null : 'Enter a number.'; }
  };
  function ruleFn(rule) {
    var s = String(rule), m;
    if (V[s]) return V[s];
    if ((m = s.match(/^minLength:(\d+)$/))) return function (v) { return String(v).length >= +m[1] ? null : 'At least ' + m[1] + ' chars.'; };
    if ((m = s.match(/^min:(-?\d+)$/))) return function (v) { return Number(v) >= +m[1] ? null : 'Min ' + m[1] + '.'; };
    if ((m = s.match(/^max:(-?\d+)$/))) return function (v) { return Number(v) <= +m[1] ? null : 'Max ' + m[1] + '.'; };
    return function () { return null; };
  }

  function render(root, opts) {
    opts = opts || {};
    var Argus = window.Argus, A = window.ApA11y, pid = opts.promptId || (A ? A.uid('form') : 'form');
    var fields = opts.fields || [];
    root.innerHTML = '';
    var form = document.createElement('form'); form.className = 'ap-form'; form.setAttribute('novalidate', '');
    if (opts.title) form.appendChild(Object.assign(document.createElement('div'), { className: 'ap-prompt', textContent: opts.title }));

    var models = fields.map(function (f, i) {
      var fid = pid + '-' + (f.name || i);
      var wrap = document.createElement('div'); wrap.className = 'ap-field';
      var label = document.createElement('label'); label.className = 'ap-label'; label.setAttribute('for', fid); label.textContent = f.label || f.name;
      var input;
      if (f.type === 'select') {
        input = document.createElement('select');
        (f.options || []).forEach(function (o) { var op = document.createElement('option'); op.value = o.value; op.textContent = o.label; input.appendChild(op); });
      } else { input = document.createElement('input'); input.type = f.type || 'text'; if (f.placeholder) input.placeholder = f.placeholder; }
      input.className = 'ap-input'; input.id = fid;
      if (f.value != null) input.value = f.value;
      input.setAttribute('aria-describedby', fid + '-err');
      var err = document.createElement('div'); err.className = 'ap-error'; err.id = fid + '-err';
      wrap.appendChild(label); wrap.appendChild(input); wrap.appendChild(err);
      if (f.hint) wrap.appendChild(Object.assign(document.createElement('div'), { className: 'ap-hint', textContent: f.hint }));
      form.appendChild(wrap);
      var rules = (f.validate ? (Array.isArray(f.validate) ? f.validate : [f.validate]) : []).map(ruleFn);
      input.addEventListener('input', function () { if (input.getAttribute('aria-invalid') === 'true') { var e = validate1(); err.textContent = e || ''; input.setAttribute('aria-invalid', e ? 'true' : 'false'); } });
      function validate1() { for (var r = 0; r < rules.length; r++) { var e = rules[r](input.value); if (e) return e; } return null; }
      return { name: f.name || String(i), input: input, err: err, validate: validate1 };
    });

    var submit = document.createElement('button');
    // NOT type="submit". The content frame is sandboxed as allow-scripts WITHOUT
    // allow-forms, so the browser SILENTLY blocks native <form> submission and the
    // submit handler never fires. We do not need native submit: answers travel over
    // the Argus messaging layer on click, exactly like choice/text-input/dice.
    submit.type = 'button'; submit.className = 'ap-btn ap-btn--primary ap-form-submit';
    submit.textContent = opts.submitLabel || 'Submit';
    form.appendChild(submit);

    function doSubmit(e) {
      if (e) e.preventDefault();
      var ok = true, out = {}, firstBad = null;
      models.forEach(function (m) {
        var err = m.validate();
        m.err.textContent = err || ''; m.input.setAttribute('aria-invalid', err ? 'true' : 'false');
        if (err) { ok = false; if (!firstBad) firstBad = m.input; }
        out[m.name] = m.input.value;
      });
      if (!ok) { if (firstBad) firstBad.focus(); if (A) A.announce('Please fix the highlighted fields.'); return; }
      if (Argus) Argus.answer(pid, out);
      if (A) A.announce('Submitted.');
      submit.classList.add('is-selected'); submit.textContent = opts.submittedLabel || 'Submitted ✓';
    }
    submit.addEventListener('click', doSubmit);
    form.addEventListener('submit', doSubmit);   // Enter key, where the UA permits it

    root.appendChild(form);
    return { values: function () { var o = {}; models.forEach(function (m) { o[m.name] = m.input.value; }); return o; }, destroy: function () { root.innerHTML = ''; } };
  }
  if (window.ApComponents) window.ApComponents.register('form', render);
})();
