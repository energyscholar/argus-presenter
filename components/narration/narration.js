/*!
 * Argus Presenter component: NARRATION
 * Styled boxtext for read-aloud GM narration / lesson exposition. Optional
 * typewriter reveal (respects reduced-motion; click to skip) + optional speaker
 * label + optional continue CTA (emits 'continue').
 *
 * opts = { text, speaker?, typewriter?:bool, speed?, cta?, promptId? }
 */
(function () {
  'use strict';
  function render(root, opts) {
    opts = opts || {};
    var Argus = window.Argus, A = window.ApA11y, pid = opts.promptId || 'narration';
    root.innerHTML = '';
    var wrap = document.createElement('div'); wrap.className = 'ap-narration';
    if (opts.speaker) { var sp = document.createElement('div'); sp.className = 'ap-narration-speaker'; sp.textContent = opts.speaker; wrap.appendChild(sp); }
    var body = document.createElement('div'); body.className = 'ap-narration-text'; body.setAttribute('aria-live', 'polite'); wrap.appendChild(body);
    root.appendChild(wrap);

    var text = opts.text || '';
    var reduced = A ? A.reducedMotion : false;
    var timer = null, ctaBtn = null;

    function done() {
      if (opts.cta && !ctaBtn) {
        ctaBtn = document.createElement('button'); ctaBtn.type = 'button';
        ctaBtn.className = 'ap-btn ap-btn--primary ap-narration-cta'; ctaBtn.textContent = opts.cta;
        ctaBtn.addEventListener('click', function () { if (Argus) Argus.emit('continue', { promptId: pid }); ctaBtn.disabled = true; ctaBtn.textContent = '…'; });
        wrap.appendChild(ctaBtn);
      }
      wrap.setAttribute('data-done', '1');
    }

    if (opts.typewriter && !reduced && text) {
      var i = 0, speed = opts.speed || 22;
      body.textContent = '';
      wrap.classList.add('is-typing');
      timer = setInterval(function () { i++; body.textContent = text.slice(0, i); if (i >= text.length) { clearInterval(timer); wrap.classList.remove('is-typing'); done(); } }, speed);
      wrap.addEventListener('click', function () { if (timer) { clearInterval(timer); body.textContent = text; wrap.classList.remove('is-typing'); done(); } });
    } else {
      body.textContent = text; done();
    }

    return { destroy: function () { if (timer) clearInterval(timer); root.innerHTML = ''; } };
  }
  if (window.ApComponents) window.ApComponents.register('narration', render);
})();
