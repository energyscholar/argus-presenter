/*!
 * Argus Presenter component: PROSE (Plan 0493 §8)
 * The standard TEXT-RESPONSE surface: renders SERVER-SANITISED markdown HTML into a legible,
 * theme-consistent "ARGUS · RESPONSE" card for a fast reader. `card`/`narration` render .textContent
 * only (no structure) — this is the gap they left. Long content SCROLLS within the stage, never clips
 * (a dropped tail is the silent-failure trap in visual form).
 *
 * opts = { html, title?, chrome? }
 *   html   — sanitised HTML from app/markdown.mjs (server-side). It contains ONLY whitelisted tags
 *            (headings, lists, strong/em, code/pre, blockquote, table, hr) with all text escaped, so it
 *            is safe to assign as innerHTML. As defence-in-depth the component still strips any element
 *            outside that whitelist before mounting.
 *   title  — optional heading shown under the ARGUS · RESPONSE chrome.
 *   chrome — set false to suppress the ARGUS · RESPONSE label (default true).
 */
(function () {
  'use strict';
  // Defence-in-depth: even though the server sanitises, drop anything not in the render whitelist
  // (and any attributes) before it touches the live DOM. Parsed in an INERT document (DOMParser), so
  // nothing executes or fetches during the scrub.
  var ALLOW = { H1:1, H2:1, H3:1, H4:1, H5:1, H6:1, P:1, UL:1, OL:1, LI:1, STRONG:1, EM:1, CODE:1,
    PRE:1, BLOCKQUOTE:1, TABLE:1, THEAD:1, TBODY:1, TR:1, TH:1, TD:1, HR:1, BR:1 };
  function scrub(node) {
    var kids = Array.prototype.slice.call(node.childNodes);
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 1) {                 // element
        if (!ALLOW[n.tagName]) { node.removeChild(n); continue; }
        // strip ALL attributes (no class/style/href/on*), keep only structure
        for (var a = n.attributes.length - 1; a >= 0; a--) n.removeAttribute(n.attributes[a].name);
        scrub(n);
      } else if (n.nodeType !== 3) {          // not element, not text ⇒ comment/etc → drop
        node.removeChild(n);
      }
    }
  }
  function safe(html) {
    try {
      var doc = new DOMParser().parseFromString('<div id="ap-prose-x">' + String(html || '') + '</div>', 'text/html');
      var host = doc.getElementById('ap-prose-x');
      scrub(host);
      return host.innerHTML;
    } catch (e) {
      // No DOMParser (shouldn't happen in a browser) → fall back to escaped text, never raw.
      return String(html || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  }
  function el(t, cls, txt) { var e = document.createElement(t); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function render(root, opts) {
    opts = opts || {};
    root.innerHTML = '';
    var wrap = el('div', 'ap-prose');
    if (opts.chrome !== false) {
      var head = el('div', 'ap-prose-chrome');
      head.appendChild(el('span', 'ap-prose-mark', 'ARGUS'));
      head.appendChild(el('span', 'ap-prose-sep', '·'));
      head.appendChild(el('span', 'ap-prose-kind', 'RESPONSE'));
      wrap.appendChild(head);
    }
    if (opts.title) wrap.appendChild(el('div', 'ap-prose-title', opts.title));
    var body = el('div', 'ap-prose-body');
    body.setAttribute('aria-live', 'polite');
    body.innerHTML = safe(opts.html);       // server-sanitised + client-scrubbed
    wrap.appendChild(body);
    root.appendChild(wrap);
    return { destroy: function () { root.innerHTML = ''; } };
  }
  if (window.ApComponents) window.ApComponents.register('prose', render);
})();
