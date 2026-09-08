/*!
 * Argus Presenter component: TUI
 *
 * ⭐⭐⭐ THE TEXT SURFACE. A scrolling monospace pane of the traffic, and one line to type into —
 * the whole interface, in that order. This is the shape the retired estate proved and was set down
 * for only two reasons: its display surface was brittle, and it grew without an energy limit. So
 * this one draws and nothing else. ⛔ IT HOLDS NO GAME LOGIC AND MAKES NO DECISIONS: it appends what
 * the store gives it and writes what the player typed. Every verb, every refusal and every render
 * lives in the engine's starship-ops plugin, where a test can reach them without a browser.
 *
 * ⛔⛔ AND IT INVENTS NO GRAMMAR. What the player types goes to the store VERBATIM. A client that
 * "helpfully" rewrites a line before sending it becomes a second dispatcher, which is the failure
 * this project has retired twice already.
 *
 * opts = {
 *   log?    — store path of the traffic log      (default 'shared/tui/log')
 *   input?  — store path this writes lines to    (default 'shared/tui/in')
 *   seat?   — the station code this pane belongs to; sent with each line
 *   rows?   — visible height in lines            (default 24, the honest terminal)
 *   prompt? — what precedes the input box        (default the seat, or '>')
 *   readOnly? — draw the log, offer no input
 * }
 */
(function () {
  'use strict';

  /* ⛔ ONE PLACE DECIDES WIDTH AND HEIGHT. The estate this replaces rendered one frame with FIVE
     different line widths because its chrome was drawn in several places, one of them hardcoding a
     number the others disagreed with. Here the pane is sized by CSS and nothing pads by hand. */
  var DEFAULT_ROWS = 24;

  function render(root, opts) {
    opts = opts || {};
    var Argus = window.Argus;
    var logPath = opts.log || 'shared/tui/log';
    var inPath = opts.input || 'shared/tui/in';
    var seat = opts.seat || null;

    root.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'ap-tui';
    if (opts.rows) wrap.style.setProperty('--ap-tui-rows', String(opts.rows) || DEFAULT_ROWS);

    var pane = document.createElement('pre');
    pane.className = 'ap-tui-log';
    pane.setAttribute('aria-live', 'polite');
    pane.setAttribute('aria-label', seat ? ('traffic at ' + seat) : 'traffic');
    wrap.appendChild(pane);

    var line = null;
    var input = null;
    if (!opts.readOnly) {
      line = document.createElement('div');
      line.className = 'ap-tui-line';
      var caret = document.createElement('span');
      caret.className = 'ap-tui-prompt';
      caret.textContent = (opts.prompt || seat || '') + '>';
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'ap-tui-input';
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('spellcheck', 'false');
      input.setAttribute('aria-label', seat ? ('type at ' + seat) : 'type a line');
      line.appendChild(caret);
      line.appendChild(input);
      wrap.appendChild(line);
    }
    root.appendChild(wrap);

    /* ⭐ THE LOG IS APPEND-ONLY AND THE PANE FOLLOWS THE BOTTOM — but only when the reader is
       ALREADY at the bottom. Yanking someone back down while they are reading up the scrollback is
       how a chat surface becomes unusable during the one moment it matters. */
    var seen = Object.create(null);
    function append(text) {
      if (text === null || text === undefined) return;
      var atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 24;
      pane.textContent += (pane.textContent ? '\n' : '') + String(text);
      if (atBottom) pane.scrollTop = pane.scrollHeight;
    }

    /* ⛔ A LINE IS RENDERED FROM ITS OWN FIELDS, never by trusting a pre-formatted string from the
       store: the log is written by other clients and is untrusted input. `textContent` throughout —
       this component never assigns innerHTML. */
    function lineOf(v) {
      if (v === null || v === undefined) return null;
      if (typeof v === 'string') return v;
      var who = v.seat || v.from || '';
      var body = v.text === undefined ? '' : String(v.text);
      if (v.kind === 'render') return body;
      if (v.kind === 'refusal') return '  ' + body;
      return who ? (who + '> ' + body) : body;
    }

    var subs = [];
    if (Argus && Argus.subscribeState) {
      subs.push(Argus.subscribeState(logPath, function (path, value) {
        /* ⛔ EVERY ENTRY IS SHOWN ONCE. A store may resend a key on resync, and a traffic log that
           duplicates lines on reconnect is a log nobody trusts. */
        var id = String(path);
        if (seen[id]) return;
        seen[id] = 1;
        append(lineOf(value));
      }));
    }

    function submit() {
      if (!input) return;
      var text = input.value;
      if (!text || !text.trim()) return;
      input.value = '';
      /* ⭐ ECHO LOCALLY AT ONCE. The round trip is a network away and a console that swallows your
         keystrokes until the server answers feels broken even when it is working. ⛳ The server's
         own echo carries an id; a caller that wants to reconcile the two has it. */
      append((seat || '') + '> ' + text);
      if (Argus && Argus.op) {
        Argus.op(inPath, 'add', { v: 1, seat: seat, text: text, ts: Date.now() });
      }
    }
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
    }

    return {
      /* ⛳ A caller may push a line in without a store — used by the demo page and by anything
         driving this pane from outside. */
      append: append,
      focus: function () { if (input) input.focus(); },
      destroy: function () {
        for (var i = 0; i < subs.length; i += 1) {
          try { if (typeof subs[i] === 'function') subs[i](); } catch (e) { /* already gone */ }
        }
        root.innerHTML = '';
      },
    };
  }

  if (window.ApComponents && window.ApComponents.register) {
    window.ApComponents.register('tui', render);
  }
}());
