// Verify the reading page behaves like an ordinary document: no horizontal
// overflow at 100%, 150% and 200% browser zoom, and figures scale with the text.
import puppeteer from 'puppeteer';
const URL = process.argv[2];
const b = await puppeteer.launch({ args: ['--no-sandbox'] });
for (const zoom of [1, 1.5, 2]) {
  const p = await b.newPage();
  await p.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await p.goto(URL, { waitUntil: 'load' });
  await p.evaluate((z) => { document.body.style.zoom = z; }, zoom);
  await new Promise(r => setTimeout(r, 700));
  const m = await p.evaluate(() => {
    const de = document.documentElement;
    const over = [...document.querySelectorAll('body *')]
      .filter(e => e.getBoundingClientRect().right > de.clientWidth + 2)
      .slice(0, 4).map(e => e.tagName + (e.className ? '.' + String(e.className).split(' ')[0] : ''));
    return { sw: de.scrollWidth, cw: de.clientWidth, sh: de.scrollHeight, over };
  });
  const bad = m.sw > m.cw + 2;
  console.log(`zoom ${String(zoom * 100).padStart(3)}%  scrollW=${m.sw} clientW=${m.cw} pageH=${m.sh}` +
    (bad ? `  ⚠ H-OVERFLOW ${JSON.stringify(m.over)}` : '  ✓ no horizontal overflow'));
  if (zoom === 2) await p.screenshot({ path: '/tmp/read-zoom200.png' });
  if (zoom === 1) await p.screenshot({ path: '/tmp/read-zoom100.png' });
  await p.close();
}
await b.close();
