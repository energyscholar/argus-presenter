/*!
 * Argus Presenter component: TOKENS — N draggable tokens over the shared map.
 *
 * `navmap` drags exactly ONE token and rides `map/markers` to do it. This is the general case:
 * an authored roster of N tokens, each with ITS OWN STORE KEY, so two people dragging two
 * different tokens in the same instant cannot lose a write.
 *
 *   opts = <map opts> + { path?:      'shared/tactical/tokens',
 *                         tokens?:    [ { id, label, side, kind, px, py, status, pin, ...anything } ],
 *                         draggable?: 'all' | 'off' }
 *
 * ⛔ `draggable` is a property of the MOUNT; `pin` is a property of the TOKEN. A board whose centre
 * is a declared origin needs one piece that cannot be moved on a surface where everything else can,
 * and `draggable` cannot express that. A pinned token refuses the grab and says so on screen.
 *
 * ⭐ A TOKEN RECORD IS OPEN, NOT A FIXED SEVEN FIELDS. `id/label/side/kind/px/py/status` are the
 * only names this component understands, and it understands them only well enough to COERCE them;
 * every other field the caller publishes is carried through read, drag, drop and re-read untouched.
 * ⛔ Keys beginning `_` are the host's, not the token's, and are the one thing dropped on the floor.
 *
 * ⛔ DOMAIN-FREE (PSS t0531-01). `side` and `kind` are opaque strings the caller supplies; this
 * component never learns what any of them mean. `side` only ever picks a stable tint out of a hash,
 * exactly as map.js tints a peer cursor, so a caller gets distinguishable teams without the engine
 * naming one. `kind` is published as a `data-kind` hook and styled by nobody here.
 *
 * ── WHAT THIS IS BUILT TO, and every line of it was MEASURED (plan 0720 B3/B6), not guessed ─────
 *
 * 1. ⛔ ONE KEY PER TOKEN — `op(path + '/' + id, 'set', record)`. B3 measured the alternative on
 *    the same server: 8 clients appending to one collection key retained 1 of 8 writes per round,
 *    silently, every op accepted and acknowledged. Per key retained 8 of 8, four rounds of four.
 *    ⚠ That buys CONCURRENCY, NOT OWNERSHIP: `shared/**` lets any participant write any key, so
 *    two people dragging the SAME token is still last-write-wins. Nothing here claims otherwise.
 *
 * 2. ⛔ SUBSCRIBE AT THE COLLECTION, NEVER AT AN ITEM. B6 measured a subscriber on an item path
 *    hearing NOTHING when the collection was written wholesale (itemHits:0, collHits:1) — which
 *    would have shipped as "the board silently goes stale". So one subscription, at `path`, and
 *    the token id is derived from the tail of the FULL path the handler is given.
 *
 * 3. ⛔ NO `pointer` OR `laser` SEGMENT IN THE PATH. Any such path is ephemeral-coalesced: B6 saw
 *    12 ops collapse into 1 delivered diff with `version:null`. A drag may ride that deliberately;
 *    a DROP must not. A path that would be coalesced is refused a drop and says so, visibly.
 *
 * 4. ⭐ EMIT ON DROP, NOT DURING THE DRAG. navmap paid for this one: `map` renders a radar ping per
 *    marker write, and streaming at pointer rate carpets the board.
 *
 * 5. ⚠ RENDER IDEMPOTENTLY. The writer gets its own diff back, and B6 saw 8 diffs arrive at a
 *    wholly idle client merely because two other people connected. So every state event runs the
 *    same reconcile — create the missing, remove the departed, repaint the rest — and running it
 *    twice is indistinguishable from running it once.
 *
 * 6. The snapshot is separate and complete, so a late joiner is seeded with zero diffs. The roster
 *    is therefore read on MOUNT (`Argus.state`) as well as on every diff: a panel is never blank.
 *
 * ── ANCHORING (plan 0457 T2, as map.js does it) ────────────────────────────────────────────────
 * `px`/`py` are fractions of the UNTRANSFORMED `.ap-map-content` box. Tokens live INSIDE that box
 * and counter-scale (`translate(-50%,-50%) scale(1/scale)`), so they stay pinned under pan and
 * zoom at a constant apparent size. The scale is re-read from the map's own live view whenever the
 * map re-applies its transform — observed, not mirrored, so there is no second copy to go stale.
 */
