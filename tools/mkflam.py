#!/usr/bin/env python3
"""S19-FLAMMARION — Zgounder, the refit, and the hull for Raschev. Plan 0555 §4."""
import json, math, random
from mkhelpers import frame, stars, title, comms, MONO
from mkplaces import zgounder

OUT="/home/bruce/software/argus-presenter/modules/s19-flammarion.json"

def refit():
    """The Astral Dawn stops existing."""
    p=[stars(4001, 140, 0)]
    p.append('<rect x="-500" y="-500" width="1000" height="1000" fill="#0a0d13"/>')
    p.append(stars(4001, 140, 0))
    for i,(y,lab,col,sub) in enumerate([
        (-190,"ISS ASTRAL DAWN","#7ec8a0","Bastien-class Q-ship · 600 t · J-3 · transponder ASTRAL DAWN"),
        (90,"⟨ NEW NAME ⟩","#f0b429","Subsidised Liner (Type M) · 600 t · J-3 · TL12 · new transponder")]):
        p.append(f'<g transform="translate(-40,{y})">')
        p.append(f'<path d="M-190,0 L100,-42 L230,0 L100,42 Z" fill="#131b26" stroke="{col}" stroke-width="2"/>')
        p.append(f'<path d="M-190,0 L-250,-26 L-250,26 Z" fill="{col}" opacity=".5"/>')
        if i==0:
            for tx in (-110,-20,70):
                p.append(f'<rect x="{tx}" y="-52" width="26" height="12" rx="2" fill="#1b2534" stroke="{col}" stroke-width="1.2"/>')
            p.append(f'<text x="150" y="-56" fill="{col}" font-family="{MONO}" font-size="10">turrets, visible</text>')
        else:
            for tx in (-110,-20,70):
                p.append(f'<rect x="{tx}" y="-46" width="26" height="8" rx="2" fill="#131b26" stroke="#39434f" stroke-width="1" stroke-dasharray="2 3"/>')
            p.append(f'<text x="150" y="-52" fill="#5f7086" font-family="{MONO}" font-size="10">turrets, faired over</text>')
        p.append('</g>')
        p.append(f'<text x="-470" y="{y-8}" fill="{col}" font-family="{MONO}" font-size="16">{lab}</text>')
        p.append(f'<text x="-470" y="{y+12}" fill="#8e9bb0" font-family="{MONO}" font-size="11">{sub}</text>')
    p.append('<path d="M0,-110 L0,10" stroke="#f0b429" stroke-width="2" stroke-dasharray="6 6" opacity=".7"/>')
    p.append(f'<text x="16" y="-46" fill="#f0b429" font-family="{MONO}" font-size="13">REFIT AT ZGOUNDER</text>')
    p.append(title("SHE STOPS EXISTING", "the same 600 t hull, the same J-3 — only the name is a lie", "#f0b429"))
    p.append(f'<text x="-470" y="452" fill="#7ec8a0" font-family="{MONO}" font-size="12.5">'
             '⭐ A Subsidised Liner is 600 t, J-3, TL12. The AD is 600 t. She fakes NOTHING but her name.</text>')
    p.append(f'<text x="-470" y="470" fill="#8e9bb0" font-family="{MONO}" font-size="11.5">'
             'GM: the ship they have flown for 17 sessions ends here. Play it as a small grief.</text>')
    return frame("".join(p))

BEATS=[
 ("f1-zgounder","F1 · ZGOUNDER — home", zgounder(),
  "PLAYER-SAFE. 50,000 t, TL11, heavy planetoid armour, five berths, repair + refit. It moves and cannot jump. "
  "Title: Lady Sandra Fauntleroy — NAMED ONLY, never on screen."),
 ("f2-refit","F2 · The Astral Dawn stops existing", refit(),
  "PLAYER-SAFE. Refit to a different subsidised liner, new transponder. Same 600 t, same J-3 — she fakes only her name."),
 ("f3-fartrader","F3 · The hull for Raschev", comms(
    name="200 t FAR TRADER", role="Type A2 · TL12 · J-2 · 1G · 64 t cargo", org="MCr 52.24 · a Zgounder rebuild",
    sig="⭐ This is what Raschev gets — EITHER branch.|Pre-requested by Delleron months ago.|⛔ His foresight is GM-ONLY.",
    body="Cheap. Scarred. Cannot fight anyone.|Vince asked for warships.|Somebody has to hand this over and explain it.",
    chan="JSI DISPOSAL · IMPERIUM PURPOSE"),
  "🔒 GM. Vince asked for warships and gets a merchant hull — the right answer to a payment dispute and the wrong "
  "answer to a man with guns overhead. ⭐ J-2 + 64 t is also enough to go and meet the slow ships. "
  "Galley bulkhead still carries a family's height-marks for a child."),
]

mod={"manifest":{"title":"S19 FLAMMARION — Zgounder, the refit, the choice","version":"1.0",
  "kind":"00 · LIVE SESSION","defaultBeatId":"f1-zgounder",
  "summary":("Plan 0555 §4. Home is a 50,000 t armoured rock that moves and cannot jump, leased from an "
   "Imperial Knight and worked for eight months by a JSI skeleton crew. The maiden voyage formally ends: "
   "crew rotate, every PC has a trained understudy, and the AD can sail with ZERO PCs aboard. She is "
   "refitted into a different subsidised liner with a new transponder. And a 200 t Far Trader is waiting — "
   "the hull Raschev gets either way. ⛔ JSI gives hulls for IMPERIUM purposes, never personal ones: the "
   "PCs get nothing for themselves.")},
 "sections":[{"id":"s-home","title":"HOME","kind":"section",
   "summary":"Zgounder, and the end of the ship they arrived in.","beatIds":["f1-zgounder","f2-refit"]},
  {"id":"s-hull","title":"🔒 THE HULL — GM ONLY","kind":"section",
   "summary":"What Raschev gets, and why it is not what Vince asked for.","beatIds":["f3-fartrader"]}],
 "beats":[{"id":b[0],"title":b[1],"component":"map",
   "section":("s-hull" if b[0].startswith("f3") else "s-home"),
   "onDemand":True,"durationSec":0,
   "opts":{"svg":b[2],"title":b[1],"laser":True,"controllable":False,"cursors":"all","fit":"contain","note":b[3]}}
  for b in BEATS]}
json.dump(mod,open(OUT,"w"),indent=1)
print(f"wrote {OUT}: {len(mod['beats'])} beats")
