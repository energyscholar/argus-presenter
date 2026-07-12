/*!
 * Argus Presenter — component registry (zero-dependency).
 * Components self-register by name so MANY can coexist on one page and so
 * plugins can add their own. Replaces the single `window.ApComponent`.
 *
 *   ApComponents.register('choice', function(root, opts){ ... return handle; });
 *   var handle = ApComponents.mount('choice', el, opts);
 */
(function (global) {
  'use strict';
  var reg = {};
  var API = {
    register: function (name, factory) { reg[name] = factory; return API; },
    has: function (name) { return !!reg[name]; },
    get: function (name) { return reg[name]; },
    all: function () { return Object.keys(reg); },
    mount: function (name, root, opts) {
      var f = reg[name];
      if (!f) { if (root) root.textContent = 'Unknown component: ' + name; return null; }
      return f(root, opts || {});
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.ApComponents = API;
})(typeof window !== 'undefined' ? window : this);
