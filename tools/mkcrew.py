#!/usr/bin/env python3
"""S-HELPERS2 — THE CREW. Standing, reusable, session-independent.

Bruce, 2026-08-11: "Ideally we want banked PC spotlights built into the adventure modules!
So we don't need to keep repeating them. That's what the S-HELPER module is for."

⇒ 0556 L2 applied to content: the BANKED SITUATION lives here, once. A session module holds
only that session's USE of it. Source: compendium/SPOTLIGHT-BANK.md + PLAYER-ROSTER.md + the
crew roster in campaign.db.
"""
import json
from mkhelpers import frame, stars, title, MONO

OUT = "/home/bruce/software/argus-presenter/modules/s-helpers2-crew.json"

COL = {"Captain":"#ffd700","Pilot":"#4488ff","Astrogator":"#88ccff","Sensors":"#00ff88",
       "Gunner":"#ff4444","Comms":"#00ffff","Engineer":"#ffaa00","Damage Control":"#ff8800",
       "Medic":"#44ff44","Marines":"#ff6644","Psi":"#cc88ff","Steward":"#ffcc88",
       "Observer":"#888888"}
ICON = {"Captain":"⚓","Pilot":"🚀","Astrogator":"🌌","Sensors":"📡","Gunner":"🎯","Comms":"📻",
        "Engineer":"⚙️","Damage Control":"🔧","Medic":"⚕️","Marines":"⚔️","Psi":"🧠",
        "Steward":"🍽️","Observer":"👁️"}


def card(kind, who, sub, colour, blocks, foot=""):
    """A compact standing card. blocks = [(LABEL, colour, [lines])]."""
    p = [stars(hash(who) % 9999, 60, 0)]
    p.append('<rect x="-500" y="-500" width="1000" height="1000" fill="#0a0b10"/>')
    p.append(stars(hash(who) % 9999, 60, 0))
    H = 150 + sum(46 + 24 * len(b[2]) for b in blocks) + (34 if foot else 0)
    p.append(f'<rect x="-460" y="-400" width="920" height="{H}" rx="7" fill="#12141c" stroke="#252a36" stroke-width="1.5"/>')
    p.append(f'<rect x="-460" y="-400" width="920" height="5" fill="{colour}"/>')
    p.append(f'<text x="-432" y="-360" fill="{colour}" font-family="{MONO}" font-size="11" letter-spacing="3">{kind}</text>')
    p.append(f'<text x="-432" y="-312" fill="#f0f3f8" font-family="{MONO}" font-size="27">{who}</text>')
    p.append(f'<text x="-432" y="-282" fill="#8e9bb0" font-family="{MONO}" font-size="13">{sub}</text>')
    y = -244
    for lbl, lc, lines in blocks:
        p.append(f'<text x="-432" y="{y}" fill="{lc}" font-family="{MONO}" font-size="10.5" letter-spacing="2">{lbl}</text>')
        y += 26
        for ln in lines:
            p.append(f'<text x="-432" y="{y}" fill="#dbe2ec" font-family="Georgia,serif" font-size="17.5">{ln}</text>')
            y += 24
        y += 20
    if foot:
        p.append(f'<text x="-432" y="{y}" fill="#5f7086" font-family="{MONO}" font-size="11">{foot}</text>')
    return frame("".join(p))


G, B, W = "#e05252", "#7ec8a0", "#f0b429"   # guardrail / give-them / warn

