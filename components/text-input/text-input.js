/*!
 * Argus Presenter component: TEXT-INPUT
 * Free text / number entry with validation. Accessible: label association,
 * aria-invalid + aria-describedby error, live-region announce, actionable messages.
 * Validators are NAMED (opts.validate is JSON-safe strings) — Strategy pattern.
 *
 * opts = {
 *   prompt, promptId, placeholder?, value?, type?, hint?, multiline?, maxLength?,
 *   validate?: string | string[]   // 'required'|'email'|'number'|'minLength:N'|
 *                                   //  'maxLength:N'|'min:N'|'max:N'|'regex:...'
 *   submit?: boolean (default true), submitLabel?, submittedLabel?,
 *   userId?, userName?, channel?
 * }
 * Emits: 'change'{value} live, 'answer'{value} on submit/Enter (valid only).
 * Patterns: Strategy (validators), State (pristine/invalid/submitted).
 */
(function () {
  'use strict';
  var V = {
    required: function (v) { return v != null && String(v).trim() !== '' ? null : 'This field is required.'; },
    email: function (v) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : 'Enter a valid email address, e.g. name@example.com.'; },
    number: function (v) { return v !== '' && !isNaN(Number(v)) ? null : 'Enter a number.'; }
  };
  function ruleFn(rule) {
    var s = String(rule), m;
    if (V[s]) return V[s];
    if ((m = s.match(/^minLength:(\d+)$/))) return function (v) { return String(v).length >= +m[1] ? null : 'Must be at least ' + m[1] + ' characters.'; };
    if ((m = s.match(/^maxLength:(\d+)$/))) return function (v) { return String(v).length <= +m[1] ? null : 'Must be at most ' + m[1] + ' characters.'; };
    if ((m = s.match(/^min:(-?\d+(?:\.\d+)?)$/))) return function (v) { return Number(v) >= +m[1] ? null : 'Must be at least ' + m[1] + '.'; };
    if ((m = s.match(/^max:(-?\d+(?:\.\d+)?)$/))) return function (v) { return Number(v) <= +m[1] ? null : 'Must be at most ' + m[1] + '.'; };
    if ((m = s.match(/^regex:(.*)$/))) return function (v) { try { return new RegExp(m[1]).test(v) ? null : 'Invalid format.'; } catch (e) { return null; } };
    return function () { return null; };
  }

  function render(root, opts) {
    opts = opts || {};
    var A = window.ApA11y, Argus = window.Argus;
    var pid = opts.promptId || (A ? A.uid('text') : 'text');
    var rules = (opts.validate ? (Array.isArray(opts.validate) ? opts.validate : [opts.validate]) : []).map(ruleFn);
    var multiline = !!opts.multiline;
    var showSubmit = opts.submit !== false;

    root.innerHTML = '';
    var wrap = document.createElement('div'); wrap.className = 'ap-textfield';
    var label = document.createElement('label');
    label.className = 'ap-label'; label.id = pid + '-label'; label.setAttribute('for', pid + '-input');
    label.textContent = opts.prompt || 'Your answer:';

    var input = document.createElement(multiline ? 'textarea' : 'input');
    input.className = 'ap-input'; input.id = pid + '-input';
    if (!multiline) input.type = opts.type || 'text';
    if (multiline) input.rows = opts.rows || 3;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.value != null) input.value = opts.value;
    if (opts.maxLength) input.maxLength = opts.maxLength;
    input.setAttribute('aria-labelledby', pid + '-label');
    input.setAttribute('aria-describedby', pid + '-error' + (opts.hint ? ' ' + pid + '-hint' : ''));

    var err = document.createElement('div'); err.className = 'ap-error'; err.id = pid + '-error'; err.setAttribute('aria-live', 'polite');

    function validate(v) { for (var i = 0; i < rules.length; i++) { var e = rules[i](v); if (e) return e; } return null; }
    function setError(msg) { err.textContent = msg || ''; input.setAttribute('aria-invalid', msg ? 'true' : 'false'); }
    function doSubmit() {
      var v = input.value, e = validate(v);
      setError(e);
      if (e) { input.focus(); if (A) A.announce(e); return false; }
      if (Argus) Argus.answer(pid, v);
      if (A) A.announce('Submitted.');
      if (submit) { submit.classList.add('is-selected'); submit.textContent = opts.submittedLabel || 'Submitted ✓'; }
      return true;
    }

    input.addEventListener('input', function () {
      if (input.getAttribute('aria-invalid') === 'true') setError(validate(input.value));  // clear error as they fix it
      if (Argus) Argus.emit('change', { promptId: pid, value: input.value });
    });
    input.addEventListener('blur', function () { if (rules.length) setError(validate(input.value)); });
    if (!multiline) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSubmit(); } });

    wrap.appendChild(label); wrap.appendChild(input); wrap.appendChild(err);
    if (opts.hint) { var hint = document.createElement('div'); hint.className = 'ap-hint'; hint.id = pid + '-hint'; hint.textContent = opts.hint; wrap.appendChild(hint); }
    var submit = null;
    if (showSubmit) {
      submit = document.createElement('button');
      submit.type = 'button'; submit.className = 'ap-btn ap-btn--primary ap-textfield-submit';
      submit.textContent = opts.submitLabel || 'Submit';
      submit.addEventListener('click', doSubmit);
      wrap.appendChild(submit);
    }
    root.appendChild(wrap);

    return { value: function () { return input.value; }, validate: function () { return validate(input.value); }, submit: doSubmit, destroy: function () { root.innerHTML = ''; } };
  }
  if (window.ApComponents) window.ApComponents.register('text-input', render);
})();
