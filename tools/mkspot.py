#!/usr/bin/env python3
"""Ten beats for S18 — two per PC: one SPOTLIGHT, one STATION.

Grounded in compendium/SPOTLIGHT-BANK.md. ⛔ Banked beats have guardrails and Bruce spends
them; these SURFACE and stop. Marina is in spotlight ARREARS since S9 — hers pays first.
"""
import math, random
from mkhelpers import frame, stars, title, MONO

# station registry colours (presenter_stations)
COL = {"Captain":"#ffd700","Gunner":"#ff4444","Marines":"#ff6644",
       "Engineer":"#ffaa00","Sensors":"#00ff88"}
ICON = {"Captain":"⚓","Gunner":"🎯","Marines":"⚔️","Engineer":"⚙️","Sensors":"📡"}


def spotlight(pc, player, station, head, situation, prompt, guard, bank=""):
    """A GM prompt card. Warm, personal, deliberately NOT a tactical screen."""
    c = COL[station]
    p = [stars(hash(pc) % 9999, 70, 0)]
    p.append('<rect x="-500" y="-500" width="1000" height="1000" fill="#0b0a0d"/>')
    p.append(stars(hash(pc) % 9999, 70, 0))
    p.append(f'<rect x="-460" y="-400" width="920" height="800" rx="8" fill="#15131a" stroke="#2a2733" stroke-width="1.5"/>')
    p.append(f'<rect x="-460" y="-400" width="920" height="5" fill="{c}"/>')
    p.append(f'<text x="-430" y="-358" fill="{c}" font-family="{MONO}" font-size="11.5" letter-spacing="3">◆ SPOTLIGHT</text>')
    p.append(f'<text x="430" y="-358" fill="#6b6478" font-family="{MONO}" font-size="11" text-anchor="end">{ICON[station]} {station} · {player}</text>')
    p.append(f'<text x="-430" y="-300" fill="#f2eef7" font-family="{MONO}" font-size="30">{pc}</text>')
    p.append(f'<text x="-430" y="-262" fill="{c}" font-family="Georgia,serif" font-size="21" font-style="italic">{head}</text>')
    p.append(f'<line x1="-430" y1="-238" x2="430" y2="-238" stroke="#2a2733" stroke-width="1"/>')
    y = -200
    p.append(f'<text x="-430" y="{y}" fill="#6b6478" font-family="{MONO}" font-size="10.5" letter-spacing="2">THE SITUATION</text>')
    y += 30
    for ln in situation.split("|"):
        p.append(f'<text x="-430" y="{y}" fill="#ded8e8" font-family="Georgia,serif" font-size="18">{ln.strip()}</text>'); y += 29
    y += 18
    p.append(f'<rect x="-440" y="{y-24}" width="880" height="{30+29*len(prompt.split("|"))}" rx="4" fill="#0e1a14" stroke="{c}" stroke-width="1" opacity=".55"/>')
    p.append(f'<text x="-430" y="{y}" fill="{c}" font-family="{MONO}" font-size="10.5" letter-spacing="2">GIVE THEM THIS</text>')
    y += 30
    for ln in prompt.split("|"):
        p.append(f'<text x="-424" y="{y}" fill="#f2eef7" font-family="Georgia,serif" font-size="18.5">{ln.strip()}</text>'); y += 29
    y += 26
    p.append(f'<text x="-430" y="{y}" fill="#c96b6b" font-family="{MONO}" font-size="10.5" letter-spacing="2">⛔ GUARDRAIL</text>')
    y += 26
    for ln in guard.split("|"):
        p.append(f'<text x="-430" y="{y}" fill="#d9a3a3" font-family="{MONO}" font-size="12.5">{ln.strip()}</text>'); y += 22
    if bank:
        y += 16
        p.append(f'<text x="-430" y="{y}" fill="#6b6478" font-family="{MONO}" font-size="11">{bank}</text>')
    return frame("".join(p))


