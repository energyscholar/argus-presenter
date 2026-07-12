/*!
 * Argus Presenter component: POLL-RESULTS
 * Live tally display (animated horizontal bars). STORE-NATIVE (Plan 0435 D3/D5): it
 * subscribes to the poll's vote SLICE (polls/{promptId}/votes) and recomputes the
 * tally from state — seeded by the connection snapshot, kept live by diffs. An
 * initial opts.tally is accepted for standalone rendering.
 *
 * opts = { prompt?, options:[{label,value,style?}], promptId?, tally?, count?, votes? }
 * Patterns: Observer (slice subscription), Reducer (recompute from the slice).
 */
(function () {
  'use strict';
  function render(root, opts) {
    opts = opts || {};
    var Argus = window.Argus;
    var options = opts.options || [];
    var pid = opts.promptId || null;

    var wrap = document.createElement('div'); wrap.className = 'ap-pollresults';
    if (opts.prompt) { var p = document.createElement('div'); p.className = 'ap-prompt'; p.textContent = opts.prompt; wrap.appendChild(p); }

    var rows = {};
    options.forEach(function (o) {
      var row = document.createElement('div'); row.className = 'ap-pr-row';
      var label = document.createElement('div'); label.className = 'ap-pr-label'; label.textContent = o.label;
      var track = document.createElement('div'); track.className = 'ap-pr-track';
      var fill = document.createElement('div'); fill.className = 'ap-pr-fill' + (o.style ? ' ap-pr-fill--' + o.style : ''); fill.style.width = '0%';
      var count = document.createElement('div'); count.className = 'ap-pr-count'; count.textContent = '0';
      count.setAttribute('data-value', o.value);
      track.appendChild(fill); row.appendChild(label); row.appendChild(track); row.appendChild(count);
      wrap.appendChild(row);
      rows[o.value] = { fill: fill, count: count };
    });
    var totalEl = document.createElement('div'); totalEl.className = 'ap-pr-total'; totalEl.setAttribute('aria-live', 'polite');
    wrap.appendChild(totalEl);
    root.innerHTML = ''; root.appendChild(wrap);

    // Local view of the vote slice: userId -> option value. Recompute on change.
    var votes = opts.votes || {};
    function recomputeFromVotes() {
      var counts = {}, count = 0;
      for (var uid in votes) { if (!Object.prototype.hasOwnProperty.call(votes, uid)) continue; var v = votes[uid]; if (v == null) continue; counts[v] = (counts[v] || 0) + 1; count++; }
      update(counts, count);
    }
    function update(tally, count) {
      tally = tally || {};
      var total = count != null ? count : Object.keys(tally).reduce(function (a, k) { return a + (tally[k] || 0); }, 0);
      var max = Math.max(1, total);
      options.forEach(function (o) {
        var c = tally[o.value] || 0, r = rows[o.value];
        r.fill.style.width = (100 * c / max) + '%';
        r.count.textContent = String(c);
      });
      totalEl.textContent = total === 1 ? '1 vote' : (total + ' votes');
    }
    // Initial render: explicit tally (standalone) or from a seeded votes slice.
    if (opts.tally) update(opts.tally, opts.count); else recomputeFromVotes();

    var offMsg = null, offSlice = null;
    if (Argus) {
      // Seed the vote slice from the connection snapshot.
      offMsg = Argus.onMessage(function (m) {
        if (m.type === 'snapshot' && m.state && pid) {
          var poll = m.state.polls && m.state.polls[pid];
          if (poll && poll.votes) { votes = {}; for (var uid in poll.votes) votes[uid] = poll.votes[uid]; recomputeFromVotes(); }
        }
      });
      // Live: recompute from vote-slice diffs.
      if (pid && Argus.subscribeState) {
        offSlice = Argus.subscribeState('polls/' + pid + '/votes', function (path, value) {
          var uid = path.split('/').pop();
          if (value == null) delete votes[uid]; else votes[uid] = value;
          recomputeFromVotes();
        });
      }
    }
    return { update: update, destroy: function () { if (offMsg) offMsg(); if (offSlice) offSlice(); root.innerHTML = ''; } };
  }
  if (window.ApComponents) window.ApComponents.register('poll-results', render);
})();
