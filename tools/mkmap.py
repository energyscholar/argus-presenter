import math, json

# Bowman (1132) — canon: M0V, L=0.13982, HZ 0.39-0.74, jump shadow 0.55, M-drive limit 5.5, snow line 1.01
ORB = [
    (0.40, "jump shadow edge",           None,        "#3a4a5e", 0),
    (0.70, "BELT I · the 'mainworld'", "belt",     "#c9a227", 204),
    (1.00, "snow line",                  "snow",       "#4a7fb5", 170),
    (1.60, "BELT II · working belt", "belt",       "#9aa7b8", 135),
    (2.80, "",                           None,         "#2e3a4a", 102),
    (5.20, "BOWMAN PRIME + rings",       "giant",      "#d08a3e", 75),
    (10.00,"BELT III",                   "belt",       "#8a3d3d", 54),
]
def r(au, W):           # sqrt scale so 10 AU fits with the inner system legible
    return 60 + (W-90) * math.sqrt(au/10.0)

def build(gm):
    W = 470
    P = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="-500 -500 1000 1000">',
         '<defs><radialGradient id="star"><stop offset="0" stop-color="#ffd9a8"/><stop offset="1" stop-color="#c9563a"/></radialGradient>',
         '<radialGradient id="gg"><stop offset="0" stop-color="#e8b174"/><stop offset="1" stop-color="#9c5f24"/></radialGradient>',
         '<radialGradient id="glow"><stop offset="0" stop-color="#c9563a" stop-opacity=".33"/><stop offset="1" stop-color="#c9563a" stop-opacity="0"/></radialGradient></defs>',
         '<rect x="-500" y="-500" width="1000" height="1000" fill="#080b11"/>']
    # starfield
    import random; random.seed(1132)
    for i in range(150):
        x,y = random.uniform(-495,495), random.uniform(-495,495)
        if math.hypot(x,y) < 70: continue
        o = random.uniform(.12,.6); s = random.choice([.6,.6,.8,1.1])
        P.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{s}" fill="#cfe0f5" opacity="{o:.2f}"/>')
    P.append('<circle cx="0" cy="0" r="150" fill="url(#glow)"/>')
    # habitable zone band
    a,b = r(0.39,W), r(0.74,W)
    P.append(f'<circle cx="0" cy="0" r="{(a+b)/2:.1f}" fill="none" stroke="#2f6b4a" stroke-width="{b-a:.1f}" opacity=".09"/>')
    for au,label,kind,col,teq in ORB:
        rad = r(au,W)
        if kind == "belt":
            n = 130 if au<9 else 150
            P.append(f'<g opacity="{".95" if (gm and au>9) else ".8"}">')
            for i in range(n):
                th = random.uniform(0,2*math.pi); rr = rad + random.uniform(-7,7)
                P.append(f'<circle cx="{rr*math.cos(th):.1f}" cy="{rr*math.sin(th):.1f}" r="{random.uniform(.9,2.3):.1f}" fill="{col}" opacity="{random.uniform(.45,1):.2f}"/>')
            P.append('</g>')
        elif kind == "snow":
            P.append(f'<circle cx="0" cy="0" r="{rad:.1f}" fill="none" stroke="{col}" stroke-width="1.2" stroke-dasharray="3 7" opacity=".75"/>')
        else:
            P.append(f'<circle cx="0" cy="0" r="{rad:.1f}" fill="none" stroke="{col}" stroke-width=".9" opacity=".5"/>')
    # star
    P.append('<circle cx="0" cy="0" r="17" fill="url(#star)"/>')
    P.append('<text x="0" y="42" fill="#e8a87c" font-family="ui-monospace,monospace" font-size="13" text-anchor="middle">BOWMAN · M0 V</text>')
    # gas giant on orbit 6
    gx, gy = r(5.2,W)*math.cos(math.radians(-72)), r(5.2,W)*math.sin(math.radians(-72))
    P.append(f'<ellipse cx="{gx:.0f}" cy="{gy:.0f}" rx="34" ry="9" fill="none" stroke="#c79a5e" stroke-width="3" opacity=".55" transform="rotate(-24 {gx:.0f} {gy:.0f})"/>')
    P.append(f'<circle cx="{gx:.0f}" cy="{gy:.0f}" r="15" fill="url(#gg)"/>')
    lx = gx - 26
    P.append(f'<text x="{lx:.0f}" y="{gy-20:.0f}" fill="#e8b174" font-family="ui-monospace,monospace" font-size="14" text-anchor="end">BOWMAN PRIME</text>')
    P.append(f'<text x="{lx:.0f}" y="{gy-5:.0f}" fill="#8e9bb0" font-family="ui-monospace,monospace" font-size="11" text-anchor="end">gas giant · 12 moons · ring system</text>')
    P.append(f'<text x="{lx:.0f}" y="{gy+12:.0f}" fill="#7ec8a0" font-family="ui-monospace,monospace" font-size="11.5" text-anchor="end">ALPHA — Garrison Starport + IISS · pop 3,000</text>')
    P.append(f'<text x="{lx:.0f}" y="{gy+27:.0f}" fill="#7ec8a0" font-family="ui-monospace,monospace" font-size="11.5" text-anchor="end">EPSILON — Darrian ruin, 2,000 yr</text>')
    P.append(f'<text x="{lx:.0f}" y="{gy+42:.0f}" fill="#8e9bb0" font-family="ui-monospace,monospace" font-size="11" text-anchor="end">Prometheus · Epimetheus — LSP, Trojan pts</text>')
    # labels for belts
    def lab(au, text, sub, col, ang=138):
        rad=r(au,W); x,y = rad*math.cos(math.radians(ang)), rad*math.sin(math.radians(ang))
        P.append(f'<line x1="{x:.0f}" y1="{y:.0f}" x2="{x-58:.0f}" y2="{y-30:.0f}" stroke="{col}" stroke-width=".8" opacity=".6"/>')
        P.append(f'<text x="{x-62:.0f}" y="{y-34:.0f}" fill="{col}" font-family="ui-monospace,monospace" font-size="13" text-anchor="end">{text}</text>')
        if sub: P.append(f'<text x="{x-62:.0f}" y="{y-20:.0f}" fill="#8e9bb0" font-family="ui-monospace,monospace" font-size="10.5" text-anchor="end">{sub}</text>')
    lab(0.70,"BELT I","the UWP 'mainworld' — no planet","#c9a227",168)
    lab(1.60,"BELT II","the working belt","#9aa7b8",122)
    lab(1.00,"snow line 1.01 AU","ice — and fuel — free beyond","#4a7fb5",204)
    lab(10.0,"BELT III","the outer belt · 10 AU · 54 K","#8a7a7a",108)
    if gm:
        rad=r(10,W); x,y=rad*math.cos(math.radians(52)), rad*math.sin(math.radians(52))
        P.append(f'<circle cx="0" cy="0" r="{rad:.1f}" fill="none" stroke="#c04a4a" stroke-width="1.4" stroke-dasharray="9 6" opacity=".85"/>')
        P.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="26" fill="none" stroke="#e05252" stroke-width="1.6"/>')
        P.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="5" fill="#e05252"/>')
        for t,dy,c,sz in [("🔒 BELT III — THE BASE",-46,"#ff6b6b",15),
                          ("10 AU · 54 K · 83 light-minutes",-30,"#f0b429",11.5),
                          ("SCAN SHOWS: tug, mobile base,",44,"#9aa7b8",11),
                          ("smallcraft, 2× Seeker miners",57,"#9aa7b8",11),
                          ("HIDDEN: armed 400t + 3–4 raiders",73,"#ff6b6b",11.5),
                          ("array resolves ONLY IF THEY LOOK",86,"#ff6b6b",11.5)]:
            P.append(f'<text x="{x:.0f}" y="{y+dy:.0f}" fill="{c}" font-family="ui-monospace,monospace" font-size="{sz}" text-anchor="middle">{t}</text>')
    # header
    t1 = "BOWMAN 1132 — GM" if gm else "BOWMAN 1132"
    P.append(f'<text x="-478" y="-455" fill="#f0b429" font-family="ui-monospace,monospace" font-size="17" letter-spacing="2">{t1}</text>')
    P.append(f'<text x="-478" y="-434" fill="#8e9bb0" font-family="ui-monospace,monospace" font-size="11.5">M0 V · 0.57 M☉ · L 0.140 · 8,000 sophonts · NO INHABITED PLANET</text>')
    P.append(f'<text x="-478" y="-418" fill="#8e9bb0" font-family="ui-monospace,monospace" font-size="11.5">jump shadow 0.55 AU · M-drive limit 5.5 AU · snow line 1.01 AU</text>')
    if gm: P.append('<text x="-478" y="470" fill="#e05252" font-family="ui-monospace,monospace" font-size="12">🔒 GM ONLY — DO NOT STAGE TO PLAYERS</text>')
    P.append('</svg>')
    return "".join(P)

if __name__ == "__main__":
  for gm,name in ((False,"art1-player.svg"),(True,"art1g-gm.svg")):
    s=build(gm); open(name,"w").write(s); print(f"{name}: {len(s):,} bytes")
