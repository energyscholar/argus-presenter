#!/usr/bin/env python3
"""S-HELPERS1 — standard, re-usable beats. Jumpspace, emergence, refuelling, docking,
the official-comms card, tactical range bands. Built once, used every session."""
import json, math, random, os

OUT = "/home/bruce/software/argus-presenter/modules/s-helpers1.json"
MONO = 'ui-monospace,monospace'

def frame(body, w=1000):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-500 -500 {w} {w}">'
            f'<rect x="-500" y="-500" width="{w}" height="{w}" fill="#080b11"/>{body}</svg>')

def stars(seed, n=190, hole=0):
    random.seed(seed); out=[]
    for _ in range(n):
        x,y = random.uniform(-498,498), random.uniform(-498,498)
        if hole and math.hypot(x,y) < hole: continue
        out.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{random.choice([.6,.6,.8,1.2]):.1f}" '
                   f'fill="#cfe0f5" opacity="{random.uniform(.12,.65):.2f}"/>')
    return "".join(out)

def title(t, sub="", col="#f0b429"):
    s = f'<text x="-478" y="-452" fill="{col}" font-family="{MONO}" font-size="17" letter-spacing="2">{t}</text>'
    if sub: s += f'<text x="-478" y="-431" fill="#8e9bb0" font-family="{MONO}" font-size="11.5">{sub}</text>'
    return s

# ── 1. JUMPSPACE ────────────────────────────────────────────────────────────────
def jumpspace():
    random.seed(7); p=[]
    p.append('<defs><radialGradient id="jg"><stop offset="0" stop-color="#3a3550" stop-opacity=".85"/>'
             '<stop offset=".55" stop-color="#1d1b2c" stop-opacity=".6"/>'
             '<stop offset="1" stop-color="#0a0910" stop-opacity="1"/></radialGradient>'
             '<filter id="soft"><feGaussianBlur stdDeviation="7"/></filter></defs>')
    p.append('<rect x="-500" y="-500" width="1000" height="1000" fill="#0a0910"/>')
    for i in range(26):
        r = 40 + i*19
        p.append(f'<circle cx="0" cy="0" r="{r}" fill="none" stroke="#4a4270" '
                 f'stroke-width="{max(.4, 2.4-i*0.08):.1f}" opacity="{max(.03, .3-i*0.011):.3f}"/>')
    for _ in range(60):
        a = random.uniform(0,2*math.pi); r0 = random.uniform(30,470)
        x,y = r0*math.cos(a), r0*math.sin(a)
        rr = random.uniform(16,70)
        p.append(f'<path d="M{x:.0f},{y:.0f} q{rr*math.cos(a+1.1):.0f},{rr*math.sin(a+1.1):.0f} '
                 f'{rr*1.4*math.cos(a+.4):.0f},{rr*1.4*math.sin(a+.4):.0f}" fill="none" '
                 f'stroke="#6b5f9c" stroke-width="{random.uniform(.5,1.6):.1f}" opacity="{random.uniform(.08,.3):.2f}"/>')
    p.append('<circle cx="0" cy="0" r="470" fill="url(#jg)"/>')
    p.append('<circle cx="0" cy="0" r="150" fill="#2a2440" opacity=".5" filter="url(#soft)"/>')
    p.append(title("JUMPSPACE", "no stars · no reference · no contact", "#9b8bd4"))
    p.append(f'<text x="0" y="455" fill="#6b5f9c" font-family="{MONO}" font-size="12.5" text-anchor="middle">'
             'the viewport shows nothing the eye can hold</text>')
    return frame("".join(p))

