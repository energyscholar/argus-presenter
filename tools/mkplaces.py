#!/usr/bin/env python3
"""Places and hardware plates for S18/S19 — the beats Bruce asked for that were missing:
central city structure, the planetoids, the engagement, and Zgounder."""
import math, random
from mkhelpers import frame, stars, title, MONO


# ── ALPHA: the settlement, structurally ─────────────────────────────────────────
def alpha_city():
    random.seed(3001); p=[]
    p.append('<rect x="-500" y="-500" width="1000" height="1000" fill="#0a0d13"/>')
    p.append('<defs><linearGradient id="reg" x1="0" y1="0" x2="0" y2="1">'
             '<stop offset="0" stop-color="#1a2230"/><stop offset="1" stop-color="#0e131c"/></linearGradient></defs>')
    # the buried town: a warren under regolith, because there is no atmosphere
    p.append('<rect x="-470" y="-150" width="940" height="70" fill="#20262f"/>')
    for _ in range(120):
        x=random.uniform(-470,470); y=random.uniform(-148,-84)
        p.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{random.uniform(1,5):.1f}" fill="#2b323c" opacity=".7"/>')
    p.append('<text x="-460" y="-160" fill="#5f7086" font-family="{}" font-size="11">REGOLITH — 4 m of it, and it is the radiation shielding</text>'.format(MONO))
    # surface: pads + the mast
    for x,w,lbl in [(-390,120,"PAD 1"),(-230,150,"PAD 2 · long-haul"),(-40,110,"PAD 3"),(110,90,"PAD 4"),(240,150,"IISS PAD")]:
        p.append(f'<rect x="{x}" y="-176" width="{w}" height="8" fill="#39434f" stroke="#5a6675" stroke-width="1"/>')
        p.append(f'<text x="{x+w/2:.0f}" y="-186" fill="#7ec8a0" font-family="{MONO}" font-size="9.5" text-anchor="middle">{lbl}</text>')
    p.append('<line x1="420" y1="-176" x2="420" y2="-300" stroke="#4a5768" stroke-width="2.5"/>')
    p.append('<circle cx="420" cy="-306" r="5" fill="#e05252"/>')
    p.append(f'<text x="410" y="-318" fill="#8e9bb0" font-family="{MONO}" font-size="10" text-anchor="end">comms mast</text>')
    # the levels
    LV = [(-60, "LEVEL 1 — PORT",   ["customs","freight hall","the ONE bar","bunkrooms"], "#f0b429"),
          (60,  "LEVEL 2 — TOWN",   ["market","school (31 children)","clinic","council room"], "#7ec8a0"),
          (180, "LEVEL 3 — WORKS",  ["fabrication","water plant","hydroponics","power"], "#4a9fd8"),
          (300, "LEVEL 4 — IISS",   ["scout berths","the ARRAY (EV2)","records","sealed"], "#9b8bd4")]
    for y,name,rooms,col in LV:
        p.append(f'<rect x="-440" y="{y}" width="880" height="86" rx="4" fill="url(#reg)" stroke="{col}" stroke-width="1.2" opacity=".95"/>')
        p.append(f'<text x="-428" y="{y+20}" fill="{col}" font-family="{MONO}" font-size="12.5" letter-spacing="1">{name}</text>')
        for i,r in enumerate(rooms):
            rx=-420+i*218
            p.append(f'<rect x="{rx}" y="{y+30}" width="200" height="42" rx="3" fill="#141b26" stroke="#28323f" stroke-width="1"/>')
            p.append(f'<text x="{rx+100}" y="{y+56}" fill="#a8b4c4" font-family="{MONO}" font-size="11" text-anchor="middle">{r}</text>')
        p.append(f'<line x1="0" y1="{y+86}" x2="0" y2="{y+120 if y<300 else y+86}" stroke="#3a4553" stroke-width="3"/>')
    p.append(title("ALPHA — THE SETTLEMENT", "3,000 people, four levels, one bar. No sky.", "#f0b429"))
    p.append(f'<text x="-470" y="452" fill="#8e9bb0" font-family="{MONO}" font-size="12">'
             'Everyone knows everyone. A stranger asking questions is the day’s news by supper.</text>')
    p.append(f'<text x="-470" y="470" fill="#5f7086" font-family="{MONO}" font-size="11.5">'
             '⛔ NOBODY HERE KNOWS ABOUT THE PIRATES. Alpha is clean. The fragments live outside.</text>')
    return frame("".join(p))