(function () {
  'use strict';

  var DEFAULT_PATH = 'shared/tactical/tokens';
  var EPHEMERAL_SEGMENTS = { pointer: 1, laser: 1 };   // B6: these paths are coalesced by the host
  /*
   * ⛔ A TAP IS NOT A MOVE, AND ON A TOUCH SCREEN A TAP *IS* A DRAG. `onUp` used to emit whatever
   * had happened between `pointerdown` and `pointerup`, and a finger resting on a piece for a
   * moment produces exactly that pair with nothing in between. So merely TOUCHING a token converted
   * it from an authored record into a stored one — after which the roster no longer owns it and
   * re-authoring can no longer change it.
   *
   * 4px, the same figure `map.js` already uses to tell a click from a pan, so the two surfaces
   * agree about what counts as having moved. It is in CSS pixels of the viewport, deliberately: the
   * question is "did the hand move", and the hand does not know the map's zoom.
   */
  var MOVE_THRESHOLD_PX = 4;

  /* Stable tint from an opaque string — the same hash map.js uses for a peer cursor. Domain-free:
     the component never knows which side is which, only that two different strings differ. */
  function tint(s) {
    var h = 0, str = String(s || '');
    for (var i = 0; i < str.length; i++) h = (h * 131 + str.charCodeAt(i)) % 100000;
    return 'hsl(' + Math.round((h * 137.508) % 360) + ', 70%, 64%)';
  }

  function num(v, dflt) { return typeof v === 'number' && isFinite(v) ? v : dflt; }
  function clamp01(n) { return n < 0 ? 0 : (n > 1 ? 1 : n); }

  function render(root, opts) {
    opts = opts || {};
    var reg = window.ApComponents;
    var mapFactory = reg && reg.get && reg.get('map');
    /* ⛔ DEGRADE VISIBLY, NEVER THROW. A thrown factory takes the whole surface down and says
       nothing a human can read; a sentence in the host element says exactly what is missing. */
    if (!mapFactory) {
      root.textContent = 'tokens: base map component unavailable';
      return { destroy: function () { root.innerHTML = ''; } };
    }

    var handle = mapFactory(root, opts) || {};
    var Argus = window.Argus;
    var content = root.querySelector('.ap-map-content');
    if (!content) return handle;                       // base map changed shape — degrade to a plain map

    var path = String(opts.path || DEFAULT_PATH).replace(/^\/+/, '').replace(/\/+$/, '');
    var editable = opts.draggable !== 'off';
    var segments = path.split('/');
    var coalesced = false;
    for (var si = 0; si < segments.length; si++) {
      if (EPHEMERAL_SEGMENTS[segments[si]]) coalesced = true;
    }

    var layer = document.createElement('div');
    layer.className = 'ap-tokens-layer';
    layer.setAttribute('data-ap-path', path);
    content.appendChild(layer);

    /* The path is unusable for a DROP, so say so where a human will see it rather than dropping
       writes into a coalescing channel and letting the board look merely unreliable. */
    if (coalesced) {
      var warning = document.createElement('div');
      warning.className = 'ap-tokens-warning';
      warning.textContent = 'tokens: "' + path + '" contains an ephemeral segment — drops are not durable';
      layer.appendChild(warning);
      layer.setAttribute('data-ap-ephemeral', '1');
      editable = false;
    }

    /*
     * ⭐ TWO SOURCES, AND WHICH ONE OWNS WHAT IS THE WHOLE DESIGN.
     *
     *   `authored` — the roster the beat supplies. It owns MEMBERSHIP: which tokens exist at all.
     *                Plan 0720 D2: "nothing creates a token in play; the roster is authored ahead
     *                of the fight."
     *   `stored`   — the collection in the shared store. It owns POSITION and CONDITION: what has
     *                happened to those tokens since.
     *
     * ⛔ THE STORE IS AN OVERLAY, NOT A REPLACEMENT, and the first cut of this got it wrong in a
     * way only a late joiner could see: seeding by REPLACING the roster with the collection showed
     * a viewer who arrived mid-fight only the tokens somebody had already dragged, and silently
     * dropped every token still sitting where it was authored. Everyone already in the room saw a
     * complete board, so the defect was invisible from inside the session that caused it.
     * ⇒ union by id, store wins per token; a token removed from the store falls back to its
     *   authored record rather than vanishing.
     */
    var authored = {};   // id -> record — membership, from opts
    var stored = {};     // id -> record — position/condition, mirroring the store collection
    var model = {};      // id -> record — what this viewer is showing (authored ⊕ stored ⊕ my hand)
    var els = {};        // id -> { el, body, status, label }
    var dragId = null;   // the token under this viewer's hand, or null
    var dragFrom = null; // where the hand went down (viewport px) — the threshold's origin
    var dragBefore = null; // the record as it stood at pointerdown, restored if this was a tap
    var dragMoved = false; // has the hand travelled far enough to mean it?
    var subs = [];
    var dead = false;    // teardown is idempotent — the registry may destroy what a caller already did

    // ── the roster ────────────────────────────────────────────────────────────────────────────
    /*
     * ⛔⛔ THE FIELD WHITELIST WAS AN ERASER, AND IT ERASED ON *READ* (plan 0720 RUN A / F1).
     *
     * `normalise` used to BUILD a fresh object out of seven named fields, and three other places
     * did the same enumeration by hand. Because `applyCollection` runs `normalise` over everything
     * the store hands back, a field the caller published — a size, a description, a pin — was gone
     * the instant it was read, not merely the first time somebody dragged the token. A feature
     * carried in an eighth field could therefore never work AT ALL, in any client, and the failure
     * was silent: the write succeeded, the store held it, and every board dropped it on arrival.
     *
     * ⇒ The rule is inverted. Whatever the caller published is CARRIED; the fields below are the
     * only ones this component claims, and it claims them only to COERCE them (a position must be
     * a number in 0..1 or the geometry is meaningless; a label must be a string or it cannot be
     * drawn). Everything else is opaque payload, exactly as `side` and `kind` are opaque strings.
     *
     * ⛔ ONE EXCLUSION, AND IT IS DELIBERATE: keys beginning `_` are the HOST's bookkeeping
     * (`_locks` and friends), never a token's own data. Carrying them would round-trip the store's
     * internals back through a participant write, and a lock would start rendering as a piece.
     */
    var COERCED = { id: 1, label: 1, side: 1, kind: 1, px: 1, py: 1, status: 1, pin: 1 };

    /** A shallow copy of a record — the ONE place a record is duplicated, so no copy can shrink it. */
    function cloneRec(rec) {
      var out = {};
      for (var k in rec) if (Object.prototype.hasOwnProperty.call(rec, k)) out[k] = rec[k];
      return out;
    }

    function normalise(id, raw) {
      var r = raw && typeof raw === 'object' ? raw : {};
      var out = {};
      for (var k in r) {
        if (!Object.prototype.hasOwnProperty.call(r, k)) continue;
        if (k.charAt(0) === '_' || COERCED[k]) continue;   // host bookkeeping · coerced below
        out[k] = r[k];
      }
      out.id = id;
      out.label = r.label == null ? id : String(r.label);
      out.side = r.side == null ? null : String(r.side);
      out.kind = r.kind == null ? null : String(r.kind);
      out.px = clamp01(num(r.px, 0.5));
      out.py = clamp01(num(r.py, 0.5));
      out.status = r.status === undefined ? null : r.status;
      /*
       * ⛔ `pin` — THE PER-TOKEN EXCEPTION TO `draggable`, and it is not a nicety.
       * `draggable` is a property of the MOUNT: every piece moves or none do. A board whose centre
       * is a declared origin needs the opposite — one piece that cannot be shoved, on a surface
       * where everything else can. `recompute()` lets STORED beat AUTHORED, so a single stray
       * finger writes a new position for the origin and re-pushing the roster does NOT put it back;
       * from that moment every ring on the board measures from the wrong place, silently.
       *
       * ⚠ Boolean and nothing else. A pin that arrived as the string "false" must not read as
       * pinned, and a pin that is simply absent must read as NOT pinned rather than as `undefined`,
       * or the drag guard would be deciding on a value it never received.
       */
      out.pin = r.pin === true;
      return out;
    }
    var roster = Array.isArray(opts.tokens) ? opts.tokens : [];
    for (var ai = 0; ai < roster.length; ai++) {
      var a = roster[ai];
      if (a && a.id != null) authored[String(a.id)] = normalise(String(a.id), a);
    }

    /** model = authored ⊕ stored, with the token under this hand left exactly where the hand is. */
    function recompute() {
      var next = {}, id;
      for (id in authored) next[id] = authored[id];
      for (id in stored) next[id] = stored[id];
      /* ⚠ THE ECHO (B6 finding 4): the writer gets its own diff back, and diffs it did not cause
         arrive constantly. Neither may yank a token out from under the person dragging it. */
      if (dragId && model[dragId]) next[dragId] = model[dragId];
      model = next;
    }

    function seedFromStore() {
      /* Finding 6: the snapshot is separate and COMPLETE, so a late joiner is seeded with zero
         diffs. Reading the collection on mount is what turns that fact into a board that is never
         blank and never half a roster. */
      if (!Argus || !Argus.state) return;
      applyCollection(Argus.state(path, null));
    }

    function applyCollection(value) {
      stored = {};
      if (value && typeof value === 'object') {
        for (var id in value) {
          if (!Object.prototype.hasOwnProperty.call(value, id)) continue;
          if (value[id] == null) continue;
          stored[id] = normalise(id, value[id]);
        }
      }
    }
    function applyToken(id, value) {
      if (value == null) delete stored[id];            // ⇒ falls back to the authored record
      else stored[id] = normalise(id, value);
    }
    function applyField(id, parts, value) {
      if (parts.length !== 1) return;                  // deeper leaves are not ours to guess at
      var base = stored[id] || authored[id] || normalise(id, {});
      /* ⛔ COPY THE RECORD, DO NOT REBUILD IT. Naming the fields here made a single-leaf diff —
         `…/<id>/status`, one field — silently AMPUTATE every other field the record was carrying,
         because the rebuild only ever mentioned seven of them. */
      var raw = cloneRec(base);
      raw[parts[0]] = value;
      stored[id] = normalise(id, raw);
    }

    // ── geometry ──────────────────────────────────────────────────────────────────────────────
    function scaleNow() {
      var v = handle.view && handle.view();
      var s = v && v.scale;
      if (!s) {                                        // map changed shape: read the transform back
        var m = /scale\(([-0-9.]+)\)/.exec(content.style.transform || '');
        s = m ? parseFloat(m[1]) : 1;
      }
      return s && isFinite(s) && s !== 0 ? s : 1;
    }
    function place(id) {
      var e = els[id], rec = model[id];
      if (!e || !rec) return;
      e.el.style.left = (rec.px * 100) + '%';
      e.el.style.top = (rec.py * 100) + '%';
      e.el.style.transform = 'translate(-50%, -50%) scale(' + (1 / scaleNow()) + ')';
    }
    function placeAll() { for (var id in els) place(id); }

    /** Event coords -> fraction of the untransformed content box (the wire's own units). */
    function frac(ev) {
      var r = content.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { px: clamp01((ev.clientX - r.left) / r.width), py: clamp01((ev.clientY - r.top) / r.height) };
    }

    // ── DOM, reconciled rather than rebuilt ───────────────────────────────────────────────────
    /** Can THIS viewer move THIS token right now? Mount-wide permission AND the token's own pin. */
    function movable(id) {
      var rec = model[id];
      return !!(editable && rec && rec.pin !== true);
    }
    function create(id) {
      var el = document.createElement('div');
      el.className = 'ap-token';
      el.setAttribute('data-token-id', id);
      var body = document.createElement('div'); body.className = 'ap-token-body';
      var status = document.createElement('div'); status.className = 'ap-token-status';
      var label = document.createElement('div'); label.className = 'ap-token-label';
      body.appendChild(status); el.appendChild(body); el.appendChild(label);
      /* ⛔ THE LISTENER IS BOUND ON PERMISSION, THE REFUSAL HAPPENS IN `grab`. A pin can arrive
         from the store at any moment — the origin may be declared long after the piece is on the
         board — and an element created before that diff would otherwise stay draggable for the
         rest of the session with nothing on screen to show it. `grab` reads the LIVE record. */
      if (editable) el.addEventListener('pointerdown', function (ev) { grab(id, el, ev); });
      layer.appendChild(el);
      els[id] = { el: el, body: body, status: status, label: label };
    }
    function drop(id) {
      var e = els[id];
      if (e && e.el.parentNode) e.el.parentNode.removeChild(e.el);
      delete els[id];
    }
    /* `status` is whatever the caller publishes and is NEVER derived here — a second derivation of
       a fact the system already computes is how two sources of truth start. Two shapes are honoured:
       an opaque string (published as a hook), or a record carrying the colour/word/emphasis the
       producer already settled on. */
    function paintStatus(e, st) {
      var el = e.status;
      el.removeAttribute('title'); el.classList.remove('is-emphasis');
      el.style.background = ''; el.setAttribute('data-status', '');
      if (st == null || st === '') { el.style.display = 'none'; return; }
      el.style.display = '';
      if (typeof st === 'object') {
        var colour = st.colour || st.color;
        if (colour) el.style.background = String(colour);
        if (st.word != null) el.setAttribute('title', String(st.word));
        if (st.emphasis) el.classList.add('is-emphasis');
        el.setAttribute('data-status', st.word == null ? '' : String(st.word));
      } else {
        el.setAttribute('data-status', String(st));
        el.setAttribute('title', String(st));
      }
    }
    function paint(id) {
      var e = els[id], rec = model[id];
      if (!e || !rec) return;
      if (e.label.textContent !== rec.label) e.label.textContent = rec.label;
      e.el.setAttribute('data-side', rec.side == null ? '' : rec.side);
      e.el.setAttribute('data-kind', rec.kind == null ? '' : rec.kind);
      /* A piece nobody can move must LOOK like one. `is-static` covers both reasons — the mount
         forbids dragging, or this token is pinned — because to a finger they are the same fact;
         `data-pin` keeps the two distinguishable for anyone who needs to know which. */
      e.el.classList.toggle('is-static', !movable(id));
      e.el.classList.toggle('is-pinned', rec.pin === true);
      if (rec.pin === true) e.el.setAttribute('data-pin', '1'); else e.el.removeAttribute('data-pin');
      e.el.style.setProperty('--ap-token-tint', tint(rec.side == null ? id : rec.side));
      paintStatus(e, rec.status);
    }
    /*
     * ⛔⛔ AN EMPTY BOARD MUST SAY IT IS EMPTY. This project has already shipped one region that
     * rendered nothing and told nobody, and it survived a week of green tests because a region that
     * renders nothing satisfies every assertion that asks "did the region render?".
     *
     * It stops being a corner case the moment the board is authored into the STORE rather than into
     * the mount: the component then legitimately comes up with no pieces, every time, before the
     * tool has written anything. A blank plot and a broken plot look identical, and the person
     * looking at it is mid-session and has no way to tell which one they have.
     *
     * ⚠ The message says the board is empty. It does NOT say "loading" — the component does not
     * know whether anything is coming, and a spinner that never resolves is a worse lie than a
     * statement of fact.
     *
     * ⛔ IT HANGS OFF THE VIEWPORT, NOT OFF THE TOKEN LAYER. The layer lives INSIDE
     * `.ap-map-content`, which the map scales: a message parked there would shrink with the zoom
     * and slide away with the pan, so the one thing on screen whose whole job is to be read could
     * end up three pixels tall or off the edge. Tokens counter-scale because they are anchored to
     * the board; a message is anchored to the reader.
     */
    var viewportEl = root.querySelector('.ap-map-viewport') || layer;
    var emptyEl = null;
    function paintEmpty(isEmpty) {
      if (isEmpty && !emptyEl) {
        emptyEl = document.createElement('div');
        emptyEl.className = 'ap-tokens-empty';
        emptyEl.setAttribute('data-ap-empty', '1');
        emptyEl.textContent = 'No pieces on this board yet.';
        viewportEl.appendChild(emptyEl);
      } else if (!isEmpty && emptyEl) {
        if (emptyEl.parentNode) emptyEl.parentNode.removeChild(emptyEl);
        emptyEl = null;
      }
    }

    /** ⭐ The whole render, and it is IDEMPOTENT: running it twice equals running it once. */
    function sync() {
      var id, any = false;
      for (id in model) if (!els[id]) create(id);
      for (id in els) if (!model[id]) drop(id);
      for (id in els) { paint(id); place(id); any = true; }
      paintEmpty(!any);
    }

    // ── drag: local while moving, ONE write on drop ───────────────────────────────────────────
    function grab(id, el, ev) {
      /* ⛔ A PINNED TOKEN IS NOT A GRAB HANDLE — and note what is NOT done here: no
         `stopPropagation`, no `preventDefault`. The press falls through to the map exactly as a
         press on empty space does, so a pinned piece stays clickable and pannable-through rather
         than becoming a dead patch on the board. */
      if (!movable(id)) return;
      /* ⛔ CLONE BEFORE MOVING. `recompute()` puts the AUTHORED record itself into the model when
         the store has nothing for that token, so mutating it in place during a drag would rewrite
         the roster's own starting position — and the corruption would only show up the next time
         the store dropped that key and the token was expected to fall back to where it began. */
      /* ⛔ AND THIS WAS THE FOURTH SITE, NAMED BY NOBODY. The clone that protects the authored
         record from being mutated in place was ITSELF a seven-field rebuild — so a token's extra
         fields were gone at `pointerdown`, before `emit` ever ran. Fixing only the three sites the
         audit listed would have left the drag path erasing them anyway. */
      model[id] = cloneRec(model[id]);
      dragId = id;
      /* Where the hand went down, and the record as it stood before it did. A press that turns out
         to be a tap must leave BOTH the board and the store exactly as it found them, and "exactly"
         means the record, not just the two coordinates. */
      dragFrom = { x: ev.clientX, y: ev.clientY };
      dragBefore = cloneRec(model[id]);
      dragMoved = false;
      el.classList.add('is-dragging');
      try { el.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic pointers have no capture */ }
      /* stopPropagation keeps the map from panning; preventDefault on `pointerdown` suppresses the
         compatibility mouse events, which is what keeps map.js from dropping a click marker under
         the token. Both are needed, and navmap learned it the same way. */
      ev.stopPropagation(); ev.preventDefault();
    }
    /* Move/up are on WINDOW, not on the token. With pointer capture the events retarget to the
       token and bubble here anyway; WITHOUT capture (a synthetic pointer, a fast drag that outruns
       the element) they land on whatever is underneath and still bubble here. One listener covers
       both, and it fires exactly once either way. */
    function onMove(ev) {
      if (!dragId) return;
      /* ⛔ NOTHING MOVES UNTIL THE THRESHOLD IS CROSSED. Tracking the movement but painting it
         anyway would mean a sub-threshold press visibly nudged the piece and then snapped it back
         on release, which reads as a glitch; and if the press ended above the threshold the piece
         would have been following a hand that had not yet decided to drag. Below 4px, nothing
         happened — on the board and in the record alike. */
      if (!dragMoved) {
        if (Math.abs(ev.clientX - dragFrom.x) <= MOVE_THRESHOLD_PX
          && Math.abs(ev.clientY - dragFrom.y) <= MOVE_THRESHOLD_PX) return;
        dragMoved = true;
      }
      var f = frac(ev); if (!f) return;
      var rec = model[dragId];
      if (!rec) return;
      rec.px = f.px; rec.py = f.py;
      place(dragId);                                   // local only — see 4: no write per pointer move
      ev.stopPropagation();
    }
    function onUp(ev) {
      if (!dragId) return;
      var id = dragId; dragId = null;
      var e = els[id]; if (e) e.el.classList.remove('is-dragging');
      if (e) { try { e.el.releasePointerCapture(ev.pointerId); } catch (err) {} }
      /*
       * ⛔⛔ A TAP WRITES NOTHING. Not "writes the same value" — NOTHING. The distinction is the
       * whole point: a `set` of an identical record still converts an AUTHORED token into a STORED
       * one, and from that moment `recompute()` lets the store win, so re-authoring the roster can
       * never change that piece again. The board would go quietly un-authorable one tap at a time,
       * with every value on screen still correct.
       */
      if (!dragMoved) {
        if (dragBefore) model[id] = dragBefore;        // put the record back, whole
        place(id);
        dragBefore = null;
        ev.stopPropagation();
        return;
      }
      dragBefore = null;
      emit(id);                                        // ⭐ ONE write, on drop
      ev.stopPropagation();
    }
    function emit(id) {
      var rec = model[id];
      if (!rec || !Argus || !Argus.op || coalesced) return;
      /* `set` with the whole record, not `merge`: a token that has never been written must arrive
         complete, and B3.2 measured `set` per key as the lossless form.
         ⛔ THE WHOLE record — the one this viewer is holding, field for field. Enumerating seven
         names here turned every drop into a lossy write: the store kept whatever the caller had
         published only until the first person touched the piece. */
      Argus.op(path + '/' + id, 'set', cloneRec(rec));
    }
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);

    // ── state ─────────────────────────────────────────────────────────────────────────────────
    if (Argus && Argus.subscribeState) {
      /* ⛔ ONE subscription, AT THE COLLECTION (B6 finding 1). The handler is given the FULL path,
         never a path relative to the prefix, so the id comes off the tail. */
      subs.push(Argus.subscribeState(path, function (full, value) {
        if (full === path) applyCollection(value);
        else {
          var tail = full.slice(path.length + 1);
          if (!tail) return;
          var parts = tail.split('/');
          if (parts.length === 1) applyToken(parts[0], value);
          else applyField(parts[0], parts.slice(1), value);
        }
        recompute(); sync();
      }));
    }

    /* The map owns the transform; we only need to know when it changed. Observing the element it
       writes covers pan, wheel zoom, zoom-to-fit and a remote `map/view` diff with one mechanism —
       and there is no mirrored copy of the view to fall out of step. */
    var mo = null;
    if (window.MutationObserver) {
      mo = new MutationObserver(placeAll);
      mo.observe(content, { attributes: true, attributeFilter: ['style'] });
    }

    /*
     * ⛔ THE SNAPSHOT CAN ARRIVE AFTER THE MOUNT, AND A LATE JOINER HAS NOTHING ELSE.
     * `Argus._state` is filled by the host's `snapshot` frame; a component mounted before that
     * frame lands reads an empty cache, and because a late joiner is seeded ENTIRELY from the
     * snapshot (B6 finding 3: zero diffs), it would then sit on the authored roster for the rest
     * of the session with every drag that happened before it arrived invisible. Seeding twice —
     * now, and again on any snapshot — costs nothing, because `sync()` is idempotent. map.js does
     * exactly this for `map/view`, for exactly this reason.
     */
    var offSnapshot = Argus && Argus.onMessage ? Argus.onMessage(function (m) {
      if (!m || m.type !== 'snapshot') return;
      seedFromStore(); recompute(); sync();
    }) : null;

    seedFromStore();
    recompute();
    sync();

    return {
      setView: handle.setView,
      view: handle.view,
      /** Read-only view of what this viewer is showing. For tests and for a host that wants a count. */
      tokens: function () {
        var out = {};
        for (var id in model) out[id] = JSON.parse(JSON.stringify(model[id]));
        return out;
      },
      /*
       * ⛔ IDEMPOTENT. The registry now tears down whatever it last mounted on a host before it
       * mounts again (plan 0720 RUN A / F12), so a caller that also keeps its own handle would
       * otherwise destroy the same instance twice. Guarding here rather than trusting every caller
       * is the same reasoning that put the fix in the registry rather than in `assemble.mjs`.
       *
       * ⚠ NOTHING HERE IS COLLECTED BY THE DOM. Three window pointer listeners, a MutationObserver
       * and a store subscription all outlive `root.innerHTML = ''` — which is exactly why a leaked
       * instance kept reconciling a detached tree on every diff instead of failing loudly.
       */
      destroy: function () {
        if (dead) return; dead = true;
        if (offSnapshot) { try { offSnapshot(); } catch (e) {} }
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        if (mo) mo.disconnect();
        subs.forEach(function (u) { try { u(); } catch (e) {} });
        paintEmpty(false);
        if (handle.destroy) handle.destroy(); else root.innerHTML = '';
      }
    };
  }

  if (window.ApComponents) window.ApComponents.register('tokens', render);
})();
