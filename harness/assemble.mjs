/*
 * assemble.mjs — package the component library + a mount into ONE self-contained
 * pushable HTML document. Bundles ALL components (registry + every component's
 * js/css) so a `scene` can compose any of them with no build step. Mounts the
 * requested root component (a single component, or 'scene' for a multi-component
 * interface) via the registry.
 *
 * assemble({ component:'choice', opts })              -> single component
 * assemble({ component:'scene', opts: sceneSpec })    -> multi-component surface
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { resolveClosure } from './plugins.mjs';

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
    const dir = join(ROOT, 'plugins', name);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {   // .js/.css only; server-side .mjs + plugin.json excluded
      if (f.endsWith('.js')) js += `\n/* --- plugin ${name}/${f} --- */\n` + read(`plugins/${name}/${f}`);
      if (f.endsWith('.css')) css += `\n/* --- plugin ${name}/${f} --- */\n` + read(`plugins/${name}/${f}`);
    }
  }
  return { css, js };
}

export function assemble({ component = 'choice', opts = {}, theme = 'argus', title = 'Argus Component', practiceLabel = null, requires = [] } = {}) {
  const theme_css = read('lib/theme.css');
  const bridge_js = read('lib/bridge.js');
  const log_js = read('lib/log.mjs');
  const a11y_js = read('lib/a11y.js');
  const registry_js = read('lib/registry.js');
  const pluginSet = resolveClosure(requires);
  const { css: comp_css, js: comp_js } = bundle(pluginSet);

  const label = practiceLabel
    ? `<div class="ap-practice-label" aria-hidden="true">${practiceLabel}</div>`
    : '';

  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
html,body{margin:0;height:100%;background:var(--ap-bg);color:var(--ap-fg);}
body{display:flex;align-items:center;justify-content:center;}
.ap-root{width:100%;max-width:1100px;padding:clamp(1rem,4vw,3rem);}
.ap-practice-label{position:fixed;top:10px;left:12px;font:600 0.7rem/1 var(--ap-font-ui,sans-serif);
  letter-spacing:.15em;color:var(--ap-fg-dim);opacity:.6;text-transform:uppercase;z-index:10;}
${theme_css}
${comp_css}
</style>
</head>
<body class="ap-root-body">
${label}
<div class="ap-root" id="ap-mount"></div>
<script>${bridge_js}</script>
<script>${log_js}</script>
<script>${a11y_js}</script>
<script>${registry_js}</script>
<script>${comp_js}</script>
<script>
(function(){
  var OPTS = ${JSON.stringify(opts)};
  try { if (window.Argus) Argus.configure({ channel: OPTS.channel||null, contentId: OPTS.contentId||null, userId: OPTS.userId||null, userName: OPTS.userName||null }); } catch(e){}
  if (window.ApComponents && ApComponents.has(${JSON.stringify(component)})) {
    ApComponents.mount(${JSON.stringify(component)}, document.getElementById('ap-mount'), OPTS);
    if (window.Argus) Argus.ready(OPTS.promptId||null, { component: ${JSON.stringify(component)} });
  } else {
    document.getElementById('ap-mount').textContent = 'No component registered: ${component}';
  }
})();
</script>
</body>
</html>`;
}
