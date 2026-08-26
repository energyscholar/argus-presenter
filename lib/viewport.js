/*
 * lib/viewport.js — Plan 0695 Part B — ONE EXPANDABLE VIEWPORT.
 *
 * ⛔ WHY THIS FILE EXISTS, AND WHAT IT IS NOT.
 *
 * The Control page's Live Preview has been able to maximise since Plan 0522 P7.2, and it WORKS:
 * a `.fullscreen` class over `position:fixed;inset:0`, ESC to leave, six tests (0522 t17–t22)
 * holding it in place. It was never missing — it was INVISIBLE: a 10px `⤢` glyph inset two pixels
 * into the corner of a 432×282 box. The person who commissioned the preview reported the
 * capability as absent, which is the whole lesson: a feature nobody can find has the same value as
 * a feature that does not exist, and it generates the same bug report. Plan 0695 Part A made that
 * one control findable.
 *
 * Part B is the other half. A second surface (screen sharing, plan 0695 Part C) wants exactly the
 * same gesture — a small live box, maximise, restore, ESC — and writing it a second time is how two
 * maximise implementations begin to disagree about what "maximised" means. So the behaviour the
 * Control preview already PROVES lives here, once, and the preview is this module's first CALLER
 * rather than its private copy. ⛔ There must be exactly one thing in this repo that toggles the
 * maximise class. If you are about to write `classList.toggle('fullscreen', …)` anywhere else,
 * call mount() instead. (test/component/0695-expandable-viewport.test.mjs asserts that by grep.)
 *
 * ⛔ CLASS, NOT THE FULLSCREEN API. `requestFullscreen()` is not a drop-in for this:
 *   • it requires a user gesture, so no programmatic maximise (the test hook, the MCP path) can
 *     use it;
 *   • it is REFUSED inside a sandboxed iframe without `allow-fullscreen`, and the preview frame is
 *     deliberately `sandbox="allow-scripts"` and nothing else (0522 t20 nails that flag down);
 *   • iOS Safari implements it differently, and for <iframe> barely at all.
 *   The class-based maximise works today on every surface we ship to. Keep what works.
 *
 * ⭐ ENFORCE BY CONSTRUCTION, NOT BY REFUSAL. Bruce: "END SHARING doesn't apply" to the preview —
 * there is nothing to end. That is expressed here as the ABSENCE of an `onEnd` callback, and the
 * End control is then never CREATED. It is not rendered-and-hidden, and there is no `showEnd:false`
 * flag for a caller to set wrongly: a viewport with no way to end has no End button in its DOM at
 * all, so no CSS slip and no future `display:block` can reveal one.
 *
 *   mount(el, { title, onEnd?, restoreOn: ['esc','button'] })
 *     → { maximise(), restore(), toggle(), isMaximised(), destroy() }
 */

/** The class a maximised viewport wears. The Control preview's CSS has used this name since 0522. */
export const MAXIMISED_CLASS = 'fullscreen';

/**
 * Every currently-maximised viewport, outermost first. ESC peels exactly ONE layer — the last one
 * opened — which is the rule that stops a maximised viewport from also closing the config overlay
 * beneath it on a single press (0695 acceptance 7).
 */
const stack = [];

/** Documents already carrying the one shared keydown listener (mounting twice must not wire twice). */
const wired = new WeakSet();

/** The viewport ESC belongs to right now, or null. Exported for host pages and for tests. */
export function topmost() { return stack.length ? stack[stack.length - 1] : null; }

/** How many layers are open. Zero means ESC belongs to the page again. */
export function openCount() { return stack.length; }

function wire(doc) {
  if (!doc || wired.has(doc)) return;
  wired.add(doc);
  // CAPTURE phase, deliberately. Host pages already own a document-level keydown handler with
  // their own meaning for Escape — on control.html ESC closes the attendance panel, else the
  // config overlay, else STOPS the room. A maximised viewport is the layer physically covering all
  // of those, so it must take the key BEFORE they see it and then stop it dead: an exit that ALSO
  // clears the room is not an exit, and 0522 t18 asserts exactly that. One press, one layer.
  doc.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    const vp = topmost();
    // Nothing open, or the topmost layer does not answer to ESC ⇒ the page keeps its key. Falling
    // through is the correct behaviour, not a miss: t18's SECOND press must reach STOP.
    if (!vp || !vp._escapes) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    vp.restore();
  }, true);
}

/**
 * Mount an expandable viewport on `el`.
 *
 * @param {Element}  el                the viewport box itself — this is the element that grows.
 * @param {object}   opts
 * @param {string}   opts.title        human name; used for the control's title/aria-label.
 * @param {Function} [opts.onEnd]      ABSENT ⇒ NO End control is created at all. See the header.
 * @param {string[]} [opts.restoreOn]  which gestures restore. Default ['esc','button'].
 * @param {Element}  [opts.control]    an EXISTING maximise button to ADOPT instead of creating one.
 *                                     control.html passes its `#btn-pvfull`: that button predates
 *                                     this module, it is what 0522 t17–t22 click, and ⛔ it must
 *                                     not be deleted, renamed or rebuilt.
 * @param {string}   [opts.controlId]  id for a button this module CREATES (ignored when adopting).
 * @param {string}   [opts.className]  the maximise class. Defaults to MAXIMISED_CLASS.
 * @param {Element[]} [opts.alsoToggle] elements that must carry the class too. The preview needs
 *                                     this: `#pvdock` is position:fixed WITH a z-index, so it owns
 *                                     a stacking context and a z-index on the preview alone can
 *                                     never climb past the settings overlay.
 * @param {Function} [opts.onChange]   (maximised) => void, called after every state change.
 * @param {string}   [opts.endLabel]   label for the End control, when one is created.
 * @param {Document} [opts.document]   for tests; defaults to el.ownerDocument.
 */