# ── EPSILON: the Darrian ruin ───────────────────────────────────────────────────
def epsilon():
    random.seed(3002); p=[stars(3002, 130, 0)]
    p.append('<path d="M-500,250 Q-200,150 60,190 Q340,232 500,300 L500,500 L-500,500 Z" fill="#2a2f38"/>')
    p.append('<path d="M-500,250 Q-200,150 60,190 Q340,232 500,300" fill="none" stroke="#4b5566" stroke-width="1.5"/>')
    for _ in range(30):
        cx=random.uniform(-470,470); cy=random.uniform(280,470); r=random.uniform(8,40)
        p.append(f'<ellipse cx="{cx:.0f}" cy="{cy:.0f}" rx="{r:.0f}" ry="{r*.4:.0f}" fill="#1a1f27" opacity=".6"/>')
    # the outpost: geometric, half-buried, two thousand years of dust
    cx,cy=0,270
    p.append(f'<g opacity=".95">')
    for i,(rr,rot,op) in enumerate([(150,0,.55),(104,18,.7),(62,36,.85)]):
        pts=[]
        for k in range(6):
            a=math.radians(60*k+rot); pts.append(f"{cx+rr*math.cos(a):.0f},{cy+rr*math.sin(a)*.42:.0f}")
        p.append(f'<polygon points="{" ".join(pts)}" fill="none" stroke="#8fa8c8" stroke-width="1.6" opacity="{op}"/>')
    p.append('</g>')
    p.append(f'<circle cx="{cx}" cy="{cy}" r="14" fill="#8fa8c8" opacity=".5"/>')
    p.append(f'<circle cx="{cx}" cy="{cy}" r="26" fill="none" stroke="#8fa8c8" stroke-width="1" opacity=".4"/>')
    # the dig camp
    for dx in (-215, -168, 205):
        p.append(f'<rect x="{dx}" y="300" width="34" height="20" rx="3" fill="#1d2733" stroke="#7ec8a0" stroke-width="1.2"/>')
    p.append('<path d="M-160,312 L-40,286" stroke="#7ec8a0" stroke-width="1" stroke-dasharray="3 4" opacity=".7"/>')
    p.append(title("EPSILON — THE DARRIAN OUTPOST", "2,000 years old · an archaeological expedition lives here", "#8fa8c8"))
    p.append(f'<text x="-470" y="452" fill="#7ec8a0" font-family="{MONO}" font-size="12">'
             'Dr. Sabine Kuru, field director. Furious, not frightened. → EV4</text>')
    p.append(f'<text x="-470" y="470" fill="#8e9bb0" font-family="{MONO}" font-size="11.5">'
             '"It flew a grid. Nobody flies a grid by accident."</text>')
    return frame("".join(p))