# ── BANKED PC SPOTLIGHTS — the standing situation, once ─────────────────────────
PC_CARDS = [
 ("bank-marina", "💸 Marina — SPOTLIGHT ARREARS", card(
  "◆ BANKED — PC SPOTLIGHT", "Marina DeVeillter", "Alex · 🎯 Gunner · lead diplomat · Remote Ops", COL["Gunner"],
  [("THE DEBT", G, ["Owed since S9. S15 logged: one in-fiction beat all session.",
                    "⛔ Voicing Anemone does NOT discharge it — Anemone is an",
                    "NPC Alex voices, not a second PC (R-15).",
                    "⭐ PAY THIS BEFORE ANY OTHER BANKED BEAT."]),
   ("WHAT SHE HAS THAT NOBODY HAS SPENT", B,
    ["73rd Raschev Coastal Defense veteran — a personal claim on",
     "the entire Raschev arc that has never been used.",
     "Gunnery Chief: weapons, six AI gunners, Anemone, lead diplomat."]),
   ("⚠ RECURRING ERROR", W, ["She is NOT the sensor operator. That is Von Sydo.",
                             "She is a TL-15 sensors expert BY SKILL, which is why",
                             "she keeps getting miscast. Sensor rolls gate to Von Sydo."])],
  "SPOTLIGHT-BANK.md — Marina")),

 ("bank-vonsydo", "🏦 Von Sydo — Kyra, and the Vigil", card(
  "◆ BANKED — PC SPOTLIGHT", "Von Sydo", "Les · 📡 Sensors · psion", COL["Sensors"],
  [("KYRA AND THE CHILD — Raschev", B,
    ["Pregnant by him, still carrying. She learned after the AD left.",
     "He acknowledged her, set her up as best he could, did not marry her.",
     "The players know. It is settled between them.",
     "⭐ Value: a secretive tactical man gets to be an ordinary person."]),
   ("⛔ GUARDRAILS", G, ["NOT A CRISIS. No scandal, no ultimatum, no paternity scene.",
                        "Do NOT name the child, decide its sex, or stage a birth.",
                        "SEVERAL SMALL MOMENTS, never one big one. (R-05)"]),
   ("⏳ THE VIGIL — 🔒 GM-ONLY", W,
    ["At risk, real and pending — but NOT pursued. A loaded gun, unfired.",
     "⚠ Vera is a psion too. Both halves of the marriage are exposed.",
     "Bruce 07-30: 'no plan to get The Vigil involved just yet.' (R-06)"])],
  "SPOTLIGHT-BANK.md — Von Sydo")),

 ("bank-max", "🏦 Max — the Tourism Award", card(
  "◆ BANKED — PC SPOTLIGHT", "Max Planck", "Max · ⚙️ Chief Engineer", COL["Engineer"],
  [("🏆 THE RASCHEV BOARD OF TOURISM AWARD — Bruce's own idea", B,
    ["An award and a ceremony for bringing tourists to Raschev.",
     "His tourism business is GENUINELY GOOD — real holidays, real value —",
     "which is exactly what makes the occasional disappearance unremarkable.",
     "⭐ They are not investigating him. They are thanking him.",
     "Applause cannot be deflected by a Deception roll."]),
   ("⛔ GUARDRAILS", G, ["The PLAYERS all know; the PCs do not, or only suspect.",
                        "The comedy runs on that gap. Do NOT have an NPC accuse him.",
                        "⛔ Presenter: Vince Aliyev. NOT Hin Levairi — he is dead."]),
   ("ALSO LIVE", W, ["'May have left someone pregnant' — unresolved ON PURPOSE (R-09).",
                     "Chamax tech research — his SCIENCE, not his guilt (R-01)."])],
  "SPOTLIGHT-BANK.md — Max · third beat in an escalating joke")),

 ("bank-asao", "🏦 Asao — the estate he has never lived on", card(
  "◆ BANKED — PC SPOTLIGHT", "Asao Ora", "DragonKnight912 · ⚔️ Marine Commander · Aslan", COL["Marines"],
  [("THE LAND GRANT — Raschev", B,
    ["He holds it, and has been onto the land EXACTLY ONCE.",
     "He is no longer landless. For an Aslan that is the single most",
     "consequential status change there is, and it is already earned.",
     "⭐ The beat writes itself in a session about coming home."]),
   ("⛔ GUARDRAILS", G, ["Spend it ON RASCHEV. It does not fire anywhere else.",
                        "⚠ arc-planning.md still calls him 'Landless Aslan' — STALE.",
                        "'Lord of Raschev' is not a distant endpoint; the grant is the bridge."]),
   ("⏳ HTASEA'A — his wife, at JSI HQ on Caladbolg (R-12)", W,
    ["⛔ UNRULED: is she carrying his child? The only source is the drafted",
     "email that also invented her sister. A son 'Aokhryu' is the same",
     "disqualified tier. DO NOT ASSERT EITHER. (R-04)"])],
  "SPOTLIGHT-BANK.md — Asao")),

 ("bank-james", "🏦 James — the six fighters", card(
  "◆ BANKED — PC SPOTLIGHT", "Capt. James Delleron", "James · ⚓ Captain · 🔒 ADMIRAL, Naval Intelligence", COL["Captain"],
  [("⭐ THE SIX MISSILE FIGHTERS — reserved for payoff", B,
    ["He withheld them at Pagaton and the pirates STILL do not know.",
     "He said it himself: 'But they don't know about the fighters.'",
     "They cost the crew a 6–8 month expedition to acquire.",
     "Bruce: 'it would be fitting if that decision wound up being of",
     "great strategic significance in a future conflict.'"]),
   ("⛔ GUARDRAILS", G, ["Do NOT reveal them in prep, fiction, or any NPC's mouth.",
                        "Do NOT spend them cheaply. This only works if it stays hidden",
                        "until it DECIDES something. (R-24)"]),
   ("⏳ COMPROMISED AS AN ADMIRAL — already in play", W,
    ["S14: PO1 Yannick Reese and a dozen veterans SALUTED him.",
     "Paparazzi already believe he holds flag rank. He does.",
     "⭐ Free structural tension: he files as a merchant captain to a",
     "service he secretly outranks. ⚠ PLAYER knowledge — James knows."])],
  "SPOTLIGHT-BANK.md — James · R-44/R-47")),
]