# ── 2. EMERGENCE ────────────────────────────────────────────────────────────────
def emergence():
    p=[stars(3, 210)]
    p.insert(0,'<defs><radialGradient id="br"><stop offset="0" stop-color="#cfd8ff" stop-opacity=".9"/>'
               '<stop offset=".35" stop-color="#6b5f9c" stop-opacity=".45"/>'
               '<stop offset="1" stop-color="#0a0910" stop-opacity="0"/></radialGradient></defs>')
    p.append('<circle cx="0" cy="0" r="330" fill="url(#br)" opacity=".55"/>')
    for i in range(7):
        p.append(f'<circle cx="0" cy="0" r="{60+i*46}" fill="none" stroke="#9b8bd4" '
                 f'stroke-width="{2.6-i*0.3:.1f}" opacity="{.42-i*0.05:.2f}"/>')
    p.append(title("BREAKOUT", "transition complete · stars resolving · sensors settling", "#9b8bd4"))
    p.append(f'<text x="0" y="455" fill="#8e9bb0" font-family="{MONO}" font-size="12.5" text-anchor="middle">'
             'first sweep is coarse — detail arrives over the next several minutes</text>')
    return frame("".join(p))

# ── 3. GAS-GIANT FUEL SKIM ──────────────────────────────────────────────────────
def skim():
    p=[stars(11, 150)]
    p.insert(0,'<defs><linearGradient id="gband" x1="0" y1="0" x2="0" y2="1">'
               '<stop offset="0" stop-color="#e8b174"/><stop offset=".45" stop-color="#b8763a"/>'
               '<stop offset=".72" stop-color="#d79a56"/><stop offset="1" stop-color="#8a5522"/></linearGradient></defs>')
    p.append('<rect x="-500" y="90" width="1000" height="410" fill="url(#gband)"/>')
    for i,(y,o,h) in enumerate([(120,.30,15),(178,.22,26),(250,.28,19),(330,.20,30),(410,.26,22)]):
        p.append(f'<rect x="-500" y="{y}" width="1000" height="{h}" fill="#6f3f18" opacity="{o}"/>')
    p.append('<ellipse cx="-120" cy="228" rx="150" ry="26" fill="#f0c48c" opacity=".22"/>')
    p.append('<path d="M-500,92 Q0,58 500,92" fill="none" stroke="#ffdcae" stroke-width="3" opacity=".55"/>')
    p.append('<g transform="translate(150,-40) rotate(8)">'
             '<path d="M-52,0 L28,-11 L58,0 L28,11 Z" fill="#1b2534" stroke="#7ec8a0" stroke-width="1.6"/>'
             '<path d="M-52,0 L-72,-7 L-72,7 Z" fill="#7ec8a0" opacity=".55"/></g>')
    p.append('<path d="M78,-32 Q-40,20 -190,120" fill="none" stroke="#7ec8a0" stroke-width="1.2" '
             'stroke-dasharray="5 6" opacity=".7"/>')
    p.append(title("FUEL SKIM", "gas giant · unrefined hydrogen · free, and slow", "#e8b174"))
    p.append(f'<text x="-478" y="470" fill="#8e9bb0" font-family="{MONO}" font-size="12">'
             'unrefined fuel: misjump risk on the next jump unless purified</text>')
    return frame("".join(p))

# ── 4. ICE MINING (the belt alternative) ────────────────────────────────────────
def icemine():
    random.seed(21); p=[stars(21, 260)]
    for _ in range(34):
        a=random.uniform(0,2*math.pi); r=random.uniform(120,430)
        x,y=r*math.cos(a),r*math.sin(a); s=random.uniform(9,46)
        p.append(f'<ellipse cx="{x:.0f}" cy="{y:.0f}" rx="{s:.0f}" ry="{s*random.uniform(.6,.95):.0f}" '
                 f'fill="#7f8ea3" opacity="{random.uniform(.35,.8):.2f}"/>')
        p.append(f'<ellipse cx="{x-s*.28:.0f}" cy="{y-s*.3:.0f}" rx="{s*.42:.0f}" ry="{s*.3:.0f}" '
                 f'fill="#cfe0f5" opacity="{random.uniform(.15,.4):.2f}"/>')
    p.append('<g transform="translate(-40,10)"><path d="M-46,0 L24,-10 L52,0 L24,10 Z" fill="#1b2534" '
             'stroke="#7ec8a0" stroke-width="1.6"/></g>')
    p.append(title("ICE — FREE FUEL", "anywhere beyond the snow line · no starport, no fees, no record", "#8fc4e8"))
    p.append(f'<text x="-478" y="470" fill="#8e9bb0" font-family="{MONO}" font-size="12">'
             'water ice cracks to hydrogen · slower than a port, and nobody logs your arrival</text>')
    return frame("".join(p))

