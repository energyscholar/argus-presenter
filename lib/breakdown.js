/*
 * lib/breakdown.js — SHOW THE ARITHMETIC. Plan 0539 P1.7 (+ R2 amendment).
 *
 * ⛓ THIS FILE IS DELIBERATELY DOMAIN-NEUTRAL AND DELIBERATELY NOT ABOUT DICE.
 *
 * The need arrived from a dice log ("a total appeared and nothing said why"), but the shape of the
 * problem is not a dice shape. Anything that computes `base + reason + reason − reason` and shows a
 * human only the answer has the same defect: a capability level assembled from several named
 * sources, a score, a budget, a load figure. Plan 0539's R2 amendment names that explicitly — the
 * next caller needs the IDENTICAL `modifiers: [{label, value}]` shape, and if the renderer had been
 * written inside dice-only code that caller would have invented a second format.
 *
 * So: no dice vocabulary in any identifier here, and nothing in this file knows what a die is.
 * The caller maps ITS record onto the model; this file renders the model.
 *
 * ── THE MODEL ────────────────────────────────────────────────────────────────────────────────
 *   {
 *     label:      string|null    what the total is FOR ("accuracy check", "lift capacity")
 *     parts:      [number | {label, value}]
 *                                the raw contributions that carry no reason of their own — the
 *                                individual values that were generated/measured. May be empty.
 *     partsLabel: string|null    heading for the parts group ("rolled", "sampled", "base")
 *     modifiers:  [{label, value}]
 *                                ⭐ THE SHARED SHAPE. Each entry is a number AND THE REASON FOR IT.
 *                                `label: null` means "no reason was recorded" — which is honest and
 *                                is NOT the same as inventing one.
 *     total:      number|null    the authoritative total. When null it is computed. When supplied
 *                                and it does NOT equal parts+modifiers, the discrepancy is SHOWN,
 *                                never silently reconciled — see `reconciles` below.
 *     note:       string|null    one line of context ("entered by hand", "vs 8+ — SUCCESS")
 *   }
 *
 * ⛔ EVERY STRING IN THE MODEL IS UNTRUSTED. `render()` builds DOM and assigns `textContent`; it
 *    never touches innerHTML. `text()` returns a plain string with no markup semantics. A caller
 *    that takes `text()` and injects it as HTML has re-opened the hole on its own.
 *
 * ⛓ NOT HOVER-ONLY. The expansion is a native <details>/<summary>: it opens on click, on Enter/Space
 *    with a keyboard, and on tap. A `title=` tooltip would be invisible to both touch and keyboard.
 */