# ── STATION CARDS — who sits there, and what that seat is for ───────────────────
ST = [
 # ⭐ ONLY THE FIVE PC-OCCUPIED STATIONS. Bruce 2026-08-11: "for stations we only do the
 #    stations occupied by PCs, usually" — so 5 person cards + 5 job cards, not thirteen.
 ("Captain", "Capt. James Delleron", "PC · James · 🔒 Admiral, Naval Intelligence",
  ["Command, and the decisions with teeth.",
   "⭐⭐ THERE IS NO ASTROGATOR ABOARD — the captain does the arithmetic.",
   "And the J-4 Override's stated cost is HARDER ASTROGATION plus misjump",
   "risk, so the empty chair IS that risk, made of nothing.",
   "⇒ If they want the fast road to Raschev, that is what they are betting."],
  "⚠ He files as a merchant captain to a service he outranks."),
 ("Sensors", "Von Sydo", "PC · Les · psion",
  ["The array — and the decision to spend it on a picture that already",
   "looks solved. That decision is the whole of his seat.",
   "⭐ Sensor rolls gate HERE. Never to Marina."],
  "Vera Khaldun trains him. Both halves of that marriage are exposed."),
 ("Gunner", "Marina DeVeillter", "PC · Alex · + Anemone + 6 AI gunners",
  ["Weapons, REMOTE DRONE OPS, and lead diplomat — three jobs.",
   "⭐ Remote Ops is hers alone: nobody else can put eyes somewhere",
   "the ship is not.",
   "⭐ Anemone Lindqvist, 18, Assistant Gunner, hero-worships her."],
  "💸 SPOTLIGHT ARREARS since S9 — pay hers before any other banked beat."),
 ("Engineer", "Max Planck", "PC · Max · + Eddie ED-7",
  ["Fuel, power, and what a tool list actually MEANS.",
   "⭐ Only an engineer reads an inventory as a capability.",
   "⭐⭐ EDDIE IS THE ONE WHO FOUND THE J-4 OVERRIDE and told Max."],
  "Fuel processor 200 t/day ⇒ buying refined is paying to leave sooner."),
 ("Marines", "Asao Ora", "PC · DragonKnight912 · + Reyes, Woo-Park, Henriksen, Kowalski",
  ["Entry plans, boarding, and four marines he has trained for 8 months.",
   "⭐ They have had that whole time to learn how he moves.",
   "He has not had eight months to learn anything new about them.",
   "⚠ Pvt. Kowalski — too honest for OPSEC conditioning, three failures."],
  "Aslan land-holder. On a company-town moon that buys him nothing."),
]

def station_card(name, who, sub, lines, foot):
    c = COL[name]
    return card(f"{ICON[name]} STATION — {name.upper()}", who, sub, c,
                [("WHAT THIS SEAT IS FOR", c, lines)], foot)

STATION_BEATS = [(f"st-{name.lower().replace(' ','-')}", f"{ICON[name]} {name} — {who}",
                  station_card(name, who, sub, lines, foot),
                  f"STANDING. Who holds {name} and what the seat is for. {foot}".strip())
                 for name, who, sub, lines, foot in ST]

