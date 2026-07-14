// T3 (Plan 0457) — data-tip density: a map overlay with many data-tip nodes wires
// them ALL to the shared tooltip. The committed fixture is NEUTRAL (waypoints);
// the second test exercises the LOCAL gitignored dev module beat when present.
import { test, check as expect } from '../../harness/test.mjs';
import { drive } from '../../harness/drive.mjs';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// NEUTRAL fixture: 19 waypoint groups (same density as a real survey overlay).
const groups = Array.from({ length: 19 }, (_, i) => {
  const x = 12 + (i % 5) * 22, y = 12 + Math.floor(i / 5) * 24;
  return `<g data-tip="Waypoint ${i}&#10;Row ${Math.floor(i / 5)} · Col ${i % 5}&#10;Status nominal"><circle cx="${x}" cy="${y}" r="5" fill="#8ac"/></g>`;
}).join('');
const FIXTURE = `<svg viewBox="0 0 130 140">${groups}</svg>`;

async function assertWiring(svg, label) {
  const r = await drive({
    component: 'map', opts: { controllable: false, svg },
    probe: () => {
      const tip = document.querySelector('.ap-map-tip');
      const nodes = Array.from(document.querySelectorAll('.ap-map-content [data-tip]'));
      const sample = (el) => {
        el.dispatchEvent(new MouseEvent('mouseenter', { clientX: 200, clientY: 200 }));
        const shown = tip.style.display !== 'none';
        const first = tip.firstElementChild && tip.firstElementChild.textContent;
        el.dispatchEvent(new MouseEvent('mouseleave'));
        return { shown, first };
      };
      const s0 = nodes.length ? sample(nodes[0]) : null;
      const sLast = nodes.length ? sample(nodes[nodes.length - 1]) : null;
      return { count: nodes.length, s0, sLast };
    }
  });
  const p = r.probe || {};
  expect(`${label}: >=15 data-tip nodes wired`, p.count >= 15, String(p.count));
  expect(`${label}: sampled first node shows a tooltip`, p.s0 && p.s0.shown && !!p.s0.first, JSON.stringify(p.s0));
  expect(`${label}: sampled last node shows a tooltip`, p.sLast && p.sLast.shown && !!p.sLast.first, JSON.stringify(p.sLast));
  return p;
}

test('T3 — dense data-tip overlay wires every node (neutral fixture)', async () => {
  const p = await assertWiring(FIXTURE, 'fixture');
  expect('fixture: sampled tooltip first line matches', p.s0 && p.s0.first === 'Waypoint 0', p.s0 && String(p.s0.first));
});

test('T3 — local dev module beat wires its overlay (skips when absent)', async () => {
  const path = join(ROOT, 'modules', 'arabus.json');
  if (!existsSync(path)) { console.log('  ok   (skip) no local modules/arabus.json'); return; }
  let beat = null;
  try {
    const mod = JSON.parse(readFileSync(path, 'utf8'));
    beat = (mod.beats || []).find((b) => b.id === 'dev-parsec-map') || null;
  } catch { /* unreadable local module -> skip */ }
  if (!beat || !beat.opts || !beat.opts.svg) { console.log('  ok   (skip) no dev-parsec-map beat with an inline svg'); return; }
  await assertWiring(beat.opts.svg, 'dev beat');
});
