/*!
 * Argus Presenter component: IMAGE
 * Display an image (URL or data URI) with optional caption + fit mode. The most
 * common display primitive in both GM sessions (portraits/maps) and teaching
 * (slides/screenshots). Graceful load-error fallback.
 *
 * opts = { src, alt?, caption?, fit?:'contain'|'cover', maxHeight?, frame?:bool }
 */
(function () {
  'use strict';
  function render(root, opts) {
    opts = opts || {};
    root.innerHTML = '';
    var fig = document.createElement('figure');
    fig.className = 'ap-image' + (opts.frame ? ' ap-image--frame' : '');
    var img = document.createElement('img');
    img.className = 'ap-image-img';
    img.alt = opts.alt || opts.caption || '';
    img.style.objectFit = opts.fit || 'contain';
    if (opts.maxHeight) img.style.maxHeight = typeof opts.maxHeight === 'number' ? opts.maxHeight + 'px' : opts.maxHeight;
    img.addEventListener('error', function () {
      fig.classList.add('is-error');
      img.replaceWith(Object.assign(document.createElement('div'), { className: 'ap-image-fallback', textContent: '⌧ image unavailable' }));
    });
    img.addEventListener('load', function () { if (window.Argus) Argus.emit('image-loaded', { src: opts.src }); });
    img.src = opts.src || '';
    fig.appendChild(img);
    if (opts.caption) { var cap = document.createElement('figcaption'); cap.className = 'ap-image-cap'; cap.textContent = opts.caption; fig.appendChild(cap); }
    root.appendChild(fig);
    return { destroy: function () { root.innerHTML = ''; } };
  }
  if (window.ApComponents) window.ApComponents.register('image', render);
})();
