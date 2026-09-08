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
    /* ⛔⛔ LOOKED UP AT CALL TIME, NEVER CAPTURED AT MOUNT. Measured in a browser: this component
       mounted before the bridge had set `window.Argus`, so a captured reference was undefined
       forever — and `if (Argus && Argus.op)` then dropped every typed line SILENTLY while the local
       echo still drew, which is a console that looks like it works and sends nothing. A guard that
       hides a missing dependency is worse than the crash it prevents. */
    var api = function () { return window.Argus || null; };
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
    /* ⛔⛔ THE PANE MUST SHOW WHAT WAS SAID BEFORE IT MOUNTED. `subscribeState` delivers DIFFS only,
       so a seat that joins mid-round saw an empty console and a crew already talking — measured in a
       browser, where the board pushed before mount simply never appeared. ⇒ read the local mirror
       once at mount, in key order, then subscribe for what follows. */
    /* ⛔⛔ THE SNAPSHOT CAN ARRIVE AFTER MOUNT, so reading once here is not enough: a pane that
       mounted first showed an empty console while the crew were already talking. The bridge raises
       an event when the snapshot lands and sets `_stateReady`; take whichever comes first, and take
       it only once. */
    function drawBacklog() {
      var A = api();
      if (!A || !A.state) return;
      var existing = A.state(logPath) || {};
      Object.keys(existing).sort().forEach(function (k) {
        var id = logPath + '/' + k;
        if (seen[id]) return;
        seen[id] = 1;
        append(lineOf(existing[k]));
      });
    }
    drawBacklog();
    try {
      window.addEventListener((api() && api().NS ? api().NS : 'argus-presenter') + ':state', drawBacklog);
    } catch (e) { /* no window events here; the mount-time read is the fallback */ }
    if (api() && api().subscribeState) {
      subs.push(api().subscribeState(logPath, function (path, value) {
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
      /* ⛔⛔ `set` AT A CLIENT-MADE KEY, NEVER `add` ON THE COLLECTION. MEASURED in a browser: an
         `add` to `shared/tui/in` lands NOWHERE and reports nothing — a `set` at
         `shared/tui/in/<id>` in the same frame, on the same connection, works. Every typed line was
         being dropped in silence.
         ⭐ And the key IS the line's id, which is what lets the server echo it back and a client
         reconcile the echo it drew optimistically against the one that returns. */
      var A = api();
      var opId = (seat || 'anon') + '-' + Date.now().toString(36) + '-'
        + Math.random().toString(36).slice(2, 7);
      if (A && A.op) A.op(inPath + '/' + opId, 'set', { v: 1, id: opId, seat: seat, text: text, ts: Date.now() });
      /* ⛔ AND IT SAYS SO WHEN IT CANNOT SEND. Silence here is indistinguishable from success. */
      else append('  ⛔ not connected — that line went nowhere.');
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