# ── THE RINGS: ice, and someone else's cuts ─────────────────────────────────────
def rings():
    random.seed(3003); p=[stars(3003, 90, 0)]
    p.append('<defs><linearGradient id="gg3" x1="0" y1="0" x2="1" y2="1">'
             '<stop offset="0" stop-color="#c99257"/><stop offset="1" stop-color="#6d3f16"/></linearGradient></defs>')
    p.append('<ellipse cx="-330" cy="120" rx="300" ry="300" fill="url(#gg3)" opacity=".9"/>')
    for i in range(9):
        y=-210+i*74; op=.5 if i%2 else .28
        p.append(f'<ellipse cx="80" cy="{y}" rx="620" ry="{9+i*1.4:.0f}" fill="#9aa7b8" opacity="{op*.5:.2f}"/>')
    for _ in range(260):
        x=random.uniform(-500,500); band=random.choice([-210,-136,-62,12,86,160,234])
        y=band+random.uniform(-9,9)
        p.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{random.uniform(.7,3.1):.1f}" fill="#cfe0f5" opacity="{random.uniform(.25,.85):.2f}"/>')
    # the cut face — clean, industrial, unfiled
    p.append('<g transform="translate(230,86)">')
    p.append('<path d="M-70,-30 L40,-44 L74,4 L28,46 L-58,34 Z" fill="#7f8ea3" stroke="#cfe0f5" stroke-width="1.4"/>')
    p.append('<path d="M-58,34 L28,46 L74,4" fill="none" stroke="#f0b429" stroke-width="2.4"/>')
    p.append('<text x="92" y="4" fill="#f0b429" font-family="{}" font-size="12">CUT FACE</text>'.format(MONO))
    p.append('<text x="92" y="20" fill="#8e9bb0" font-family="{}" font-size="10.5">clean · industrial · months old</text>'.format(MONO))
    p.append('<text x="92" y="35" fill="#8e9bb0" font-family="{}" font-size="10.5">no claim filed</text>'.format(MONO))
    p.append('</g>')
    p.append(title("BOWMAN PRIME — THE RINGS", "ice, mined occasionally · free fuel · and somebody else has been here", "#8fc4e8"))
    p.append(f'<text x="-470" y="466" fill="#7ec8a0" font-family="{MONO}" font-size="12">'
             'Tobiah Vance works these faces. He calls it claim-jumping. → EV1</text>')
    return frame("".join(p))


# ── BELT II: the working belt ───────────────────────────────────────────────────
def belt2():
    random.seed(3004); p=[stars(3004, 150, 0)]
    for _ in range(20):
        cx=random.uniform(-460,460); cy=random.uniform(-380,420); r=random.uniform(16,78)
        p.append(f'<ellipse cx="{cx:.0f}" cy="{cy:.0f}" rx="{r:.0f}" ry="{r*random.uniform(.55,.9):.0f}" '
                 f'fill="#4e5764" opacity="{random.uniform(.5,.9):.2f}"/>')
        p.append(f'<ellipse cx="{cx-r*.3:.0f}" cy="{cy-r*.3:.0f}" rx="{r*.4:.0f}" ry="{r*.28:.0f}" fill="#6b7684" opacity=".4"/>')
    # a worked rock: lights, a cut, a docked hull
    p.append('<g transform="translate(-60,60)">')
    p.append('<ellipse cx="0" cy="0" rx="150" ry="112" fill="#565f6c"/>')
    p.append('<ellipse cx="-40" cy="-34" rx="58" ry="40" fill="#6d7886" opacity=".55"/>')
    p.append('<rect x="-28" y="-116" width="56" height="14" rx="2" fill="#2b3440" stroke="#7ec8a0" stroke-width="1.2"/>')
    for lx in (-70,-24,26,72):
        p.append(f'<circle cx="{lx}" cy="-98" r="2.6" fill="#ffe6a8"/>')
    p.append('<path d="M-150,10 L-96,-6 L-92,26 L-146,40 Z" fill="#3a434f" stroke="#8e9bb0" stroke-width="1"/>')
    p.append('</g>')
    p.append('<g transform="translate(150,-140) rotate(-12)"><path d="M-40,0 L22,-9 L48,0 L22,9 Z" fill="#1b2534" stroke="#7ec8a0" stroke-width="1.4"/></g>')
    p.append(title("BELT II — THE WORKING BELT", "1.6 AU · where the belters actually are · Doc Merisi rides a circuit", "#9aa7b8"))
    p.append(f'<text x="-470" y="466" fill="#7ec8a0" font-family="{MONO}" font-size="12">'
             '"Same hands, twice this year. That’s a press injury." → EV5</text>')
    return frame("".join(p))


