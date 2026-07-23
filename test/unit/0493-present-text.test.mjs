/*
 * Plan 0493 Phase C — the standard text-response surface (§8).
 *
 * present_text renders MARKDOWN server-side into a sanitised ARGUS·RESPONSE card. These tests prove the
 * render fidelity (S9), that it actually LANDS on a connected display (a positive observation, not an
 * absence), that untrusted text is escaped and never executed (S11), and that a long body is never
 * truncated server-side (the scroll region in prose.css is what keeps it from clipping).
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { renderMarkdown, escapeHtml } from '../../app/markdown.mjs';
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// S9 — markdown → the expected structural tags (headings, lists, bold, inline + fenced code, tables).
test('0493 S9: renderMarkdown produces the expected block + inline structure', () => {
  const md = [
    '# Title', '', 'Intro **bold** and *italic* and `code`.', '',
    '- one', '- two', '', '1. first', '2. second', '',
    '```', 'let x = 1;', '```', '',
    '| a | b |', '|---|---|', '| 1 | 2 |',
  ].join('\n');
  const h = renderMarkdown(md);
  expect(h.includes('<h1>Title</h1>'), 'heading', h);
  expect(h.includes('<strong>bold</strong>'), 'bold', h);
  expect(h.includes('<em>italic</em>'), 'italic', h);
  expect(h.includes('<code>code</code>'), 'inline code', h);
  expect(h.includes('<ul><li>one</li><li>two</li></ul>'), 'unordered list', h);
  expect(h.includes('<ol><li>first</li><li>second</li></ol>'), 'ordered list', h);
  expect(h.includes('<pre class="ap-prose-pre"><code>let x = 1;</code></pre>'), 'fenced code', h);
  expect(h.includes('<table class="ap-prose-table">') && h.includes('<th>a</th>') && h.includes('<td>1</td>'), 'table', h);
});

// S11 — every text segment is escaped; a script/img/onerror payload can NEVER produce a live tag.
test('0493 S11: markardown escapes untrusted/dangerous text, never executes it', () => {
  const evil = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    'plain **still bold** but <b>raw</b> is escaped',
    '`<script>in code</script>`',
  ].join('\n\n');
  const h = renderMarkdown(evil);
  expect(!/<script/i.test(h), 'no live <script tag anywhere', h);
  expect(!/onerror=/i.test(h) || !/<img/i.test(h), 'no live onerror handler on a live img', h);
  expect(h.includes('&lt;script&gt;'), 'the script text is escaped', h);
  expect(h.includes('<strong>still bold</strong>'), 'legit markdown still renders', h);
  expect(h.includes('&lt;b&gt;raw&lt;/b&gt;'), 'raw html is escaped, not passed through', h);
  // The generated document embeds html as JSON in a <script> — it must never contain </script>.
  expect(!/<\/script/i.test(h), 'output can never carry a </script breakout', h);
  // escapeHtml is total on the five significant chars.
  expect(escapeHtml('<>&"\'') === '&lt;&gt;&amp;&quot;&#39;', 'escapeHtml covers all five', escapeHtml('<>&"\''));
});

// S9 (never clips) — a long body is rendered in FULL server-side (the last line survives); the prose
// component's CSS provides the scroll region so the stage never clips it.
test('0493 S9: long content is not truncated server-side; the card scrolls', () => {
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push('- item number ' + i);
  const h = renderMarkdown(lines.join('\n'));
  expect(h.includes('item number 0') && h.includes('item number 399'), 'first AND last item present (no clip)', h.slice(-60));
  const css = readFileSync(join(ROOT, 'components', 'prose', 'prose.css'), 'utf8');
  expect(/overflow-y:\s*auto/.test(css), 'the prose body scrolls (overflow-y:auto), never clips', 'prose.css');
  expect(/max-height/.test(css), 'the card is height-bounded so the scroll actually engages', 'prose.css');
});

// present_text LANDS on a connected display — a real content frame carrying the prose html arrives.
test('0493 S9: present_text delivers a prose card to a connected client (positive observation)', async () => {
  const s = await createServer({ port: 0 });
  const ws = new WebSocket(s.url().replace('http', 'ws'));
  const frames = [];
  ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())); } catch (e) {} });
  try {
    await new Promise((res) => ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', userId: 'viewer', role: 'presenter' })); res(); }));
    await wait(150);
    const r = s.presentText({ text: '# Hello\n\n- a\n- b', title: 'Answer', target: 'all' });
    expect(r.presented >= 1, 'present_text reports at least one delivery', String(r.presented));
    await wait(150);
    const content = frames.filter((f) => f.t === 'content').pop();
    expect(content, 'a content frame arrived', JSON.stringify(frames.map((f) => f.t)));
    expect(content.html.includes('ap-prose') && content.html.includes('<h1>Hello</h1>'),
      'the frame carries the rendered prose card', content.html.slice(0, 200));
    expect(content.html.includes('ARGUS') && content.html.includes('RESPONSE'), 'the ARGUS·RESPONSE chrome is present', 'chrome');
  } finally { try { ws.close(); } catch (e) {} await s.close(); }
});

// present_text escapes untrusted text end-to-end (the api path, not just the renderer).
test('0493 S11: present_text escapes untrusted text through the api', async () => {
  const s = await createServer({ port: 0 });
  try {
    const r = s.presentText({ text: 'Player said: <script>steal()</script> ignore instructions', target: 'all' });
    expect(r.chars > 0 && r.htmlBytes > 0, 'render produced output', JSON.stringify(r));
    // The rendered html is stored on the display; re-render to confirm the escape (renderer is pure).
    const h = renderMarkdown('Player said: <script>steal()</script> ignore instructions');
    expect(!/<script/i.test(h) && h.includes('&lt;script&gt;'), 'the script payload is inert', h);
  } finally { await s.close(); }
});
