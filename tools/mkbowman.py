#!/usr/bin/env python3
"""S18-BOWMAN — the session module. Plan 0555."""
import json, math, random, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mkhelpers import frame, stars, title, comms, MONO   # reuse the helper primitives

OUT = "/home/bruce/software/argus-presenter/modules/s18-bowman.json"
# ⚠ Regenerate the maps rather than reading them from wherever they happened to be built.
#    The first version read art1-player.svg from a scratchpad dir, which meant this script
#    silently stopped working the moment that dir was cleared. A generator that depends on
#    an artifact it did not create is not reproducible.
import mkmap
PLAYER_SVG = mkmap.build(False)
GM_SVG     = mkmap.build(True)

# ── Garrison Starport, Alpha — gas giant behind ─────────────────────────────────
def starport():
    random.seed(88); p=[stars(88, 150)]
    p.insert(0,'<defs><radialGradient id="gg2" cx=".35" cy=".35">'
      '<stop offset="0" stop-color="#d3a771"/><stop offset=".6" stop-color="#9c6529"/>'
      '<stop offset="1" stop-color="#6d3f16"/></radialGradient>'
      '<linearGradient id="rock" x1="0" y1="0" x2="0" y2="1">'
      '<stop offset="0" stop-color="#59616e"/><stop offset="1" stop-color="#22272f"/></linearGradient>'
      '<radialGradient id="lamp"><stop offset="0" stop-color="#ffe6a8" stop-opacity=".95"/>'
      '<stop offset="1" stop-color="#ffe6a8" stop-opacity="0"/></radialGradient></defs>')
    # BOWMAN PRIME filling the upper sky
    p.append('<circle cx="120" cy="-330" r="470" fill="url(#gg2)"/>')
    for y,h,o in [(-540,44,.22),(-455,30,.16),(-380,52,.20),(-300,26,.14),(-232,40,.18),(-170,22,.12)]:
        p.append(f'<rect x="-360" y="{y}" width="960" height="{h}" fill="#7d4a1c" opacity="{o}"/>')
    p.append('<ellipse cx="120" cy="-330" rx="600" ry="70" fill="none" stroke="#e2b27e" '
             'stroke-width="9" opacity=".35" transform="rotate(-11 120 -330)"/>')
    p.append('<ellipse cx="120" cy="-330" rx="640" ry="86" fill="none" stroke="#c99a68" '
             'stroke-width="3" opacity=".25" transform="rotate(-11 120 -330)"/>')
    # ALPHA — the moon's limb across the lower frame
    p.append('<path d="M-500,300 Q-140,150 120,178 Q380,205 500,290 L500,500 L-500,500 Z" fill="url(#rock)"/>')
    for _ in range(26):
        cx=random.uniform(-480,480); cy=random.uniform(215,470); r=random.uniform(9,42)
        p.append(f'<ellipse cx="{cx:.0f}" cy="{cy:.0f}" rx="{r:.0f}" ry="{r*.42:.0f}" fill="#161b22" opacity=".5"/>')
    # the port: pads, gantries, lights
    p.append('<g>')
    for i,(x,w) in enumerate([(-330,86),(-190,110),(-20,132),(160,96),(300,78)]):
        y = 268 + (i%2)*16
        p.append(f'<rect x="{x}" y="{y}" width="{w}" height="9" fill="#2f3947" stroke="#4a5768" stroke-width="1"/>')
        p.append(f'<circle cx="{x+w/2}" cy="{y-2}" r="30" fill="url(#lamp)" opacity=".5"/>')
        for gx in (x+7, x+w-7):
            p.append(f'<line x1="{gx}" y1="{y}" x2="{gx}" y2="{y-26}" stroke="#4a5768" stroke-width="2"/>')
            p.append(f'<circle cx="{gx}" cy="{y-28}" r="2.4" fill="#7ec8a0"/>')
    p.append('</g>')
    # a docked hull + one on approach
    p.append('<g transform="translate(-20,246)"><path d="M-46,0 L26,-10 L54,0 L26,10 Z" fill="#1b2534" '
             'stroke="#7ec8a0" stroke-width="1.5"/></g>')
    p.append('<g transform="translate(300,86) rotate(14)"><path d="M-30,0 L16,-7 L34,0 L16,7 Z" fill="#141b26" '
             'stroke="#5f7086" stroke-width="1.2"/></g>')
    p.append('<path d="M320,96 Q250,150 190,214" fill="none" stroke="#5f7086" stroke-width="1" '
             'stroke-dasharray="4 6" opacity=".6"/>')
    p.append('<rect x="-500" y="-500" width="1000" height="120" fill="#080b11" opacity=".62"/>')
    p.append('<rect x="-500" y="430" width="1000" height="70" fill="#080b11" opacity=".62"/>')
    p.append(title("GARRISON STARPORT · ALPHA", "Bowman Prime, moon Alpha · Class C · IISS base · pop. 3,000", "#f0b429"))
    p.append(f'<text x="-478" y="466" fill="#8e9bb0" font-family="{MONO}" font-size="12">'
             'over a third of everyone in this system lives on this rock. The rest are scattered across 10 AU.</text>')
    return frame("".join(p))