def actions_strip(c, acts):
    """v1 role-panel idiom: what this seat can do NOW, and what it cannot, and WHY.
    Inspired by traveller-starship-operations-vtt/public/operations/modules/role-panels/ —
    2,716 lines of console where `Plot Course` greys out with the reason attached. The
    constraint IS the drama; a disabled control says more than a paragraph."""
    o = ['<rect x="-470" y="286" width="940" height="128" rx="4" fill="#0a0f16" stroke="#1d2735" stroke-width="1"/>']
    o.append(f'<text x="-454" y="310" fill="{c}" font-family="{MONO}" font-size="10.5" letter-spacing="2">ACTIONS AVAILABLE AT THIS STATION</text>')
    x = -454
    for label, hot, reason in acts:
        w = 300 if reason else 216
        live = not reason
        fill = "#101c14" if live else "#161418"
        stroke = c if live else "#3a3540"
        txt = "#eef2f7" if live else "#6b6478"
        o.append(f'<rect x="{x}" y="324" width="{w}" height="{74 if reason else 40}" rx="4" fill="{fill}" stroke="{stroke}" stroke-width="1.3"'
                 + ('' if live else ' stroke-dasharray="4 4"') + '/>')
        o.append(f'<text x="{x+13}" y="{350}" fill="{txt}" font-family="{MONO}" font-size="13">{label}</text>')
        if hot:
            o.append(f'<text x="{x+w-13}" y="{350}" fill="{c if live else "#4a4550"}" font-family="{MONO}" font-size="11" text-anchor="end">[{hot}]</text>')
        if reason:
            o.append(f'<text x="{x+13}" y="{370}" fill="#9b7d7d" font-family="{MONO}" font-size="10.5">⛔ {reason[0]}</text>')
            if len(reason) > 1:
                o.append(f'<text x="{x+13}" y="{386}" fill="#9b7d7d" font-family="{MONO}" font-size="10.5">{reason[1]}</text>')
        x += w + 12
    return "".join(o)


def screen(station, player, head, sub, body_fn, foot="", acts=None):
    """A station screen — what THAT seat sees that nobody else does."""
    c = COL[station]
    p = [stars(hash(head) % 9999, 90, 0)]
    p.append('<rect x="-500" y="-500" width="1000" height="1000" fill="#070a0e"/>')
    p.append(stars(hash(head) % 9999, 90, 0))
    p.append(f'<rect x="-470" y="-448" width="940" height="46" rx="3" fill="#0d1420" stroke="{c}" stroke-width="1.2"/>')
    p.append(f'<text x="-452" y="-418" fill="{c}" font-family="{MONO}" font-size="15" letter-spacing="2">{ICON[station]} {station.upper()} — {head}</text>')
    p.append(f'<text x="452" y="-418" fill="#5f7086" font-family="{MONO}" font-size="11" text-anchor="end">{player}</text>')
    p.append(f'<text x="-470" y="-378" fill="#8e9bb0" font-family="{MONO}" font-size="12">{sub}</text>')
    p.append(body_fn(c))
    if acts:
        p.append(actions_strip(c, acts))
    if foot:
        yy = 440 if not acts else 442
        for ln in foot.split("|"):
            p.append(f'<text x="-470" y="{yy}" fill="#a8b4c4" font-family="{MONO}" font-size="11.5">{ln.strip()}</text>'); yy += 18
    return frame("".join(p))


# ── station screen bodies ───────────────────────────────────────────────────────
def _captain_plot(c):
    """Transit-time proof: a schedule nobody legitimate could afford."""
    o = []
    o.append('<rect x="-430" y="-300" width="860" height="550" rx="4" fill="#0a1018" stroke="#1d2735" stroke-width="1"/>')
    for i in range(7):
        y = -260 + i * 70
        o.append(f'<line x1="-400" y1="{y}" x2="400" y2="{y}" stroke="#16202c" stroke-width="1"/>')
        o.append(f'<text x="-418" y="{y+4}" fill="#5f7086" font-family="{MONO}" font-size="10" text-anchor="end">{10-i*1.5:.1f} AU</text>')
    for i, m in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN"]):
        o.append(f'<text x="{-360+i*140}" y="200" fill="#5f7086" font-family="{MONO}" font-size="10" text-anchor="middle">{m}</text>')
    # the impossible sawtooth
    pts = [(-360, -270), (-290, 130), (-220, -268), (-150, 128), (-80, -272), (-10, 126),
           (60, -270), (130, 130), (200, -268), (270, 128), (340, -270)]
    o.append('<polyline points="' + " ".join(f"{x},{y}" for x, y in pts) +
             f'" fill="none" stroke="{c}" stroke-width="2" opacity=".9"/>')
    for x, y in pts:
        o.append(f'<circle cx="{x}" cy="{y}" r="3.4" fill="{c}"/>')
    o.append(f'<text x="-352" y="-286" fill="{c}" font-family="{MONO}" font-size="11">OUTER — 10 AU</text>')
    o.append(f'<text x="-282" y="152" fill="{c}" font-family="{MONO}" font-size="11">INNER — the port</text>')
    o.append(f'<rect x="60" y="-190" width="352" height="86" rx="3" fill="#1a1206" stroke="#f0b429" stroke-width="1.2"/>')
    o.append(f'<text x="76" y="-166" fill="#f0b429" font-family="{MONO}" font-size="12.5">ROUND TRIP: 9–11 DAYS</text>')
    o.append(f'<text x="76" y="-146" fill="#e0d0a8" font-family="{MONO}" font-size="11">at that rate, every month, for months</text>')
    o.append(f'<text x="76" y="-126" fill="#e0d0a8" font-family="{MONO}" font-size="11">no belter can afford that fuel bill</text>')
    return "".join(o)


