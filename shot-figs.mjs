// Capture each <figure> in the primer at two animation times, so a diagram that
// only looks right at t=0 (or only at mid-loop) cannot pass silently.
import puppeteer from 'puppeteer';
const URL = process.argv[2], OUT = process.argv[3] || '/tmp/figs';
import fs from 'node:fs'; fs.mkdirSync(OUT, { recursive: true });
const b = await puppeteer.launch({ args: ['--no-sandbox'] });
for (const t of [1200, 4200]) {
  const p = await b.newPage();
  await p.setViewport({ width: 1100, height: 900 });
  await p.goto(URL, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, t));
  const figs = await p.$$('figure');
  for (let i = 0; i < figs.length; i++) {
    await figs[i].screenshot({ path: `${OUT}/fig${i + 1}-t${t}.png` });
  }
  console.log(`t=${t}ms → ${figs.length} figures captured`);
  await p.close();
}
await b.close();