# ── 5. OFFICIAL COMMS CARD (ART-8, reusable) ────────────────────────────────────
def comms(name="⟨NAME⟩", role="⟨role / title⟩", org="⟨organisation · where⟩",
          sig="⟨why they matter — one line⟩|⟨second line⟩|⟨third line⟩",
          body="\u201c⟨what they actually say⟩\u201d|\u201c⟨second line of speech⟩\u201d",
          chan="⟨CHANNEL · CLASSIFICATION⟩"):
    p=[stars(5, 0, )]
    nsig  = len(sig.split('|')); nbody = len(body.split('|'))
    H     = 300 + nsig*21 + nbody*32          # size to content, never a half-empty card
    p.append(f'<rect x="-470" y="-410" width="940" height="{H}" rx="6" fill="#10151f" '
             f'stroke="#1d2735" stroke-width="1.5"/>')
    p.append('<rect x="-470" y="-410" width="940" height="4" fill="#f0b429"/>')
    p.append(f'<text x="-440" y="-368" fill="#f0b429" font-family="{MONO}" font-size="12" letter-spacing="3">'
             'INCOMING TRANSMISSION</text>')
    p.append(f'<text x="440" y="-368" fill="#5f7086" font-family="{MONO}" font-size="11" text-anchor="end">{chan}</text>')
    # portrait plate
    p.append('<rect x="-440" y="-330" width="210" height="210" rx="4" fill="#0d1420" stroke="#2a3away" '
             'stroke-width="0"/>')
    p.append('<rect x="-440" y="-330" width="210" height="210" rx="4" fill="#0d1420" stroke="#233042" stroke-width="1.4"/>')
    p.append('<circle cx="-335" cy="-262" r="42" fill="#1b2534" stroke="#3c5570" stroke-width="1.4"/>')
    p.append('<path d="M-395,-160 a60,52 0 0 1 120,0 z" fill="#1b2534" stroke="#3c5570" stroke-width="1.4"/>')
    p.append(f'<text x="-335" y="-136" fill="#3c5570" font-family="{MONO}" font-size="10" text-anchor="middle">NO IMAGE ON FILE</text>')
    # identity
    p.append(f'<text x="-205" y="-288" fill="#eef2f7" font-family="{MONO}" font-size="27">{name}</text>')
    p.append(f'<text x="-205" y="-258" fill="#7ec8a0" font-family="{MONO}" font-size="14">{role}</text>')
    p.append(f'<text x="-205" y="-234" fill="#8e9bb0" font-family="{MONO}" font-size="13">{org}</text>')
    p.append('<line x1="-205" y1="-214" x2="440" y2="-214" stroke="#233042" stroke-width="1"/>')
    p.append(f'<text x="-205" y="-190" fill="#5f7086" font-family="{MONO}" font-size="10.5" letter-spacing="2">WHY THEY MATTER</text>')
    y=-166
    for line in sig.split("|"):
        p.append(f'<text x="-205" y="{y}" fill="#c8d0dc" font-family="{MONO}" font-size="13">{line.strip()}</text>'); y+=21
    # message body
    p.append('<line x1="-440" y1="-92" x2="440" y2="-92" stroke="#233042" stroke-width="1"/>')
    yy=-58
    for line in body.split("|"):
        p.append(f'<text x="-440" y="{yy}" fill="#e6ecf5" font-family="Georgia,serif" font-size="19">{line.strip()}</text>'); yy+=32
    return frame("".join(p))