# ── THE ENGAGEMENT: stand-off geometry ──────────────────────────────────────────
def engagement():
    p=[stars(3005, 80, 0)]
    p.append('<rect x="-500" y="-500" width="1000" height="1000" fill="#0a0d13"/>')
    p.append(stars(3005, 90, 0))
    # range rings from the AD
    ax,ay=-330,120
    for r,lbl,col in [(150,"CLOSE — their guns bite","#e05252"),(300,"SHORT","#e0894a"),
                      (470,"MEDIUM","#e0c04a"),(640,"LONG — YOU LIVE HERE","#7ec8a0")]:
        p.append(f'<circle cx="{ax}" cy="{ay}" r="{r}" fill="none" stroke="{col}" stroke-width="1.2" '
                 f'stroke-dasharray="5 6" opacity=".45"/>')
        p.append(f'<text x="{ax+r-6}" y="{ay-8}" fill="{col}" font-family="{MONO}" font-size="10.5" text-anchor="end">{lbl}</text>')
    # AD + fighters
    p.append(f'<g transform="translate({ax},{ay})"><path d="M-40,0 L24,-10 L52,0 L24,10 Z" fill="#16202e" stroke="#7ec8a0" stroke-width="2"/></g>')
    p.append(f'<text x="{ax}" y="{ay+34}" fill="#7ec8a0" font-family="{MONO}" font-size="12" text-anchor="middle">ASTRAL DAWN</text>')
    random.seed(9)
    for i in range(6):
        fx=ax+120+i*44; fy=ay-90+((i%3)-1)*54
        p.append(f'<path d="M{fx-9},{fy} L{fx+6},{fy-4} L{fx+13},{fy} L{fx+6},{fy+4} Z" fill="#7ec8a0"/>')
    p.append(f'<text x="{ax+230}" y="{ay-150}" fill="#7ec8a0" font-family="{MONO}" font-size="12">6 × MISSILE FIGHTERS</text>')
    p.append(f'<text x="{ax+230}" y="{ay-134}" fill="#8e9bb0" font-family="{MONO}" font-size="10.5">+6 hardpoints · 14 total ≈ 1,400 t of fire</text>')
    # the pirates
    px,py=300,-160
    for i,(dx,dy) in enumerate([(0,0),(-70,90),(80,110),(30,-90)]):
        p.append(f'<g transform="translate({px+dx},{py+dy})"><path d="M-30,0 L18,-8 L40,0 L18,8 Z" fill="#2a1418" stroke="#e05252" stroke-width="1.6"/></g>')
    p.append(f'<text x="{px+70}" y="{py-40}" fill="#e05252" font-family="{MONO}" font-size="12">3–4 × 400 t CONVERTED</text>')
    p.append(f'<text x="{px+70}" y="{py-24}" fill="#8e9bb0" font-family="{MONO}" font-size="10.5">ENERGY weapons · few missiles</text>')
    # missile arcs
    for i in range(5):
        p.append(f'<path d="M{ax+150},{ay-60+i*24} Q{(ax+px)/2+60},{(ay+py)/2-140} {px-40+i*10},{py+40}" '
                 f'fill="none" stroke="#f0b429" stroke-width="1.1" stroke-dasharray="4 7" opacity=".55"/>')
    p.append(title("THE ENGAGEMENT — STAND OFF AND SHOOT", "🔒 GM ONLY — DO NOT STAGE", "#e05252"))
    p.append(f'<text x="-470" y="440" fill="#7ec8a0" font-family="{MONO}" font-size="13">'
             '⭐ Piracy wants CAPTURE, not destruction — so they carry energy weapons and few missiles.</text>')
    p.append(f'<text x="-470" y="459" fill="#f0b429" font-family="{MONO}" font-size="12.5">'
             'Hold LONG range and pour missiles in. AD likely wins. CLOSE the range and you hand it back.</text>')
    p.append(f'<text x="-470" y="477" fill="#e05252" font-family="{MONO}" font-size="12">'
             '⚠ They may go nuclear — existential for them. AD intercepts ~99% AT LONG RANGE ONLY.</text>')
    return frame("".join(p))


