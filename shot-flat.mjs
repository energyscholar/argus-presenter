// Headless verification of the flat-in-silica module. Runs from argus-presenter/ so
// puppeteer resolves from the repo's node_modules. Shoots every beat at 16:9.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const OUT = process.argv[2] || '/tmp/flatshots';
fs.mkdirSync(OUT, { recursive: true });
const mod = JSON.parse(fs.readFileSync('modules/flat-in-silica.json', 'utf8'));
const proseCss = fs.readFileSync('components/prose/prose.css', 'utf8');
const themeCss = fs.readFileSync('lib/theme.css', 'utf8');
const proseJs = fs.readFileSync('components/prose/prose.js', 'utf8');

const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });

for (const beat of mod.beats) {
  let html;
  if (beat.component === 'map') {
    html = `<html><body style="margin:0;background:#0f1622">
      <div style="width:100vw;height:100vh">${beat.opts.svg
        .replace('<svg ', '<svg style="width:100%;height:100%;display:block" ')}</div></body></html>`;
  } else {
    html = `<html><head><style>${themeCss}\n${proseCss}
      html,body{margin:0;background:#0f1622}
      #host{max-width:1100px;margin:0 auto;padding:28px 32px}</style></head>
      <body data-theme="argus"><div id="host"></div>
      <script>window.ApComponents={register:(n,f)=>{window.__r=f}}<\/script>
      <script>${proseJs}<\/script>
      <script>window.__r(document.getElementById('host'), ${JSON.stringify(beat.opts)})<\/script>
      </body></html>`;
  }
  await page.setContent(html, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 1400)); // past SMIL begin offsets
  const file = path.join(OUT, `${beat.id}.png`);
  await page.screenshot({ path: file });
  // overflow check
  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
    cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight,
  }));
  const clip = m.sw > m.cw + 2 ? ' ⚠ H-OVERFLOW' : (m.sh > m.ch + 2 ? ` (scrolls ${m.sh}px)` : '');
  console.log(beat.id.padEnd(14), beat.component.padEnd(6), file + clip);
}
await browser.close();
