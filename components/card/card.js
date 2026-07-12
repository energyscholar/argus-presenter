/*!
 * Argus Presenter component: CARD
 * Portrait/image + title + subtitle + badges + body, with an optional REVEAL
 * (hidden content behind a button). Dual-use: NPC card (secrets) / concept card
 * (answer or hint reveal — Socratic teaching). Reveal emits 'reveal'.
 *
 * opts = { title, subtitle?, image?, imageAlt?, body?, badges?:[str], footer?,
 *          reveal?:{ label?, hideLabel?, body }, promptId? }
 */
(function () {
  'use strict';
  function el(t, cls, txt) { var e = document.createElement(t); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function render(root, opts) {
    opts = opts || {};
    var Argus = window.Argus, pid = opts.promptId || 'card';
    root.innerHTML = '';
    var card = el('div', 'ap-card');
    if (opts.image) {
      var im = el('img', 'ap-card-img'); im.src = opts.image; im.alt = opts.imageAlt || '';
      im.addEventListener('error', function () { im.style.display = 'none'; });
      card.appendChild(im);
    }
    var body = el('div', 'ap-card-body');
    if (opts.badges && opts.badges.length) {
      var bg = el('div', 'ap-card-badges');
      opts.badges.forEach(function (b) { bg.appendChild(el('span', 'ap-card-badge', b)); });
      body.appendChild(bg);
    }
    if (opts.title) body.appendChild(el('div', 'ap-card-title', opts.title));
    if (opts.subtitle) body.appendChild(el('div', 'ap-card-subtitle', opts.subtitle));
    if (opts.body) body.appendChild(el('div', 'ap-card-text', opts.body));
    if (opts.reveal) {
      var hidden = el('div', 'ap-card-reveal', opts.reveal.body || ''); hidden.hidden = true;
      var btn = el('button', 'ap-btn ap-card-revealbtn', opts.reveal.label || 'Reveal');
      btn.type = 'button'; btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', function () {
        var show = hidden.hidden;
        hidden.hidden = !show;
        btn.setAttribute('aria-expanded', show ? 'true' : 'false');
        btn.textContent = show ? (opts.reveal.hideLabel || 'Hide') : (opts.reveal.label || 'Reveal');
        if (show && Argus) Argus.emit('reveal', { promptId: pid, revealed: true });
      });
      body.appendChild(btn); body.appendChild(hidden);
    }
    if (opts.footer) body.appendChild(el('div', 'ap-card-footer', opts.footer));
    card.appendChild(body); root.appendChild(card);
    return { destroy: function () { root.innerHTML = ''; } };
  }
  if (window.ApComponents) window.ApComponents.register('card', render);
})();