# ── Bruce's two crew events ─────────────────────────────────────────────────────
EVENT_BEATS = [
 ("ev-sparring", "⚔️ CREW EVENT — eight months of watching him", card(
  "◆ CREW EVENT — end of tour", "Sparring — Pvt. Kowalski's idea", "Marines deck · Asao Ora · Sgt. Reyes officiating", COL["Marines"],
  [("THE SITUATION", "#7ec8a0",
    ["Kowalski proposes a bout. Everyone treats it as a joke.",
     "⭐ But his marines have had EIGHT MONTHS to study how Asao moves.",
     "They have drilled against an Aslan every week since Flammarion.",
     "He has not had eight months to learn anything new about them."]),
   ("GIVE THEM THIS", "#7ec8a0", ["The first exchange goes exactly as he expects.",
                                  "The second does not."]),
   ("⛔ GUARDRAIL", G, ["NOT a humbling and NOT a defeat. A MEASUREMENT.",
                       "⭐ He trained them. This is his own work coming back at him,",
                       "which is what a good commander should want to see.",
                       "⚠ Kowalski is a PRIVATE, and too honest for OPSEC conditioning."])],
  "Bruce's idea, 2026-08-11")),

 ("ev-girlsnight", "🎯 CREW EVENT — Anemone's night", card(
  "◆ CREW EVENT — end of tour", "Anemone and Vera host", "Marina invited · Gunner + Psi · off duty", COL["Gunner"],
  [("THE SITUATION", "#7ec8a0",
    ["Anemone Lindqvist, 18, Assistant Gunner, has made a friend of Vera",
     "Khaldun and organised something. Marina is invited, not commanded.",
     "⭐⭐ ANEMONE IS FROM RASCHEV. Eldest of three daughters, father",
     "dead, and she sends her earnings home to her mother — who is there."]),
   ("GIVE THEM THIS", "#7ec8a0",
    ["The mail has arrived. Anemone has read about Raschev too.",
     "She hero-worships Marina and will not ask directly.",
     "⇒ Marina is the only person aboard who can tell her the truth",
     "about what four hulls over Loka actually means."]),
   ("⛔ GUARDRAIL", G, ["⛔ Voicing Anemone does NOT discharge Marina's spotlight debt (R-15).",
                       "This beat PAYS it only if MARINA is the one being asked.",
                       "Not a crisis. Do not harm Anemone's family off-screen."])],
  "Bruce's idea, 2026-08-11 · ⭐ the Raschev connection is canon, not invented")),
]


# ── THE ASTRAL DAWN — the ship as a character, and her stats ────────────────────
# Bruce 2026-08-11: "S-HELPER[x] would also have one for the Astral Dawn as a character,
# map, etc, which we don't have. At least the stats."
SHIP = "#7ec8a0"
SHIP_BEATS = [
 ("ad-character", "🛰 ISS ASTRAL DAWN — who she is", card(
  "◆ STANDING — THE SHIP", "ISS Astral Dawn", "Bastien-class Q-ship · 600 t · Capt. James Delleron · JSI", SHIP,
  [("SHE WAS SOMETHING ELSE FIRST", B,
    ["Built as the ISS AMISHI, a liner. She CRASHED ON GORRAM.",
     "The PCs salvaged her undercover as Gorram Search & Rescue,",
     "took her to Caladbolg — JSI's actual HQ — and had her refitted",
     "at Flammarion into what she is now. (R-11, R-12)",
     "⭐ This is how the crew got their ship. They dug it out of a hole."]),
   ("WHAT SHE PRETENDS TO BE", W,
    ["A subsidised merchant. Since the Collace release she is publicly",
     "an 'armed merchant with a JSI patrol contract' (R-22) — which is",
     "a real status and still not the whole truth.",
     "⇒ At Flammarion she is refitted AGAIN, into a different liner",
     "with a different transponder. The name she has now ends there."]),
   ("⭐ EIGHT-NINE MONTHS OUT", "#8fc4e8",
    ["Flammarion → Bowman is a 256-day voyage, and 178 of those days",
     "were NOT in jump. She is tired, and everyone aboard knows it."])],
  "compendium/SHIPS.md · R-11/R-12/R-22")),

 ("ad-stats", "🛰 ISS ASTRAL DAWN — the numbers", card(
  "◆ STANDING — SHIP STATS", "ISS Astral Dawn", "600 t streamlined · Type-R conversion · TL12 · hull 240", SHIP,
  [("DRIVES & RANGE", SHIP,
    ["Manoeuvre  Thrust 3 (agile)      Jump drive  JUMP 3 CAPABLE",
     "Internal fuel 125 t — a J-2 burns 120 t, so tankage alone = J-2",
     "5 × 50 t collapsible bladders (250 t) — 4 ship + 1 pinnace",
     "⇒ 'J-2 internal / J-3 with bladder' is a FUEL fact, not a drive limit",
     "Fuel processor 10 t · 200 t/day · full internal refuel under a day",
     "Fuel scoops integral ⇒ WILDERNESS REFUELLING HIGHLY CAPABLE"]),
   ("⭐⭐ THE J-4 OVERRIDE — and the crew KNOW", W,
    ["JSI experimental. Officially cancelled. THE HARDWARE REMAINS.",
     "Cost: harder astrogation, MISJUMP RISK, longer prep.",
     "Eddie ED-7 found it and told Max. Asao has called the J4 jump",
     "'a giant risk' at the table. It is not a secret to reveal —",
     "it is a lever they already hold. ⚠ And there is NO ASTROGATOR."]),
   ("CARRIED", "#8fc4e8",
    ["Armed Launch 44 t   ·   ⭐ ARMORED PINNACE 22 t — a tiny SDB,",
     "and the PCs effectively own it. A match for a 100 t scout.",
     "🔒 6 × MISSILE FIGHTERS — +6 hardpoints. The pack does not know.",
     "Q-ship disguise · jump net (prize towing) · mining drones/bots",
     "Cargo 79 t (39 t once bladders and stores are aboard)"])],
  "⛔ Prizes vest in JSI; crew take cash shares (R-25)")),
]