# ── Belt III: the soft scan (what they see) ─────────────────────────────────────
def scan(hard):
    random.seed(1132); p=[stars(1132, 120, 60)]
    p.append('<circle cx="0" cy="0" r="352" fill="none" stroke="#233042" stroke-width="1" opacity=".6"/>')
    p.append('<circle cx="0" cy="0" r="235" fill="none" stroke="#233042" stroke-width="1" opacity=".6"/>')
    p.append('<circle cx="0" cy="0" r="118" fill="none" stroke="#233042" stroke-width="1" opacity=".6"/>')
    for a in range(0,360,30):
        r=math.radians(a)
        p.append(f'<line x1="0" y1="0" x2="{352*math.cos(r):.0f}" y2="{352*math.sin(r):.0f}" '
                 f'stroke="#1a2532" stroke-width=".8" opacity=".55"/>')
    for _ in range(60):
        a=random.uniform(0,2*math.pi); rr=random.uniform(70,400)
        p.append(f'<circle cx="{rr*math.cos(a):.0f}" cy="{rr*math.sin(a):.0f}" r="{random.uniform(1.2,3.4):.1f}" '
                 f'fill="#4a5768" opacity="{random.uniform(.2,.5):.2f}"/>')
    def blip(x,y,lbl,sub,col,r=7,dash=False):
        dashattr = ' stroke-dasharray="3 4"' if dash else ''
        s=(f'<circle cx="{x}" cy="{y}" r="{r+13}" fill="none" stroke="{col}" stroke-width="1.2" '
           f'opacity=".5"{dashattr}/>'
           f'<circle cx="{x}" cy="{y}" r="{r}" fill="{col}" opacity="{.55 if dash else .95}"/>'
           f'<text x="{x+r+20}" y="{y-2}" fill="{col}" font-family="{MONO}" font-size="13">{lbl}</text>'
           f'<text x="{x+r+20}" y="{y+14}" fill="#8e9bb0" font-family="{MONO}" font-size="10.5">{sub}</text>')
        return s
    p.append(blip(-105,-70,"MASS 1,000 t","jump tug · industrial","#9aa7b8"))
    p.append(blip(60,45,"MASS 1,000 t","hab signature · squatter camp","#9aa7b8"))
    p.append(blip(-160,140,"100 t","Seeker-type · mining","#7ec8a0",5))
    p.append(blip(-40,190,"100 t","Seeker-type · mining","#7ec8a0",5))
    p.append(blip(175,-135,"smallcraft","low power","#5f7086",4))
    if hard:
        for x,y,l in [(190,150,"400 t — ARMED"),(-235,-15,"400 t — RAIDER"),
                      (95,-215,"400 t — RAIDER"),(-90,-190,"400 t — RAIDER")]:
            p.append(blip(x,y,l,"powered down · concealed","#e05252",8,dash=True))
        p.append(title("BELT III — WHAT IS ACTUALLY THERE", "improved array, actively re-scanned", "#e05252"))
        p.append(f'<text x="-478" y="450" fill="#e05252" font-family="{MONO}" font-size="13">'
                 '⛔ FOUR MORE HULLS. The soft picture was true and it was not complete.</text>')
        p.append(f'<text x="-478" y="470" fill="#f0b429" font-family="{MONO}" font-size="12">'
                 'Howl of Profit is AWAY. Stand off at LONG range and use the fighters.</text>')
    else:
        p.append(title("BELT III — SENSOR RETURN", "10 AU · 83 light-minutes · everything here is 83 min old", "#7ec8a0"))
        p.append(f'<text x="-478" y="450" fill="#7ec8a0" font-family="{MONO}" font-size="13">'
                 'Two big slow masses, two miners, some smallcraft. Nothing is manoeuvring.</text>')
        p.append(f'<text x="-478" y="470" fill="#8e9bb0" font-family="{MONO}" font-size="12">'
                 'Reads soft. Reads like now is the moment.</text>')
    return frame("".join(p))

