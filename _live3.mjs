import puppeteer from 'puppeteer';
import { launchOpts } from './harness/browser.mjs';
import { mkdtempSync } from 'fs'; import { tmpdir } from 'os'; import { join } from 'path';
const b = await puppeteer.launch(launchOpts({ userDataDir: mkdtempSync(join(tmpdir(),'ap-l3-')) }));
const p = await b.newPage();
await p.goto('https://starship-ops.freethemath.org/', { waitUntil:'domcontentloaded', timeout:45000 });
await new Promise(r=>setTimeout(r,3500));
await p.evaluate(() => { localStorage.setItem('argus-presenter:name','Argus live probe'); });
await p.reload({ waitUntil:'domcontentloaded', timeout:45000 });
await new Promise(r=>setTimeout(r,3500));
const seen = await p.evaluate(()=>({ uid: localStorage.getItem('argus-presenter:uid'),
  name: localStorage.getItem('argus-presenter:name'), who: document.getElementById('who')?.textContent?.trim() }));
console.log('CLIENT:', JSON.stringify(seen));
console.log('HOLDING 20s — query presence now');
await new Promise(r=>setTimeout(r,20000));
await b.close();