export function mount(el, opts) {
  opts = opts || {};
  if (!el) throw new Error('viewport.mount: no element');
  const doc = opts.document || el.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const cls = opts.className || MAXIMISED_CLASS;
  const restoreOn = Array.isArray(opts.restoreOn) ? opts.restoreOn : ['esc', 'button'];
  const title = opts.title || 'Viewport';
  const also = Array.isArray(opts.alsoToggle) ? opts.alsoToggle.filter(Boolean) : [];
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
  // ⭐ The one line that turns "END SHARING doesn't apply" into a fact about the DOM rather than a
  //   flag a caller can set wrongly.
  const onEnd = typeof opts.onEnd === 'function' ? opts.onEnd : null;
  const buttonRestores = restoreOn.indexOf('button') !== -1;

  let open = false;
  let created = null;    // the control we MADE, if we made one — destroy() removes only ours
  let endBtn = null;

  const api = {
    el: el,
    /** Whether ESC restores this one. Read by the shared keydown listener above. */
    _escapes: restoreOn.indexOf('esc') !== -1,
    isMaximised: function () { return open; },
    maximise: function () { set(true); },
    restore: function () { set(false); },
    toggle: function () { set(!open); },
    /** The maximise control — adopted or created. */
    control: null,
    /** The End control, or NULL when no onEnd was given. The null is the whole point. */
    endControl: null,
    destroy: destroy,
  };

  function set(on) {
    on = !!on;
    if (on === open) return;
    open = on;
    el.classList.toggle(cls, on);
    for (let i = 0; i < also.length; i++) also[i].classList.toggle(cls, on);
    const at = stack.indexOf(api);
    if (on) { if (at === -1) stack.push(api); }
    else if (at !== -1) stack.splice(at, 1);
    label();
    if (onChange) onChange(on);
  }

  function label() {
    const b = api.control;
    if (!b) return;
    // The glyph and the WORDS are separate nodes so the glyph can flip without eating the label —
    // Part A's whole point is that there IS a label. A button that is only a glyph (older markup,
    // or one built without the spans) still gets its glyph swapped, so nothing regresses.
    const g = b.querySelector ? b.querySelector('[data-vp-glyph]') : null;
    const t = b.querySelector ? b.querySelector('[data-vp-text]') : null;
    if (g) g.textContent = open ? '⤡' : '⤢'; else b.textContent = open ? '⤡' : '⤢';
    if (t) t.textContent = open ? 'Exit full screen' : 'Full screen';
    const tip = open
      ? 'Exit full screen (ESC, or press F) — ' + title
      : 'Full screen (or press F) — ' + title + ' at native size, interactive. ESC exits.';
    b.setAttribute('title', tip);
    b.setAttribute('aria-label', tip);
    b.setAttribute('aria-pressed', open ? 'true' : 'false');
  }

  // ── the maximise control ─────────────────────────────────────────────────────────────────────
  if (opts.control) {
    api.control = opts.control;
  } else {
    // Nothing was handed in, so this viewport builds its own. A viewport with no VISIBLE way in or
    // out is precisely the defect Part A exists to fix, so the control is not optional.
    const b = doc.createElement('button');
    b.type = 'button';
    if (opts.controlId) b.id = opts.controlId;
    b.className = 'ap-vp-full';
    b.setAttribute('data-vp-control', '');
    const g = doc.createElement('span'); g.setAttribute('data-vp-glyph', ''); g.textContent = '⤢';
    const t = doc.createElement('span'); t.setAttribute('data-vp-text', ''); t.textContent = 'Full screen';
    b.appendChild(g); b.appendChild(t);
    el.appendChild(b);
    created = b;
    api.control = b;
  }
  function clickControl(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    if (open && !buttonRestores) return;   // this viewport was declared to exit some other way
    api.toggle();
  }
  if (api.control) api.control.addEventListener('click', clickControl);

  // ── the End control — created ONLY when there is something to end ────────────────────────────
  if (onEnd) {
    endBtn = doc.createElement('button');
    endBtn.type = 'button';
    endBtn.className = 'ap-vp-end';
    endBtn.setAttribute('data-vp-end', '');
    endBtn.textContent = opts.endLabel || 'End sharing';
    endBtn.setAttribute('title', (opts.endLabel || 'End sharing') + ' — ' + title);
    endBtn.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); onEnd(api); });
    el.appendChild(endBtn);
    api.endControl = endBtn;
  }

  wire(doc);
  label();
  return api;

  function destroy() {
    set(false);
    if (api.control) api.control.removeEventListener('click', clickControl);
    if (created && created.parentNode) created.parentNode.removeChild(created);
    if (endBtn && endBtn.parentNode) endBtn.parentNode.removeChild(endBtn);
    endBtn = null; api.endControl = null; created = null;
    const at = stack.indexOf(api);
    if (at !== -1) stack.splice(at, 1);
  }
}

export default { mount, topmost, openCount, MAXIMISED_CLASS };