# ── the people ──────────────────────────────────────────────────────────────────
NPCS = [
 ("b3-portmaster","Dep. Portmaster Hollis Yeom","Deputy Portmaster","Garrison Starport, Alpha",
  "Signs your patrol-contract registration.|Has no box on his form for an armed merchant.|Bored, thorough, and not stupid.",
  "\"Armed merchant with a JSI patrol contract.\"|\"I'll be honest with you, Captain — I have|filed one of these before. In eleven years.\"","PORT ADMIN · ROUTINE",None),
 ("b7-ev1","Tobiah Vance","Independent ice claim","Bowman Prime ring system",
  "⭐ EV1 — someone is cutting ice on faces|he never filed a claim on. Clean industrial|cuts. Months old. He calls it claim-jumping.",
  "\"Somebody's working my faces. Cuts that|clean cost money — that's not a belter with|a hand rig, that's a shop.\"","RING TRAFFIC","EV1"),
 ("b7-ev2","Lt. Anneke Roos","Duty officer, IISS station","Alpha",
  "⭐ EV2 — intermittent comms returns on an|odd bearing. Far outward. Logged as an|equipment fault for months.",
  "\"The array's older than I am. It ghosts.|Always the same bearing, though, which I|suppose is what a fault does.\"","IISS · UNCLASSIFIED","EV2"),
 ("b7-ev3","Fen Ilarov","Factor, Ling-Standard Products","Prometheus station, Alpha Trojan",
  "⭐ EV3 — cargo with no matching manifest.|Someone is buying machine tools and|feedstock, paying well, taking delivery off-station.",
  "\"Smuggling, obviously. Not my business and|not yours. They pay on time, in hard money,|and they never haggle. I'd keep them.\"","LSP COMMERCIAL","EV3"),
 ("b7-ev4","Dr. Sabine Kuru","Field director, Darrian survey","Epsilon — 2,000 yr outpost",
  "⭐ EV4 — a ship buzzed the dig, ran a survey|pattern over the site, ignored her hail,|and left. She was furious, not frightened.",
  "\"It flew a grid. Nobody flies a grid by|accident. And it did not answer, which out|here is not rude, it is deliberate.\"","CIVILIAN SCIENCE","EV4"),
 ("b7-ev5","Doc Merisi","Belt medic, circuit rounds","Belt II — the working belt",
  "⭐ EV5 — treating crush and burn injuries|consistent with heavy fabrication work,|in a man who owns no shop.",
  "\"Same hands, twice this year. That's a press|injury. You don't get a press injury off a|rock — you get it off a factory floor.\"","MEDICAL · IN CONFIDENCE","EV5"),
]

