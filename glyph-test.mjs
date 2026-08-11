import puppeteer from 'puppeteer';
const chars = ['⊠','⊗','⊕','⊂','≅','τ','φ','κ','σ','ξ','ν','Δ','ħ','≪','⇒','∧','∞','𝒞','𝒟','₋','²','≠','√','⟺','·','—','≈','×','ℤ','Γ','θ','ρ','μ','∈','∀','⊕','§','✓','✗','→','←'];
const b = await puppeteer.launch({args:['--no-sandbox']});
const p = await b.newPage();
await p.setContent(`<html><body><svg width="900" height="200"><text id="t" x="0" y="50" font-family="'Courier New', ui-monospace, monospace" font-size="40"></text></svg></body></html>`);
const res = await p.evaluate((chars)=>{
  const t=document.getElementById('t');
  const w=(s)=>{t.textContent=s;return t.getComputedTextLength();};
  const ref=w('M'); const tofu=w('￿');
  return chars.map(c=>({c, w:+w(c).toFixed(1), ref:+ref.toFixed(1), tofu:+tofu.toFixed(1)}));
},chars);
console.log('ref M width', res[0].ref, 'tofu width', res[0].tofu);
console.log(res.filter(r=>Math.abs(r.w-r.tofu)<0.5).map(r=>r.c).join(' ') || '(none match tofu width)');
console.log('all:', res.map(r=>r.c+':'+r.w).join('  '));
await b.close();