(function (root) {
  'use strict';

  var MINUS = '−';   // U+2212 MINUS SIGN — the typographic minus, not a hyphen

  function num(v) { var n = Number(v); return (typeof n === 'number' && isFinite(n)) ? n : 0; }
  function str(v) { return v == null ? null : String(v); }
  /** "+3" / "−1" — a signed contribution reads as an operation, not as a quantity. */
  function signed(v) { return (v < 0 ? MINUS : '+') + Math.abs(v); }

  /**
   * Coerce anything caller-shaped into the canonical model. Never throws: a malformed model
   * degrades to "a total with no explanation", which is exactly the pre-0539 display and is
   * strictly better than an exception inside a chat log.
   */
  function normalize(model) {
    var m = (model && typeof model === 'object') ? model : {};
    var parts = [];
    if (Array.isArray(m.parts)) {
      for (var i = 0; i < m.parts.length; i++) {
        var p = m.parts[i];
        if (p && typeof p === 'object') parts.push({ label: str(p.label), value: num(p.value) });
        else parts.push({ label: null, value: num(p) });
      }
    }
    var mods = [];
    if (Array.isArray(m.modifiers)) {
      for (var j = 0; j < m.modifiers.length; j++) {
        var x = m.modifiers[j];
        if (x == null) continue;
        if (typeof x === 'object') mods.push({ label: str(x.label), value: num(x.value) });
        else mods.push({ label: null, value: num(x) });
      }
    }
    var partsSum = 0; for (var a = 0; a < parts.length; a++) partsSum += parts[a].value;
    var modsSum = 0;  for (var b = 0; b < mods.length; b++)  modsSum  += mods[b].value;
    var computed = partsSum + modsSum;
    var hasTotal = (m.total !== null && m.total !== undefined && isFinite(Number(m.total)));
    var total = hasTotal ? num(m.total) : computed;
    return {
      label: str(m.label), partsLabel: str(m.partsLabel), note: str(m.note),
      parts: parts, modifiers: mods,
      partsSum: partsSum, modsSum: modsSum, computed: computed, total: total,
      // ⛓ An authoritative total that does not equal the shown arithmetic is a REAL disagreement
      // and the display says so. Quietly printing the authoritative number over an arithmetic that
      // contradicts it is how one event becomes two facts.
      reconciles: (!hasTotal) || (computed === total),
      // Is there anything to expand? A total with no parts and no modifiers explains nothing.
      explained: (parts.length + mods.length) > 0
    };
  }

  /** The model as flat rows: [{label, value, text, kind}]. `kind` ∈ part | modifier | total. */
  function rows(model) {
    var n = normalize(model), out = [], i;
    // ⛓ UNLABELLED PARTS COLLAPSE INTO ONE ROW. They are the raw values that were generated — they
    // have no reasons to give, so one row per value just repeats the group heading down the side
    // ("generated 6 / generated 2"), which reads as two facts where there is one. When ANY part
    // carries a label the caller is distinguishing them on purpose, so they stay separate.
    var anyLabelled = false;
    for (i = 0; i < n.parts.length; i++) if (n.parts[i].label) anyLabelled = true;
    if (n.parts.length && !anyLabelled) {
      var vals = [];
      for (i = 0; i < n.parts.length; i++) vals.push(n.parts[i].value);
      out.push({ kind: 'part', label: n.partsLabel || 'parts', value: n.partsSum, values: vals,
                 text: (n.partsLabel ? n.partsLabel + ': ' : '') + vals.join(' + ') });
    } else {
      for (i = 0; i < n.parts.length; i++) {
        out.push({ kind: 'part', label: n.parts[i].label, value: n.parts[i].value, values: [n.parts[i].value],
                   text: (n.parts[i].label ? n.parts[i].label + ': ' : '') + n.parts[i].value });
      }
    }
    for (i = 0; i < n.modifiers.length; i++) {
      var lbl = n.modifiers[i].label;
      out.push({ kind: 'modifier', label: lbl, value: n.modifiers[i].value,
                 text: signed(n.modifiers[i].value) + (lbl ? '  ' + lbl : '  (no reason recorded)') });
    }
    out.push({ kind: 'total', label: 'total', value: n.total, text: 'total ' + n.total });
    return out;
  }

  /** One plain line, e.g. `check: 3 + 4 +2 trained −1 distance = 8`. No markup. */
  function text(model) {
    var n = normalize(model), bits = [], i;
    if (n.label) bits.push(n.label + ':');
    if (n.parts.length) {
      var ps = [];
      for (i = 0; i < n.parts.length; i++) ps.push((n.parts[i].label ? n.parts[i].label + ' ' : '') + n.parts[i].value);
      bits.push((n.partsLabel ? n.partsLabel + ' ' : '') + ps.join(' + '));
    }
    for (i = 0; i < n.modifiers.length; i++) {
      bits.push(signed(n.modifiers[i].value) + (n.modifiers[i].label ? ' ' + n.modifiers[i].label : ''));
    }
    bits.push('= ' + n.total);
    if (!n.reconciles) bits.push('(shown arithmetic gives ' + n.computed + ')');
    if (n.note) bits.push('— ' + n.note);
    return bits.join(' ');
  }

  /* The stylesheet, exported as a STRING so a host injects it where it belongs — this file never
   * reaches into a document it was not asked to touch. `injectCss` is the convenience path. */
  var CSS = [
    '.ap-bd{display:block;}',
    '.ap-bd>summary{cursor:pointer;list-style:none;}',
    '.ap-bd>summary::-webkit-details-marker{display:none;}',
    '.ap-bd>summary::after{content:" \\25B8";opacity:.55;}',
    '.ap-bd[open]>summary::after{content:" \\25BE";}',
    '.ap-bd-body{margin:3px 0 2px 10px;padding-left:8px;border-left:2px solid currentColor;opacity:.85;}',
    '.ap-bd-row{display:flex;justify-content:space-between;gap:10px;}',
    '.ap-bd-row.total{font-weight:700;opacity:1;border-top:1px solid currentColor;margin-top:2px;padding-top:2px;}',
    '.ap-bd-row.mismatch{color:#e0a94a;}',
    '.ap-bd-note{opacity:.75;font-style:italic;}'
  ].join('\n');

  function injectCss(doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || d.getElementById('ap-breakdown-css')) return;
    var s = d.createElement('style'); s.id = 'ap-breakdown-css'; s.textContent = CSS;
    (d.head || d.documentElement).appendChild(s);
  }

  /**
   * Render the model as a self-contained, expandable element.
   * `opts.summary` overrides the collapsed line (default: `label total`, plus the note).
   * `opts.open` starts it expanded.
   * ⛔ textContent only. Never innerHTML. Every label here came from a person.
   */
  function render(model, opts) {
    var o = opts || {};
    var d = o.document || (typeof document !== 'undefined' ? document : null);
    if (!d) return null;
    var n = normalize(model);

    var det = d.createElement('details');
    det.className = 'ap-bd';
    if (o.open) det.open = true;

    var sum = d.createElement('summary');
    sum.className = 'ap-bd-sum';
    sum.textContent = (o.summary != null) ? String(o.summary)
      : ((n.label ? n.label + ' ' : '') + n.total + (n.note ? '  ' + n.note : ''));
    det.appendChild(sum);

    var body = d.createElement('div');
    body.className = 'ap-bd-body';
    if (!n.explained) {
      var none = d.createElement('div');
      none.className = 'ap-bd-note';
      // ⛓ Say that the reason is ABSENT rather than showing an empty box. An empty expansion reads
      // as a broken feature; "no breakdown was recorded" reads as the truth, which it is.
      none.textContent = 'no breakdown was recorded for this number';
      body.appendChild(none);
    } else {
      var rs = rows(n), i;
      for (i = 0; i < rs.length; i++) {
        var r = rs[i];
        var row = d.createElement('div');
        row.className = 'ap-bd-row ' + r.kind + ((r.kind === 'total' && !n.reconciles) ? ' mismatch' : '');
        var l = d.createElement('span'), v = d.createElement('span');
        if (r.kind === 'part')      { l.textContent = r.label || (n.partsLabel || 'value');
                                      // Show the individual values, and their sum when there is more than one.
                                      v.textContent = (r.values && r.values.length > 1)
                                        ? (r.values.join(' + ') + ' = ' + r.value) : String(r.value); }
        else if (r.kind === 'modifier') { l.textContent = r.label || '(no reason recorded)'; v.textContent = signed(r.value); }
        else                        { l.textContent = 'total';  v.textContent = String(r.value); }
        row.appendChild(l); row.appendChild(v);
        body.appendChild(row);
      }
      if (!n.reconciles) {
        var mm = d.createElement('div');
        mm.className = 'ap-bd-row mismatch';
        var ml = d.createElement('span'), mv = d.createElement('span');
        ml.textContent = 'shown arithmetic gives'; mv.textContent = String(n.computed);
        mm.appendChild(ml); mm.appendChild(mv);
        body.appendChild(mm);
      }
    }
    if (n.note) {
      var nt = d.createElement('div'); nt.className = 'ap-bd-note'; nt.textContent = n.note;
      body.appendChild(nt);
    }
    det.appendChild(body);
    return det;
  }

  var API = { normalize: normalize, rows: rows, text: text, render: render, injectCss: injectCss, CSS: CSS, signed: signed };
  if (typeof module === 'object' && module.exports) module.exports = API;
  root.ArgusBreakdown = API;
})(typeof self !== 'undefined' ? self : this);
