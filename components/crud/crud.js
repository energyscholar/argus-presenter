/*!
 * Argus Presenter component: CRUD (shared, store-native) — the shared-stateful
 * workhorse. A schema-configured collection over the
 * slice crud/{id}: every user can Create/Read/Update/Delete, server-authoritative,
 * lockable, role-permissioned. shared-list = 1-column CRUD; shared-select = a
 * single-record CRUD (configs land in F4).
 *
 * F1 (this): render items from the state slice (seeded by the connection snapshot,
 * kept live by crud/{id} diffs). Interactivity (ops) + locking land in F2/F3.
 *
 * opts = { id, title?, fields:[{name,label,type?}], items?, config? }
 * Patterns: Observer (slice subscription), Reducer (render from slice), Composite.
 */
(function () {
  'use strict';
  function el(t, cls, txt) { var e = document.createElement(t); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  function render(root, opts) {
    opts = opts || {};
    var Argus = window.Argus;
    var cid = opts.id || 'list';
    var fields = opts.fields || [{ name: 'text', label: 'Item' }];
    var items = {};
    if (opts.items) for (var k in opts.items) items[k] = opts.items[k];

    var me = (Argus && Argus.identity && Argus.identity().userId) || opts.userId || null;
    var myRole = opts.viewerRole || null;               // server-stamped role (presenter override)
    var isPresenter = myRole === 'presenter' || myRole === 'gm';
    var slice = 'crud/' + cid + '/items';
    var single = opts.config === 'shared-select';   // F4: single-record CRUD
    var allowAdd = opts.allowAdd !== false && !single;
    function op(path, verb, value) { if (Argus && Argus.op) Argus.op(path, verb, value); }
    function genId() { return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

    root.innerHTML = '';
    var wrap = el('div', 'ap-crud');
    if (opts.title) wrap.appendChild(el('div', 'ap-crud-title', opts.title));
    var list = el('div', 'ap-crud-list'); wrap.appendChild(list);
    root.appendChild(wrap);

    function itemIds() { return Object.keys(items).filter(function (id) { return items[id] != null; }).sort(); }
    // F3: an item is editable unless another user holds the lock (presenter bypasses).
    function editable(it) { return !it.lock || it.lock === me || isPresenter; }

    function renderList() {
      list.innerHTML = '';
      itemIds().forEach(function (id) {
        var it = items[id];
        var row = el('div', 'ap-crud-item'); row.setAttribute('data-id', id);
        if (it.lock) row.setAttribute('data-locked', it.lock);
        var canEdit = editable(it);
        fields.forEach(function (f) {
          var input;
          if (f.type === 'select') {   // F4: shared-select
            input = el('select', 'ap-crud-field ap-crud-input');
            (f.options || []).forEach(function (o) { var val = (o && o.value != null) ? o.value : o; var lab = (o && o.label != null) ? o.label : val; var opt = el('option', null, String(lab)); opt.value = String(val); input.appendChild(opt); });
          } else {
            input = el('input', 'ap-crud-field ap-crud-input');
          }
          input.setAttribute('data-field', f.name);
          input.value = it[f.name] != null ? String(it[f.name]) : '';
          input.disabled = !canEdit;
          input.addEventListener('change', function () { var v = {}; v[f.name] = input.value; op(slice + '/' + id, 'merge', v); });   // F2 update
          row.appendChild(input);
        });
        // Lock toggle (F3): claim/release the item lock.
        var lockBtn = el('button', 'ap-crud-btn ap-crud-lock-btn', it.lock ? ('🔒 ' + it.lock) : '🔓');
        lockBtn.type = 'button';
        lockBtn.addEventListener('click', function () { if (it.lock && (it.lock === me || isPresenter)) op(slice + '/' + id, 'unlock'); else if (!it.lock) op(slice + '/' + id, 'lock', { by: me }); });
        row.appendChild(lockBtn);
        var rm = el('button', 'ap-crud-btn ap-crud-remove', '✕'); rm.type = 'button'; rm.disabled = !canEdit;
        rm.addEventListener('click', function () { op(slice, 'remove', id); });   // F2 delete
        row.appendChild(rm);
        list.appendChild(row);
      });
    }
    renderList();

    // F2 create: an add-row (unless single-record config).
    if (allowAdd) {
      var addRow = el('div', 'ap-crud-add'); var addInputs = {};
      fields.forEach(function (f) {
        var inp = el('input', 'ap-crud-input'); inp.setAttribute('placeholder', f.label || f.name); inp.setAttribute('data-add', f.name);
        addInputs[f.name] = inp; addRow.appendChild(inp);
      });
      var addBtn = el('button', 'ap-crud-btn ap-crud-add-btn', '+ Add'); addBtn.type = 'button';
      function doAdd() { var val = { id: genId() }, any = false; fields.forEach(function (f) { val[f.name] = addInputs[f.name].value; if (addInputs[f.name].value) any = true; }); if (!any) return; op(slice, 'add', val); fields.forEach(function (f) { addInputs[f.name].value = ''; }); }
      addBtn.addEventListener('click', doAdd);
      addRow.appendChild(addBtn); wrap.appendChild(addRow);
    }

    // Apply a diff path (crud/{cid}/items/{id} or .../{id}/lock) to the local model.
    function applyDiff(path, value) {
      var parts = path.split('/');
      if (parts[0] !== 'crud' || parts[1] !== cid || parts[2] !== 'items') return;
      var id = parts[3];
      if (parts.length === 4) { if (value == null) delete items[id]; else items[id] = value; }
      else if (parts.length === 5 && parts[4] === 'lock') { if (!items[id]) items[id] = {}; if (value == null) delete items[id].lock; else items[id].lock = value; }
      renderList();
    }

    var subs = [], off = null;
    if (Argus && Argus.subscribeState) subs.push(Argus.subscribeState('crud/' + cid, function (p, v) { applyDiff(p, v); }));
    if (Argus) off = Argus.onMessage(function (m) {
      if (m.type === 'snapshot' && m.state && m.state.crud && m.state.crud[cid] && m.state.crud[cid].items) {
        items = {}; var src = m.state.crud[cid].items; for (var id in src) items[id] = src[id]; renderList();
      }
    });

    return { destroy: function () { if (off) off(); subs.forEach(function (u) { u(); }); root.innerHTML = ''; }, _items: function () { return items; } };
  }
  if (window.ApComponents) window.ApComponents.register('crud', render);
})();