# ── ZGOUNDER — 50,000 t, Flammarion outer system ────────────────────────────────
def zgounder():
    random.seed(3006); p=[stars(3006, 170, 0)]
    p.append('<defs><radialGradient id="zr" cx=".38" cy=".32">'
             '<stop offset="0" stop-color="#6a7382"/><stop offset=".65" stop-color="#3b434e"/>'
             '<stop offset="1" stop-color="#1a1f26"/></radialGradient></defs>')
    # the rock
    p.append('<ellipse cx="-30" cy="40" rx="400" ry="300" fill="url(#zr)"/>')
    for _ in range(40):
        a=random.uniform(0,2*math.pi); rr=random.uniform(0,340)
        cx=-30+rr*math.cos(a); cy=40+rr*math.sin(a)*.75; s=random.uniform(10,58)
        p.append(f'<ellipse cx="{cx:.0f}" cy="{cy:.0f}" rx="{s:.0f}" ry="{s*.5:.0f}" fill="#232a33" opacity=".45"/>')
    # the cut-in docking face — this is a WORKING base
    p.append('<path d="M120,-150 L360,-96 L364,150 L128,206 Z" fill="#11161e" stroke="#4a5768" stroke-width="1.6"/>')
    for i in range(5):
        y=-108+i*62
        p.append(f'<rect x="150" y="{y}" width="180" height="34" rx="3" fill="#0b0f15" stroke="#5a6675" stroke-width="1"/>')
        p.append(f'<rect x="150" y="{y}" width="{random.choice([50,90,130,180])}" height="34" fill="#f0b429" opacity=".13"/>')
        p.append(f'<circle cx="340" cy="{y+17}" r="3" fill="#7ec8a0"/>')
    p.append(f'<text x="150" y="-124" fill="#7ec8a0" font-family="{MONO}" font-size="11">5 BERTHS · repair + refit</text>')
    # a hull in dock, and the Far Trader waiting
    p.append('<g transform="translate(258,15)"><path d="M-52,0 L28,-11 L58,0 L28,11 Z" fill="#1b2534" stroke="#7ec8a0" stroke-width="1.5"/></g>')
    p.append('<g transform="translate(-320,-250) rotate(-8)"><path d="M-38,0 L20,-9 L44,0 L20,9 Z" fill="#221a12" stroke="#f0b429" stroke-width="1.6"/></g>')
    p.append(f'<text x="-350" y="-282" fill="#f0b429" font-family="{MONO}" font-size="12">200 t FAR TRADER · J-2</text>')
    p.append(f'<text x="-350" y="-266" fill="#8e9bb0" font-family="{MONO}" font-size="10.5">the hull for Raschev — pre-requested</text>')
    # drive nozzles: it MOVES, slowly
    for i,dx in enumerate((-380,-350,-320)):
        p.append(f'<ellipse cx="{dx}" cy="{170+i*8}" rx="16" ry="22" fill="#1a2029" stroke="#4a5768" stroke-width="1.2"/>')
    p.append(f'<text x="-400" y="238" fill="#8e9bb0" font-family="{MONO}" font-size="10.5">manoeuvre drives — minimal. NO JUMP DRIVE.</text>')
    p.append(title("ZGOUNDER — 50,000 t", "Flammarion outer system · TL11 · heavy planetoid armour · JSI, leased", "#f0b429"))
    p.append(f'<text x="-470" y="452" fill="#8e9bb0" font-family="{MONO}" font-size="12">'
             'Ex-Sternmetal Horizons mining base. Title: Lady Sandra Fauntleroy, Imperial Knight Regent.</text>')
    p.append(f'<text x="-470" y="470" fill="#7ec8a0" font-family="{MONO}" font-size="12">'
             '8 months of JSI salvage, training and refit. It moves. It cannot jump. It is home.</text>')
    return frame("".join(p))
