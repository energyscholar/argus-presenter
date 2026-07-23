/*
 * app/markdown.mjs — Plan 0493 §8: a zero-dependency, SANITISING markdown → HTML renderer.
 *
 * WHY THIS EXISTS. Until now the only way to put structured text on the Presenter stage was to
 * hand-author an SVG `map` per reply (slow, error-prone — the reason S212 comms were painful). This
 * turns the SAME markdown Argus would write to the terminal into a legible card, server-side.
 *
 * SECURITY (the load-bearing property, §8/§11). EVERY text segment is HTML-escaped BEFORE any tag is
 * emitted, and the source is never passed through raw — so a literal `<` in the input becomes `&lt;`,
 * never a tag. The output therefore contains ONLY the whitelisted tags this file emits (h1-6, p, ul/ol,
 * li, strong, em, code, pre, blockquote, table/thead/tbody/tr/th/td, hr, br). It can contain no
 * `<script>`, no event handler, no external-fetch tag, and — because it never emits a script tag — no
 * `</script>` sequence that could break out of the JSON-embedded opts in the assembled document.
 * Untrusted transcript text routed through here is escaped, not executed (acceptance S11).
 *
 * SCOPE. Headings, unordered/ordered lists, bold/italic, inline + fenced code, blockquotes, simple
 * tables, horizontal rules, paragraphs. No links (dropped deliberately — a link is a javascript:/data:
 * URL vector; the plan lists headings/lists/bold/code/tables, not links). Link syntax renders as escaped
 * literal text, which is safe and legible.
 */

// Escape the five HTML-significant characters. This runs on EVERY text segment before it is wrapped in
// a tag — the whole safety model rests on it (a literal `<` becomes `&lt;`, never a tag).
export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Bold/italic on an ALREADY-escaped fragment (no backticks in it — code spans are handled separately).
function emphasis(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_/g, '$1<em>$2</em>');
}

// Inline formatting. Split on backticks: odd segments are code spans (escaped, wrapped, NOT further
// formatted); even segments get emphasis. Placeholder-free — no restore step to corrupt user digits.
function inline(text) {
  const parts = String(text == null ? '' : text).split('`');
  let out = '';
  for (let k = 0; k < parts.length; k++) {
    out += (k % 2 === 1) ? ('<code>' + escapeHtml(parts[k]) + '</code>') : emphasis(escapeHtml(parts[k]));
  }
  return out;
}

const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_HR = /^\s*([-*_])\1{2,}\s*$/;
const RE_UL = /^\s*[-*+]\s+(.*)$/;
const RE_OL = /^\s*\d+\.\s+(.*)$/;
const RE_QUOTE = /^\s*>\s?(.*)$/;
const RE_FENCE = /^\s*```/;
// A table separator row: pipes + dashes + optional colons, at least one dash.
const RE_TSEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function cells(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

/**
 * Render markdown to a sanitised HTML string. Never throws on malformed input — unrecognised syntax
 * degrades to escaped paragraph text.
 */
export function renderMarkdown(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block — everything until the closing fence is verbatim + escaped, no inline pass.
    if (RE_FENCE.test(line)) {
      flushPara();
      const code = [];
      i++;
      for (; i < lines.length && !RE_FENCE.test(lines[i]); i++) code.push(lines[i]);
      out.push('<pre class="ap-prose-pre"><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
      continue;   // i is on the closing fence (or past end); loop ++ moves on
    }

    // Table — a row of pipes immediately followed by a separator row.
    if (line.includes('|') && i + 1 < lines.length && RE_TSEP.test(lines[i + 1])) {
      flushPara();
      const head = cells(line);
      i += 2;   // skip header + separator
      const rows = [];
      for (; i < lines.length && lines[i].includes('|') && lines[i].trim() !== ''; i++) rows.push(cells(lines[i]));
      i--;      // step back; the loop ++ re-advances
      let html = '<table class="ap-prose-table"><thead><tr>';
      for (const hc of head) html += '<th>' + inline(hc) + '</th>';
      html += '</tr></thead><tbody>';
      for (const r of rows) {
        html += '<tr>';
        for (let c = 0; c < head.length; c++) html += '<td>' + inline(r[c] || '') + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
      out.push(html);
      continue;
    }

    // Heading.
    const h = RE_HEADING.exec(line);
    if (h) { flushPara(); const n = h[1].length; out.push('<h' + n + '>' + inline(h[2]) + '</h' + n + '>'); continue; }

    // Horizontal rule.
    if (RE_HR.test(line)) { flushPara(); out.push('<hr>'); continue; }

    // Blockquote — consecutive quote lines fold into one blockquote.
    if (RE_QUOTE.test(line)) {
      flushPara();
      const q = [];
      for (; i < lines.length && RE_QUOTE.test(lines[i]); i++) q.push(RE_QUOTE.exec(lines[i])[1]);
      i--;
      out.push('<blockquote class="ap-prose-quote">' + inline(q.join(' ')) + '</blockquote>');
      continue;
    }

    // Unordered list.
    if (RE_UL.test(line)) {
      flushPara();
      const items = [];
      for (; i < lines.length && RE_UL.test(lines[i]); i++) items.push(RE_UL.exec(lines[i])[1]);
      i--;
      out.push('<ul>' + items.map((it) => '<li>' + inline(it) + '</li>').join('') + '</ul>');
      continue;
    }

    // Ordered list.
    if (RE_OL.test(line)) {
      flushPara();
      const items = [];
      for (; i < lines.length && RE_OL.test(lines[i]); i++) items.push(RE_OL.exec(lines[i])[1]);
      i--;
      out.push('<ol>' + items.map((it) => '<li>' + inline(it) + '</li>').join('') + '</ol>');
      continue;
    }

    // Blank line ends a paragraph; otherwise accumulate.
    if (line.trim() === '') flushPara();
    else para.push(line.trim());
  }
  flushPara();
  return out.join('\n');
}