def _gunner_drone(c):
    """Remote Ops: a drone feed over the cut face."""
    random.seed(77)
    o = ['<rect x="-430" y="-320" width="860" height="560" rx="4" fill="#08100c" stroke="#1d2735" stroke-width="1"/>']
    for _ in range(120):
        x, y = random.uniform(-425, 425), random.uniform(-315, 195)
        o.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{random.uniform(.6,2.4):.1f}" fill="#cfe0f5" opacity="{random.uniform(.2,.7):.2f}"/>')
    o.append('<path d="M-150,-90 L60,-130 L150,10 L40,120 L-130,80 Z" fill="#6c7a8c" stroke="#cfe0f5" stroke-width="1.5"/>')
    o.append(f'<path d="M-130,80 L40,120 L150,10" fill="none" stroke="{c}" stroke-width="3.5"/>')
    o.append(f'<rect x="170" y="-30" width="240" height="96" rx="3" fill="#140a0a" stroke="{c}" stroke-width="1.2"/>')
    o.append(f'<text x="184" y="-8" fill="{c}" font-family="{MONO}" font-size="12">CUT ANALYSIS</text>')
    for i, t in enumerate(["kerf 2.1 cm — powered saw", "faces parallel ±0.3°", "NOT hand-rigged", "age: 3–5 months"]):
        o.append(f'<text x="184" y="{12+i*18}" fill="#e8d0d0" font-family="{MONO}" font-size="10.5">{t}</text>')
    for i, (dx, dy) in enumerate([(-300, -230), (-250, -215), (-200, -232)]):
        o.append(f'<g transform="translate({dx},{dy})"><path d="M-11,0 L6,-4 L14,0 L6,4 Z" fill="{c}"/></g>')
    o.append(f'<text x="-300" y="-252" fill="{c}" font-family="{MONO}" font-size="10.5">DRONES 1–3 · station-keeping</text>')
    o.append('<line x1="0" y1="-320" x2="0" y2="200" stroke="#1d3a2c" stroke-width=".8" stroke-dasharray="3 6"/>')
    o.append('<line x1="-430" y1="-60" x2="430" y2="-60" stroke="#1d3a2c" stroke-width=".8" stroke-dasharray="3 6"/>')
    return "".join(o)


def _marines_boarding(c):
    """Entry plan on a 1,000t converted colony ship."""
    o = ['<rect x="-420" y="-300" width="840" height="540" rx="4" fill="#0d0a09" stroke="#1d2735" stroke-width="1"/>']
    o.append('<rect x="-330" y="-230" width="660" height="330" rx="26" fill="#161a20" stroke="#5a6675" stroke-width="1.6"/>')
    for i in range(4):
        o.append(f'<line x1="{-330+132*(i+1)}" y1="-230" x2="{-330+132*(i+1)}" y2="100" stroke="#232a33" stroke-width="1"/>')
    o.append('<line x1="-330" y1="-65" x2="330" y2="-65" stroke="#232a33" stroke-width="1"/>')
    for x, y, lbl in [(-300, -196, "HAB"), (-168, -196, "HAB"), (-36, -196, "GALLEY"), (96, -196, "SHOPS"), (228, -196, "SHOPS"),
                      (-300, -30, "STORES"), (-168, -30, "POWER"), (-36, -30, "BRIDGE"), (96, -30, "FAB"), (228, -30, "CARGO")]:
        o.append(f'<text x="{x}" y="{y}" fill="#8e9bb0" font-family="{MONO}" font-size="10">{lbl}</text>')
    for x, y, n in [(-330, -140, "A"), (330, -140, "B"), (0, 100, "C")]:
        o.append(f'<circle cx="{x}" cy="{y}" r="15" fill="{c}" opacity=".85"/>')
        o.append(f'<text x="{x}" y="{y+5}" fill="#140a08" font-family="{MONO}" font-size="14" text-anchor="middle" font-weight="700">{n}</text>')
    o.append(f'<rect x="-410" y="120" width="380" height="40" rx="3" fill="#1a0e0c" stroke="{c}" stroke-width="1"/>')
    o.append(f'<text x="-396" y="145" fill="#f0c4b4" font-family="{MONO}" font-size="11.5">A cargo · B airlock · C engineering — pick TWO</text>')
    o.append(f'<text x="40" y="145" fill="#8e9bb0" font-family="{MONO}" font-size="11">crew: unknown. shops = tools = weapons.</text>')
    return "".join(o)