ALL = SHIP_BEATS + PC_CARDS + STATION_BEATS + EVENT_BEATS
mod = {
 "manifest": {"title": "S-HELPERS2 — THE CREW (banked spotlights + stations)",
   "version": "1.0", "kind": "00 · LIVE SESSION", "defaultBeatId": "ad-character",
   "summary": ("STANDING, REUSABLE, SESSION-INDEPENDENT. Bruce 2026-08-11: 'we want banked PC "
     "spotlights built into the modules so we don't need to keep repeating them — that's what the "
     "S-HELPER module is for.' ⇒ The banked SITUATION lives here once; a session module holds only "
     "that session's USE of it. Five PC spotlight banks with their guardrails, all thirteen stations "
     "with who holds them, and two end-of-tour crew events. "
     "💸 Marina is in spotlight ARREARS since S9 — pay hers first. "
     "⛔ Banked beats carry guardrails and BRUCE spends them; these surface and stop.")},
 "sections": [
  {"id": "c-ship", "title": "🛰 THE SHIP", "kind": "section",
   "summary": "The Astral Dawn as a character and as numbers. She was the Amishi, and she crashed on Gorram before the crew dug her out.",
   "beatIds": [b[0] for b in SHIP_BEATS]},
  {"id": "c-banked", "title": "💸 BANKED PC SPOTLIGHTS", "kind": "section",
   "summary": "The standing situation per PC, with the guardrail that matters more than the beat. Marina first — arrears since S9.",
   "beatIds": [b[0] for b in PC_CARDS]},
  {"id": "c-stations", "title": "STATIONS — PC-occupied", "kind": "section",
   "summary": "Who holds each seat and what it is for. Only the five stations PCs actually occupy. ⭐ The Astrogator chair is EMPTY — see the Captain card.",
   "beatIds": [b[0] for b in STATION_BEATS]},
  {"id": "c-events", "title": "⭐ END-OF-TOUR CREW EVENTS", "kind": "section",
   "summary": "Eight or nine months aboard. The NPCs the PCs trained now do things back at them.",
   "beatIds": [b[0] for b in EVENT_BEATS]},
 ],
 "beats": [{"id": b[0], "title": b[1], "component": "map",
   "section": ("c-ship" if b[0].startswith("ad-") else
               "c-banked" if b[0].startswith("bank-") else
               "c-events" if b[0].startswith("ev-") else "c-stations"),
   "onDemand": True, "durationSec": 0,
   "opts": {"svg": b[2], "title": b[1], "laser": True, "controllable": False,
            "cursors": "all", "fit": "contain",
            "note": (b[3] if len(b) > 3 else "STANDING — reusable every session. See the card for guardrails.")}}
           for b in ALL],
}
json.dump(mod, open(OUT, "w"), indent=1)
print(f"wrote {OUT}")
print(f"  {len(ALL)} beats = {len(PC_CARDS)} banked PC + {len(STATION_BEATS)} stations + {len(EVENT_BEATS)} events")
