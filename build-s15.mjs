/*
 * build-s15.mjs — build the S15 "Dragon's World" CATALOG.
 *
 * A tabletop module is a CATALOG, not a deck: players choose the order, so every beat is
 * named and independently showable (mcp show_beat({beatId}) / control.html outline).
 *
 * Art is HAND-AUTHORED ANIMATED SVG, inlined as utf8 data URIs — ~1-2 KB per beat instead
 * of ~400 KB per photo, and it moves. No '#' or '%' inside the SVG (they would need
 * percent-encoding in a utf8 data URI): use rgb() and offset='0'..'1'.
 *
 * Emits three artefacts, three independent fallback layers:
 *   1. modules/s15-live.json  — Argus cues it            (needs Argus)
 *   2. s15-catalog.html       — Bruce drives it himself  (needs only a browser, file://)
 *   3. s15-cuesheet.md        — copy/paste into Discord  (needs nothing)
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const AP = '/home/bruce/software/argus-presenter';
const S = (inner, w = 420, h = 240) =>
  `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'>${inner}</svg>`;

const BG = `<rect width='420' height='240' fill='rgb(4,6,14)'/>`;
const cap = (t, y = 230, c = 'rgb(120,150,180)') =>
  `<text x='210' y='${y}' fill='${c}' font-family='monospace' font-size='11' text-anchor='middle'>${t}</text>`;
const stars = (n = 26) => {
  let s = `<g fill='rgb(150,170,210)'>`;
  for (let i = 0; i < n; i++) {
    const x = ((i * 97) % 410) + 5, y = ((i * 53) % 226) + 6, r = (i % 3) * 0.35 + 0.5, o = 0.2 + (i % 5) * 0.12;
    s += `<circle cx='${x}' cy='${y}' r='${r}' opacity='${o.toFixed(2)}'/>`;
  }
  return s + `</g>`;
};
const EMBER = `<defs><radialGradient id='e'><stop offset='0' stop-color='rgb(255,196,150)'/><stop offset='.45' stop-color='rgb(214,68,38)'/><stop offset='1' stop-color='rgb(74,10,7)'/></radialGradient></defs>`;

// ---------------------------------------------------------------- ART -------
const ART = {
// HOME — the Arabus system map. This is the DEFAULT scene: whenever nothing else is
// happening the stage returns here, so the table always has something true to look at.
// Typhon actually orbits; the interaction zone breathes where the two fields meet.
home: S(`${EMBER}${BG}${stars(40)}
<g fill='none' stroke='rgb(70,150,210)' opacity='.30'><ellipse cx='150' cy='150' rx='150' ry='44' stroke-dasharray='2 7'/></g>
<circle cx='150' cy='150' r='150' fill='none' stroke='rgb(90,200,255)' opacity='.13' stroke-dasharray='3 9'>
  <animate attributeName='opacity' values='.07;.22;.07' dur='9s' repeatCount='indefinite'/></circle>
<circle cx='150' cy='150' r='118' fill='none' stroke='rgb(90,200,255)' opacity='.10' stroke-dasharray='3 9'/>
<g opacity='.5'><ellipse cx='236' cy='150' rx='40' ry='58' fill='rgb(40,120,150)' opacity='.16'>
  <animate attributeName='rx' values='40;50;40' dur='7s' repeatCount='indefinite'/>
  <animate attributeName='opacity' values='.10;.26;.10' dur='7s' repeatCount='indefinite'/></ellipse></g>
<circle cx='150' cy='150' r='62' fill='url(_e_)'/>
<g stroke='rgb(176,64,40)' fill='none' opacity='.45'><path d='M96 130 q54 -13 108 0'/><path d='M92 150 q58 15 116 0'/><path d='M98 170 q52 -12 104 0'/></g>
<circle cx='265' cy='122' r='7' fill='rgb(206,174,96)'/>
<text x='412' y='14' fill='rgb(70,88,112)' font-family='monospace' font-size='8' text-anchor='end'>REAL TIME</text>
<g fill='rgb(200,220,255)'><rect x='352' y='58' width='24' height='9' rx='3'/>
  <animate attributeName='opacity' values='1;.45;1' dur='3.4s' repeatCount='indefinite'/></g>
<text x='344' y='50' fill='rgb(150,190,255)' font-family='monospace' font-size='10'>ASTRAL DAWN</text>
<text x='236' y='222' fill='rgb(90,190,220)' font-family='monospace' font-size='10' text-anchor='middle'>INTERACTION ZONE</text>
<text x='46' y='222' fill='rgb(130,160,150)' font-family='monospace' font-size='10'>QUIET HEMISPHERE</text>
<text x='150' y='36' fill='rgb(226,150,110)' font-family='monospace' font-size='13' text-anchor='middle' letter-spacing='2'>ARABUS · 1235</text>
<text x='150' y='232' fill='rgb(96,112,140)' font-family='monospace' font-size='9' text-anchor='middle'>sub-brown dwarf · unlit · Typhon in orbit</text>`.replace(/_e_/g, '%23e'), 420, 240),
// BRIDGE — interior. Viewport arc up top with the ember outside; console silhouettes below
// with station indicators that blink out of phase, so the room reads as CREWED, not empty.
bridge: S(`${EMBER}${BG}
<path d='M20 118 A190 128 0 0 1 400 118 Z' fill='rgb(2,4,10)' stroke='rgb(52,74,110)'/>
<clipPath id='v'><path d='M20 118 A190 128 0 0 1 400 118 Z'/></clipPath>
<g clip-path='url(_v_)'>${stars(26)}<circle cx='286' cy='72' r='34' fill='url(_e_)' opacity='.95'/></g>
<path d='M20 118 A190 128 0 0 1 400 118' fill='none' stroke='rgb(90,140,200)' opacity='.55'/>
<rect x='0' y='124' width='420' height='116' fill='rgb(6,9,18)'/>
<g fill='rgb(14,22,40)' stroke='rgb(48,70,104)'>
  <rect x='26' y='140' width='104' height='52' rx='5'/><rect x='158' y='134' width='104' height='58' rx='5'/><rect x='290' y='140' width='104' height='52' rx='5'/></g>
<g fill='rgb(120,235,190)'>
  <circle cx='44' cy='156' r='2.6'><animate attributeName='opacity' values='1;.15;1' dur='2.6s' repeatCount='indefinite'/></circle>
  <circle cx='58' cy='156' r='2.6'><animate attributeName='opacity' values='.2;1;.2' dur='3.4s' repeatCount='indefinite'/></circle>
  <circle cx='176' cy='150' r='2.6'><animate attributeName='opacity' values='.9;.2;.9' dur='4.1s' repeatCount='indefinite'/></circle>
  <circle cx='308' cy='156' r='2.6'><animate attributeName='opacity' values='.25;1;.25' dur='3.1s' repeatCount='indefinite'/></circle></g>
<g stroke='rgb(90,200,255)' opacity='.45'><path d='M34 172 h88' stroke-dasharray='3 5'/><path d='M166 168 h88' stroke-dasharray='3 5'/><path d='M298 172 h88' stroke-dasharray='3 5'/></g>
<text x='78' y='206' fill='rgb(96,124,160)' font-family='monospace' font-size='9' text-anchor='middle'>SENSORS</text>
<text x='210' y='206' fill='rgb(96,124,160)' font-family='monospace' font-size='9' text-anchor='middle'>CONN</text>
<text x='342' y='206' fill='rgb(96,124,160)' font-family='monospace' font-size='9' text-anchor='middle'>GUNNERY</text>
${cap('ISS ASTRAL DAWN · BRIDGE')}`.replace(/_e_/g, '%23e').replace(/_v_/g, '%23v')),

// SCAN — deliberately abstract: a sweep, range rings, and returns that BRIGHTEN as the beam
// crosses them and decay after. Reads as an instrument, not a picture of one.
scan: S(`${BG}
<defs><linearGradient id='sw' x1='0' y1='0' x2='1' y2='0'>
  <stop offset='0' stop-color='rgb(120,235,190)' stop-opacity='.55'/>
  <stop offset='1' stop-color='rgb(120,235,190)' stop-opacity='0'/></linearGradient></defs>
<g fill='none' stroke='rgb(60,120,110)' opacity='.5'>
  <circle cx='210' cy='120' r='28'/><circle cx='210' cy='120' r='56'/><circle cx='210' cy='120' r='84'/><circle cx='210' cy='120' r='108' stroke-dasharray='2 6'/>
  <path d='M102 120 h216 M210 12 v216' opacity='.4'/></g>
<g transform='translate(210,120)'>
  <path d='M0 0 L108 0 A108 108 0 0 0 76 -76 Z' fill='url(_sw_)'>
    <animateTransform attributeName='transform' type='rotate' from='0' to='360' dur='4s' repeatCount='indefinite'/></path>
  <line x1='0' y1='0' x2='108' y2='0' stroke='rgb(150,255,210)' stroke-width='1.3'>
    <animateTransform attributeName='transform' type='rotate' from='0' to='360' dur='4s' repeatCount='indefinite'/></line></g>
<g fill='rgb(150,255,210)'>
  <circle cx='268' cy='78' r='3'><animate attributeName='opacity' values='1;.08;.08;.08' dur='4s' repeatCount='indefinite'/></circle>
  <circle cx='158' cy='72' r='2.4'><animate attributeName='opacity' values='.08;1;.08;.08' dur='4s' repeatCount='indefinite'/></circle>
  <circle cx='150' cy='168' r='2.6'><animate attributeName='opacity' values='.08;.08;1;.08' dur='4s' repeatCount='indefinite'/></circle>
  <circle cx='276' cy='166' r='2'><animate attributeName='opacity' values='.08;.08;.08;1' dur='4s' repeatCount='indefinite'/></circle></g>
<circle cx='210' cy='120' r='3' fill='rgb(200,255,230)'/>
${cap('ACTIVE SCAN · RETURNS UNCLASSIFIED')}`.replace(/_sw_/g, '%23sw')),

// SYSMAP — schematic, not a view: orbits to scale-ish, labelled bodies, ship marker, the zone
// called out. Complements 'home' (which is the pretty resting screen) with something readable.
sysmap: S(`${EMBER}${BG}
<g fill='none' stroke='rgb(64,96,140)' opacity='.55'><circle cx='150' cy='128' r='58' stroke-dasharray='2 5'/><circle cx='150' cy='128' r='96' stroke-dasharray='2 5'/><circle cx='150' cy='128' r='132' stroke-dasharray='1 7' opacity='.5'/></g>
<circle cx='150' cy='128' r='26' fill='url(_e_)'/>
<circle cx='150' cy='128' r='96' fill='none' stroke='rgb(90,200,255)' opacity='.14'/>
<path d='M150 32 A96 96 0 0 1 226 176 L150 128 Z' fill='rgb(40,120,150)' opacity='.14'>
  <animate attributeName='opacity' values='.08;.22;.08' dur='6s' repeatCount='indefinite'/></path>
<circle cx='187' cy='84' r='6' fill='rgb(206,174,96)'/>
<text x='412' y='14' fill='rgb(70,88,112)' font-family='monospace' font-size='8' text-anchor='end'>REAL TIME</text>
<circle cx='150' cy='32' r='0' fill='none'/>
<g fill='rgb(200,220,255)'><rect x='300' y='58' width='22' height='8' rx='3'/></g>
<path d='M312 66 L246 104' stroke='rgb(90,120,160)' stroke-dasharray='2 5' opacity='.6'/>
<g font-family='monospace' font-size='9' fill='rgb(120,150,180)'>
  <text x='150' y='226' text-anchor='middle'>ARABUS 1235 · sub-brown dwarf</text>
  <text x='200' y='72' fill='rgb(206,174,96)'>TYPHON</text>
  <text x='300' y='50' fill='rgb(150,190,255)'>AD</text>
  <text x='240' y='192' fill='rgb(90,190,220)'>INTERACTION ZONE</text>
  <text x='36' y='60' fill='rgb(130,160,150)'>QUIET HEMI</text></g>
<g stroke='rgb(96,120,150)' opacity='.7'><path d='M330 214 h64'/><path d='M330 210 v8'/><path d='M394 210 v8'/></g>
<text x='362' y='206' fill='rgb(96,120,150)' font-family='monospace' font-size='8' text-anchor='middle'>~1 AU</text>`.replace(/_e_/g, '%23e')),


// JUMPSPACE — deliberately unlike every other beat: no stars, no ember, no cyan. A featureless
// violet-grey field with slow flowing distortion and the ship sealed in its bubble. Nothing out
// there returns a sensor ping, so there is nothing true to draw. Duration stated as a NUMBER
// (~168 h); the motion here is field turbulence, not anything orbital.
// LIVE (S210, mid-session): Delleron ordered two probes, NOT the ones the prep anticipated.
// GM-side: the radiation probe irritates the thing in the field. PLAYER-SIDE: contours deform
// near the probe and dose readings stop matching the model. The noun is never on screen.
probeRad: S(`${EMBER}<rect width='660' height='300' fill='rgb(4,6,14)'/>
<circle cx='96' cy='150' r='58' fill='url(_e_)' opacity='.9'/>
<circle cx='96' cy='150' r='96' fill='none' stroke='rgb(206,174,96)' stroke-dasharray='2 9' opacity='.5'/>
<circle cx='168' cy='86' r='11' fill='rgb(206,174,96)'/>
<text x='168' y='68' fill='rgb(206,174,96)' font-family='monospace' font-size='9' text-anchor='middle'>TYPHON</text>
${[[150,'rgb(208,90,74)','.30'],[196,'rgb(208,120,74)','.22'],[242,'rgb(190,150,90)','.16'],[292,'rgb(150,170,120)','.11']].map(([r,c,o])=>`<circle cx='96' cy='150' r='${r}' fill='none' stroke='${c}' stroke-width='16' opacity='${o}'><animate attributeName='opacity' values='${o};${Number(o)*1.8};${o}' dur='${5+r/90}s' repeatCount='indefinite'/></circle>`).join('')}
<path d='M620 240 q-200 -40 -330 -84' fill='none' stroke='rgb(150,245,200)' stroke-dasharray='4 6' opacity='.55'/>
<circle r='5' fill='rgb(150,245,200)'><animateMotion path='M620 240 q-200 -40 -330 -84' dur='8s' fill='freeze'/></circle>
<text x='560' y='262' fill='rgb(150,245,200)' font-family='monospace' font-size='10'>PROBE · RAD MAPPING</text>
<g stroke='rgb(255,150,130)' fill='none' opacity='.75'>
<path d='M262 150 q26 -30 54 -6'><animate attributeName='d' values='M262 150 q26 -30 54 -6;M262 150 q30 22 54 -14;M262 150 q26 -30 54 -6' dur='4s' repeatCount='indefinite'/></path>
<path d='M258 178 q30 26 58 4'><animate attributeName='d' values='M258 178 q30 26 58 4;M258 178 q24 -26 58 12;M258 178 q30 26 58 4' dur='5.4s' repeatCount='indefinite'/></path></g>
<text x='330' y='118' fill='rgb(255,150,130)' font-family='monospace' font-size='10'>LOCAL CONTOURS NOT HOLDING SHAPE</text>
<g font-family='monospace' font-size='10'>
<text x='420' y='36' fill='rgb(120,145,175)'>DOSE AT PROBE</text><text x='420' y='52' fill='rgb(255,150,130)'>4.1e3 · RISING</text>
<text x='420' y='76' fill='rgb(120,145,175)'>MODEL FIT</text><text x='420' y='92' fill='rgb(255,190,110)'>DIVERGING</text>
<text x='420' y='116' fill='rgb(120,145,175)'>BELT EDGE</text><text x='420' y='132' fill='rgb(150,235,190)'>2 – 11 AR MAPPED</text></g>
<text x='636' y='288' fill='rgb(70,88,112)' font-family='monospace' font-size='8' text-anchor='end'>TRANSIT · 31 h COMPRESSED TO 8 s</text>`.replace(/_e_/g,'%23e'), 660, 300),

// The debris survey is SLOW and mostly null — that is the honest picture and it makes the one
// hit land. Objects tick over; nearly all read NULL.
probeDebris: S(`<rect width='660' height='300' fill='rgb(4,6,14)'/>
${Array.from({length:54},(_,i)=>{const x=40+((i*137)%580),y=44+((i*89)%210),r=(i%4)*0.7+1.1;return `<circle cx='${x}' cy='${y}' r='${r}' fill='rgb(108,128,158)' opacity='${(0.25+(i%5)*0.12).toFixed(2)}'/>`;}).join('')}
<rect x='40' y='40' width='120' height='120' fill='none' stroke='rgb(150,245,200)' opacity='.7'>
  <animate attributeName='x' values='40;460;40' dur='16s' repeatCount='indefinite'/>
  <animate attributeName='y' values='40;140;40' dur='23s' repeatCount='indefinite'/></rect>
<rect x='40' y='40' width='120' height='120' fill='rgb(120,235,190)' opacity='.06'>
  <animate attributeName='x' values='40;460;40' dur='16s' repeatCount='indefinite'/>
  <animate attributeName='y' values='40;140;40' dur='23s' repeatCount='indefinite'/></rect>
<text x='24' y='28' fill='rgb(150,245,200)' font-family='monospace' font-size='12' letter-spacing='2'>DEBRIS FIELD SURVEY · 800 AR</text>
<g font-family='monospace' font-size='10'>
<text x='24' y='250' fill='rgb(120,145,175)'>OBJECTS EXAMINED</text><text x='24' y='266' fill='rgb(206,222,244)'>1 174</text>
<text x='180' y='250' fill='rgb(120,145,175)'>CLASSIFIED</text><text x='180' y='266' fill='rgb(150,235,190)'>NULL · 1 171</text>
<text x='330' y='250' fill='rgb(120,145,175)'>FLAGGED</text><text x='330' y='266' fill='rgb(255,190,110)'>3 · pending</text>
<text x='470' y='250' fill='rgb(120,145,175)'>COVERAGE</text><text x='470' y='266' fill='rgb(206,222,244)'>6 pct</text></g>
<rect x='24' y='278' width='612' height='6' rx='3' fill='rgb(14,20,34)' stroke='rgb(34,50,78)'/>
<rect x='25' y='279' width='37' height='4' rx='2' fill='rgb(120,235,190)' opacity='.8'/>
<text x='636' y='28' fill='rgb(70,88,112)' font-family='monospace' font-size='8' text-anchor='end'>SURVEY · 40 d COMPRESSED · slow work</text>`, 660, 300),

// The find. Inferior, barely viable — good enough to matter, bad enough to argue about.
iceteroid: S(`<defs><radialGradient id='ic'><stop offset='0' stop-color='rgb(206,226,240)'/><stop offset='.6' stop-color='rgb(128,150,172)'/><stop offset='1' stop-color='rgb(52,66,84)'/></radialGradient></defs>
<rect width='660' height='300' fill='rgb(4,6,14)'/>
${Array.from({length:26},(_,i)=>`<circle cx='${30+((i*211)%600)}' cy='${26+((i*97)%250)}' r='${((i%3)*0.6+0.7).toFixed(1)}' fill='rgb(108,128,158)' opacity='.35'/>`).join('')}
<path d='M182 150 q10 -66 66 -74 q56 -8 84 24 q34 32 20 78 q-14 46 -70 56 q-56 10 -84 -22 q-26 -30 -16 -62 z' fill='url(_ic_)' opacity='.95'/>
<g fill='rgb(84,102,124)' opacity='.6'><circle cx='236' cy='128' r='11'/><circle cx='286' cy='170' r='7'/><circle cx='258' cy='196' r='5'/></g>
<circle cx='258' cy='150' r='104' fill='none' stroke='rgb(150,235,190)' stroke-dasharray='3 8' opacity='.35'>
  <animate attributeName='opacity' values='.18;.45;.18' dur='6s' repeatCount='indefinite'/></circle>
<text x='24' y='28' fill='rgb(150,235,190)' font-family='monospace' font-size='12' letter-spacing='2'>OBJECT 1174-C · FLAGGED</text>
<g font-family='monospace' font-size='10'>
<text x='400' y='72' fill='rgb(120,145,175)'>COMPOSITION</text><text x='400' y='88' fill='rgb(206,222,244)'>DIRTY WATER ICE</text>
<text x='400' y='112' fill='rgb(120,145,175)'>SILICATE FRACTION</text><text x='400' y='128' fill='rgb(255,190,110)'>HIGH · 34 pct</text>
<text x='400' y='152' fill='rgb(120,145,175)'>USABLE YIELD</text><text x='400' y='168' fill='rgb(255,190,110)'>LOW</text>
<text x='400' y='192' fill='rgb(120,145,175)'>PROCESSING</text><text x='400' y='208' fill='rgb(255,190,110)'>SLOW · HEAVY WEAR</text>
<text x='400' y='236' fill='rgb(120,145,175)'>VERDICT</text><text x='400' y='252' fill='rgb(150,235,190)'>VIABLE — BARELY</text></g>
<text x='24' y='282' fill='rgb(104,120,146)' font-family='monospace' font-size='9'>it would fuel the ship. it would not be pleasant, or fast, or good for the plant.</text>`.replace(/_ic_/g,'%23ic'), 660, 300),

// LIVE (S210): Von Sydo made 11 then 13 on sensors. GM ruled the radiation zone ROTATES WITH
// TYPHON and the weakest dose lies at 90 degrees from the moon. That is a navigational fact the
// crew has EARNED, so it belongs on a map. Lobes are strongest along the Arabus-Typhon axis
// (torus + flux tube) and fall to minima on the perpendicular.
radCorridor: S(`${EMBER}<rect width='660' height='430' fill='rgb(4,6,14)'/>
<text x='330' y='30' fill='rgb(206,222,244)' font-family='monospace' font-size='14' text-anchor='middle' letter-spacing='2'>RADIATION STRUCTURE · LOCKED TO TYPHON</text>
<text x='330' y='50' fill='rgb(120,145,175)' font-family='monospace' font-size='10' text-anchor='middle'>zone rotates with the moon · corridor rotates with it</text>
<g transform='translate(330,238)'>
${[[168,'rgb(208,70,58)','.30'],[132,'rgb(214,110,64)','.26'],[96,'rgb(206,160,90)','.20']].map(([r,c,o])=>
`<ellipse cx='0' cy='0' rx='${r}' ry='${Math.round(r*0.42)}' fill='${c}' opacity='${o}'><animate attributeName='opacity' values='${o};${(Number(o)*1.5).toFixed(2)};${o}' dur='${6+r/60}s' repeatCount='indefinite'/></ellipse>`).join('')}
<path d='M0 -186 A186 186 0 0 1 0 186 L0 0 Z' fill='rgb(120,235,190)' opacity='0'/>
<g fill='rgb(120,235,190)' opacity='.10'>
<path d='M-30 -190 L30 -190 L18 0 L-18 0 Z'/><path d='M-30 190 L30 190 L18 0 L-18 0 Z'/></g>
<g stroke='rgb(120,235,190)' fill='none' opacity='.65' stroke-dasharray='5 6'>
<path d='M0 -196 L0 196'/></g>
<circle cx='0' cy='0' r='30' fill='url(_e_)'/>
<circle cx='196' cy='0' r='13' fill='rgb(206,174,96)'/>
<text x='196' y='-24' fill='rgb(206,174,96)' font-family='monospace' font-size='11' text-anchor='middle'>TYPHON</text>
<text x='0' y='-206' fill='rgb(120,235,190)' font-family='monospace' font-size='11' text-anchor='middle'>MINIMUM DOSE · 90 deg</text>
<text x='0' y='218' fill='rgb(120,235,190)' font-family='monospace' font-size='11' text-anchor='middle'>MINIMUM DOSE · 90 deg</text>
<text x='-190' y='6' fill='rgb(232,110,92)' font-family='monospace' font-size='11'>MAXIMUM</text>
<text x='108' y='-84' fill='rgb(232,110,92)' font-family='monospace' font-size='11'>MAXIMUM</text></g>
<g font-family='monospace' font-size='10'>
<text x='24' y='396' fill='rgb(120,145,175)'>APPROACH ON THE PERPENDICULAR</text>
<text x='24' y='412' fill='rgb(150,235,190)'>lowest dose · corridor moves as Typhon moves</text>
<text x='636' y='396' fill='rgb(120,145,175)' text-anchor='end'>MAPPING EFFORT</text>
<text x='636' y='412' fill='rgb(255,190,110)' text-anchor='end'>PARTIAL · zone not yet fully resolved</text></g>`.replace(/_e_/g,'%23e'), 660, 430),

// LIVE (S210): plasma discharge on the AD. PLAYER VIEW = an observation, never the GM's noun.
// The screen says ORIGIN: INTERACTION ZONE and reports BEAM COHERENCE — because coherence is the
// tell. Natural discharge is broadband and scattered; this is collimated and repeating, which no
// hazard does. That single number is what kills Von Sydo's "automatic anomaly" theory.
plasmaAttack: S(`<defs>
<linearGradient id='bm' x1='0' y1='0' x2='1' y2='0'>
 <stop offset='0' stop-color='rgb(190,140,255)' stop-opacity='.10'/>
 <stop offset='.6' stop-color='rgb(226,170,255)' stop-opacity='.95'/>
 <stop offset='1' stop-color='rgb(255,244,255)' stop-opacity='1'/></linearGradient>
<radialGradient id='hit'><stop offset='0' stop-color='rgb(255,255,255)'/><stop offset='.4' stop-color='rgb(236,180,255)'/><stop offset='1' stop-color='rgb(150,70,200)' stop-opacity='0'/></radialGradient></defs>
<rect width='660' height='430' fill='rgb(4,6,14)'/>
${Array.from({length:34},(_,i)=>`<circle cx='${18+((i*211)%626)}' cy='${16+((i*97)%398)}' r='${((i%3)*0.6+0.6).toFixed(1)}' fill='rgb(120,140,175)' opacity='.28'/>`).join('')}
<!-- THREE separate unresolved bearings, converging. The origin is NOT one place — which is the
     whole horror of it. Nothing is drawn at the source end: they have not resolved it. -->
${[['M-20 40 L318 200','0s','118'],['M700 66 L344 202','.9s','132'],['M-20 404 L316 226','1.9s','96']].map(([d,b,ang])=>`
<path d='${d}' stroke='url(_bm_)' stroke-width='3.5' fill='none' opacity='0'>
  <animate attributeName='opacity' values='0;1;1;0;0' keyTimes='0;.05;.15;.24;1' dur='4.4s' begin='${b}' repeatCount='indefinite'/></path>`).join('')}
${['0s','.9s','1.9s'].map((b)=>`<circle cx='330' cy='213' r='24' fill='url(_hit_)' opacity='0'>
  <animate attributeName='opacity' values='0;0;.95;0;0' keyTimes='0;.11;.17;.33;1' dur='4.4s' begin='${b}' repeatCount='indefinite'/>
  <animate attributeName='r' values='10;10;36;52;52' keyTimes='0;.11;.19;.33;1' dur='4.4s' begin='${b}' repeatCount='indefinite'/></circle>`).join('')}
<g fill='rgb(206,222,244)'>
<path d='M282 202 q24 -20 66 -20 h46 q26 0 37 11 l24 11 -24 11 q-11 11 -37 11 h-46 q-42 0 -66 -20 z' opacity='.95'/></g>
<text x='362' y='178' fill='rgb(159,192,255)' font-family='monospace' font-size='10' text-anchor='middle'>ISS ASTRAL DAWN</text>
<text x='330' y='34' fill='rgb(226,170,255)' font-family='monospace' font-size='14' text-anchor='middle' letter-spacing='3'>COLLIMATED DISCHARGE · THREE SOURCES</text>
<g font-family='monospace' font-size='10'>
<text x='24' y='340' fill='rgb(120,145,175)'>BEAM COHERENCE</text><text x='24' y='356' fill='rgb(255,110,96)'>0.94 · COLLIMATED</text>
<text x='196' y='340' fill='rgb(120,145,175)'>SOURCE BEARINGS</text><text x='196' y='356' fill='rgb(255,190,110)'>THREE · UNRESOLVED</text>
<text x='388' y='340' fill='rgb(120,145,175)'>SEPARATION</text><text x='388' y='356' fill='rgb(255,190,110)'>WIDE · NOT CO-LOCATED</text>
<text x='556' y='340' fill='rgb(120,145,175)'>NATURAL FIT</text><text x='556' y='356' fill='rgb(255,110,96)'>NONE</text></g>
<rect x='24' y='378' width='612' height='30' rx='5' fill='rgb(10,14,26)' stroke='rgb(120,60,90)'/>
<text x='36' y='398' fill='rgb(255,150,130)' font-family='monospace' font-size='10'>THREE BEARINGS. WIDELY SEPARATED. ALL THREE CORRECT ONTO THE SAME HULL.</text>`
.replace(/_bm_/g,'%23bm').replace(/_hit_/g,'%23hit'), 660, 430),

// MARINA'S MOMENT — targeted to her seat. Ferromagnetic particulate is the ONE cargo aboard
// designed to interact with a magnetic structure, planted before tonight in `marina-sand`.
marinaSand: S(`<defs><radialGradient id='sp'><stop offset='0' stop-color='rgb(226,238,255)'/><stop offset='1' stop-color='rgb(120,150,190)' stop-opacity='0'/></radialGradient></defs>
<rect width='660' height='430' fill='rgb(4,6,14)'/>
${Array.from({length:24},(_,i)=>`<circle cx='${20+((i*233)%620)}' cy='${16+((i*101)%398)}' r='${((i%3)*0.5+0.6).toFixed(1)}' fill='rgb(120,140,175)' opacity='.26'/>`).join('')}
<path d='M-20 70 L300 206' stroke='rgb(226,170,255)' stroke-width='3' fill='none' opacity='.5'/>
<g fill='rgb(206,222,244)'><path d='M300 196 q24 -20 64 -20 h44 q26 0 36 11 l23 11 -23 11 q-10 11 -36 11 h-44 q-40 0 -64 -20 z' opacity='.95'/></g>
<g fill='rgb(198,214,236)'>${Array.from({length:120},(_,i)=>{const a=(-38+ (i%40)*1.9)*Math.PI/180, r=40+((i*37)%150); const x=300+Math.cos(a+Math.PI)*r, y=207+Math.sin(a+Math.PI)*r;
 return `<circle cx='${x.toFixed(0)}' cy='${y.toFixed(0)}' r='${(1+(i%3)*0.6).toFixed(1)}' opacity='0'><animate attributeName='opacity' values='0;.85;.55;0' dur='5s' begin='${(i%25)*0.11}s' repeatCount='indefinite'/></circle>`;}).join('')}</g>
<ellipse cx='214' cy='207' rx='108' ry='86' fill='url(_sp_)' opacity='.16'><animate attributeName='opacity' values='.06;.24;.06' dur='4s' repeatCount='indefinite'/></ellipse>
<text x='214' y='118' fill='rgb(198,214,236)' font-family='monospace' font-size='11' text-anchor='middle'>FERROMAGNETIC PARTICULATE</text>
<text x='330' y='34' fill='rgb(150,235,190)' font-family='monospace' font-size='14' text-anchor='middle' letter-spacing='3'>SANDCASTER · SPECIAL LOAD</text>
<g font-family='monospace' font-size='10'>
<text x='24' y='344' fill='rgb(120,145,175)'>LOAD</text><text x='24' y='360' fill='rgb(206,222,244)'>HIGH-FERROMAGNETIC</text>
<text x='196' y='344' fill='rgb(120,145,175)'>DESIGNED FOR</text><text x='196' y='360' fill='rgb(255,190,110)'>OBSOLETE · NOBODY ASKS</text>
<text x='388' y='344' fill='rgb(120,145,175)'>BEHAVIOUR IN FIELD</text><text x='388' y='360' fill='rgb(150,235,190)'>COUPLES · DEFLECTS</text>
<text x='556' y='344' fill='rgb(120,145,175)'>RACKS</text><text x='556' y='360' fill='rgb(150,235,190)'>FULL</text></g>
<rect x='24' y='382' width='612' height='28' rx='5' fill='rgb(10,14,26)' stroke='rgb(60,120,96)'/>
<text x='36' y='401' fill='rgb(150,235,190)' font-family='monospace' font-size='10'>A MAGNETICALLY STEERED BEAM CAN BE MAGNETICALLY SPOILED.</text>`.replace(/_sp_/g,'%23sp'), 660, 430),

// LIVE (S210 close): the skimming probe was destroyed; the watcher at 12 AR SURVIVED and observed
// the discharge from an ORTHOGONAL angle to the Astral Dawn. Two baselines 90 deg apart resolve
// bearings into loci. Stated objective (Delleron): "where this came from and how it was done."
// DELIBERATELY UNDECIDED: the three loci are drawn resolving but their positions are NOT
// identified against anything on the map. Bruce owns where they are. The beat delivers the
// METHOD and the one finding he already told me — NOT co-located with the interaction zone.
triangulation: S(`<rect width='660' height='430' fill='rgb(4,6,14)'/>
${Array.from({length:28},(_,i)=>`<circle cx='${18+((i*211)%626)}' cy='${16+((i*97)%398)}' r='${((i%3)*0.6+0.6).toFixed(1)}' fill='rgb(120,140,175)' opacity='.24'/>`).join('')}
<text x='330' y='32' fill='rgb(150,235,190)' font-family='monospace' font-size='14' text-anchor='middle' letter-spacing='3'>TWO BASELINES · 90 DEGREES APART</text>
<g fill='rgb(206,222,244)'><path d='M96 300 q18 -15 48 -15 h34 q20 0 27 8 l18 8 -18 8 q-7 8 -27 8 h-34 q-30 0 -48 -8 z' opacity='.92'/></g>
<text x='150' y='334' fill='rgb(159,192,255)' font-family='monospace' font-size='10' text-anchor='middle'>ASTRAL DAWN</text>
<circle cx='520' cy='120' r='8' fill='rgb(150,245,200)'/>
<text x='520' y='102' fill='rgb(150,245,200)' font-family='monospace' font-size='10' text-anchor='middle'>PROBE · 12 AR · SURVIVED</text>
<g stroke='rgb(120,180,235)' fill='none' opacity='.5' stroke-dasharray='4 7'>
<path d='M150 292 L262 150'/><path d='M150 292 L330 176'/><path d='M150 292 L404 232'/></g>
<g stroke='rgb(150,245,200)' fill='none' opacity='.5' stroke-dasharray='4 7'>
<path d='M520 128 L262 150'/><path d='M520 128 L330 176'/><path d='M520 128 L404 232'/></g>
${[[262,150],[330,176],[404,232]].map(([x,y],i)=>`
<circle cx='${x}' cy='${y}' r='9' fill='none' stroke='rgb(255,150,130)' stroke-width='2'>
 <animate attributeName='r' values='9;22;9' dur='3.4s' begin='${i*0.5}s' repeatCount='indefinite'/>
 <animate attributeName='opacity' values='.95;0;.95' dur='3.4s' begin='${i*0.5}s' repeatCount='indefinite'/></circle>
<circle cx='${x}' cy='${y}' r='4' fill='rgb(255,150,130)'/>
<text x='${x}' y='${y-26}' fill='rgb(255,150,130)' font-family='monospace' font-size='10' text-anchor='middle'>LOCUS ${i+1}</text>`).join('')}
<g font-family='monospace' font-size='10'>
<text x='24' y='366' fill='rgb(120,145,175)'>SKIM PROBE</text><text x='24' y='382' fill='rgb(255,110,96)'>DESTROYED · DATA SCRAMBLED</text>
<text x='200' y='366' fill='rgb(120,145,175)'>WATCH PROBE</text><text x='200' y='382' fill='rgb(150,235,190)'>INTACT · CLEAN · ORTHOGONAL</text>
<text x='412' y='366' fill='rgb(120,145,175)'>SOLUTION</text><text x='412' y='382' fill='rgb(255,190,110)'>CONVERGES · 3 LOCI</text></g>
<rect x='24' y='396' width='612' height='24' rx='5' fill='rgb(10,14,26)' stroke='rgb(120,60,90)'/>
<text x='36' y='412' fill='rgb(255,150,130)' font-family='monospace' font-size='10'>NO LOCUS COINCIDES WITH THE INTERACTION ZONE.</text>`, 660, 430),

jumpspace: S(`<defs>
<radialGradient id='js' cx='50%' cy='50%' r='72%'><stop offset='0' stop-color='rgb(46,38,66)'/><stop offset='.55' stop-color='rgb(26,22,40)'/><stop offset='1' stop-color='rgb(10,8,18)'/></radialGradient>
<radialGradient id='bb'><stop offset='0' stop-color='rgb(190,170,240)' stop-opacity='.30'/><stop offset='.72' stop-color='rgb(150,130,215)' stop-opacity='.10'/><stop offset='1' stop-color='rgb(120,100,190)' stop-opacity='0'/></radialGradient></defs>
<rect width='660' height='430' fill='url(_js_)'/>
<g stroke='rgb(150,130,205)' fill='none' opacity='.22'>
${[0,1,2,3,4,5,6].map(i=>`<path d='M-40 ${40+i*58} q165 ${i%2?-46:46} 330 0 t330 0'><animate attributeName='d' values='M-40 ${40+i*58} q165 ${i%2?-46:46} 330 0 t330 0;M-40 ${40+i*58} q165 ${i%2?46:-46} 330 0 t330 0;M-40 ${40+i*58} q165 ${i%2?-46:46} 330 0 t330 0' dur='${11+i*2.2}s' repeatCount='indefinite'/></path>`).join('')}</g>
<g stroke='rgb(205,190,250)' fill='none' opacity='.13'>
${[0,1,2,3].map(i=>`<path d='M${-60+i*30} -20 q${70+i*18} 215 ${-30+i*22} 470'><animate attributeName='opacity' values='.05;.20;.05' dur='${9+i*3}s' repeatCount='indefinite'/></path>`).join('')}</g>
<circle cx='330' cy='206' r='128' fill='url(_bb_)'/>
<circle cx='330' cy='206' r='128' fill='none' stroke='rgb(186,166,240)' opacity='.35'>
  <animate attributeName='r' values='128;133;128' dur='9s' repeatCount='indefinite'/>
  <animate attributeName='opacity' values='.20;.45;.20' dur='9s' repeatCount='indefinite'/></circle>
<circle cx='330' cy='206' r='104' fill='none' stroke='rgb(186,166,240)' opacity='.16' stroke-dasharray='3 10'/>
<g fill='rgb(214,222,244)'>
<path d='M290 200 q22 -20 66 -20 h44 q26 0 36 10 l24 10 -24 10 q-10 10 -36 10 h-44 q-44 0 -66 -20 z' opacity='.92'/></g>
<text x='330' y='262' fill='rgb(176,160,220)' font-family='monospace' font-size='10' text-anchor='middle'>JUMP BUBBLE STABLE</text>
<text x='330' y='40' fill='rgb(206,192,246)' font-family='monospace' font-size='15' text-anchor='middle' letter-spacing='4'>JUMPSPACE</text>
<text x='330' y='60' fill='rgb(126,114,166)' font-family='monospace' font-size='10' text-anchor='middle'>no external referent · nothing returns a ping</text>
<g font-family='monospace' font-size='10'>
<text x='24' y='352' fill='rgb(126,114,166)'>EXTERNAL SENSORS</text><text x='24' y='368' fill='rgb(255,150,130)'>NO RETURN</text>
<text x='190' y='352' fill='rgb(126,114,166)'>JUMP FIELD</text><text x='190' y='368' fill='rgb(150,235,190)'>STABLE</text>
<text x='330' y='352' fill='rgb(126,114,166)'>DURATION</text><text x='330' y='368' fill='rgb(214,222,244)'>~168 h · 7 d</text>
<text x='476' y='352' fill='rgb(126,114,166)'>VARIANCE</text><text x='476' y='368' fill='rgb(255,190,110)'>PLUS/MINUS 10 pct</text></g>
<rect x='24' y='388' width='612' height='7' rx='3' fill='rgb(20,17,32)' stroke='rgb(52,44,78)'/>
<rect x='25' y='389' width='150' height='5' rx='2' fill='rgb(170,150,230)' opacity='.8'>
  <animate attributeName='opacity' values='.5;.9;.5' dur='5s' repeatCount='indefinite'/></rect>
<text x='24' y='414' fill='rgb(104,94,140)' font-family='monospace' font-size='9'>TRANSIT · 7 DAYS · the only clock aboard is the ship's</text>
<text x='636' y='414' fill='rgb(104,94,140)' font-family='monospace' font-size='9' text-anchor='end'>ARRIVAL CANNOT BE OBSERVED IN ADVANCE</text>`.replace(/_js_/g,'%23js').replace(/_bb_/g,'%23bb'), 660, 430),

emergence: S(`${EMBER}${BG}${stars()}<circle cx='210' cy='120' r='54' fill='url(_e_)' opacity='.96'/>
<g stroke='rgb(180,70,45)' fill='none' opacity='.5'><path d='M162 104 q48 -12 96 0'/><path d='M158 120 q52 14 104 0'/><path d='M164 137 q46 -10 92 0'/></g>
${cap('NO SUN LIGHTS IT · IT LIGHTS ITSELF')}`.replace(/_e_/g, '%23e')),

sphere: S(`${EMBER}${BG}<g fill='none' stroke='rgb(90,200,255)'>
<circle cx='210' cy='118' r='58' opacity='.55'><animate attributeName='r' values='58;100;58' dur='7s' repeatCount='indefinite'/><animate attributeName='opacity' values='.55;0;.55' dur='7s' repeatCount='indefinite'/></circle>
<circle cx='210' cy='118' r='58' opacity='.4'><animate attributeName='r' values='58;100;58' dur='7s' begin='2.3s' repeatCount='indefinite'/><animate attributeName='opacity' values='.4;0;.4' dur='7s' begin='2.3s' repeatCount='indefinite'/></circle>
<circle cx='210' cy='118' r='108' opacity='.22' stroke-dasharray='3 7'/></g>
<circle cx='210' cy='118' r='40' fill='url(_e_)'/>${cap('NO BOW SHOCK · NO MAGNETOTAIL · SYMMETRIC')}`.replace(/_e_/g, '%23e')),

typhon: S(`${EMBER}${BG}<circle cx='52' cy='118' r='108' fill='url(_e_)' opacity='.8'/>
<g stroke='rgb(90,200,255)' fill='none' opacity='.34'><circle cx='250' cy='118' r='50' stroke-dasharray='2 6'/><circle cx='250' cy='118' r='72' stroke-dasharray='2 9' opacity='.6'/></g>
<g fill='rgb(190,230,120)'><circle cx='250' cy='86' r='3'><animate attributeName='cy' values='86;44;86' dur='4s' repeatCount='indefinite'/><animate attributeName='opacity' values='.9;0;.9' dur='4s' repeatCount='indefinite'/></circle>
<circle cx='262' cy='90' r='2.4'><animate attributeName='cy' values='90;52;90' dur='5.2s' begin='1.1s' repeatCount='indefinite'/><animate attributeName='opacity' values='.8;0;.8' dur='5.2s' begin='1.1s' repeatCount='indefinite'/></circle></g>
<circle cx='250' cy='118' r='24' fill='rgb(196,164,86)'/>${cap('NESTED FIELD · INTERACTION ZONE ACTIVE')}`.replace(/_e_/g, '%23e')),

probes: S(`${EMBER}${BG}<circle cx='330' cy='118' r='74' fill='url(_e_)' opacity='.9'/>
<path d='M60 118 q90 -80 194 -32' fill='none' stroke='rgb(120,235,190)' stroke-dasharray='4 5' opacity='.5'/>
<path d='M60 118 q86 90 198 38' fill='none' stroke='rgb(255,190,110)' stroke-dasharray='4 5' opacity='.5'/>
<circle r='4' fill='rgb(150,245,200)'><animateMotion path='M60 118 q90 -80 194 -32' dur='6s' fill='freeze'/></circle>
<circle r='4' fill='rgb(255,210,120)'><animateMotion path='M60 118 q86 90 198 38' dur='6s' fill='freeze'/><animate attributeName='opacity' values='1;1;.1' dur='6s' fill='freeze'/></circle>
<g fill='rgb(200,220,255)'><rect x='44' y='112' width='26' height='11' rx='3'/></g>
<text x='128' y='46' fill='rgb(150,245,200)' font-family='monospace' font-size='11'>BETA · QUIET HEMISPHERE</text>
<text x='120' y='206' fill='rgb(255,190,110)' font-family='monospace' font-size='11'>ALPHA · INTERACTION ZONE</text>
<text x='412' y='14' fill='rgb(70,88,112)' font-family='monospace' font-size='8' text-anchor='end'>TRANSIT · 6 h COMPRESSED TO 6 s</text>`.replace(/_e_/g, '%23e')),

alphaLost: S(`${BG}<g stroke='rgb(120,235,190)' fill='none' opacity='.5'><path d='M26 160 q26 -22 52 0 t52 0'>
<animate attributeName='d' values='M26 160 q26 -22 52 0 t52 0;M26 160 q26 -8 52 0 t52 0;M26 160 q26 -22 52 0 t52 0' dur='3s' repeatCount='indefinite'/></path></g>
<path d='M130 160 q30 -8 60 -2 t54 4' fill='none' stroke='rgb(255,190,110)' opacity='.3' stroke-dasharray='3 6'/>
<line x1='246' y1='132' x2='246' y2='188' stroke='rgb(220,70,60)' stroke-width='1.5' opacity='.85'/>
<text x='252' y='184' fill='rgb(220,90,80)' font-family='monospace' font-size='10'>LOSS</text>
<text x='26' y='132' fill='rgb(120,235,190)' font-family='monospace' font-size='10'>TELEMETRY</text>
<g fill='none' stroke='rgb(150,190,255)' opacity='.5'><path d='M298 58 q22 -16 42 2 q-14 22 -42 -2z'><animate attributeName='d' values='M298 58 q22 -16 42 2 q-14 22 -42 -2z;M298 58 q26 6 40 -14 q-6 26 -40 14z;M298 58 q22 -16 42 2 q-14 22 -42 -2z' dur='5s' repeatCount='indefinite'/></path>
<path d='M304 94 q26 8 44 -6 q-10 24 -44 6z'><animate attributeName='d' values='M304 94 q26 8 44 -6 q-10 24 -44 6z;M304 94 q20 -18 44 4 q-18 20 -44 -4z;M304 94 q26 8 44 -6 q-10 24 -44 6z' dur='6.4s' repeatCount='indefinite'/></path></g>
<text x='296' y='36' fill='rgb(150,190,255)' font-family='monospace' font-size='10'>STRUCTURES SHIFTING</text>
<g fill='rgb(108,128,158)'><circle cx='366' cy='206' r='2.2'/><circle cx='384' cy='214' r='1.7'/><circle cx='350' cy='218' r='1.4'/><circle cx='396' cy='200' r='1.2'/></g>
<text x='300' y='232' fill='rgb(78,94,118)' font-family='monospace' font-size='9'>debris · unremarkable</text>`),

record: S(`${BG}<rect x='96' y='30' width='228' height='176' rx='4' fill='rgb(12,18,32)' stroke='rgb(60,84,120)'/>
<text x='116' y='58' fill='rgb(150,190,255)' font-family='monospace' font-size='11'>IISS SURVEY RECORD</text>
<line x1='116' y1='68' x2='304' y2='68' stroke='rgb(60,84,120)'/>
<g fill='rgb(130,155,185)' font-family='monospace' font-size='10'><text x='116' y='92'>SANDOVAL, K.  LT</text><text x='116' y='110'>TYPE S · DROP TANKS</text><text x='116' y='128'>LAST CONTACT  -11 YR</text></g>
<text x='116' y='168' fill='rgb(224,86,72)' font-family='monospace' font-size='13'>MISSING</text>
<text x='116' y='186' fill='rgb(224,86,72)' font-family='monospace' font-size='11' opacity='.8'>PRESUMED MISJUMP</text>
<rect x='96' y='30' width='228' height='176' fill='none' stroke='rgb(224,86,72)' opacity='0'><animate attributeName='opacity' values='0;.45;0' dur='4s' repeatCount='indefinite'/></rect>`),

thenNow: S(`${BG}<line x1='210' y1='24' x2='210' y2='200' stroke='rgb(60,84,120)' stroke-dasharray='3 5'/>
<text x='104' y='40' fill='rgb(120,140,170)' font-family='monospace' font-size='11' text-anchor='middle'>NAVY · THEN</text>
<text x='316' y='40' fill='rgb(120,235,190)' font-family='monospace' font-size='11' text-anchor='middle'>DAWN · NOW</text>
<g stroke='rgb(120,140,170)' fill='none' opacity='.55'><path d='M32 130 q18 -16 36 0 t36 0 t36 0'/></g>
<g stroke='rgb(120,235,190)' fill='none' opacity='.75'><path d='M228 130 q18 -16 36 0 t36 0 t36 0'/></g>
<g fill='rgb(255,190,110)'><circle cx='264' cy='114' r='3'><animate attributeName='opacity' values='.2;1;.2' dur='2.2s' repeatCount='indefinite'/></circle>
<circle cx='336' cy='114' r='3'><animate attributeName='opacity' values='1;.2;1' dur='2.8s' repeatCount='indefinite'/></circle></g>
${cap('SAME DATA · DIFFERENT EYES')}`),

rhythms: S(`${BG}<g stroke='rgb(150,190,255)' fill='none' opacity='.7'>
<path d='M20 120 q14 -34 28 0 t28 0 t28 0 t28 0 t28 0 t28 0 t28 0 t28 0 t28 0 t28 0 t28 0 t28 0 t28 0'/></g>
<g stroke='rgb(190,150,255)' fill='none' opacity='.8'><path d='M20 150 q10 -18 20 0 t26 0 t14 0 t30 0 t18 0 t24 0 t12 0 t28 0 t20 0 t26 0 t14 0 t22 0'>
<animate attributeName='opacity' values='.35;.95;.35' dur='5s' repeatCount='indefinite'/></path></g>
<text x='20' y='102' fill='rgb(150,190,255)' font-family='monospace' font-size='10'>PERIODIC</text>
<text x='20' y='176' fill='rgb(190,150,255)' font-family='monospace' font-size='10'>NOT PERIODIC — RHYTHMS</text>
${cap('IT COULD BE NOTHING')}`),

beacon: S(`${BG}${stars(18)}<g fill='none' stroke='rgb(255,120,110)'>
<circle cx='300' cy='118' r='14' opacity='.9'><animate attributeName='r' values='14;62;14' dur='3.2s' repeatCount='indefinite'/><animate attributeName='opacity' values='.9;0;.9' dur='3.2s' repeatCount='indefinite'/></circle></g>
<circle cx='300' cy='118' r='5' fill='rgb(255,140,120)'/>
<g stroke='rgb(90,200,255)' fill='none' opacity='.3'><circle cx='300' cy='118' r='86' stroke-dasharray='2 8'/></g>
<g fill='rgb(200,220,255)'><rect x='40' y='112' width='24' height='10' rx='3'/></g>
<path d='M66 118 L286 118' stroke='rgb(90,120,160)' stroke-dasharray='2 6' opacity='.5'/>
${cap('IISS PROBE FREQUENCY · DEEP IN THE ZONE')}`),

zone: S(`${BG}<g fill='none' stroke='rgb(120,235,190)' opacity='.6'>
<path d='M40 70 q60 -26 120 0 t120 0 t100 0'><animate attributeName='opacity' values='.2;.8;.2' dur='4s' repeatCount='indefinite'/></path>
<path d='M40 118 q60 30 120 0 t120 0 t100 0'><animate attributeName='opacity' values='.8;.2;.8' dur='5.2s' repeatCount='indefinite'/></path>
<path d='M40 166 q60 -24 120 0 t120 0 t100 0'><animate attributeName='opacity' values='.3;.75;.3' dur='6.1s' repeatCount='indefinite'/></path></g>
<g fill='rgb(255,210,140)'><circle cx='120' cy='94' r='2.6'><animate attributeName='cx' values='120;300;120' dur='9s' repeatCount='indefinite'/></circle>
<circle cx='300' cy='142' r='2.2'><animate attributeName='cx' values='300;120;300' dur='11s' repeatCount='indefinite'/></circle></g>
${cap('ORGANIZED FLOW · ALONG FIELD LINES')}`),

logFrame: (n, alarm) => S(`${BG}<rect x='60' y='28' width='300' height='170' rx='4' fill='rgb(10,14,26)' stroke='rgb(${alarm ? '150,50,44' : '60,84,120'})'/>
<text x='80' y='56' fill='rgb(${alarm ? '235,110,95' : '150,190,255'})' font-family='monospace' font-size='11'>SANDOVAL · LOG ${n}</text>
<line x1='80' y1='66' x2='340' y2='66' stroke='rgb(${alarm ? '150,50,44' : '60,84,120'})'/>
<g stroke='rgb(${alarm ? '235,110,95' : '120,235,190'})' fill='none' opacity='.7'><path d='M80 130 q20 ${alarm ? -46 : -14} 40 0 t40 0 t40 0 t40 0 t40 0 t40 0'>
<animate attributeName='opacity' values='.3;.9;.3' dur='${alarm ? 1.4 : 3.6}s' repeatCount='indefinite'/></path></g>
${alarm ? `<text x='210' y='186' fill='rgb(235,110,95)' font-family='monospace' font-size='12' text-anchor='middle'>JUMP CALIBRATION DM-6</text>` : ''}`),

staticEnd: S(`${BG}<g fill='rgb(90,104,130)'>
<rect x='40' y='110' width='340' height='1.5' opacity='.5'><animate attributeName='opacity' values='.1;.7;.1' dur='.5s' repeatCount='indefinite'/></rect>
<rect x='40' y='124' width='340' height='1' opacity='.3'><animate attributeName='opacity' values='.6;.1;.6' dur='.35s' repeatCount='indefinite'/></rect>
<rect x='40' y='98' width='340' height='1' opacity='.4'><animate attributeName='opacity' values='.2;.6;.2' dur='.7s' repeatCount='indefinite'/></rect></g>
${cap('END OF RECORDING · ELEVEN YEARS OLD', 168, 'rgb(120,140,170)')}`),

museum: S(`${BG}<g fill='none' stroke='rgb(150,190,255)' opacity='.45'>
<rect x='60' y='50' width='48' height='30' rx='2'/><rect x='128' y='58' width='34' height='22' rx='2'/><rect x='186' y='46' width='42' height='26' rx='2'/>
<rect x='252' y='60' width='30' height='30' rx='2'/><rect x='306' y='50' width='46' height='24' rx='2'/>
<rect x='72' y='120' width='36' height='36' rx='2'/><rect x='130' y='128' width='44' height='24' rx='2'/><rect x='196' y='118' width='30' height='38' rx='2'/>
<rect x='248' y='126' width='40' height='28' rx='2'/><rect x='308' y='120' width='34' height='34' rx='2'/></g>
<g stroke='rgb(90,200,255)' fill='none' opacity='.28' stroke-dasharray='2 6'>
<ellipse cx='210' cy='66' rx='168' ry='34'><animate attributeName='opacity' values='.12;.42;.12' dur='6s' repeatCount='indefinite'/></ellipse>
<ellipse cx='210' cy='138' rx='168' ry='34'><animate attributeName='opacity' values='.42;.12;.42' dur='7.4s' repeatCount='indefinite'/></ellipse></g>
${cap('EVERY COMPONENT · SORTED · HELD')}`),

psi: S(`${BG}<g fill='none' stroke='rgb(190,150,255)'>
<circle cx='210' cy='118' r='30' opacity='.5'><animate attributeName='r' values='30;96;30' dur='8s' repeatCount='indefinite'/><animate attributeName='opacity' values='.5;0;.5' dur='8s' repeatCount='indefinite'/></circle>
<circle cx='210' cy='118' r='30' opacity='.4'><animate attributeName='r' values='30;96;30' dur='8s' begin='2.6s' repeatCount='indefinite'/><animate attributeName='opacity' values='.4;0;.4' dur='8s' begin='2.6s' repeatCount='indefinite'/></circle>
<circle cx='210' cy='118' r='30' opacity='.3'><animate attributeName='r' values='30;96;30' dur='8s' begin='5.2s' repeatCount='indefinite'/><animate attributeName='opacity' values='.3;0;.3' dur='8s' begin='5.2s' repeatCount='indefinite'/></circle></g>
${cap('PRESENCE', 214, 'rgb(190,150,255)')}`),

sand: S(`${BG}<g fill='rgb(190,205,230)'>${Array.from({ length: 46 }, (_, i) => {
  const x = 90 + ((i * 37) % 250), y = 60 + ((i * 61) % 120), r = 0.9 + (i % 3) * 0.5;
  return `<circle cx='${x}' cy='${y}' r='${r}' opacity='.7'><animate attributeName='cy' values='${y};${y - 8};${y}' dur='${3 + (i % 5)}s' repeatCount='indefinite'/></circle>`;
}).join('')}</g>
<g stroke='rgb(90,200,255)' fill='none' opacity='.35'><path d='M70 118 q80 -40 160 0 t120 0' stroke-dasharray='3 6'/></g>
${cap('FERROMAGNETIC PARTICULATE · FULL RACKS')}`),
};

// -------------------------------------------------------------- BEATS -------
const B = [
// HOME is first AND the default: the stage idles here between beats.
['home','Arabus',null,
 'Sub-brown dwarf. Hex 1235. No star lights it — it glows from its own heat, a billion years of slow contraction.\n\nTyphon orbits close, venting sulfur. Where the moon\'s small field meets the giant\'s unconfined one, the interaction zone burns.\n\nThe quiet hemisphere is skimmable. The other side is not.',
 ART.home,null],
// --- SHIP / INSTRUMENT beats (S210, Bruce's request) — reusable ANY session, not just S15.
['bridge','On the Bridge of the Astral Dawn',null,
 'Low light. The viewport holds the ember and nothing else — no star, no horizon, no up.\n\nSensors, Conn, Gunnery. Three stations lit, indicators out of phase with each other.\n\nSomeone has the watch. Somebody always has the watch.',
 ART.bridge,null],
['scan','Active Scan',null,
 'The dish comes around. Ping, listen, ping.\n\nReturns come back from the interaction zone — bright, then gone, then bright again somewhere they should not be.\n\nThe computer classifies none of them. It offers a confidence figure instead, and the figure is low.',
 ART.scan,null],
['sysmap','System Schematic',null,
 'Arabus at centre. Typhon inside, tight and fast. The interaction zone painted where the two fields grind against each other.\n\nThe quiet hemisphere is marked skimmable.\n\nThe Astral Dawn holds high and outside, which is where you want to be when you do not yet know what you are looking at.',
 ART.sysmap,null],
['emergence','Emergence',null,
 'Jump space releases you into perfect black.\n\nThen you see it: a dull red ember hanging in the void, glowing with its own heat. No sun lights it. It lights itself.\n\nCherry-red bands of cloud, visible to the naked eye. Below the threshold of a star — but not by much.',
 ART.emergence,null],
['sphere','A Sphere of Force','Jeri Tallux · Sensors',
 '"The magnetic field is… odd. No bow shock. No magnetotail. It\'s symmetric — a sphere of force hundreds of thousands of kilometers across.\n\nThat shouldn\'t happen. Unless there\'s nothing pushing against it."',
 ART.sphere,null],
['typhon','Typhon',null,
 'The volcanic moon burns bright in infrared — sulfur plumes erupting hundreds of kilometers into space, flares against the dark.\n\nIt has its own magnetic field. Small. Nested inside the giant\'s.\n\nWhere the two fields meet, the sensors show… a lot going on.',
 ART.typhon,null],
['probes','Probes Away','ORACLE',
 '"Alpha inbound to the interaction zone, high approach. Beta swinging wide to the quiet hemisphere.\n\nTelemetry nominal on both tracks."',
 ART.probes,null],
['alpha-lost','PROBE ALPHA — SIGNAL LOST',null,
 'Beta reports clean: the quiet hemisphere is an ordinary gas giant. Skimming is viable.\n\nAlpha\'s telemetry degraded for forty minutes as it closed on the interaction zone. Its final data burst shows field structures that seem to shift. To move.\n\nThen nothing.\n\nFootnote in Beta\'s wide sweep: distant orbital debris, very far out. Small cold bodies. Logged as unremarkable.',
 ART.alphaLost,null],
['record','IISS Record — Lt. Kira Sandoval',null,
 'Scout survey, 11 years ago. Arrived with drop tanks. Deployed probes. Stopped transmitting.\n\nNavy cruiser, 4 years later: no wreckage, no beacon, no distress call. One dead probe in the outer approach. "Unusual EM activity at the magnetopause boundary."\n\nOfficial status: MISSING, PRESUMED MISJUMP.',
 ART.record,null],
['then-and-now','Then and Now',null,
 'The Navy\'s sensors were good. They weren\'t looking for this.\n\nTheir logs show the same EM activity — catalogued as natural magnetospheric dynamics.\n\nThe Astral Dawn\'s upgraded pattern recognition is flagging anomalies. Not biological. Not yet. But the patterns don\'t match any known model.',
 ART.thenNow,null],
['rhythms','Rhythms','Dr. Elara Holt',
 '"Some of these patterns repeat. Not regularly — not like a pulsar. More like… rhythms.\n\nIt could be nothing. Natural systems have rhythms too."',
 ART.rhythms,null],
['beacon','CONTACT — ARTIFICIAL SIGNAL',null,
 'Buried in the plasma noise: a weak, repeating beacon.\n\nStandard IISS survey probe frequency.\n\nBearing: DEEP inside the interaction zone — well past the point where Probe Alpha went dark.',
 ART.beacon,null],
['zone','The Zone Is Active',null,
 'Not just noise.\n\nFlux tubes that form and dissolve in patterns. Organized particle flows moving ALONG field lines. Energy concentrations that flare — and fade.\n\nSomething that might be coordinated movement. Or might be reconnection dynamics.\n\nNone of it is conclusive.',
 ART.zone,null],
['log-1','Sandoval Log — Entry 1',null,
 '"Lieutenant Sandoval, IISS Survey, arrival at designated rogue planet Alpha, hex 1235. Confirming sub-brown dwarf classification… The magnetosphere is remarkable — unconfined, spherical. Deploying probes toward the interaction zone. Initial readings show standard magnetosphere dynamics. Fascinating scale. Sandoval out."',
 ART.logFrame(1,false),null],
['log-2','Sandoval Log — Entry 2',null,
 '"Day two. The interaction zone data is… I\'m not sure what to make of it. Organized structures forming in the plasma sheet — but they\'re persisting longer than they should. Some of them appear to be moving AGAINST the ambient flow. I\'ve repositioned for closer observation."',
 ART.logFrame(2,false),null],
['log-3','Sandoval Log — Entry 3',null,
 '"Day three. The structures are responding to my probes. I deployed a magnetometer array and the local field geometry… changed. The flux tubes reorganized around the instruments. I pulled the array back and they returned to their previous configuration. This is not standard magnetospheric behavior. Jump calibration is showing a minus-two modifier. I\'m noting this but proceeding. If this is what I think it might be—"',
 ART.logFrame(3,false),null],
['log-4','Sandoval Log — FINAL ENTRY',null,
 '"Sandoval, emergency log. The field is ALIVE. I\'m certain of it now. The structures are organisms. They\'re investigating my ship. Something large — very large — is reshaping the local magnetic topology around me. Jump calibration has degraded to minus-six. I cannot safely jump from this position. The field geometry is — it\'s closing around me. I\'m going to attempt a jump. Risk of misjump is… significant. If anyone finds this: THE MAGNETOSPHERE IS INHABITED. Do not enter the interaction zone without proper preparation. The intelligence is distributed, enormous, and it does not want visitors. Sandoval — attempting jump."',
 ART.logFrame(4,true),null],
['static','— static —',null,'End of recording.\n\nEleven years old.',ART.staticEnd,null],
['metal','Contact — Metal',null,
 'The first piece you identify is a hull plate. Standard Type S scout plating, about two meters square, floating in what appears to be a magnetic cradle.\n\nThen another, thirty meters away.\n\nThen more — arranged in a pattern your brain keeps trying to parse as organized.\n\nBecause it is.',
 ART.museum,null],
['museum','Not a Debris Field',null,
 'Every component of the scout has been separated, preserved, and positioned. Jump drive coils in one region. Sensor arrays in another. Life support — air scrubbers, water recyclers — in a third.\n\nIt looks like someone took apart a ship the way a xenobiologist dissects a specimen.\n\nYou find no remains of Lieutenant Sandoval.',
 ART.museum,null],
['its-a-museum','"It\'s a museum."','Max Planck','It\'s a museum.',ART.museum,null],
// --- private, per-PC -------------------------------------------------------
['marina-sand','Ordnance Inventory',null,
 'Sandcaster canisters: full racks.\n\nIncluding the special loads nobody ever asks about — high-ferromagnetic particulate, the "obsolete" ones.\n\nYou\'ve been right about sandcasters before.',
 ART.sand,'marina'],
['vonsydo-pressure','◈',null,
 'You reach out, carefully.\n\nPressure. Like a room full of whispered conversations just below the threshold of hearing.\n\nNot hostile. Not welcoming.\n\nPresence.',
 ART.psi,'vonsydo'],
['vonsydo-forest','◈',null,
 'It is nothing like the Flat — that was crystalline, precise. Nothing like a mind you have ever touched.\n\nIt is like standing in a forest and knowing the forest is alive, without being able to find a single animal.\n\nVast. Diffuse. Aware.',
 ART.psi,'vonsydo'],
['max-anomaly','Pattern Analysis — Private Channel',null,
 'The anomaly flags keep accumulating. Flux-rope persistence 4σ beyond model. Counter-flow motion. Reorganization around instruments.\n\nEvery individual reading has a natural explanation.\n\nThe ensemble does not.',
 ART.thenNow,'max'],
['james-orders','Mission Orders — Eyes Only',null,
 'Survey and assess Arabus for automated refueling operations. Two ARS prototypes aboard. Loss of one unit is acceptable; the data is the mission.\n\nAmendment (Cassian Holt): scientific discretion authorized. Your call, Captain.',
 ART.record,'james'],
['asao-eva','Marine Readiness',null,
 'What do you prepare for when you don\'t know the threat?\n\nEverything.\n\nFire teams on rotation. EVA gear staged at both locks. Reyes has the watch bill. The Fabrication Chamber inventory is current — if something breaks out there, you can build the fix.',
 null,'asao'],
];

// --- NAVIGABLE SYSTEM MAP ---------------------------------------------------------------
// Not a card image: the `map` component is pan/zoomable, the PRESENTER's view is mirrored to
// every viewer, peer clicks drop ATTRIBUTED markers, and there is a laser pointer + per-user
// cursors. Raw SVG (not a data URI) ⇒ '#' and '%' are safe here.
// Big canvas on purpose — detail rewards zooming, and the waypoints are the point: players can
// find the debris field themselves instead of being told about it.
const navmapSvg = ({ alpha = false, beacon = false, probes = false } = {}) => {
  // S210 (Bruce): scale is in ARABUS RADII (AR). AD arrives at 120 AR; M-drives are useful to
  // ~1000 AR. Holding 10 AR and 1100 AR on one screen means a LOG radial scale — linear would
  // put Arabus at half a pixel. The scale is declared on the map so it is honest, not a cheat.
  // Skim point removed (fuel skimming is an abstract decision, not a map feature).
  const CX = 840, CY = 500, RMAX = 430, LOGMAX = Math.log(1100);
  const R = (ar) => RMAX * Math.log(Math.max(1, ar)) / LOGMAX;
  const P = (ar, deg) => [CX + R(ar) * Math.cos(deg * Math.PI / 180), CY + R(ar) * Math.sin(deg * Math.PI / 180)];
  const ring = (ar, label, col, dash) => `<circle cx="${CX}" cy="${CY}" r="${R(ar).toFixed(0)}" fill="none" stroke="${col}" stroke-dasharray="${dash}" opacity=".5"/>
<text x="${CX}" y="${(CY - R(ar) - 8).toFixed(0)}" text-anchor="middle" fill="${col}" font-size="13">${label}</text>`;
  const mark = (ar, deg, col, t, sub, pulse) => { const [x, y] = P(ar, deg); return `
<g stroke="${col}" fill="none" stroke-width="2"><circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="13">${pulse ? `<animate attributeName="r" values="13;34;13" dur="3s" repeatCount="indefinite"/><animate attributeName="opacity" values=".95;0;.95" dur="3s" repeatCount="indefinite"/>` : ''}</circle></g>
<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="4" fill="${col}"/>
<text x="${x.toFixed(0)}" y="${(y - 24).toFixed(0)}" text-anchor="middle" fill="${col}" font-size="16">${t}</text>
<text x="${x.toFixed(0)}" y="${(y + 34).toFixed(0)}" text-anchor="middle" fill="#6b7d94" font-size="12">${sub}</text>`; };
  const [tx, ty] = P(5.3, -58), [adx, ady] = P(120, -28), [dbx, dby] = P(800, 42);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1680 1050" font-family="Verdana,Geneva,sans-serif">
<defs>
 <radialGradient id="space" cx="50%" cy="45%" r="78%"><stop offset="0%" stop-color="#0d1526"/><stop offset="60%" stop-color="#070b18"/><stop offset="100%" stop-color="#03050c"/></radialGradient>
 <radialGradient id="ember"><stop offset="0%" stop-color="#ffc496"/><stop offset="45%" stop-color="#d64426"/><stop offset="100%" stop-color="#4a0a07"/></radialGradient>
</defs>
<rect width="1680" height="1050" fill="url(#space)"/>
<g fill="#9fb4d8">${Array.from({ length: 70 }, (_, i) => `<circle cx="${(i * 331) % 1670 + 5}" cy="${(i * 197) % 1040 + 5}" r="${((i % 3) * 0.7 + 0.7).toFixed(1)}" opacity="${(0.12 + (i % 5) * 0.08).toFixed(2)}"/>`).join('')}</g>

<text x="46" y="52" fill="#9fc0ff" font-size="22" letter-spacing="3">ARABUS 1235 — SYSTEM PLOT</text>
<text x="46" y="76" fill="#5c789c" font-size="13">radial scale LOGARITHMIC in Arabus radii (AR) · 1 AR = 7.9e4 km · orbits stationary, real time</text>

<!-- ZONES, drawn as bands so they read as regions rather than lines -->
<circle cx="${CX}" cy="${CY}" r="${((R(2) + R(11)) / 2).toFixed(0)}" fill="none" stroke="#d05a4a" stroke-width="${(R(11) - R(2)).toFixed(0)}" opacity=".09"/>
<circle cx="${CX}" cy="${CY}" r="${((R(4) + R(7)) / 2).toFixed(0)}" fill="none" stroke="#b07a3a" stroke-width="${(R(7) - R(4)).toFixed(0)}" opacity=".13"/>
<circle cx="${CX}" cy="${CY}" r="${((R(4.4) + R(6.4)) / 2).toFixed(0)}" fill="none" stroke="#2ea8c8" stroke-width="${(R(6.4) - R(4.4)).toFixed(0)}" opacity=".16">
  <animate attributeName="opacity" values=".09;.24;.09" dur="7s" repeatCount="indefinite"/></circle>

${ring(10, '10 AR', '#3d5878', '3 10')}
${ring(200, '200 AR · 100-DIAMETER JUMP LIMIT', '#7d93ab', '6 8')}
${ring(1000, '1000 AR · PRACTICAL M-DRIVE RANGE', '#4d6076', '2 12')}

<!-- Arabus: SMALL. 1 AR is a fifth of a pixel at this scale, so the disc is drawn oversized
     and said so. Better an admitted exaggeration than a silent one. -->
<circle cx="${CX}" cy="${CY}" r="15" fill="url(#ember)"/>
<text x="${CX}" y="${CY + 38}" text-anchor="middle" fill="#e2966e" font-size="15">ARABUS</text>
<text x="${CX}" y="${CY + 56}" text-anchor="middle" fill="#7d6154" font-size="11">disc exaggerated · true radius 1 AR</text>

<!-- Typhon, static (real time). Period stated as a number instead. -->
<circle cx="${CX}" cy="${CY}" r="${R(5.3).toFixed(0)}" fill="none" stroke="#6b5a3a" stroke-dasharray="2 9" opacity=".7"/>
<circle cx="${tx.toFixed(0)}" cy="${ty.toFixed(0)}" r="9" fill="#cead60"/>
<text x="${tx.toFixed(0)}" y="${(ty - 18).toFixed(0)}" text-anchor="middle" fill="#cead60" font-size="14">TYPHON</text>
<text x="${tx.toFixed(0)}" y="${(ty + 26).toFixed(0)}" text-anchor="middle" fill="#7d6a42" font-size="11">5.3 AR · P 14.9 h</text>

<!-- LAGRANGE POINTS of the Arabus-Typhon pair. Five, and only five: Arabus is a rogue, so
     there is no star-primary system to add another set. Typhon sits at 5.3 AR bearing -58 deg.
     L1/L2 are one Hill radius in/out (mass ratio ~5e-5 => r_H/a ~ 0.025, so 5.17 and 5.43 AR) —
     they crowd Typhon on a log scale, which is TRUE, so they are drawn crowded and labelled.
     L3 is antipodal; L4/L5 lead and trail by 60 deg and are STABLE at this mass ratio, which is
     why loose material collects there. That is a place to go and look. -->
${(() => { const TD = -58, TA = 5.3;
  const pts = [['L1', 5.17, TD], ['L2', 5.43, TD], ['L3', TA, TD + 180], ['L4', TA, TD - 60], ['L5', TA, TD + 60]];
  return pts.map(([n, ar, deg]) => { const [x, y] = P(ar, deg); const stable = (n === 'L4' || n === 'L5');
    const c = stable ? '#8ee0b0' : '#7d93ab';
    return `<g stroke="${c}" fill="none" opacity="${stable ? '.85' : '.55'}"><path d="M${(x-7).toFixed(0)} ${y.toFixed(0)} h14 M${x.toFixed(0)} ${(y-7).toFixed(0)} v14"/>${stable ? `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="11" stroke-dasharray="2 4"/>` : ''}</g>
<text x="${(x + (n === 'L1' ? -16 : n === 'L2' ? 16 : 0)).toFixed(0)}" y="${(y - 14).toFixed(0)}" text-anchor="middle" fill="${c}" font-size="13">${n}</text>`;
  }).join('');
})()}
<text x="${P(5.3, -58 - 60)[0].toFixed(0)}" y="${(P(5.3, -58 - 60)[1] + 30).toFixed(0)}" text-anchor="middle" fill="#5d8571" font-size="11">stable · material collects</text>

<!-- the AD is a DRAGGABLE TOKEN (navmap component), not part of this SVG -->
${probes ? `
<!-- PROBE TRACKS. Real transits are hours-to-weeks; these creep across minutes and the rate is
     declared bottom-right. Travel is the ONE place compression is allowed. -->
<g stroke="#8ee0b0" fill="none" opacity=".40" stroke-dasharray="4 9"><path id="pr1" d="${(() => { const [x0,y0]=P(120,-28), [x1,y1]=P(9,-52); return `M${x0.toFixed(0)} ${y0.toFixed(0)} Q${((x0+x1)/2+70).toFixed(0)} ${((y0+y1)/2-60).toFixed(0)} ${x1.toFixed(0)} ${y1.toFixed(0)}`; })()}"/></g>
<circle r="7" fill="#8ee0b0"><animateMotion dur="300s" repeatCount="indefinite" rotate="auto"><mpath href="#pr1"/></animateMotion></circle>
<text x="${P(9,-52)[0].toFixed(0)}" y="${(P(9,-52)[1]-22).toFixed(0)}" text-anchor="middle" fill="#8ee0b0" font-size="13">PROBE 1 · RAD MAPPING</text>
<g stroke="#c8b58e" fill="none" opacity=".34" stroke-dasharray="3 10"><path id="pr2" d="${(() => { const [x0,y0]=P(120,-28), [x1,y1]=P(800,42); return `M${x0.toFixed(0)} ${y0.toFixed(0)} Q${((x0+x1)/2+40).toFixed(0)} ${((y0+y1)/2+120).toFixed(0)} ${x1.toFixed(0)} ${y1.toFixed(0)}`; })()}"/></g>
<circle r="7" fill="#c8b58e"><animateMotion dur="600s" repeatCount="indefinite"><mpath href="#pr2"/></animateMotion></circle>
<text x="${P(800,42)[0].toFixed(0)}" y="${(P(800,42)[1]-46).toFixed(0)}" text-anchor="middle" fill="#c8b58e" font-size="13">PROBE 2 · DEBRIS SURVEY</text>
<text x="1620" y="1008" text-anchor="end" fill="#3f5268" font-size="12">PROBE TRACKS COMPRESSED · bodies still, real time</text>` : ''}
${mark(800, 42, '#9fb4d8', 'DEBRIS FIELD', 'small cold bodies · logged unremarkable', false)}
${alpha ? mark(6.0, 14, '#ffbe6e', 'ALPHA LOST', 'telemetry decayed, then nothing', false) : ''}
${beacon ? mark(5.6, -14, '#ff6f5e', 'BEACON', 'IISS probe frequency', true) : ''}

<!-- zone key, replacing scattered labels -->
<g transform="translate(46,832)">
 <rect x="-8" y="-20" width="330" height="132" rx="6" fill="#080d1a" stroke="#22344f" opacity=".92"/>
 <text x="6" y="0" fill="#7086a0" font-size="12" letter-spacing="1">ZONES</text>
 <rect x="6" y="12" width="22" height="10" fill="#2ea8c8" opacity=".5"/><text x="38" y="22" fill="#93a6bd" font-size="12">interaction zone · 4.4–6.4 AR</text>
 <rect x="6" y="34" width="22" height="10" fill="#b07a3a" opacity=".5"/><text x="38" y="44" fill="#93a6bd" font-size="12">sulfur plasma torus · 4–7 AR</text>
 <rect x="6" y="56" width="22" height="10" fill="#d05a4a" opacity=".5"/><text x="38" y="66" fill="#93a6bd" font-size="12">radiation belt · 2–11 AR · EVA PROHIBITED</text>
 <rect x="6" y="78" width="22" height="10" fill="none" stroke="#7d93ab"/><text x="38" y="88" fill="#93a6bd" font-size="12">jump limit · 200 AR</text>
 <text x="6" y="108" fill="#8ee0b0" font-size="12">L1–L5 Arabus/Typhon · L4 L5 stable</text></g>

<g transform="translate(1298,832)">
 <rect x="-10" y="-20" width="336" height="132" rx="6" fill="#080d1a" stroke="#22344f" opacity=".92"/>
 <text x="6" y="0" fill="#7086a0" font-size="12" letter-spacing="1">SENSOR SUMMARY · TL-15</text>
 <g font-size="12" fill="#93a6bd" font-family="monospace">
  <text x="6" y="22">PRIMARY   8.1 M-Jup · 1.1 R-Jup · ~850 K</text>
  <text x="6" y="44">FIELD     unconfined · no bow shock</text>
  <text x="6" y="66">HYDROGEN  skimmable, quiet hemisphere</text>
  <text x="6" y="88" fill="#e0a86e">ZONE ACTIVITY  UNCLASSIFIED · conf. LOW</text></g></g>
</svg>`;
};

// --- SHIP STATUS DASHBOARD --------------------------------------------------------------
// One generator, five states. The ladder across the bottom shows every state the ship can be
// in and lights the current one, so the table sees not just where they are but where this is
// heading. Canon: 600t Bastien-class Q-ship; POWER PLANT EXACTLY 300 (zero margin); Armor 1;
// Thrust 3; J-3 with the J-4 override EXPERIMENTAL; barbettes offence-only.
const OK = 'rgb(120,235,190)', WARN = 'rgb(255,190,110)', CRIT = 'rgb(255,110,96)', DIM = 'rgb(96,120,150)', INK = 'rgb(206,222,244)';
const tone = (v) => (v >= 70 ? OK : v >= 35 ? WARN : CRIT);

function meter(x, y, w, label, v, note, forced) {
  const c = forced || tone(v);
  const fw = Math.max(2, Math.round((w - 2) * Math.min(100, Math.max(0, v)) / 100));
  return `<text x='${x}' y='${y - 6}' fill='${DIM}' font-family='monospace' font-size='10'>${label}</text>
<text x='${x + w}' y='${y - 6}' fill='${c}' font-family='monospace' font-size='10' text-anchor='end'>${note || v}</text>
<rect x='${x}' y='${y}' width='${w}' height='7' rx='3' fill='rgb(16,24,42)' stroke='rgb(34,50,78)'/>
<rect x='${x + 1}' y='${y + 1}' width='${fw}' height='5' rx='2' fill='${c}' opacity='.85'>
  <animate attributeName='opacity' values='.65;.95;.65' dur='${(3 + (label.length % 4)).toFixed(1)}s' repeatCount='indefinite'/></rect>`;
}
function led(x, y, c, per) {
  return `<circle cx='${x}' cy='${y}' r='3' fill='${c}'><animate attributeName='opacity' values='1;.2;1' dur='${per}s' repeatCount='indefinite'/></circle>`;
}

const LADDER = ['NOMINAL', 'EM INTERFERENCE', 'DM-2', 'DM-4', 'DM-6 UNSAFE'];

function shipDash({ stateIdx, fuel, sensors, sensNote, jump, jumpNote, banner, bannerColor }) {
  const W = 660, H = 430;
  const rung = LADDER.map((s, i) => {
    const on = i === stateIdx;
    const c = i === 0 ? OK : i < 3 ? WARN : CRIT;
    const x = 30 + i * 122;
    return `<rect x='${x}' y='386' width='112' height='22' rx='4' fill='${on ? 'rgb(18,28,48)' : 'rgb(9,13,24)'}' stroke='${on ? c : 'rgb(30,44,70)'}'/>
<text x='${x + 56}' y='401' fill='${on ? c : 'rgb(70,88,116)'}' font-family='monospace' font-size='9' text-anchor='middle'>${s}</text>
${on ? `<rect x='${x}' y='386' width='112' height='22' rx='4' fill='none' stroke='${c}'><animate attributeName='opacity' values='1;.25;1' dur='2s' repeatCount='indefinite'/></rect>` : ''}`;
  }).join('');
  return S(`${EMBER}<rect width='${W}' height='${H}' fill='rgb(4,6,14)'/>
<rect x='0' y='0' width='${W}' height='30' fill='rgb(9,14,26)'/>
<text x='14' y='20' fill='${INK}' font-family='monospace' font-size='12' letter-spacing='1'>ISS ASTRAL DAWN</text>
<text x='190' y='20' fill='${DIM}' font-family='monospace' font-size='10'>BASTIEN-CLASS Q-SHIP · 600 TONS · ARMOR 1</text>
<rect x='${W - 196}' y='6' width='182' height='18' rx='4' fill='rgb(12,20,36)' stroke='${bannerColor}'/>
<text x='${W - 105}' y='19' fill='${bannerColor}' font-family='monospace' font-size='10' text-anchor='middle'>${banner}</text>
<rect x='${W - 196}' y='6' width='182' height='18' rx='4' fill='none' stroke='${bannerColor}'>
  <animate attributeName='opacity' values='1;.2;1' dur='2.4s' repeatCount='indefinite'/></rect>
<g transform='translate(18,44)'>
<path d='M8 54 q30 -34 92 -34 h108 q40 0 56 16 l40 18 -40 18 q-16 16 -56 16 H100 q-62 0 -92 -34 z' fill='rgb(12,19,34)' stroke='rgb(58,84,124)'/>
<circle cx='60' cy='54' r='9' fill='url(_e_)' opacity='.5'/>
${led(120, 40, OK, 2.6)}${led(150, 40, OK, 3.3)}${led(180, 40, OK, 4.1)}
${led(120, 70, OK, 3.7)}${led(150, 70, OK, 2.9)}${led(180, 70, OK, 4.6)}
<text x='60' y='96' fill='${DIM}' font-family='monospace' font-size='8' text-anchor='middle'>BRIDGE</text>
<text x='150' y='96' fill='${DIM}' font-family='monospace' font-size='8' text-anchor='middle'>HAB · CARGO</text>
<text x='262' y='96' fill='${DIM}' font-family='monospace' font-size='8' text-anchor='middle'>DRIVES</text>
<text x='150' y='18' fill='rgb(120,150,180)' font-family='monospace' font-size='8' text-anchor='middle'>COVER: SUBSIDISED LINER · ZERO PASSENGER BERTHS</text></g>
${meter(20, 168, 190, 'HULL', 100)}
${meter(20, 200, 190, 'POWER PLANT', 100, '300 / 300', WARN)}
<text x='20' y='218' fill='${WARN}' font-family='monospace' font-size='8'>ZERO MARGIN — ANY LOSS IS TRIAGE</text>
${meter(20, 244, 190, 'FUEL', fuel, fuel + ' pct')}
${meter(20, 276, 190, 'LIFE SUPPORT', 100)}
${meter(20, 308, 190, 'M-DRIVE', 100, 'THRUST 3')}
${meter(236, 168, 190, 'SENSORS', sensors, sensNote)}
${meter(236, 200, 190, 'JUMP CALIBRATION', jump, jumpNote)}
<text x='236' y='218' fill='${jump < 50 ? CRIT : DIM}' font-family='monospace' font-size='8'>J-3 RATED · J-4 OVERRIDE EXPERIMENTAL — MISJUMP RISK</text>
${meter(236, 244, 190, 'COMPUTER', 100, 'TL-15')}
${meter(236, 276, 190, 'ECM / ECCM', 100, 'READY')}
${meter(236, 308, 190, 'SANDCASTERS', 100, 'FULL RACKS')}
<rect x='452' y='150' width='192' height='172' rx='5' fill='rgb(8,12,24)' stroke='rgb(30,44,70)'/>
<text x='462' y='166' fill='${DIM}' font-family='monospace' font-size='9'>WEAPONS</text>
${led(634, 162, OK, 2.2)}
<text x='462' y='184' fill='${INK}' font-family='monospace' font-size='9'>BARBETTE 1 · PARTICLE</text>
<text x='462' y='196' fill='${DIM}' font-family='monospace' font-size='8'>HY+IF · Marina · OFFENCE ONLY</text>
<text x='462' y='214' fill='${INK}' font-family='monospace' font-size='9'>BARBETTE 2 · ION</text>
<text x='462' y='226' fill='${DIM}' font-family='monospace' font-size='8'>HY+LR · Anemone · OFFENCE ONLY</text>
<text x='462' y='244' fill='${INK}' font-family='monospace' font-size='9'>TURRETS 2 VIS / 2 HIDDEN</text>
<text x='462' y='256' fill='${DIM}' font-family='monospace' font-size='8'>AI GUNNERS · FC/4</text>
<line x1='462' y1='268' x2='634' y2='268' stroke='rgb(30,44,70)'/>
<text x='462' y='284' fill='${DIM}' font-family='monospace' font-size='9'>COMPLEMENT</text>
<text x='462' y='300' fill='${INK}' font-family='monospace' font-size='9'>6 FIGHTERS · LAUNCH · PINNACE</text>
<text x='462' y='313' fill='${INK}' font-family='monospace' font-size='9'>G-CARRIER · 8 MARINES</text>
<text x='20' y='352' fill='${DIM}' font-family='monospace' font-size='9'>STATE MACHINE</text>
<g font-family='monospace' font-size='8'>
<text x='452' y='352' fill='${OK}'>■ NOMINAL</text><text x='530' y='352' fill='${WARN}'>■ DEGRADED</text><text x='614' y='352' fill='${CRIT}'>■ CRITICAL</text></g>
<line x1='20' y1='362' x2='${W - 20}' y2='362' stroke='rgb(26,38,60)'/>
${rung}`.replace(/_e_/g, '%23e'), W, H);
}


// NYRTHUS 1135 — the sibling world. Canon: Arabus and Nyrthus are wide companions of WALSTON
// (1232), ejected together ~1.5 Myr ago at ~2 km/s, now 3 pc from Walston and ~1 pc apart.
// Ice shell over a subsurface ocean kept liquid by hydrothermal vents.
// PLAYER VIEW: thermal anomalies and a gravimetric two-layer solution. NOT life, NOT structure,
// NOT the vent ecology — those are earned later, and Von Sydo's psi is the door, not the map.
// Log radial scale again, in NYRTHUS RADII (NR). The point of this screen is the CONTRAST with
// Arabus: no belts, no torus, no discharge. It is quiet, and the quiet should feel wrong.
const nyrthusSvg = () => {
  const CX = 840, CY = 500, RMAX = 400, LOGMAX = Math.log(900);
  const R = (nr) => RMAX * Math.log(Math.max(1, nr)) / LOGMAX;
  const P = (nr, deg) => [CX + R(nr) * Math.cos(deg * Math.PI / 180), CY + R(nr) * Math.sin(deg * Math.PI / 180)];
  const ring = (nr, label) => `<circle cx="${CX}" cy="${CY}" r="${R(nr).toFixed(0)}" fill="none" stroke="#42566e" stroke-dasharray="3 11" opacity=".5"/>
<text x="${CX}" y="${(CY - R(nr) - 8).toFixed(0)}" text-anchor="middle" fill="#5d7590" font-size="13">${label}</text>`;
  const [adx, ady] = P(90, -34);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1680 1050" font-family="Verdana,Geneva,sans-serif">
<defs>
 <radialGradient id="dark" cx="50%" cy="45%" r="78%"><stop offset="0" stop-color="#0a1220"/><stop offset=".6" stop-color="#060a14"/><stop offset="1" stop-color="#03050a"/></radialGradient>
 <radialGradient id="ice"><stop offset="0" stop-color="#e2eef8"/><stop offset=".55" stop-color="#9fb8cd"/><stop offset="1" stop-color="#41586e"/></radialGradient>
</defs>
<rect width="1680" height="1050" fill="url(#dark)"/>
<g fill="#8fa6c4">${Array.from({length:96},(_,i)=>`<circle cx="${(i*331)%1670+5}" cy="${(i*197)%1040+5}" r="${((i%3)*0.7+0.7).toFixed(1)}" opacity="${(0.14+(i%6)*0.09).toFixed(2)}"/>`).join('')}</g>
<text x="46" y="52" fill="#a9c6de" font-size="22" letter-spacing="3">NYRTHUS 1135 — SYSTEM PLOT</text>
<text x="46" y="76" fill="#5d7590" font-size="13">radial scale LOGARITHMIC in Nyrthus radii (NR) · no primary · no belts · orbits stationary, real time</text>
${ring(10,'10 NR')}${ring(200,'200 NR · 100-DIAMETER JUMP LIMIT')}${ring(800,'800 NR · PRACTICAL M-DRIVE RANGE')}
<circle cx="${CX}" cy="${CY}" r="17" fill="url(#ice)"/>
<circle cx="${CX}" cy="${CY}" r="30" fill="none" stroke="#7ea8c8" opacity=".22"/>
<text x="${CX}" y="${CY+50}" text-anchor="middle" fill="#bcd6e8" font-size="15">NYRTHUS</text>
<text x="${CX}" y="${CY+68}" text-anchor="middle" fill="#5d7590" font-size="11">ice · disc exaggerated · true radius 1 NR</text>
<g fill="#ff9d6e">
${[[-8,'4.1e2'],[64,'3.7e2'],[188,'5.2e2'],[262,'2.9e2']].map(([deg,k],i)=>{const [x,y]=P(1.9,deg);
 return `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="6" opacity=".9"><animate attributeName="opacity" values=".35;.95;.35" dur="${5+i*1.4}s" repeatCount="indefinite"/></circle>`;}).join('')}</g>
<text x="${CX}" y="${CY-96}" text-anchor="middle" fill="#ff9d6e" font-size="13">THERMAL ANOMALIES · 4 · SUB-SURFACE</text>
<circle cx="${adx.toFixed(0)}" cy="${ady.toFixed(0)}" r="7" fill="#c8dcff"><animate attributeName="opacity" values="1;.4;1" dur="3.4s" repeatCount="indefinite"/></circle>
<text x="${adx.toFixed(0)}" y="${(ady-20).toFixed(0)}" text-anchor="middle" fill="#9fc0ff" font-size="16">ISS ASTRAL DAWN</text>
<text x="${adx.toFixed(0)}" y="${(ady+28).toFixed(0)}" text-anchor="middle" fill="#5c789c" font-size="12">90 NR · station-keeping</text>
<g transform="translate(46,832)">
 <rect x="-8" y="-20" width="352" height="150" rx="6" fill="#070c16" stroke="#22344f" opacity=".93"/>
 <text x="6" y="0" fill="#6f8aa4" font-size="12" letter-spacing="1">SENSOR SUMMARY · TL-15</text>
 <g font-size="12" fill="#93a6bd" font-family="monospace">
  <text x="6" y="22">SURFACE     WATER ICE · 51 K</text>
  <text x="6" y="42">GRAVIMETRIC TWO-LAYER SOLUTION</text>
  <text x="6" y="62" fill="#8ee0b0">SUB-SURFACE LIQUID · CONSISTENT</text>
  <text x="6" y="82" fill="#ff9d6e">HEAT SOURCE  INTERNAL · 4 POINTS</text>
  <text x="6" y="102">MAGNETOSPHERE  NEGLIGIBLE</text>
  <text x="6" y="122" fill="#8ee0b0">RADIATION    BACKGROUND ONLY</text></g></g>
<g transform="translate(1236,832)">
 <rect x="-10" y="-20" width="404" height="150" rx="6" fill="#070c16" stroke="#22344f" opacity=".93"/>
 <text x="6" y="0" fill="#6f8aa4" font-size="12" letter-spacing="1">ORIGIN</text>
 <g font-size="12" fill="#93a6bd" font-family="monospace">
  <text x="6" y="22">1 pc from Arabus · 3 pc from WALSTON 1232</text>
  <text x="6" y="42">both worlds 3 pc out, same bearing</text>
  <text x="6" y="62">ejection ~2 km/s · one event</text>
  <text x="6" y="82" fill="#e0c07e">THEY LEFT TOGETHER.</text>
  <text x="6" y="112" fill="#8ee0b0">ARS TASK  mine ice · melt · electrolyze</text></g></g>
<text x="1620" y="1012" text-anchor="end" fill="#3f5268" font-size="12">no belts · no torus · nothing is aimed at you</text>
</svg>`;
};

const SYS = (fuel, sens, jump, jlabel) => [
  { key: 'hull', label: 'Hull', value: 100 },
  { key: 'power', label: 'Power Plant', value: 100 },
  { key: 'fuel', label: 'Fuel', value: fuel },
  { key: 'sensors', label: sens[0], value: sens[1] },
  { key: 'jump', label: jlabel, value: jump },
];
const STATES = [
  ['nominal', 'ISS Astral Dawn — all stations nominal', SYS(71, ['Sensors (upgraded)', 100], 100, 'Jump Calibration')],
  ['interference', 'ISS Astral Dawn — EM interference', SYS(71, ['Sensors (degraded — EM noise)', 62], 100, 'Jump Calibration')],
  ['dm2', 'ISS Astral Dawn — approaching interaction zone', SYS(70, ['Sensors (heavy interference)', 45], 75, 'Jump Calibration (DM-2)')],
  ['dm4', 'ISS Astral Dawn — INSIDE the interaction zone', SYS(70, ['Sensors (active only at close range)', 30], 45, 'Jump Calibration (DM-4) ⚠')],
  ['dm6', 'ISS Astral Dawn — DEEP ZONE ⚠ JUMP UNSAFE', SYS(69, ['Sensors (blind beyond 1,000 km)', 15], 12, 'Jump Calibration (DM-6) — DO NOT JUMP')],
];

const beats = [];
for (const [id, title, subtitle, body, image, target] of B) {
  const opts = { title, body };
  if (subtitle) opts.subtitle = subtitle;
  if (image) opts.image = image;
  const b = { id, component: 'card', opts };
  if (target) b.target = target;
  beats.push(b);
}
// Section 6 rendered BLANK with the `ship-status` component (S210, observed live). Render the
// five states as cards carrying the shipDash SVG instead — richer, animated, and it shows the
// whole state machine with the current rung lit, so the table sees where this is heading.
// --- STATION CONSOLES -------------------------------------------------------------------
// One full-width controls ROW per role, delivered ONLY to that seat (beat.target = the seat
// slug, which is why the login chart's u= values are load-bearing). Each tile is a control or
// readout that station actually owns, colour-coded, with its own LED phase so the row looks
// live rather than printed.
function station({ name, operator, accent, tiles, strip }) {
  const W = 660, H = 250, n = tiles.length;
  const tw = Math.floor((W - 24 - (n - 1) * 8) / n);
  const cells = tiles.map((t, i) => {
    const x = 12 + i * (tw + 8);
    const c = t.c || OK;
    return `<rect x='${x}' y='58' width='${tw}' height='128' rx='6' fill='rgb(9,14,26)' stroke='rgb(30,44,70)'/>
<rect x='${x}' y='58' width='${tw}' height='3' rx='2' fill='${c}' opacity='.8'/>
${led(x + tw - 14, 74, c, (2.2 + i * 0.6).toFixed(1))}
<text x='${x + 12}' y='84' fill='rgb(120,145,175)' font-family='monospace' font-size='9'>${t.k}</text>
<text x='${x + 12}' y='112' fill='${c}' font-family='monospace' font-size='15'>${t.v}</text>
<text x='${x + 12}' y='134' fill='rgb(150,170,200)' font-family='monospace' font-size='9'>${t.s || ''}</text>
<text x='${x + 12}' y='152' fill='rgb(96,120,150)' font-family='monospace' font-size='8'>${t.n || ''}</text>
<text x='${x + 12}' y='170' fill='rgb(96,120,150)' font-family='monospace' font-size='8'>${t.n2 || ''}</text>`;
  }).join('');
  return S(`<rect width='${W}' height='${H}' fill='rgb(4,6,14)'/>
<rect x='0' y='0' width='${W}' height='40' fill='rgb(9,14,26)'/>
<rect x='0' y='0' width='5' height='40' fill='${accent}'/>
<text x='18' y='26' fill='${accent}' font-family='monospace' font-size='15' letter-spacing='2'>${name}</text>
<text x='${W - 16}' y='26' fill='rgb(120,145,175)' font-family='monospace' font-size='11' text-anchor='end'>${operator}</text>
${cells}
<rect x='12' y='198' width='${W - 24}' height='34' rx='5' fill='rgb(8,12,22)' stroke='rgb(26,38,60)'/>
<text x='24' y='219' fill='rgb(150,170,200)' font-family='monospace' font-size='10'>${strip}</text>
${led(W - 26, 215, accent, '2.8')}`, W, H);
}

const STATIONS = [
  { id: 'st-james', target: 'james', name: 'COMMAND', operator: 'CAPT. J. DELLERON', accent: 'rgb(150,190,255)',
    title: 'Command Station', body: 'Your board. Nobody else sees this.',
    strip: 'STANDING ORDERS: survey and assess. Loss of one ARS unit is acceptable — the data is the mission.',
    tiles: [
      { k: 'SHIP STATE', v: 'NOMINAL', s: 'all stations green' },
      { k: 'ARS UNITS', v: '2 / 2', s: 'in the jump net', n: 'loss of 1 acceptable' },
      { k: 'CREW', v: '8 + 8', s: 'crew + marines', n: 'watch bill current' },
      { k: 'DISCRETION', v: 'AUTHORIZED', s: 'per Cassian Holt', n: 'scientific latitude', c: WARN },
      { k: 'JSI CHANNEL', v: 'DARK', s: 'no traffic', n: '1 pc = 1 week', c: DIM },
    ] },
  { id: 'st-marina', target: 'marina', name: 'GUNNERY · REMOTE OPS', operator: 'M. DEVEILLTER', accent: 'rgb(255,190,110)',
    title: 'Gunnery Station', body: 'Your board. Nobody else sees this.',
    strip: 'BARBETTES ARE OFFENCE ONLY — they cannot point-defend. Sand is your defence.',
    tiles: [
      { k: 'BARBETTE 1', v: 'PARTICLE', s: 'HY + IF', n: 'yours', n2: 'READY' },
      { k: 'BARBETTE 2', v: 'ION', s: 'HY + LR', n: 'Anemone', n2: 'READY' },
      { k: 'TURRETS', v: '2 + 2', s: 'visible / hidden', n: 'AI gunners FC/4' },
      { k: 'SANDCASTER', v: 'FULL', s: 'all racks', n: 'incl. ferromagnetic', n2: 'the obsolete ones', c: WARN },
      { k: 'DRONES', v: '6 + 1', s: 'AI units + Anemone', n: 'remote ops nominal' },
    ] },
  { id: 'st-vonsydo', target: 'vonsydo', name: 'SENSORS · EW', operator: 'VON SYDO', accent: 'rgb(120,235,190)',
    title: 'Sensor Station', body: 'Your board. Nobody else sees this.',
    strip: 'PSI: unregistered. Nothing you sense that way exists in the ship log.',
    tiles: [
      { k: 'ARRAY', v: 'TL-15', s: 'advanced + EAG', n: 'best in the corridor' },
      { k: 'ACTIVE SCAN', v: 'READY', s: 'ping to classify', n: 'announces you' },
      { k: 'EW SUITE', v: 'ECM/ECCM', s: 'jamming available', n: 'TL gap vs 10-12' },
      { k: 'ZONE', v: 'UNCLASSIFIED', s: 'no model match', n: 'confidence LOW', c: WARN },
      { k: 'PSI', v: 'ILLEGAL', s: 'unlogged', n: 'Vera trained', c: CRIT },
    ] },
  { id: 'st-max', target: 'max', name: 'ENGINEERING', operator: 'M. PLANCK', accent: 'rgb(190,150,255)',
    title: 'Engineering Station', body: 'Your board. Nobody else sees this.',
    strip: 'POWER PLANT IS AT EXACTLY 300 OF 300. There is no margin. Any loss is triage, not repair.',
    tiles: [
      { k: 'POWER PLANT', v: '300 / 300', s: 'zero margin', n: 'any loss = triage', c: WARN },
      { k: 'J-DRIVE', v: 'J-3', s: 'rated', n: 'J-4 override:', n2: 'EXPERIMENTAL', c: WARN },
      { k: 'M-DRIVE', v: 'THRUST 3', s: 'nominal' },
      { k: 'FUEL', v: '71', s: 'percent', n: 'skimmable quiet side' },
      { k: 'FAB CHAMBER', v: 'ONLINE', s: 'inventory current', n: 'build the fix' },
    ] },
  { id: 'st-asao', target: 'asao', name: 'MARINE DETACHMENT', operator: 'CDR. A. ORA', accent: 'rgb(255,140,120)',
    title: 'Marine Station', body: 'Your board. Nobody else sees this.',
    strip: 'RADIATION BELT IS HARD. EVA PROHIBITED inside it — that is a hull problem, not a suit problem.',
    tiles: [
      { k: 'DETACHMENT', v: '8', s: 'Reyes has the watch', n: 'Henriksen · Woo-Park' },
      { k: 'FIRE TEAMS', v: 'A / B', s: 'on rotation' },
      { k: 'EVA', v: 'STAGED', s: 'both locks', n: 'belt = PROHIBITED', c: WARN },
      { k: 'YOUR PLATE', v: 'PROT 20', s: 'powered', n: 'crew rescue suits 14' },
      { k: 'G-CARRIER', v: 'STOWED', s: 'in the pinnace', n: 'squad + heavy wpns' },
    ] },
];
for (const st of STATIONS) {
  beats.push({ id: st.id, component: 'card', target: st.target,
    opts: { title: st.title, body: st.body, imageAlt: st.name,
      image: station({ name: st.name, operator: st.operator, accent: st.accent, tiles: st.tiles, strip: st.strip }) } });
}

const STATE_DEFS = [
  { id: 'nominal', stateIdx: 0, fuel: 71, sensors: 100, sensNote: 'UPGRADED TL-15', jump: 100, jumpNote: 'NOMINAL',
    banner: 'ALL STATIONS NOMINAL', bannerColor: OK,
    title: 'ISS Astral Dawn — All Stations Nominal',
    body: 'Everything green. Fuel at 71.\n\nThe power plant reads 300 of 300 — which is not headroom, it is the absence of headroom. There is no margin to lose.\n\nThis is the baseline. Remember what it looks like.' },
  { id: 'interference', stateIdx: 1, fuel: 71, sensors: 62, sensNote: 'EM NOISE', jump: 100, jumpNote: 'NOMINAL',
    banner: 'EM INTERFERENCE', bannerColor: WARN,
    title: 'ISS Astral Dawn — EM Interference',
    body: 'Sensors down to 62 and drifting. The noise is not random — it has structure, and the structure moves.\n\nJump calibration still clean. Drives clean. Nothing is wrong yet.\n\nThis is the last state you can leave from without thinking about it.' },
  { id: 'dm2', stateIdx: 2, fuel: 70, sensors: 45, sensNote: 'HEAVY INTERFERENCE', jump: 75, jumpNote: 'DM-2',
    banner: 'APPROACHING ZONE · DM-2', bannerColor: WARN,
    title: 'ISS Astral Dawn — Approaching the Interaction Zone',
    body: 'Sensors 45. Jump calibration has taken its first bite: DM-2.\n\nSandoval logged exactly this number on her third day, noted it, and proceeded.\n\nThe ship will still jump. It will just be worse at it.' },
  { id: 'dm4', stateIdx: 3, fuel: 70, sensors: 30, sensNote: 'CLOSE RANGE ONLY', jump: 45, jumpNote: 'DM-4',
    banner: 'INSIDE THE ZONE · DM-4', bannerColor: CRIT,
    title: 'ISS Astral Dawn — Inside the Interaction Zone',
    body: 'Sensors are close-range only. Jump calibration DM-4.\n\nThe field geometry outside is reorganising faster than the computer can model it, and the computer has stopped offering classifications.\n\nEvery minute here costs calibration you cannot buy back quickly.' },
  { id: 'dm6', stateIdx: 4, fuel: 69, sensors: 15, sensNote: 'BLIND BEYOND 1000 KM', jump: 12, jumpNote: 'DM-6 — DO NOT JUMP',
    banner: 'DEEP ZONE · JUMP UNSAFE', bannerColor: CRIT,
    title: 'ISS Astral Dawn — DEEP ZONE · JUMP UNSAFE',
    body: 'Blind beyond a thousand kilometres. Jump calibration DM-6.\n\nThis is the number in Sandoval\'s final entry. She could not safely jump from this position either.\n\nShe tried anyway.' },
];
for (const s of STATE_DEFS) {
  beats.push({ id: s.id, component: 'card', opts: { title: s.title, body: s.body, image: shipDash(s), imageAlt: s.banner } });
}
// Progressive reveal: the map only ever shows what the crew has observed. Cue the later
// variants AFTER the beat that earns them (alpha-lost, then beacon).
for (const [id, label, flags] of [
  ['navmap',        'ARABUS 1235 — system plot · drag the ship to set course', {}],
  ['navmap-alpha',  'ARABUS 1235 — after Probe Alpha is lost',                 { alpha: true }],
  ['navmap-beacon', 'ARABUS 1235 — artificial signal located',                 { alpha: true, beacon: true }],
  ['navmap-probes', 'ARABUS 1235 — probes away, tracks running',              { probes: true }],
]) beats.push({ id, component: 'navmap', opts: { label, svg: navmapSvg(flags), controllable: true, laser: true, cursors: 'all',
  // AD at 120 AR, bearing -28 deg, expressed as content-box fractions of the 1680x1050 viewBox.
  tokenId: 'ship-ad', tokenLabel: 'ISS ASTRAL DAWN', tokenPx: 0.654, tokenPy: 0.345 } });

beats.push({ id: 'recover', component: 'choice', opts: { prompt: 'The beacon is deep in the zone. How do we recover it?', promptId: 'recovery', options: [
  { label: 'Shielded probe + grappler (slow, safe)', value: 'drone' },
  { label: 'Armored pinnace, crewed run (fast, risky)', value: 'pinnace' },
  { label: 'Take the Dawn closer (jump degradation)', value: 'ad' }] } });
beats.push({ id: 'captain', component: 'choice', opts: { prompt: "The magnetosphere is inhabited. The mission called for an ARS deployment. Captain's call:", promptId: 'aftermath', options: [
  { label: 'Deploy ARS in the quiet hemisphere', value: 'quiet' },
  { label: 'Learn more before deploying anything', value: 'learn' },
  { label: 'Abort Arabus — report back', value: 'abort' }] } });


beats.push({ id: 'jumpspace', component: 'card', opts: {
  title: 'Jumpspace',
  body: "Seven days. No stars, no bearing, no outside.\n\nThe sensors return nothing because there is nothing out there to return anything — not darkness, which is a thing you can measure, but absence.\n\nThe drive holds the bubble. The bubble holds you. Nobody has ever satisfactorily explained what is on the other side of it, and the crews who go looking do not come back to argue the point.",
  image: ART.jumpspace, imageAlt: 'Jumpspace — featureless field, ship in its bubble' } });

beats.push({ id: 'probe-rad', component: 'card', opts: {
  title: 'Probe One — Radiation Mapping',
  body: "Inbound to the Arabus\u2013Typhon interaction, mapping the belt structure the crew has to fly through.\n\nThe outer contours map cleanly. Close in, the readings stop agreeing with the model \u2014 not noisily, which would mean bad data, but coherently, which does not have a comfortable explanation.\n\nThe contours near the probe are not holding their shape.",
  image: ART.probeRad, imageAlt: 'Radiation mapping probe; local contours deforming' } });
beats.push({ id: 'probe-debris', component: 'card', opts: {
  title: 'Probe Two — Debris Field Survey',
  body: "Eight hundred radii out, working a volume nobody has ever had a reason to look at closely.\n\nThis is slow work. Eleven hundred objects examined, eleven hundred and seventy-one of them nothing at all. Six percent coverage.\n\nThree flagged. Pending.",
  image: ART.probeDebris, imageAlt: 'Slow wide survey of the debris field, mostly null returns' } });
beats.push({ id: 'iceteroid', component: 'card', opts: {
  title: 'Object 1174-C',
  body: "Dirty water ice, thirty-four percent silicate. Usable, in the sense that a thing can be usable and still be a bad idea.\n\nProcessing would be slow and hard on the plant \u2014 the plant that is already at three hundred of three hundred.\n\nVerdict: viable. Barely.",
  image: ART.iceteroid, imageAlt: 'A dirty ice body, marginal fuel value' } });

beats.push({ id: 'rad-corridor', component: 'card', opts: {
  title: 'Radiation Structure — Locked to Typhon',
  body: "The hard radiation is not a shell. It is a pair of lobes strung along the line between Arabus and Typhon, and it turns as the moon turns.\n\nWhich means the safe line turns too. Weakest dose lies ninety degrees off the moon \u2014 a corridor you can fly, if you keep recomputing where it is.\n\nThe zone is not fully resolved. This is the shape of it, not the map of it.",
  image: ART.radCorridor, imageAlt: 'Radiation lobes along the Arabus-Typhon axis; minima at 90 degrees' } });

beats.push({ id: 'plasma-attack', component: 'card', opts: {
  title: 'Discharge — Inbound',
  body: "The zone lets go. Not a flare, not a reconnection event \u2014 a collimated column of plasma that crosses the gap and finds the hull.\n\nThen a second. Then a third, from a different bearing, corrected.\n\nCoherence reads point nine four. Natural discharge scatters; whatever this is holds its beam. The computer offers no natural fit.",
  image: ART.plasmaAttack, imageAlt: 'Collimated plasma beams striking the Astral Dawn' } });
beats.push({ id: 'under-fire', component: 'card', opts: {
  title: 'ISS Astral Dawn — UNDER FIRE',
  body: "Hull holding. The plant is the problem \u2014 it was at three hundred of three hundred before anyone started shooting.\n\nSensors are washing out in the discharge. Jump calibration is going with them.",
  image: shipDash({ stateIdx: 3, fuel: 69, sensors: 22, sensNote: 'WASHED OUT', jump: 38, jumpNote: 'DM-4 · DEGRADING',
    banner: 'UNDER FIRE · PLASMA', bannerColor: CRIT }),
  imageAlt: 'Ship dashboard under plasma fire' } });

beats.push({ id: 'marina-fires', component: 'card', target: 'marina', opts: {
  title: 'Gunnery — Special Load',
  body: "You have been carrying these since before anyone thought they mattered. High-ferromagnetic particulate, logged obsolete, never once requisitioned.\n\nWhatever is steering that plasma is doing it with a magnetic field. Sand does not care what is aiming it. It only cares that something is.\n\nRacks full. Your call.",
  image: ART.marinaSand, imageAlt: 'Ferromagnetic sand deploying across the beam path' } });

beats.push({ id: 'nyrthus-map', component: 'navmap', opts: {
  label: 'NYRTHUS 1135 — system plot · drag the ship to set course',
  svg: nyrthusSvg(), controllable: true, laser: true, cursors: 'all',
  tokenId: 'ship-ad', tokenLabel: 'ISS ASTRAL DAWN', tokenPx: 0.697, tokenPy: 0.344 } });
beats.push({ id: 'nyrthus-arrival', component: 'card', opts: {
  title: 'Nyrthus — Emergence',
  body: "One parsec. Seven days. You come out of jump into the quietest place any of you have ever been.\n\nNo magnetosphere worth the name. No belts. Background radiation and nothing else. A ball of water ice at fifty-one kelvin, turning slowly in the dark, with four warm places under its shell.\n\nNothing here is aimed at you. After Arabus, the crew will take a while to believe that.",
  image: ART.jumpspace, imageAlt: 'Arrival at Nyrthus after a one-parsec jump' } });

beats.push({ id: 'triangulation', component: 'card', opts: {
  title: 'Reconstruction — Two Baselines',
  body: "The skimming probe died with its data scrambled. The watcher at twelve radii lived, and it was sitting ninety degrees off the ship's line.\n\nTwo viewpoints that far apart do not just confirm each other. They intersect. Every bearing that was unresolved becomes a point.\n\nThree points. Widely separated. And not one of them is where you have all been looking.",
  image: ART.triangulation, imageAlt: 'Two orthogonal baselines resolving three source loci' } });

const SECTIONS = [
    { id: 'home',    title: '0 · Home (default)',            beatIds: ['home'] },
    { id: 'ship',    title: '0b · Ship & instruments (reusable)', beatIds: ['bridge','scan','sysmap','navmap','navmap-probes','navmap-alpha','navmap-beacon'] },
    { id: 'act1',    title: '1 · Arrival & First Survey',    beatIds: ['emergence','sphere','typhon','probes','alpha-lost'] },
    { id: 'act2',    title: "2 · The Navy's Breadcrumbs",    beatIds: ['record','then-and-now','rhythms'] },
    { id: 'act3',    title: '3 · The Probe',                 beatIds: ['beacon','zone','recover','log-1','log-2','log-3','log-4','static','captain'] },
    { id: 'act4',    title: '4 · The Museum',                beatIds: ['metal','museum','its-a-museum'] },
    { id: 'stations', title: '5a · STATION CONSOLES (per role)',  beatIds: ['st-james','st-marina','st-vonsydo','st-max','st-asao'] },
    { id: 'private', title: '5b · Private beats / per-PC',       beatIds: ['marina-sand','vonsydo-pressure','vonsydo-forest','max-anomaly','james-orders','asao-eva'] },
    { id: 'states',  title: '6 · Ship states',               beatIds: ['nominal','interference','dm2','dm4','dm6','jumpspace'] },
    { id: 'live',    title: '7 · LIVE (this session)',       beatIds: ['probe-rad','probe-debris','rad-corridor','iceteroid','plasma-attack','marina-fires','under-fire','nyrthus-arrival','nyrthus-map','triangulation'] },
  ];

// ORDERING INVARIANT (S210): beats were being APPENDED in build order while being SLOTTED into
// early sections, so the array order drifted from the outline order — navmap ended up at index
// 38 inside section "0b", and stepping sequentially skipped it entirely. Sort the array into
// section order so the two can never disagree again. Anything not in a section keeps its place
// at the end (and the orphan check below will catch it).
{
  const order = new Map();
  let i = 0;
  for (const sec of SECTIONS) for (const bid of (sec.beatIds || [])) if (!order.has(bid)) order.set(bid, i++);
  const rank = (b) => (order.has(b.id) ? order.get(b.id) : 10000 + beats.indexOf(b));
  beats.sort((a, b) => rank(a) - rank(b));
  const listed = new Set(order.keys());
  const orphans = beats.filter((b) => !listed.has(b.id)).map((b) => b.id);
  const missing = [...listed].filter((id) => !beats.some((b) => b.id === id));
  if (orphans.length) console.log('  ! orphan beats (in NO section):', orphans.join(' '));
  if (missing.length) console.log('  ! section lists unknown beat ids:', missing.join(' '));
}

const module_ = {
  manifest: { title: "S15 CATALOG · lightweight (use this)", version: '1.0.0', kind: 'session',
    summary: 'CATALOG (not a deck): every beat named and independently showable. Players choose the order. Built S210.',
    defaultBeatId: 'home' },
  // control.html renderOutline() builds the clickable ToC from sections[].beatIds — a section
  // WITHOUT beatIds renders as an empty, unclickable header. Declare them explicitly.
  sections: SECTIONS,

  beats,
};
writeFileSync(join(AP, 'modules', 's15-live.json'), JSON.stringify(module_));

// ------------------------------------------------- FALLBACK LAYER 3 ---------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rows = beats.map((b) => {
  const o = b.opts || {};
  const words = o.body || (o.prompt ? o.prompt + '\n' + (o.options || []).map((x) => '  • ' + x.label).join('\n') : '');
  return { id: b.id, title: o.title || o.prompt || b.id, sub: o.subtitle || '', target: b.target || 'all', words, art: !!o.image, kind: b.component };
});

writeFileSync(join(AP, 's15-cuesheet.md'),
  `# S15 — The Dragon's World · CUE SHEET\n\nFallback layer 3: needs no server, no Argus, no network.\n` +
  `Say the cue to Argus, or click it in control.html, or paste the words into Discord.\n\n` +
  rows.map((r) => `## \`${r.id}\`${r.target !== 'all' ? `  → **${r.target} ONLY**` : ''}\n**${r.title}**${r.sub ? ` — *${r.sub}*` : ''}\n\n${r.words}\n`).join('\n---\n\n'));

writeFileSync(join(AP, 's15-catalog.html'),
`<!doctype html><meta charset="utf-8"><title>S15 — The Dragon's World · Catalog</title>
<style>
:root{color-scheme:dark light;--bg:#080b14;--fg:#e6ecf6;--dim:#8f9fb8;--line:#1e2942;--acc:#5ec8ff;--hot:#ff8a72}
@media(prefers-color-scheme:light){:root{--bg:#fbfaf7;--fg:#161a22;--dim:#5a6577;--line:#dfe3ea;--acc:#0b6ea8;--hot:#b4432c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}
header{padding:22px 26px;border-bottom:1px solid var(--line)}h1{margin:0;font-size:19px;letter-spacing:.02em}
p.sub{margin:6px 0 0;color:var(--dim);font-size:13px}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px;padding:20px 26px}
section{border:1px solid var(--line);border-radius:8px;padding:14px 16px;background:color-mix(in srgb,var(--fg) 3%,transparent)}
code.cue{font:12px ui-monospace,monospace;color:var(--acc);border:1px solid var(--line);border-radius:4px;padding:2px 7px;cursor:pointer}
code.cue:hover,code.cue:focus{border-color:var(--acc);outline:none}
h2{margin:10px 0 2px;font-size:15px}em.sp{color:var(--dim);font-style:normal;font-size:12px}
pre{white-space:pre-wrap;font:13px/1.5 ui-sans-serif,system-ui,sans-serif;margin:9px 0 0;color:var(--fg)}
.tgt{float:right;font:11px ui-monospace,monospace;color:var(--hot);border:1px solid var(--hot);border-radius:4px;padding:1px 6px}
.art{font:11px ui-monospace,monospace;color:var(--dim)}
</style>
<header><h1>S15 — The Dragon's World · Catalog</h1>
<p class="sub">${rows.length} beats. Players choose the order. Click a cue to copy it. Works offline — no server, no network.</p></header>
<main>${rows.map((r) => `<section><code class="cue" tabindex="0">${esc(r.id)}</code>${r.target !== 'all' ? `<span class="tgt">${esc(r.target)} only</span>` : ''}
<h2>${esc(r.title)}</h2>${r.sub ? `<em class="sp">${esc(r.sub)}</em>` : ''}
<pre>${esc(r.words)}</pre>${r.art ? '<p class="art">▸ animated graphic</p>' : ''}</section>`).join('\n')}</main>
<script>document.querySelectorAll('code.cue').forEach(function(c){c.addEventListener('click',function(){navigator.clipboard&&navigator.clipboard.writeText(c.textContent);var t=c.textContent;c.textContent='copied';setTimeout(function(){c.textContent=t},700)})})</script>`);

const kb = (p) => (JSON.stringify(module_).length / 1024).toFixed(0);
console.log(`modules/s15-live.json   ${beats.length} beats, ${kb()} KB`);
console.log(`s15-catalog.html        offline catalog`);
console.log(`s15-cuesheet.md         Discord copy/paste`);
console.log(`\nCUES (${beats.length}):`);
console.log(beats.map((b) => b.id).join('  '));