def _engineer_manifest(c):
    """The tool list, and what only an engineer reads in it."""
    o = ['<rect x="-440" y="-300" width="880" height="540" rx="4" fill="#0f0c07" stroke="#1d2735" stroke-width="1"/>']
    rows = [("14×", "hardened lathe tooling, 40 mm", "cuts drive shafting"),
            ("6×", "TL11 arc welding sets", "hull work, not rock"),
            ("2×", "vacuum-rated press, 200 t", "⭐ forms ARMOUR PLATE"),
            ("~40 t", "structural feedstock, ship-grade", "not ore. FINISHED stock."),
            ("9×", "precision jigs, turret-ring gauge", "⛔ TURRET rings."),
            ("1×", "spectrographic assay bench", "QA for weapons work")]
    o.append(f'<text x="-420" y="-262" fill="{c}" font-family="{MONO}" font-size="12">LSP PROMETHEUS — OFF-MANIFEST DELIVERIES, 7 MONTHS</text>')
    for i, (q, item, read) in enumerate(rows):
        y = -212 + i * 62
        o.append(f'<rect x="-420" y="{y-24}" width="840" height="50" rx="3" fill="#141009" stroke="#28323f" stroke-width="1"/>')
        o.append(f'<text x="-404" y="{y}" fill="#e8d8b8" font-family="{MONO}" font-size="13">{q}</text>')
        o.append(f'<text x="-330" y="{y}" fill="#e8ecf2" font-family="{MONO}" font-size="13">{item}</text>')
        o.append(f'<text x="-330" y="{y+18}" fill="{c}" font-family="{MONO}" font-size="11">{read}</text>')
    return "".join(o)


def _sensors_rescan(c):
    """The re-scan. The single most important station action in S18."""
    o = ['<rect x="-440" y="-300" width="880" height="540" rx="4" fill="#050d09" stroke="#1d2735" stroke-width="1"/>']
    for r in (70, 140, 210):
        o.append(f'<circle cx="-190" cy="-60" r="{r}" fill="none" stroke="#16302a" stroke-width="1"/>')
        o.append(f'<circle cx="190" cy="-60" r="{r}" fill="none" stroke="#16302a" stroke-width="1"/>')
    o.append(f'<text x="-190" y="-278" fill="#7ec8a0" font-family="{MONO}" font-size="13" text-anchor="middle">PASSIVE — what you already have</text>')
    o.append(f'<text x="190" y="-278" fill="{c}" font-family="{MONO}" font-size="13" text-anchor="middle">ACTIVE RE-SCAN — if you spend it</text>')
    soft = [(-230, -110), (-140, -30), (-250, 20), (-120, 70), (-190, -150)]
    for x, y in soft:
        o.append(f'<circle cx="{x}" cy="{y}" r="6" fill="#7ec8a0" opacity=".9"/>')
        o.append(f'<circle cx="{x+380}" cy="{y}" r="6" fill="#7ec8a0" opacity=".9"/>')
    for x, y in [(120, -120), (250, -20), (140, 60), (245, 95)]:
        o.append(f'<circle cx="{x}" cy="{y}" r="9" fill="none" stroke="#e05252" stroke-width="2" stroke-dasharray="3 3"/>')
        o.append(f'<circle cx="{x}" cy="{y}" r="3.5" fill="#e05252"/>')
    o.append(f'<text x="-190" y="130" fill="#8e9bb0" font-family="{MONO}" font-size="11.5" text-anchor="middle">5 contacts. Consistent. Resolved.</text>')
    o.append(f'<text x="190" y="130" fill="#e05252" font-family="{MONO}" font-size="11.5" text-anchor="middle">9 contacts. Four were never moving.</text>')
    o.append(f'<rect x="-420" y="-244" width="380" height="30" rx="3" fill="#0a1a12" stroke="#2a4a3a" stroke-width="1"/>')
    o.append(f'<text x="-406" y="-224" fill="#8e9bb0" font-family="{MONO}" font-size="11">the picture already looks SOLVED</text>')
    return "".join(o)


