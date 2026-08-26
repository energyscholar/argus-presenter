/*
 * assemble.mjs — package the component library + a mount into ONE self-contained
 * pushable HTML document. Bundles ALL components (registry + every component's
 * js/css) so a `scene` can compose any of them with no build step. Mounts the
 * requested root component (a single component, or 'scene' for a multi-component
 * interface) via the registry.
 *
 * assemble({ component:'choice', opts })              -> single component
 * assemble({ component:'scene', opts: sceneSpec })    -> multi-component surface
 * assemble({ html, mounts })                          -> AUTHORED PAGE hosting components
 *
 * ⭐⭐ Plan 0689 R5 — COMPOSITION IS FIRST-CLASS, AND THE THIRD FORM IS WHY THE OTHER TWO EXIST.
 *
 * Bruce, 2026-08-26: *"We built those components so that they could be combined with arbitrary
 * HTML, either in advance or on the fly, to create interactive web pages for gamers."* Declining
 * raw HTML from the agent surface did not merely block raw pages — it stranded SIXTEEN COMPONENTS,
 * because they were never a menu *instead of* HTML; they are parts to be composed into it.
 *
 * ⛔ AND THIS WRAPPER IS LOAD-BEARING, WHICH IS THE ONE THING THE PLAN ASKED TO BE TOLD PLAINLY.
 * `api.pushContent(html)` puts the caller's bytes into the sandboxed iframe VERBATIM: no registry,
 * no component code, no bridge. So a raw page cannot host a component — not because the mechanism
 * is missing, but because none of it is ON THE PAGE. The third form is what puts it there. Raw push
 * stays available and unwrapped (`presenter_push_content raw:true`) for a page that wants nothing
 * from us; every page that wants a dice check beside a navmap comes through here.
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { resolveClosure, pluginDir } from './plugins.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function dirsIn(sub) {
  const base = join(ROOT, sub);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

// Bundle core components ALWAYS + ONLY the plugins in `pluginSet` (the transitive
// closure of the content's `requires`). No requires ⇒ pluginSet=[] ⇒ ZERO plugin bytes.
function bundle(pluginSet = []) {
  let css = '', js = '';
  for (const name of dirsIn('components')) {
    const j = `components/${name}/${name}.js`, c = `components/${name}/${name}.css`;
    if (existsSync(join(ROOT, j))) js += `\n/* --- ${name} --- */\n` + read(j);
    if (existsSync(join(ROOT, c))) css += `\n/* --- ${name} --- */\n` + read(c);
  }
  for (const name of pluginSet) {
    // ⛔ Plan 0569 M2 — RESOLVE VIA pluginDir(), NEVER join(ROOT,'plugins',name).
    // This used to hardcode ROOT/plugins while plugins.mjs honoured PRESENTER_PLUGINS_DIR, so a
    // deployment or test that redirected the plugin tree got its MANIFESTS from the custom dir
    // and its COMPONENT BYTES from the default one. The closure resolved, the manifest parsed,
    // the scene mounted — and the plugin's component silently never rendered. session-rig.mjs
    // sets that env var, so this was reachable in a real run, not only in tests.
    const dir = pluginDir(name);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {   // .js/.css only; server-side .mjs + plugin.json excluded
      if (f.endsWith('.js')) js += `\n/* --- plugin ${name}/${f} --- */\n` + readFileSync(join(dir, f), 'utf8');
      if (f.endsWith('.css')) css += `\n/* --- plugin ${name}/${f} --- */\n` + readFileSync(join(dir, f), 'utf8');
    }
  }
  return { css, js };
}

export function assemble({ component = 'choice', opts = {}, theme = 'argus', title = 'Argus Component', practiceLabel = null, requires = [], html = null, mounts = null } = {}) {
  const composed = typeof html === 'string';
  const theme_css = read('lib/theme.css');
  const bridge_js = read('lib/bridge.js');
  const log_js = read('lib/log.mjs');
  const a11y_js = read('lib/a11y.js');
  const registry_js = read('lib/registry.js');
  // Plan 0539 P1.7 (R2) — the shared breakdown renderer rides into every component page, so a
  // component that computes `base + rank + equipment − damage` renders it with the SAME code the
  // host chrome uses on a roll. Without this the next caller writes a second format.
  const breakdown_js = read('lib/breakdown.js');
  const pluginSet = resolveClosure(requires);
  const { css: comp_css, js: comp_js } = bundle(pluginSet);

  const label = practiceLabel
    ? `<div class="ap-practice-label" aria-hidden="true">${practiceLabel}</div>`
    : '';

  /*
   * ⛔ A COMPOSED PAGE IS NOT CENTRED IN A FLEX BOX. The single-component body centres its one
   * child, which is right for one card and destroys an authored document's own layout the moment
   * there is more than one thing on it. The page body scrolls like a page instead.
   */
  const bodyCss = composed
    ? `body{display:block;overflow:auto;}\n.ap-page{width:100%;max-width:1100px;margin:0 auto;padding:clamp(1rem,4vw,3rem);box-sizing:border-box;}\n.ap-mount-error{margin:.75rem 0;padding:.6rem .8rem;border:1px solid #b3541e;border-radius:6px;font:600 .85rem/1.4 var(--ap-font-ui,sans-serif);color:#ffce9e;background:rgba(179,84,30,.18);}`
    : `body{display:flex;align-items:center;justify-content:center;}\n.ap-root{width:100%;max-width:1100px;padding:clamp(1rem,4vw,3rem);}`;
  const bodyInner = composed
    ? `<div class="ap-page" id="ap-page">${html}</div>`
    : `<div class="ap-root" id="ap-mount"></div>`;

  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
html,body{margin:0;height:100%;background:var(--ap-bg);color:var(--ap-fg);}
${bodyCss}
.ap-practice-label{position:fixed;top:10px;left:12px;font:600 0.7rem/1 var(--ap-font-ui,sans-serif);
  letter-spacing:.15em;color:var(--ap-fg-dim);opacity:.6;text-transform:uppercase;z-index:10;}
${theme_css}
${comp_css}
</style>
</head>
<body class="${composed ? 'ap-page-body' : 'ap-root-body'}">
${label}
<!--
  ⛔⛔ THE LIBRARY LOADS BEFORE THE AUTHORED BODY, AND THAT ORDER IS LOAD-BEARING.

  These six scripts used to sit AFTER ${bodyInner}. Scripts execute in document order, so an
  authored page's own <script> ran with Argus UNDEFINED and threw on its first line - silently,
  because an uncaught error in a sandboxed frame reaches no console anyone is reading. The page
  rendered its static markup perfectly and did nothing, which reads as "composition is broken"
  rather than "your script died before the bridge existed".

  Worse, it FAILED PARTLY: a handler registered before the throwing line stayed registered, so a
  page could come alive later on the first state event and look merely "slow to start".

  All six are definition-only — they register globals and touch no DOM at load — so hoisting them
  above the body is safe, and it means an author may use Argus.op / Argus.state / Argus.bind
  inline, at parse time, the way anyone would expect to.
-->
<script>${bridge_js}</script>
<script>${log_js}</script>
<script>${a11y_js}</script>
<script>${registry_js}</script>
<script>${breakdown_js}</script>
<script>${comp_js}</script>
<script>
/* ⭐ An authored script that throws must SAY SO. Errors inside an opaque-origin sandboxed frame
   surface nowhere by default, so the page just sits there looking finished. This collects them
   and the bootstrap below renders them in the same banner unresolved mounts use. */
window.__apErrors = [];
window.addEventListener('error', function (e) {
  window.__apErrors.push((e.message || 'script error') + (e.lineno ? ' (line ' + e.lineno + ')' : ''));
});
/* ⭐ IDENTITY BEFORE THE BODY, for the same reason the library loads before the body.
   Argus.configure() used to run only in the bootstrap AFTER the authored markup, so an authored
   script calling Argus.identity() at parse time got {userId:null} and cached it. A page that
   seats people, or labels a control with who you are, then had every viewer believing it was the
   same anonymous user — four browsers all claiming one seat. Configure is idempotent; the
   bootstrap below still calls it, and this only makes the value available EARLIER. */
window.__AP_OPTS = ${JSON.stringify(opts)};
try { if (window.Argus) Argus.configure({ channel: __AP_OPTS.channel||null, contentId: __AP_OPTS.contentId||null, userId: __AP_OPTS.userId||null, userName: __AP_OPTS.userName||null }); } catch(e){}
</script>
${bodyInner}
<script>
(function(){
  var OPTS = window.__AP_OPTS || ${JSON.stringify(opts)};
  try { if (window.Argus) Argus.configure({ channel: OPTS.channel||null, contentId: OPTS.contentId||null, userId: OPTS.userId||null, userName: OPTS.userName||null }); } catch(e){}
${composed ? `
  /* ⭐ Plan 0689 R5 — MOUNT COMPONENTS INTO AN AUTHORED PAGE.
   *  Two ways in, because an agent writing JSON and a human writing markup want different things:
   *    1. \`mounts\`  — [{ at:'#css-selector', component, opts }], supplied server-side. No attribute
   *       escaping to get wrong, which is why it is the form the tool documents first.
   *    2. \`data-ap-component="dice"\` (+ optional \`data-ap-opts\` JSON) written inline in the page.
   *  Identity (userId/userName/channel/viewerRole) INHERITS from the page to every mount unless the
   *  mount states its own — the same rule \`scene\` uses for its children.
   *  ⛔ A MOUNT THAT RESOLVES TO NOTHING IS VISIBLE, NEVER SILENT. A selector typo that quietly
   *    rendered nothing is exactly how a component can be "pushed" and not be there. */
  var MOUNTS = ${JSON.stringify(Array.isArray(mounts) ? mounts : [])};
  var page = document.getElementById('ap-page');
  var INHERIT = ['userId','userName','channel','viewerRole','contentId'];
  var problems = [];
  function inherit(o){ o = Object.assign({}, o||{}); for (var i=0;i<INHERIT.length;i++){ var k=INHERIT[i]; if (o[k]==null && OPTS[k]!=null) o[k]=OPTS[k]; } return o; }
  function mountInto(el, name, o, where){
    if (!window.ApComponents || !ApComponents.has(name)) { problems.push('no such component: ' + name + ' (' + where + ')'); return; }
    ApComponents.mount(name, el, inherit(o));
  }
  /* ⭐⭐ Plan 0691b — ROUTE A COMPONENT'S RESULT INTO THE SHARED STORE.
   *
   *  Thirteen of the sixteen components never touch shared state. That is not a defect in them:
   *  they EMIT a result (fire-and-forget, over the in-page bus and up to the host) and the server
   *  decides what it means. Correct for a poll, useless for an author who wants this slider to be
   *  THIS ship's power level.
   *
   *  'writes' closes that without touching a single component:
   *      { at:'#p', component:'slider', opts:{promptId:'pw'}, writes:{ path:'shared/ship/power' } }
   *
   *  Correlation is by promptId, which is the identity the result protocol already carries — so a
   *  page may mount four sliders and each writes its own path. One is generated if the author did
   *  not supply one (an unnamed control still needs a name to be routed by).
   *
   *  ⛔ The write is a NORMAL op: permission-checked, lock-checked, refused like any other. This
   *    grants reach, never authority. */
  function routeWrites(m, i){
    if (!m.writes || !m.writes.path || !window.Argus) return;
    var pid = (m.opts && m.opts.promptId) || ('w' + i + '-' + Math.random().toString(36).slice(2, 7));
    if (!m.opts) m.opts = {};
    if (!m.opts.promptId) m.opts.promptId = pid;
    var verb = m.writes.verb || 'set';
    var field = m.writes.from || 'value';
    Argus.subscribe(function (msg) {
      if (!msg) return;
      /* ⚠ TWO EMIT SHAPES IN THE WILD, and routing must tolerate both. answer() and send() put
         promptId at the MESSAGE level. But card, narration and stepper call
         Argus.emit(type, {promptId: ..., ...}), which nests it INSIDE the payload — so
         msg.promptId is undefined for them and a message-level match silently never fires.
         Measured: correlating only on msg.promptId routed 5 of the 8 emitting components, and the
         3 misses looked like "those components cannot write" when they simply label differently. */
      var inner = (msg.value && typeof msg.value === 'object') ? msg.value : null;
      var mine = msg.promptId === pid || (inner && inner.promptId === pid);
      if (!mine) return;
      if (m.writes.type && msg.type !== m.writes.type) return;
      /* Pull the VALUE out of whichever shape arrived.
         ⛔ Do not just hand the nested payload through: slider emits BOTH shapes, and routing the
         payload wrote {promptId:'s1',value:4} where the message-level answer would have written 4.
         The promptId is addressing, never data — strip it. A payload that is nothing BUT a
         promptId (narration's 'continue') is a bare signal, so record that it fired. */
      var v;
      if (msg.promptId === pid) v = msg[field];
      else if (inner && inner[field] !== undefined) v = inner[field];
      else if (inner) {
        var rest = {}, any = false;
        for (var k in inner) if (Object.prototype.hasOwnProperty.call(inner, k) && k !== 'promptId') { rest[k] = inner[k]; any = true; }
        v = any ? rest : true;
      }
      if (v === undefined || v === null) return;
      Argus.op(m.writes.path, verb, v);
    });
  }
  MOUNTS.forEach(function(m, i){
    if (!m || !m.component) { problems.push('mounts[' + i + '] names no component'); return; }
    var el = null; try { el = m.at ? page.querySelector(m.at) : null; } catch(e){ problems.push('mounts[' + i + '] has an invalid selector: ' + m.at); return; }
    if (!el) { problems.push('mounts[' + i + '] (' + m.component + ') found nothing at ' + JSON.stringify(m.at || null) + ' — the page has no such element'); return; }
    routeWrites(m, i);                       // BEFORE mount: the component may emit on first render
    mountInto(el, m.component, m.opts, 'mounts[' + i + ']');
  });
  Array.prototype.forEach.call(page.querySelectorAll('[data-ap-component]'), function(el){
    var name = el.getAttribute('data-ap-component');
    var o = {}; var raw = el.getAttribute('data-ap-opts');
    if (raw) { try { o = JSON.parse(raw); } catch(e){ problems.push('data-ap-opts on <' + el.tagName.toLowerCase() + '> is not valid JSON'); } }
    mountInto(el, name, o, 'data-ap-component');
  });
  if (window.__apErrors && window.__apErrors.length)
    problems = problems.concat(window.__apErrors.map(function (m) { return 'page script error: ' + m; }));
  if (problems.length) {
    var box = document.createElement('div');
    box.className = 'ap-mount-error';
    box.textContent = 'Argus Presenter — ' + problems.length + ' component mount(s) did not resolve: ' + problems.join(' · ');
    page.insertBefore(box, page.firstChild);
  }
  /* ⭐ Plan 0691 — BIND AUTHORED FORM CONTROLS TO SHARED STATE.
   *  \`<select data-ap-bind="shared/course">\` and it is shared: seeded from current state, an
   *  edit writes an op, every other viewer's copy follows. No component, no script in the page.
   *  Runs AFTER mounts so a bound control inside a mounted component is picked up too.
   *  ⛔ The store seeds it only if the viewer may READ the path — reads are default-deny. */
  var bound = 0;
  try { if (window.Argus && Argus.bindAll) { Argus.bindAll(page); bound = page.querySelectorAll('[data-ap-bind]').length; } } catch(e){ problems.push('bindAll failed: ' + e.message); }
  if (window.Argus) Argus.ready(OPTS.promptId||null, { page: true, mounted: MOUNTS.length, bound: bound, problems: problems.length });
` : `
  if (window.ApComponents && ApComponents.has(${JSON.stringify(component)})) {
    ApComponents.mount(${JSON.stringify(component)}, document.getElementById('ap-mount'), OPTS);
    if (window.Argus) Argus.ready(OPTS.promptId||null, { component: ${JSON.stringify(component)} });
  } else {
    document.getElementById('ap-mount').textContent = 'No component registered: ${component}';
  }
`}
})();
</script>
</body>
</html>`;
}