# ── 6. TACTICAL RANGE BANDS ─────────────────────────────────────────────────────
def ranges():
    p=[stars(31, 90)]
    bands=[("ADJACENT","<1 km",58,"#e05252"),("CLOSE","1–10 km",104,"#e0894a"),
           ("SHORT","10–1,250 km",158,"#e0c04a"),("MEDIUM","1,250–10,000 km",222,"#7ec8a0"),
           ("LONG","10,000–25,000 km",294,"#4a9fd8"),("VERY LONG","25,000–50,000 km",372,"#7a6fc4"),
           ("DISTANT",">50,000 km",448,"#8e9bb0")]
    for nm,dist,r,c in bands:
        p.append(f'<circle cx="0" cy="0" r="{r}" fill="none" stroke="{c}" stroke-width="1.3" '
                 f'opacity=".55" stroke-dasharray="{"" if nm in ("LONG","VERY LONG") else "4 5"}"/>')
        p.append(f'<text x="6" y="{-r+16}" fill="{c}" font-family="{MONO}" font-size="11.5">{nm}</text>')
        p.append(f'<text x="6" y="{-r+30}" fill="#5f7086" font-family="{MONO}" font-size="9.5">{dist}</text>')
    p.append('<path d="M-16,0 L10,-6 L22,0 L10,6 Z" fill="#1b2534" stroke="#7ec8a0" stroke-width="1.6"/>')
    p.append(title("RANGE BANDS", "MgT2e spacecraft combat · missiles reach where energy weapons do not", "#7ec8a0"))
    p.append(f'<text x="-478" y="452" fill="#e0894a" font-family="{MONO}" font-size="12.5">'
             'STAND-OFF: missile fire from LONG/VERY LONG · energy weapons cannot answer at that range</text>')
    p.append(f'<text x="-478" y="470" fill="#8e9bb0" font-family="{MONO}" font-size="11.5">'
             'closing to CLOSE/SHORT hands the advantage to whoever has more energy mounts</text>')
    return frame("".join(p))

BEATS = [
    ("h-jumpspace",  "Jumpspace",              jumpspace(), "Seven days of nothing. Use for any jump transit."),
    ("h-breakout",   "Breakout — emergence",   emergence(), "Transition out. Sensors coarse, detail arrives over minutes."),
    ("h-skim",       "Fuel skim — gas giant",  skim(),      "Unrefined hydrogen. Free and slow; misjump risk unless purified."),
    ("h-ice",        "Ice mining — free fuel", icemine(),   "Beyond the snow line. No port, no fees, NO RECORD OF YOUR ARRIVAL."),
    ("h-comms",      "Official comms — TEMPLATE", comms(), "REUSABLE TEMPLATE. Copy this beat into a session module and replace the ⟨angle-bracket⟩ fields: name, role, org, why-they-matter, and what they say."),
    ("h-ranges",     "Tactical range bands",   ranges(),    "MgT2e range bands. The stand-off argument, drawn."),
]

mod = {
  "manifest": {
    "title": "S-HELPERS1 — standard reusable beats",
    "version": "1.0",
    "kind": "00 · LIVE SESSION",   # top of the picker: groups sort A-Z by kind
    "defaultBeatId": "h-jumpspace",
    "summary": ("Standard, re-usable screens for any session: jumpspace, breakout, gas-giant fuel "
                "skim, ice mining, the official-communication card, and MgT2e tactical range bands. "
                "Built 2026-08-10 so these never have to be rebuilt per-session. The comms card is a "
                "TEMPLATE — copy the beat into a session module and fill in the name, role, org and "
                "message.")
  },
  "sections": [
    {"id":"h-transit","title":"TRANSIT","kind":"section",
     "summary":"Jump, breakout, and the two ways to refuel.",
     "beatIds":["h-jumpspace","h-breakout","h-skim","h-ice"]},
    {"id":"h-tools","title":"TOOLS","kind":"section",
     "summary":"Reusable card templates and rules aids.",
     "beatIds":["h-comms","h-ranges"]},
  ],
  "beats": [
    {"id":bid,"title":t,"component":"map","section":("h-transit" if bid in
      ("h-jumpspace","h-breakout","h-skim","h-ice") else "h-tools"),
     "onDemand":True,"durationSec":0,
     "opts":{"svg":svg,"title":t,"laser":True,"controllable":False,"cursors":"all","fit":"contain",
             "note":note}}
    for bid,t,svg,note in BEATS
  ],
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(mod, open(OUT,"w"), indent=1)
print(f"wrote {OUT}")
print(f"  {len(mod['beats'])} beats, {sum(len(b['opts']['svg']) for b in mod['beats']):,} bytes of SVG")