# ── the ten ─────────────────────────────────────────────────────────────────────
BEATS = [
 # ── MARINA — the debt is paid FIRST ────────────────────────────────────────────
 ("sp-marina", "⭐ SPOTLIGHT · Marina — the 73rd", spotlight(
   "Marina DeVeillter", "Alex", "Gunner", "She served on Raschev. Nobody has ever asked her about it.",
   "The mail lands and Vince's letter goes round the table.|Four of them read a friend asking for help.|She reads a coastal defence problem on ground she has walked."
   "|73rd Raschev Coastal Defense. Her unit. Her coast.",
   "“You know what four hulls over Loka means better than|anyone here. Tell them what you are actually looking at.”"
   "|Then let her be the one who is asked, for once.",
   "⛔ SPOTLIGHT DEBT — owed since S9. PAY THIS FIRST.|Voicing Anemone does NOT discharge it (R-15).|Do not make it a flashback. Make it expertise.",
   "bank: SPOTLIGHT-BANK.md — Marina, arrears")),
 ("st-marina", "🎯 STATION · Marina — drone survey, the cut face", screen(
   "Gunner", "Alex", "REMOTE OPS — drone feed", "Bowman Prime rings · 3 drones detached · her six AI gunners are idle and she owns them",
   _gunner_drone,
   acts=[("Recall drones","R",None),
        ("Hold station, keep filming","H",None),
        ("Task drones to Belt III","B",["10 AU. Drones are sub-light.","They would arrive next month"])],
   foot="⭐ HERS ALONE: Remote Drone Ops is her canon seat. Nobody else can put eyes on that face."
   "|⇒ Delivers EV1 as a MEASUREMENT, not a rumour: 2.1 cm kerf, parallel to 0.3°."
   "|⚠ She is NOT the sensor operator — that is Von Sydo. This is drones, not sensors.")),

 # ── JAMES ──────────────────────────────────────────────────────────────────────
 ("sp-james", "⭐ SPOTLIGHT · James — the form has no box", spotlight(
   "Capt. James Delleron", "James", "Captain", "He files as a merchant captain to a service he outranks.",
   "Deputy Portmaster Hollis Yeom needs the patrol contract registered,|and two first-contact reports filed."
   "|Yeom is bored, thorough, and not stupid.|His form has no box for an armed merchant with a JSI contract.",
   "“Eleven years I have been doing this and I have filed one|of these. What exactly do I write you down as?”"
   "|⇒ James answers as what he is pretending to be.",
   "⛔ Do NOT reveal the Admiral rank. It is PLAYER knowledge (James's),|kept from the other four PCs — not from the table."
   "|⛔ Do not have Yeom suspect. He is a clerk, not a foil.",
   "bank: 'compromised as an Admiral' — already in play, S14")),
 ("st-james", "⚓ STATION · James — the impossible schedule", screen(
   "Captain", "James", "PLOT — traffic vs distance", "cross-referencing EV1 ice cuts · EV2 comms bearings · EV3 delivery dates",
   _captain_plot,
   acts=[("Accept the deduction","A",None),
        ("Order the run to Belt III","R",None),
        ("Commit the fighters","F",["needs 3+ fragments — you have","fewer, and it is 83 light-min out"])],
   foot="⭐ THE SYNTHESIS. No Astrogator seat exists, so the captain does the arithmetic."
   "|⇒ Proves a base at 10 AU WITHOUT ANYONE SEEING IT. Two fragments and a calendar."
   "|⚠ Only fires if they have collected 2+. Do not stage it early.")),

 # ── MAX ────────────────────────────────────────────────────────────────────────
 ("sp-max", "⭐ SPOTLIGHT · Max — money or a day", spotlight(
   "Max Planck", "Max", "Engineer", "The whole session's pace is his call, and he may not notice.",
   "Refined fuel at Alpha costs top dollar. They can afford it.|Or he skims and runs the processor: 200 t/day, under a day internal."
   "|Free ice anywhere past 1.01 AU, and nobody logs your arrival."
   "|⇒ Buying refined is PAYING TO LEAVE SOONER.",
   "“Chief — port price, or do you want to make it yourself?”"
   "|Let him weigh a day of everyone's time against the ship's money.|It is his ship's plumbing and his decision.",
   "⛔ Do not push. If they buy and run, Bowman keeps (Bruce, 08-10).|⚠ Do NOT frame it as port-vs-belt. It is MONEY vs A DAY.",
   "AD: fuel processor 10 t, 200 t/day, wilderness-capable")),
 ("st-max", "⚙️ STATION · Max — what those tools are FOR", screen(
   "Engineer", "Max", "OFF-MANIFEST — LSP Prometheus", "Fen Ilarov called it smuggling and stopped thinking. An engineer cannot.",
   _engineer_manifest,
   acts=[("Tell the captain","T",None),
        ("Cross-check against Alpha's records","X",None),
        ("Trace the buyer","∅",["LSP will not name a paying","customer to a stranger"])],
   foot="⭐ HIS ALONE: only an engineer reads a tool list as a CAPABILITY."
   "|⇒ A 200 t vacuum press forms armour plate. Turret-ring gauges have ONE use."
   "|⛔ Do not say 'pirates'. Give him the list and let him say it.")),

 # ── ASAO ───────────────────────────────────────────────────────────────────────
 ("sp-asao", "⭐ SPOTLIGHT · Asao — a lord in a company town", spotlight(
   "Asao Ora", "DragonKnight912", "Marines", "3,000 people, four levels, one bar — and nobody knows what he is.",
   "He holds a Raschev land grant. Among Aslan that is the single|most consequential status change there is. He has stood on it once."
   "|On Alpha it buys him nothing. Nobody here has heard of Raschev|and the bar does not care who his family is.",
   "“You are, for the first time in years, simply a large armed|man in a small room where everyone already knows everyone.”"
   "|⇒ Let him choose whether that is a relief or an insult.",
   "⛔ Do NOT stage the estate — that beat belongs on Raschev, banked.|⛔ Do not invent Aslan NPCs to recognise him. The point is nobody does.",
   "bank: 'the estate he has never lived on' — RASCHEV, unspent")),
 ("st-asao", "⚔️ STATION · Asao — two ways in", screen(
   "Marines", "DragonKnight912", "ENTRY PLAN — 1,000 t converted colony ship", "🔒 GM · Belt III branch only · shops mean tools mean improvised weapons",
   _marines_boarding,
   acts=[("Breach A + C","A",None),
        ("Breach B alone, quietly","B",None),
        ("Cut power first","P",["Engineering is BEHIND the","shops. You go through them"])],
   foot="⭐ HIS ALONE: Marine Commander picks the entry, and lives with it."
   "|⚠ Crew strength UNKNOWN. Fabrication shops arm defenders in minutes."
   "|⛔ Only stage this if they actually reach Belt III and choose to board.")),

 # ── VON SYDO ───────────────────────────────────────────────────────────────────
 ("sp-vonsydo", "⭐ SPOTLIGHT · Von Sydo — Kira asks after him", spotlight(
   "Von Sydo", "Les", "Sensors", "One line in a five-month-old letter, and it is not a crisis.",
   "Marta's oldest note, buried under roofing and kitchen opinions:|“Kira is settled in the east wing and asks after Von Sydo"
   "|more often than she admits to. She is well. Everything is as it|should be there and you are not to worry about it.”",
   "Hand him the line and say nothing else.|⇒ A tactical, secretive man gets to be an ordinary person|for thirty seconds, in front of his crew.",
   "⛔ NOT A CRISIS. No scandal, no ultimatum, no paternity scene.|⛔ Do not name the child, decide its sex, or stage a birth."
   "|⭐ Several small moments, never one big one (R-05).",
   "bank: 'Kyra and the child' — SPEND SMALL, spend often")),
 ("st-vonsydo", "📡 STATION · Von Sydo — look again", screen(
   "Sensors", "Les", "ACTIVE RE-SCAN — Belt III", "🔒 GM · the picture already looks solved. That is the trap.",
   _sensors_rescan,
   acts=[("ACTIVE RE-SCAN — spend it","S",None),
        ("Accept the passive picture","P",None),
        ("Re-scan without being seen","∅",["Active means ACTIVE. At this","range they see you first"])],
   foot="⭐⭐ THE MOST IMPORTANT STATION ACTION IN S18. His alone."
   "|The soft return is TRUE and reads WEAK. The array resolves the concealed"
   "|hulls ONLY IF HE DECIDES TO RE-SCAN SOMETHING ALREADY RESOLVED."
   "|⇒ The trap punishes complacency, not dice. He is the counter to it.")),
]