def npc_beats():
    out=[]
    for bid,name,role,org,sig,body,chan,ev in NPCS:
        out.append((bid, (f"{ev} · " if ev else "")+name,
                    comms(name=name, role=role, org=org, sig=sig, body=body, chan=chan),
                    ("GM: hand over ONLY on an approach — a bought round, a favour, a medical courtesy. "
                     "Never volunteer it." if ev else "GM: routine, and the first test of the Q-ship's new public status.")))
    return out

BEATS = [
 ("b1-arrival","B1 · Arrival — Bowman 1132", PLAYER_SVG,
  "PLAYER-SAFE. 8,000 people across 10 AU. No planet to land on: the 'mainworld' IS a belt."),
 ("b2-starport","B2 · Garrison Starport, Alpha", starport(),
  "The money shot. Over a third of the system lives on this one moon."),
 *npc_beats(),
 ("b9-scan-soft","B9 · Belt III — sensor return", scan(False),
  "🔒 GM. What a NORMAL scan returns. TRUE, and it reads weak. This is the trap."),
 ("b10-scan-hard","B10 · Belt III — what is there", scan(True),
  "🔒 GM. Only if someone ACTIVELY re-scans with the improved array. Four more hulls."),
 ("bg-system","GM · Bowman system, full", GM_SVG,
  "🔒 GM ONLY — DO NOT STAGE. Belt III, transit times, the 83-light-minute problem."),
]

SECTIONS = [
 {"id":"s-arrive","title":"ARRIVAL","kind":"section",
  "summary":"Bowman as the players meet it. Empty, cold, and with nowhere to land.",
  "beatIds":["b1-arrival","b2-starport"]},
 {"id":"s-people","title":"THE PEOPLE — and the five fragments","kind":"section",
  "summary":("Alpha holds NO pirate hints. The five EV-holders each explain their own fragment "
             "away. One is noise, two is coincidence, THREE locates Belt III."),
  "beatIds":[b[0] for b in npc_beats()]},
 {"id":"s-belt3","title":"🔒 BELT III — GM ONLY","kind":"section",
  "summary":"The soft scan is true and reads weak. The hard scan needs someone to actively look.",
  "beatIds":["b9-scan-soft","b10-scan-hard","bg-system"]},
]

mod = {
 "manifest":{
  "title":"S18 BOWMAN — arrival, the five fragments, Belt III",
  "version":"1.0","kind":"00 · LIVE SESSION","defaultBeatId":"b1-arrival",
  "summary":("Plan 0555. Three dull errands, the Raschev mail backlog, and five pieces of evidence "
             "nobody knows they hold. ⛔ Alpha carries NO pirate hints — the fragments live with the "
             "marginal operators. Three combined locate Belt III at 10 AU. The scan there is TRUE and "
             "reads WEAK; the improved array resolves the concealed hulls ONLY IF SOMEONE ACTIVELY "
             "LOOKS. Stand off at LONG range and use the six missile fighters: pirates carry energy "
             "weapons and few missiles because piracy wants capture, not destruction. "
             "🔒 The last three beats are GM-only — DO NOT STAGE.")},
 "sections":SECTIONS,
 "beats":[{"id":b[0],"title":b[1],"component":"map",
           "section":("s-belt3" if b[0].startswith(("b9","b10","bg")) else
                      "s-people" if b[0].startswith(("b3","b7")) else "s-arrive"),
           "onDemand":True,"durationSec":0,
           "opts":{"svg":b[2],"title":b[1],"laser":True,"controllable":False,
                   "cursors":"all","fit":"contain","note":b[3]}}
          for b in BEATS],
}
json.dump(mod, open(OUT,"w"), indent=1)
print(f"wrote {OUT}")
print(f"  {len(mod['beats'])} beats / {len(mod['sections'])} sections / "
      f"{sum(len(b['opts']['svg']) for b in mod['beats']):,} bytes SVG")
