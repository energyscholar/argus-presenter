/*!
 * Argus Presenter component: CRUD (shared, store-native) — the shared-stateful
 * workhorse. A schema-configured collection over the
 * slice crud/{id}: every user can Create/Read/Update/Delete, server-authoritative,
 * lockable, role-permissioned. shared-list = 1-column CRUD; shared-select = a
 * single-record CRUD (configs land in F4).
 *
 * ⚠ THIS HEADER WAS STALE AND IT MISLED A READER (corrected 2026-08-26). It said
 * "F1 (this): render only — interactivity (ops) + locking land in F2/F3". F2 AND F3 ARE BUILT:
 * this component adds (`op(slice,'add')`), deletes (`'remove'`), edits (`'merge'`) and
 * locks/unlocks rows, and it has for some time. Measured end-to-end, not read: an add reaches
 * the server, appears on another user's screen, and a locked row now refuses another user.
 * ⇒ Render from the slice (seeded by the connection snapshot, kept live by crud/{id} diffs);
 *   every mutation is an op, server-authoritative.
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

    /*
     * "Other…" — a free-text escape hatch on ANY select field, opted into with `other: true`.
     * Generic on purpose: a seat's occupant is the first user, but nothing here knows about seats.
     *
     * ⛔ NOT window.prompt(). The stage runs in an iframe with sandbox="allow-scripts" and NO
     * allow-modals, so prompt()/alert() are BLOCKED — silently. The user would click "Other…",
     * see nothing happen, and conclude the control is broken. The select is swapped for an inline
     * input instead: Enter or blur commits, Escape restores the previous value, empty is a no-op.
     */
    var OTHER = '\uE000other';   // sentinel; cannot collide with any authored option value
    function askOther(sel, f, prev, commit) {
      var box = el('input', 'ap-crud-field ap-crud-input');
      box.setAttribute('data-field', f.name + ':other');
      box.setAttribute('placeholder', f.otherPlaceholder || 'type a name, then Enter');
      var settled = false;
      function finish(save) {
        if (settled) return; settled = true;
        var v = String(box.value || '').trim();
        if (box.parentNode) box.parentNode.replaceChild(sel, box);
        if (save && v) commit(v); else sel.value = prev;
      }
      box.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      box.addEventListener('blur', function () { finish(true); });
      if (sel.parentNode) sel.parentNode.replaceChild(box, sel);
      box.focus();
    }

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
          var cur = it[f.name] != null ? String(it[f.name]) : '';
          function commit(v) { var o = {}; o[f.name] = v; op(slice + '/' + id, 'merge', o); }
          if (f.type === 'select') {   // F4: shared-select
            input = el('select', 'ap-crud-field ap-crud-input');
            var declared = [];
            (f.options || []).forEach(function (o) {
              var val = (o && o.value != null) ? o.value : o; var lab = (o && o.label != null) ? o.label : val;
              declared.push(String(val));
              var opt = el('option', null, String(lab)); opt.value = String(val); input.appendChild(opt);
            });
            // A value TYPED earlier is not in the declared list. Without this it would render as
            // blank and the row would look empty while the store held a name — so carry it as an
            // option of its own. (Generic: applies to any select, not just seats.)
            if (cur && declared.indexOf(cur) === -1) {
              var own = el('option', null, cur); own.value = cur; input.appendChild(own);
            }
            // `other: true` on the field adds a free-text escape hatch. ⛔ NOT window.prompt():
            // the stage iframe is sandbox="allow-scripts" WITHOUT allow-modals, so prompt() is
            // silently blocked and the user would get nothing. An inline input is used instead.
            if (f.other) {
              var oth = el('option', null, f.otherLabel || 'Other…'); oth.value = OTHER; input.appendChild(oth);
            }
          } else {
            input = el('input', 'ap-crud-field ap-crud-input');
          }
          input.setAttribute('data-field', f.name);
          input.value = cur;
          input.disabled = !canEdit;
          input.addEventListener('change', function () {
            if (f.type === 'select' && f.other && input.value === OTHER) { askOther(input, f, cur, commit); return; }
            commit(input.value);
          });   // F2 update
          row.appendChild(input);
        });
        // Lock toggle (F3): claim/release the item lock.
        var lockBtn = el('button', 'ap-crud-btn ap-crud-lock-btn', it.lock ? ('🔒 ' + it.lock) : '🔓');
        lockBtn.type = 'button';
        lockBtn.addEventListener('click', function () { if (it.lock && (it.lock === me || isPresenter)) op(slice + '/' + id, 'unlock'); else if (!it.lock) op(slice + '/' + id, 'lock', { by: me }); });
        row.appendChild(lockBtn);
        // In a FIXED collection (allowAdd:false, or a single-record config) the rows are
        // FURNITURE, not user-curated entries — four seats in a vehicle, one status record.
        // There, ✕ must EMPTY the row, never delete it: "get out of the seat" is what a user
        // means, deleting the seat is not, and the deletion is unrecoverable. Bruce lost all
        // four seats of the air/raft to this within minutes of first use, sitting one pixel
        // from the control he actually wanted. The FIRST field identifies the row (the seat's
        // station) and is preserved; the rest clear.
        var fixed = !allowAdd;
        var rm = el('button', 'ap-crud-btn ap-crud-remove', fixed ? '⌫' : '✕');
        rm.type = 'button'; rm.disabled = !canEdit;
        rm.title = fixed ? 'Clear this row (it is not removed)' : 'Delete this row';
        rm.addEventListener('click', function () {
          if (!fixed) { op(slice, 'remove', id); return; }                 // F2 delete
          var blank = {};
          fields.slice(1).forEach(function (f) { blank[f.name] = ''; });
          if (Object.keys(blank).length) op(slice + '/' + id, 'merge', blank);
        });
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
