#!/usr/bin/env python3
"""
Build the ship guides: /ships/ and one page per published ship at /ships/<slug>/.

Why this exists: a guest searching "where does Carnival Breeze dock in Cozumel" gets a
straight answer from the port authority's own records, the walk to our meeting point, her
next dates in port, and a "See your price" button that opens the homepage with her ship
already in the booking bar (?ship=…&utm_source=ship_guide&utm_content=<slug>).

Sources, all read fresh on every run:
  • APIQROO history feed (build_ship_list.fetch) — every call since January 2024, plus the
    port's forward list for the coming weeks.
  • /.netlify/functions/ships-today on the live site — the day-by-day window the booking
    bar uses, and the terminal the port lists for each ship in it.
  • /.netlify/functions/port-rate on the live site — the discount for each date in that
    window. Dates beyond it are shown WITHOUT a percent.
  • index.html — the vehicle price ladder (VEH) and drive times (DEST). Nothing is typed twice.

The rules (Mike, 2026-09-24):
  • A call counts only if it happened: status green, before the build date. Cancelled
    (red) and future calls are left out. Anchorages are calls but never get a pier.
  • "Usually <terminal>" only when one terminal has ≥70% of ≥3 berthed calls in the last
    12 months (rolling, ending the build date), and the count is always shown. Otherwise
    "It varies", with the split. Since-January-2024 numbers appear as secondary context.
  • /ships/ lists every ship with ≥10 calls in the last 12 months. Ships in the published
    list get "Read guide"; the rest say "Coming soon".

Adding guides (the weekly job): append up to 10 slugs to "published" in
data/ship-guides.json — pick from "candidates" there, which is the unpublished part of the
list in call order — then run this script. It refuses a slug that is not on the list. It
rewrites ships/, the stats in data/ship-guides.json, the ship-guides block of sitemap.xml
and the "## Ship guides" section of llms.txt. Commit all of them together.

    python3 scripts/build_ship_guides.py
    python3 scripts/build_ship_guides.py --dry-run        # print, write nothing
    python3 scripts/build_ship_guides.py --cache /tmp/x   # reuse fetched past months

Stdlib only.
"""

import argparse
import collections
import datetime as dt
import html as htmllib
import json
import re
import sys
import urllib.request
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_ship_list as bsl  # noqa: E402  normalize(), normalize_terminal(), fetch(), infer_line()

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "ship-guides.json"
ORG = "https://cozumeltransfers.org"
FIRST_MONTH = (2024, 1)
MIN_CALLS_12M = 10
MIN_CALLS, MIN_SHARE = 3, 0.70
MAX_NEXT = 6
UA = "Mozilla/5.0 (Cozumel Transfers ship-guide builder)"
E = htmllib.escape

TERM_COLOR = {"Puerta Maya": "#1D7AFC", "International Pier": "#0F2C44", "Punta Langosta": "#12A07A"}
MEET = {"Puerta Maya": "puerta-maya", "International Pier": "ssa-mexico", "Punta Langosta": "punta-langosta"}
# Summarised from meet/*.html. No venue or shop names.
WALK = {
 "Puerta Maya": ("Turn left out of the terminal and stay on the ocean side of the street. Walk on past the gas station to the shopping mall, cross the street there, and we are waiting with a sign with your name.",
                 "Flat and paved, with a sidewalk the whole way. No steps, no hills."),
 "International Pier": ("Walk out of the terminal and turn right. Follow the shopping-center signs to the corner crossing, cross the street, and we are waiting with a sign with your name.",
                        "Flat and paved, with a sidewalk the whole way. No steps, no hills."),
 "Punta Langosta": ("Walk out through the terminal's shopping mall on the second floor. Take the stairs down at the far end and find the white lighthouse on the seafront. We are waiting underneath it with a sign with your name.",
                    "The walk is inside the terminal building, with stairs down to the street at the far end."),
}
NOTICE = ("The port sets each ship's berth day by day. Our booking bar looks up her exact date, "
          "and we confirm your terminal by email the day before.")


# ── data ────────────────────────────────────────────────────────────────────────
def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def months(today):
    y, m = FIRST_MONTH
    end = (today.year + (today.month + 2) // 12, (today.month + 2) % 12 + 1)   # three months ahead
    while (y, m) <= end:
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def history(today, cache):
    """Every row of the history feed from January 2024 to three months ahead, with date and status."""
    rows = []
    for y, m in months(today):
        page = None
        f = cache / f"{y}-{m:02d}.html" if cache else None
        if f and f.exists() and (y, m) < (today.year, today.month):
            page = f.read_text()
        if page is None:
            try:
                page = bsl.fetch(y, m)
            except Exception as e:                        # a future month simply has no data yet
                print(f"  {y}-{m:02d}  skipped ({e})", file=sys.stderr)
                continue
            if f:
                f.write_text(page)
        for row in re.findall(r'<tr id="tr-id-\d+".*?</tr>', page, re.S):
            cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
            if len(cells) < 7:
                continue
            st = lambda c: htmllib.unescape(re.sub(r"<[^>]+>", " ", c)).strip()
            port, ship, fecha = st(cells[0]), st(cells[2]), st(cells[3])
            name = bsl.normalize(ship)
            if not name or fecha.count("/") != 2:
                continue
            d, mo, yr = fecha.split("/")
            status = (re.search(r"circle_(\w+)\.png", cells[6]) or [None, "?"])[1]
            rows.append(dict(date=f"{yr}-{int(mo):02d}-{int(d):02d}", name=name,
                             terminal=bsl.normalize_terminal(port), status=status))
    return rows


def slug(n):
    return re.sub(r"[^a-z0-9]+", "-", n.lower()).strip("-")


def counts(rs):
    c = collections.Counter(r["terminal"] for r in rs if r["terminal"])
    return dict(c.most_common())


def summarize(name, rs, since):
    recent = [r for r in rs if r["date"] >= since]
    t_all, t12 = counts(rs), counts(recent)
    b12 = sum(t12.values())
    top, hits = next(iter(t12.items()), (None, 0))
    usual = top if b12 >= MIN_CALLS and hits / b12 >= MIN_SHARE else None
    return dict(name=name, slug=slug(name), line=bsl.infer_line(name),
                calls=len(rs), berthed=sum(t_all.values()), anchored=sum(1 for r in rs if not r["terminal"]),
                byTerminal=t_all,
                calls12=len(recent), berthed12=b12, anchored12=sum(1 for r in recent if not r["terminal"]),
                byTerminal12=t12, usualPier=usual, usualHits=hits if usual else None,
                usualShare=round(hits / b12, 2) if usual else None,
                singles12={t: [r["date"] for r in recent if r["terminal"] == t]
                           for t, c in t12.items() if c == 1})


def next_dates(name, live, rates, rows, today_iso):
    pub = live["published"]
    out = []
    for d in sorted(pub["byDay"]):
        if d < today_iso:
            continue
        hit = [s for s in pub["byDay"][d] if bsl.normalize(s["ship"]) == name]
        if not hit:
            continue
        rate = rates(d)
        o = dict(date=d, inWindow=True, ships=len(pub["byDay"][d]),
                 terminal=bsl.normalize_terminal("TERMINAL " + hit[0]["port"]))
        if rate.get("basis") == "published":
            pcts = sorted(set(rate["vehicles"].values()))
            o.update(ships=rate["ships"], percent=pcts[0], percentMax=pcts[-1])
        out.append(o)
    for r in sorted(rows, key=lambda r: r["date"]):
        if r["name"] == name and r["date"] > pub["to"] and r["status"] != "red":
            out.append(dict(date=r["date"], inWindow=False, terminal=r["terminal"]))
    for o in out:
        o["label"] = dt.date.fromisoformat(o["date"]).strftime("%a %-d %b")
    return out[:MAX_NEXT]


def site_tables():
    idx = (ROOT / "index.html").read_text()
    veh = re.search(r"const VEH = \[(.*?)\];", idx, re.S).group(1)
    VEH = [dict(max=int(m[0]), name=m[1], price=int(m[3])) for m in
           re.findall(r"\{max:(\d+),\s*name:'([^']+)',\s*sub:'([^']+)',\s*price:(\d+)\}", veh)]
    dest = re.search(r"const DEST = \{(.*?)\n\};", idx, re.S).group(1)
    DEST = [dict(slug=m[0], name=m[1], short=m[2], type=m[3], drive=m[4]) for m in
            re.findall(r"'([a-z-]+)':\{name:'([^']+)',short:'([^']+)',\s*type:'([^']+)',drive:'([^']+)'", dest)]
    if not VEH or not DEST:
        sys.exit("could not read VEH / DEST from index.html")
    return VEH, DEST


# ── words ───────────────────────────────────────────────────────────────────────
def once(n):
    return {1: "once", 2: "twice"}.get(n, f"on {n}")


def the(t):
    return "the " + t if t == "International Pier" else t


def at(t):
    return "at anchor" if t is None else "at " + the(t)


def fmtdate(iso):
    return dt.date.fromisoformat(iso).strftime("%a %-d %b %Y")


def andjoin(parts):
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


def split_phrase(counter, total):
    """'Punta Langosta on 40 of her 70 calls, the International Pier on 29 and Puerta Maya once'"""
    items = list(counter.items())
    parts = [f"{the(items[0][0])} on {items[0][1]} of her {total} calls"]
    parts += [f"{the(t)} {once(c)}" for t, c in items[1:]]
    return andjoin(parts)


# ── page ────────────────────────────────────────────────────────────────────────
CSS = """
:root{--ink:#0E0E10;--navy:#0F2C44;--deep:#0B1E2E;--mute:#4A5663;--line:#E5E5E7;--surface:#F4F8FA;
 --accent:#1D7AFC;--accent-pressed:#0F62D6;--success-deep:#1F7A3F;--card-blue:#E8F0FB;--card-green:#E6F4EA;
 --shadow:0 1px 2px rgba(14,14,16,.04),0 8px 24px rgba(14,14,16,.06)}
*{box-sizing:border-box}
html,body{overflow-x:hidden}
body{margin:0;background:#fff;color:var(--ink);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
 font-size:18px;line-height:1.6;-webkit-font-smoothing:antialiased;padding-top:64px}
a{color:var(--accent-pressed)}
.num{font-variant-numeric:tabular-nums}
.v2nav{position:fixed;top:0;left:0;right:0;z-index:950;height:64px;background:#0B1E2E;border-bottom:1px solid rgba(255,255,255,.14);
 display:flex;align-items:center;gap:16px;padding:0 18px}
.v2nav .v2-brand{display:flex;align-items:center;min-height:48px;text-decoration:none}
.v2nav .v2-brand img{height:26px;width:auto;display:block}
.v2nav .v2-links{display:flex;gap:6px;margin-left:auto;margin-right:auto}
.v2nav .v2-links a{display:inline-flex;align-items:center;min-height:48px;padding:0 14px;border-radius:10px;color:#DCE6EF;
 text-decoration:none;font-size:16px;font-weight:600;letter-spacing:-.01em}
.v2nav .v2-links a:hover{background:rgba(255,255,255,.10);color:#fff}
.v2nav .v2-wa{margin-left:auto;display:inline-flex;align-items:center;min-height:48px;padding:0 20px;border-radius:999px;
 background:#25D366;color:#fff;text-decoration:none;font-size:16px;font-weight:700;white-space:nowrap}
@media(max-width:940px){.v2nav{height:60px;padding:0 14px}.v2nav .v2-links{display:none}.v2nav .v2-brand img{height:23px}
 .v2nav .v2-wa{padding:0 16px;font-size:15px;min-height:48px}body{padding-top:60px}}
.hero{background:var(--deep);color:#fff;padding:26px 16px 34px}
.col{max-width:760px;margin:0 auto}
.crumb{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin:0 0 14px}
.crumb a{display:inline-flex;align-items:center;min-height:48px;color:#CFE0EE;font-weight:600;font-size:18px;text-decoration:none}
.crumb a:hover{text-decoration:underline}
.crumb span{color:#8FA3B5;font-size:18px}
.kick{font-size:14px;font-weight:800;letter-spacing:.13em;text-transform:uppercase;color:rgba(255,255,255,.72)}
h1{font-size:clamp(30px,5.4vw,44px);line-height:1.08;letter-spacing:-.03em;font-weight:800;margin:10px 0 16px}
.answer{font-size:21px;line-height:1.5;color:#fff;margin:0 0 10px;max-width:36em}
.answer b{color:#fff}
.sub{font-size:18px;color:#CFE0EE;margin:0;max-width:38em}
.bars{margin-top:22px;display:grid;gap:14px}
.bar-l{display:flex;justify-content:space-between;gap:10px;font-size:15px;font-weight:700;color:#CFE0EE;margin-bottom:6px}
.bar{display:flex;height:34px;border-radius:10px;overflow:hidden;background:rgba(255,255,255,.1)}
.bar i{display:block;height:100%;min-width:4px}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:16px;color:#E6EEF5;margin-top:4px}
.legend b{font-weight:800}
.sw{display:inline-block;width:14px;height:14px;border-radius:4px;margin-right:7px;vertical-align:-1px;border:1px solid rgba(255,255,255,.5)}
main section{padding:34px 16px 6px}
h2{font-size:26px;line-height:1.2;letter-spacing:-.02em;color:var(--navy);margin:0 0 12px;font-weight:800}
p{margin:0 0 14px}
.muted{color:var(--mute)}
.notice{background:var(--card-blue);border-left:5px solid var(--accent);border-radius:12px;padding:16px 18px;margin:26px auto 0;max-width:760px}
.notice p{margin:0}
.notice-wrap{padding:0 16px}
.next{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.next li{border:1px solid var(--line);border-radius:14px;padding:16px 18px;box-shadow:var(--shadow);background:#fff}
.next .d{font-size:21px;font-weight:800;color:var(--navy)}
.next .m{font-size:18px;margin-top:2px}
.pill{display:inline-block;font-size:16px;font-weight:800;border-radius:999px;padding:3px 12px;white-space:nowrap}
.pill.go{background:var(--card-green);color:var(--success-deep)}
.pill.no{background:var(--surface);color:var(--mute);border:1px solid var(--line)}
.next .t{font-size:18px;color:var(--mute);margin-top:6px}
.headline{font-size:19px;font-weight:700;color:var(--navy);background:var(--surface);border-radius:12px;padding:14px 16px;margin:0 0 14px}
.price{background:var(--deep);color:#fff;border-radius:18px;padding:24px 20px;margin-top:4px}
.price .pl{font-size:24px;font-weight:800;letter-spacing:-.02em;line-height:1.3;margin:0 0 6px}
.price p{color:#CFE0EE;margin:0 0 18px}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:58px;padding:0 30px;border-radius:999px;
 background:var(--accent);color:#fff;font-size:19px;font-weight:800;text-decoration:none;width:100%;max-width:360px}
.btn:hover{background:var(--accent-pressed)}
.walks{display:grid;gap:14px}
.walk{border:1px solid var(--line);border-radius:14px;padding:18px;background:#fff;box-shadow:var(--shadow)}
.walk h3{margin:0 0 4px;font-size:21px;color:var(--navy);display:flex;align-items:center;gap:10px}
.walk .dur{font-size:18px;font-weight:700;color:var(--success-deep);margin-bottom:8px}
.walk .more{display:inline-flex;align-items:center;min-height:48px;font-weight:700;text-decoration:none}
.walk .more:hover{text-decoration:underline}
.walk .cnt{font-size:18px;color:var(--mute);margin-top:-4px;margin-bottom:8px}
table{width:100%;border-collapse:collapse;font-size:18px}
th,td{text-align:left;padding:12px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--mute);font-weight:800}
td.r,th.r{text-align:right;white-space:nowrap}
td .ty{display:block;font-size:16px;color:var(--mute)}
.src{background:var(--surface);border-radius:14px;padding:18px;font-size:18px}
.src h2{font-size:20px}
details.faq{border-bottom:1px solid var(--line)}
details.faq summary{list-style:none;cursor:pointer;min-height:56px;display:flex;align-items:center;justify-content:space-between;gap:12px;
 font-size:19px;font-weight:700;color:var(--navy);padding:10px 0}
details.faq summary::-webkit-details-marker{display:none}
details.faq summary .fa{font-size:26px;color:var(--accent);flex:none}
details.faq[open] summary .fa{transform:rotate(45deg)}
details.faq p{margin:0 0 18px}
.end{height:40px}
footer{background:#0B1E2E;padding:34px 16px 42px;border-top:1px solid rgba(255,255,255,.14);margin-top:40px}
footer,footer *{font-family:Inter,-apple-system,sans-serif;font-size:15px;line-height:23px;font-weight:400;letter-spacing:-.15px;color:#A4AFB8}
footer > *{max-width:1060px;margin-left:auto;margin-right:auto}
footer p{margin:0;max-width:34em}
.ft-g{margin-bottom:28px}
.ft-g > a{display:flex;align-items:center;min-height:48px;text-decoration:none;margin-bottom:2px}
.ft-tel{color:#fff !important;font-size:19px !important;font-variant-numeric:tabular-nums;white-space:nowrap}
.ft-wa{display:inline-block;font-size:11px !important;font-weight:700 !important;letter-spacing:.1em !important;text-transform:uppercase;
 color:#7FD4A0 !important;margin-left:8px}
footer .ft-mail{font-size:17px !important;color:#CFE0EE !important;overflow-wrap:anywhere;text-decoration:underline;text-underline-offset:4px}
.ft-pol{display:flex;flex-wrap:wrap;column-gap:26px}
.ft-pol a{display:inline-flex;align-items:center;min-height:48px;text-decoration:underline;text-decoration-color:rgba(164,175,184,.4);text-underline-offset:4px}
.ft-legal{margin-top:34px;padding-top:26px;border-top:1px solid rgba(255,255,255,.10)}
.ft-legal p{color:#7C8A96;font-size:13.5px;line-height:21px}
.ft-legal p + p{margin-top:8px}
.line-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:0 0 8px}
.line-h h2{margin:0}
.line-h .c{font-size:16px;color:var(--mute);white-space:nowrap}
.ships{list-style:none;margin:0 0 8px;padding:0;border-top:1px solid var(--line)}
.ships li{display:flex;align-items:center;gap:12px;min-height:64px;padding:10px 0;border-bottom:1px solid var(--line)}
.ships .nm{flex:1;min-width:0}
.ships .nm b{display:block;font-size:19px;color:var(--navy);line-height:1.3}
.ships .nm span{display:block;font-size:18px;color:var(--mute);line-height:1.4}
.ships a.go{display:inline-flex;align-items:center;min-height:48px;padding:0 18px;border-radius:999px;background:var(--accent);color:#fff;
 font-weight:800;font-size:16px;text-decoration:none;white-space:nowrap;flex:none}
.ships .soon{font-size:15px;font-weight:700;color:var(--mute);background:var(--surface);border:1px solid var(--line);border-radius:999px;
 padding:5px 12px;white-space:nowrap;flex:none}
.ships a.row{color:inherit;text-decoration:none}
@media(min-width:760px){main section{padding:40px 24px 6px}.hero{padding:30px 24px 40px}.notice-wrap{padding:0 24px}}
"""

# Hides next dates that have passed since the build, and moves the headline to the first one left.
PRUNE = """<script>
(function(){var t=new Date(Date.now()-5*36e5).toISOString().slice(0,10),L=document.querySelectorAll('.next li[data-d]'),h=document.getElementById('nextH'),f=null;
for(var i=0;i<L.length;i++){if(L[i].getAttribute('data-d')<t)L[i].hidden=true;else if(!f)f=L[i];}
if(h)h.textContent=f?f.getAttribute('data-h'):h.getAttribute('data-none');})();
</script>"""


def head(title, desc, canonical, jsonld=""):
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{E(title)}</title>
<meta name="description" content="{E(desc)}">
<link rel="canonical" href="{canonical}">
<link rel="icon" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>{CSS}</style>{jsonld}
</head><body>
<nav class="v2nav">
  <a class="v2-brand" href="/" aria-label="Cozumel Transfers home"><img src="/assets/logo/cit-logo-horizontal-reverse.svg" alt="Cozumel Transfers"></a>
  <div class="v2-links">
    <a href="/#sec-destinations">Destinations</a><a href="/#sec-guests">Happy guests</a><a href="/#sec-how">How it works</a>
    <a href="/#sec-reviews">Reviews</a><a href="/#sec-faq">Questions</a>
  </div>
  <a class="v2-wa" href="https://wa.me/5219871146853" target="_blank" rel="noopener">WhatsApp us</a>
</nav>
"""


FOOT = """<footer>
  <div class="ft-g">
    <a class="ft-tel" href="https://wa.me/5219871146853" target="_blank" rel="noopener">+52 987 114 6853 <span class="ft-wa">on WhatsApp</span></a>
    <p>Message us on WhatsApp — it's the fastest way to reach us, and it's how we answer you in English.</p>
    <a class="ft-mail" href="mailto:hello@cozumelislandtransfers.com">hello@cozumelislandtransfers.com</a>
    <p>Someone answers 9 AM – 5 PM, Cozumel time (UTC−5, year round).</p>
  </div>
  <div class="ft-g ft-pol">
    <a href="/ships/">Ship guides</a>
    <a href="/terms.html#cancellation">Cancellation &amp; refunds</a>
    <a href="/terms.html">Terms of use</a>
    <a href="/privacy.html">Privacy policy</a>
  </div>
  <div class="ft-legal">
    <p>Cozumel Island Transfers, S. de R.L. de C.V.<br>San Miguel de Cozumel, Quintana Roo, México</p>
    <p>Licensed private ground-transfer operator · permit no. 483290</p>
    <p class="ft-cr">© 2015–2026 Cozumel Island Transfers</p>
  </div>
</footer>
"""


def bar(label, cnt, total):
    segs = "".join(f'<i style="width:{c/total*100:.2f}%;background:{TERM_COLOR[t]}" title="{E(t)}: {c}"></i>' for t, c in cnt.items())
    leg = "".join(f'<span><span class="sw" style="background:{TERM_COLOR[t]}"></span>{E(t)} <b class="num">{c}</b></span>' for t, c in cnt.items())
    return (f'<div><div class="bar-l"><span>{E(label)}</span><span class="num">{total} calls</span></div>'
            f'<div class="bar" role="img" aria-label="{E(label)}: ' + ", ".join(f"{t} {c}" for t, c in cnt.items()) +
            f'">{segs}</div><div class="legend">{leg}</div></div>')


def book_url(x):
    return f"{ORG}/?ship={quote(x['name'])}&utm_source=ship_guide&utm_content={x['slug']}"


def ship_page(x, ctx):
    name = x["name"]
    b12, t12, ba, ta = x["berthed12"], x["byTerminal12"], x["berthed"], x["byTerminal"]
    if not b12:
        sys.exit(f"{name}: no berthed calls in the last 12 months — nothing true to say about her pier")
    since_all = f"Since January 2024: {split_phrase(ta, ba)}."
    if x["usualPier"]:
        up, h = x["usualPier"], x["usualHits"]
        answer = (f"<b>{E(name)} usually docks at {E(the(up))}</b>: she tied up there on "
                  f"<b class='num'>{h} of her {b12} calls in the last 12 months</b>.")
        others = [the(t) + (f", on {fmtdate(x['singles12'][t][0])}" if t in x["singles12"] else f" ({c} calls)")
                  for t, c in t12.items() if t != up]
        sub = ""
        if others:
            sub += ("The other calls were" if b12 - h > 1 else "The other call was") + " at " + andjoin(others) + ". "
        sub += since_all
        faq1 = (f"At {the(up)} on {h} of her {b12} calls in the last 12 months"
                + (f"; the other{'s were' if b12 - h > 1 else ' was'} at " + andjoin([the(t) for t in t12 if t != up]) if others else "")
                + f". {since_all} The port sets the berth each day, so we confirm your terminal by email the day before.")
        walk_terms = [up]
    else:
        answer = f"<b>It varies.</b> In the last 12 months, {E(name)} has docked at {E(split_phrase(t12, b12))}."
        sub = since_all
        faq1 = (f"It varies. In the last 12 months: {split_phrase(t12, b12)}. {since_all} "
                "The port sets the berth each day; the booking bar looks up her exact date, and we confirm your terminal by email the day before.")
        walk_terms = list(t12)
    if x["anchored"]:
        sub += f" She also lay at anchor {once(x['anchored'])} since January 2024; those calls have no pier."
    bars = bar("Last 12 months", t12, b12) + bar("Since January 2024", ta, ba)

    # next dates
    items = []
    for o in x["next"]:
        if o["inWindow"] and o.get("percent") is not None:
            pct = f"{o['percent']}%" if o["percent"] == o["percentMax"] else f"{o['percent']}–{o['percentMax']}%"
            ships = f"{o['ships']} ship{'s' if o['ships'] != 1 else ''} in port"
            kind = "Quiet-day discount" if o["ships"] <= 4 else "Discount"
            h = f"Next in Cozumel: {o['label']} · {ships} · {pct} off"
            items.append(f'<li data-d="{o["date"]}" data-h="{E(h)}"><div class="d">{o["label"]}</div><div class="m"><span class="num">{ships}</span> · '
                         f'<span class="pill go">{pct} off</span></div>'
                         f'<div class="t">The port lists her {E(at(o["terminal"]))}. {kind} on every vehicle, applied at checkout.</div></li>')
        elif o["inWindow"]:
            ships = f"{o['ships']} ship{'s' if o['ships'] != 1 else ''} in port"
            h = f"Next in Cozumel: {o['label']} · {ships}"
            items.append(f'<li data-d="{o["date"]}" data-h="{E(h)}"><div class="d">{o["label"]}</div><div class="m"><span class="num">{ships}</span></div>'
                         f'<div class="t">The port lists her {E(at(o["terminal"]))}. The booking bar shows your discount when you pick the date.</div></li>')
        else:
            h = f"Next in Cozumel: {o['label']} · {at(o['terminal'])} · day not published yet"
            items.append(f'<li data-d="{o["date"]}" data-h="{E(h)}"><div class="d">{o["label"]}</div><div class="m"><span class="pill no">Day not published yet</span></div>'
                         f'<div class="t">On the port\'s forward list {E(at(o["terminal"]))}. No discount shown here yet.</div></li>')
    none = "Next in Cozumel: not on the port's schedule yet"
    first = re.search(r'data-h="([^"]*)"', items[0]).group(1) if items else E(none)
    nextsec = (f'<p class="headline num" id="nextH" data-none="{E(none)}">{first}</p>'
               + (f'<ul class="next">{"".join(items)}</ul>' if items else "")
               + f'<p class="muted" style="margin-top:14px">The port has published its day-by-day schedule to {ctx["pubTo"]}. '
               f'“Ships in port” is the number of ships it lists for that day. Dates after {ctx["pubTo"]} come from its forward list, so no discount is shown '
               f'for them here: the booking bar shows yours when you pick the date.</p>')

    walks = []
    for t in walk_terms:
        a, b = WALK[t]
        cnt = ""
        if not x["usualPier"]:
            c = t12[t]
            cnt = (f'<div class="cnt num">She docked here ' + (f"on {c} of her {b12} calls" if c > 2 else once(c))
                   + " in the last 12 months</div>")
        walks.append(f'<div class="walk"><h3><span class="sw" style="background:{TERM_COLOR[t]};border-color:transparent"></span>From {E(the(t))}</h3>{cnt}'
                     f'<div class="dur">About 10 minutes on foot</div><p>{E(a)}</p><p class="muted">{E(b)}</p>'
                     f'<a class="more" href="/meet/{MEET[t]}.html">See the walk from {E(the(t))}, step by step →</a></div>')
    walk_intro = ("Aim to be with us 15 minutes before your pickup time, so leave the ship about 25 minutes before."
                  if x["usualPier"] else
                  "The walk depends on her terminal on your day. Aim to be with us 15 minutes before your pickup time, so leave the ship about 25 minutes before.")

    rows = "".join(f'<tr><td>{E(d["short"] if d["slug"] != "somewhere-else" else "Anywhere else on the island")}<span class="ty">{E(d["type"])}</span></td>'
                   f'<td class="r num">{E(d["drive"])}</td></tr>' for d in ctx["DEST"])
    v0 = ctx["VEH"][0]
    faq = [
        (f"Where does {name} dock in Cozumel?", faq1),
        (f"How long is the walk from {the(walk_terms[0])} to the van?" if x["usualPier"] else f"How will I know which terminal {name} uses on my day?",
         ("About 10 minutes, " + ("flat and paved with a sidewalk the whole way" if walk_terms[0] != "Punta Langosta" else "through the terminal and down the stairs to the seafront")
          + ". Leave the ship about 25 minutes before your pickup time.") if x["usualPier"] else
         "Put your ship and date in the booking bar: once the port has published that day, it shows her terminal. Either way, we email your terminal and meeting point the day before."),
        (f"How much is a private transfer from {name}?",
         f"From ${v0['price']} for a private round trip for up to {v0['max']} people. The price is for the whole vehicle, and it is the same to anywhere on the island."),
    ]
    faq_html = "".join(f'<details class="faq"><summary>{E(q)}<span class="fa">+</span></summary><p>{E(a)}</p></details>' for q, a in faq)
    jsonld = ('\n<script type="application/ld+json">' + json.dumps({"@context": "https://schema.org", "@type": "FAQPage",
              "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faq]},
              ensure_ascii=False, indent=1) + "</script>")
    title = f"Where does {name} dock in Cozumel? · Cozumel Transfers"
    desc = re.sub("<[^>]+>", "", answer) + " Walk, drive times and next dates in port."
    body = f"""<header class="hero"><div class="col">
  <div class="crumb"><a href="/ships/">← All ship guides</a><span>·</span><span>{E(x['line'] or '')}</span></div>
  <div class="kick">Ship guide · {E(x['line'] or '')}</div>
  <h1>Where does {E(name)} dock in Cozumel?</h1>
  <p class="answer">{answer}</p>
  <p class="sub">{E(sub.strip())}</p>
  <div class="bars">{bars}</div>
</div></header>
<div class="notice-wrap"><div class="notice"><p><b>Before you plan around this:</b> {E(NOTICE)}</p></div></div>
<main>
<section><div class="col"><h2>When is {E(name)} in Cozumel next?</h2>{nextsec}</div></section>
<section><div class="col"><div class="price"><p class="pl">{E(f"Private round trip from ${v0['price']} for up to {v0['max']}, whole vehicle")}</p>
  <p>Same price to anywhere on the island. Your discount is applied at checkout — there is no code to type.</p>
  <a class="btn" href="{E(book_url(x))}">See your price</a></div></div></section>
<section><div class="col"><h2>The walk to your van</h2><p>{E(walk_intro)}</p><div class="walks">{"".join(walks)}</div></div></section>
<section><div class="col"><h2>Drive times</h2><p>From the cruise piers, as on our home page. One flat price per vehicle, whichever you choose.</p>
  <table><thead><tr><th>Destination</th><th class="r">Drive</th></tr></thead><tbody>{rows}</tbody></table></div></section>
<section><div class="col"><h2>Questions</h2>{faq_html}</div></section>
<section><div class="col"><div class="src"><h2>Where these numbers come from</h2>
  <p>The Quintana Roo port authority's published schedule, updated weekly. Calls are counted from its records from 1 January 2024 to {ctx['counted']}; “the last 12 months” means {ctx['since']} to {ctx['counted']}. Cancelled calls are left out. Next dates as the port listed them on {ctx['todayL']}.</p></div></div></section>
<div class="end"></div>
</main>
"""
    return head(title, desc, f"{ORG}/ships/{x['slug']}/", jsonld) + body + FOOT + PRUNE + "\n</body></html>\n"


def index_page(index, published, ctx):
    lines = {}
    for x in index:
        lines.setdefault(x["line"] or "Other lines", []).append(x)
    order = sorted(lines, key=lambda l: (-sum(s["calls12"] for s in lines[l]), l))
    secs = []
    for l in order:
        lis = []
        for x in sorted(lines[l], key=lambda s: (-s["calls12"], s["name"])):
            anch = f" · {x['anchored12']} at anchor" if x["anchored12"] else ""
            if x["usualPier"]:
                meta = E(f"Usually {x['usualPier']} · {x['usualHits']} of {x['berthed12']} calls in the last 12 months{anch}")
            else:
                meta = (E("It varies · ") + " · ".join(E(f"{t} {c}").replace(" ", " ") for t, c in x["byTerminal12"].items())
                        + E(anch) + f"<br>{x['berthed12']} calls in the last 12 months")
            if x["slug"] in published:
                lis.append(f'<li><a class="row nm" href="/ships/{x["slug"]}/"><b>{E(x["name"])}</b><span class="num">{meta}</span></a>'
                           f'<a class="go" href="/ships/{x["slug"]}/">Read guide</a></li>')
            else:
                lis.append(f'<li><div class="nm"><b>{E(x["name"])}</b><span class="num">{meta}</span></div><span class="soon">Coming soon</span></li>')
        n = len(lines[l])
        secs.append(f'<section><div class="col"><div class="line-h"><h2>{E(l)}</h2><span class="c">{n} ship{"s" if n > 1 else ""}</span></div>'
                    f'<ul class="ships">{"".join(lis)}</ul></div></section>')
    n_split = sum(1 for x in index if not x["usualPier"])
    body = f"""<header class="hero"><div class="col">
  <div class="kick">Ship guides</div>
  <h1>Where does my cruise ship dock in Cozumel?</h1>
  <p class="answer">Cozumel has three cruise terminals: Puerta Maya, the International Pier and Punta Langosta. Here is where each of the {len(index)} ships that called at least 10 times in the last 12 months has docked, from the port authority's records.</p>
  <p class="sub">We say “usually” only when a ship used one terminal on at least 70% of at least 3 calls in the last 12 months. The {n_split} ships that split their calls say “it varies”, with the split.</p>
</div></header>
<div class="notice-wrap"><div class="notice"><p><b>Before you plan around this:</b> {E(NOTICE)}</p></div></div>
<main>{"".join(secs)}
<section><div class="col"><div class="src"><h2>Where these numbers come from</h2>
  <p>The Quintana Roo port authority's published schedule, updated weekly. “The last 12 months” means {ctx['since']} to {ctx['counted']}; cancelled calls are left out, and calls at anchor are never given a pier. Each guide also shows the ship's calls since 1 January 2024. Listed: every ship with at least 10 calls in the last 12 months.</p></div></div></section>
<div class="end"></div></main>
"""
    return (head("Where does my cruise ship dock in Cozumel? · Ship guides · Cozumel Transfers",
                 "Where each cruise ship docks in Cozumel — Puerta Maya, the International Pier or Punta Langosta — from the port authority's records.",
                 f"{ORG}/ships/") + body + FOOT + "</body></html>\n")


# ── sitemap + llms.txt ──────────────────────────────────────────────────────────
SM_START, SM_END = "  <!-- ship guides: written by scripts/build_ship_guides.py -->", "  <!-- /ship guides -->"


def sitemap(text, slugs, today_iso):
    urls = [f"{ORG}/ships/"] + [f"{ORG}/ships/{s}/" for s in slugs]
    block = SM_START + "\n" + "".join(
        f"  <url>\n    <loc>{u}</loc>\n    <lastmod>{today_iso}</lastmod>\n    <changefreq>weekly</changefreq>\n"
        f"    <priority>{'0.8' if u.endswith('/ships/') else '0.7'}</priority>\n  </url>\n" for u in urls) + SM_END
    if SM_START in text:
        return re.sub(re.escape(SM_START) + r".*?" + re.escape(SM_END), lambda m: block, text, flags=re.S)
    return text.replace("</urlset>", block + "\n</urlset>")


def llms(text, pubs):
    lines = ["## Ship guides", "",
             "Where each regular cruise ship docks in Cozumel, from the port authority's records: the terminal she used in "
             "the last 12 months (\"usually\" only when one terminal had at least 70% of at least 3 calls), her calls since "
             "January 2024, the walk to our meeting point and her next dates in port.", "",
             f"- [All ship guides]({ORG}/ships/)"]
    for x in pubs:
        pier = (f"usually {the(x['usualPier'])} ({x['usualHits']} of {x['berthed12']} calls in the last 12 months)"
                if x["usualPier"] else "it varies between terminals")
        lines.append(f"- [{x['name']}]({ORG}/ships/{x['slug']}/) — {pier}")
    section = "\n".join(lines) + "\n\n"
    if "## Ship guides\n" in text:
        return re.sub(r"## Ship guides\n.*?(?=\n## |\Z)", lambda m: section.rstrip("\n") + "\n", text, flags=re.S)
    return text.replace("## Company\n", section + "## Company\n", 1)


# ── main ────────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="print the result, write nothing")
    ap.add_argument("--cache", type=Path, help="folder to keep fetched history months in (past months are reused)")
    args = ap.parse_args()
    if args.cache:
        args.cache.mkdir(parents=True, exist_ok=True)

    cfg = json.loads(DATA.read_text())
    published = list(dict.fromkeys(cfg["published"]))

    # Cozumel is UTC−5 all year, same as the functions.
    today = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=5)).date()
    today_iso = today.isoformat()
    since = today.replace(year=today.year - 1).isoformat() if not (today.month == 2 and today.day == 29) \
        else today.replace(year=today.year - 1, day=28).isoformat()

    rows = history(today, args.cache)
    happened = [r for r in rows if r["status"] == "green" and r["date"] < today_iso]
    by_ship = collections.defaultdict(list)
    for r in happened:
        by_ship[r["name"]].append(r)
    stats = {n: summarize(n, rs, since) for n, rs in by_ship.items()}
    index = sorted((x for x in stats.values() if x["calls12"] >= MIN_CALLS_12M), key=lambda x: (-x["calls12"], x["name"]))
    by_slug = {x["slug"]: x for x in index}
    missing = [s for s in published if s not in by_slug]
    if missing:
        sys.exit(f"not on the list (≥{MIN_CALLS_12M} calls in the last 12 months): {', '.join(missing)}")

    live = get_json(f"{ORG}/.netlify/functions/ships-today")
    if "published" not in live:
        sys.exit(f"ships-today gave no schedule: {live}")
    rate_cache = {}

    def rates(d):
        if d not in rate_cache:
            rate_cache[d] = get_json(f"{ORG}/.netlify/functions/port-rate?date={d}&vehicle=van_1_4")
        return rate_cache[d]

    VEH, DEST = site_tables()
    counted = max(r["date"] for r in happened)
    ctx = dict(VEH=VEH, DEST=DEST, pubTo=dt.date.fromisoformat(live["published"]["to"]).strftime("%a %-d %b"),
               counted=dt.date.fromisoformat(counted).strftime("%-d %B %Y"),
               since=dt.date.fromisoformat(since).strftime("%-d %B %Y"),
               todayL=today.strftime("%-d %B %Y"))
    pubs = [by_slug[s] for s in published]
    for x in pubs:
        x["next"] = next_dates(x["name"], live, rates, rows, today_iso)

    pages = {ROOT / "ships" / "index.html": index_page(index, set(published), ctx)}
    for x in pubs:
        pages[ROOT / "ships" / x["slug"] / "index.html"] = ship_page(x, ctx)

    keep = ("slug", "name", "line", "calls12", "berthed12", "anchored12", "byTerminal12", "usualPier", "usualHits",
            "usualShare", "calls", "berthed", "anchored", "byTerminal")
    out = dict(
        builtAt=today_iso, window=dict(since=since, countedThrough=counted),
        rules=dict(listedIf=f"at least {MIN_CALLS_12M} calls in the last 12 months",
                   usualIf=f"one terminal has at least {int(MIN_SHARE * 100)}% of at least {MIN_CALLS} berthed calls in the last 12 months"),
        published=published,
        candidates=[x["slug"] for x in index if x["slug"] not in published],
        ships=[{k: x[k] for k in keep} | dict(next=[{k: o[k] for k in ("date", "inWindow", "terminal")} | (
            {"percent": o["percent"]} if o.get("percent") is not None else {}) for o in x["next"]]) for x in pubs],
        listed=[dict(slug=x["slug"], name=x["name"], calls12=x["calls12"], usualPier=x["usualPier"]) for x in index],
    )

    print(f"{len(index)} ships with ≥{MIN_CALLS_12M} calls from {since} to {counted}; "
          f"{sum(1 for x in index if not x['usualPier'])} of them split")
    print(f"published window {live['published']['from']} → {live['published']['to']}")
    for x in pubs:
        pier = f"usually {x['usualPier']} {x['usualHits']}/{x['berthed12']}" if x["usualPier"] else f"varies {x['byTerminal12']}"
        rank = index.index(x) + 1
        print(f"  #{rank:<3} {x['name']:<34} {x['calls12']:>3} calls/12m · {pier} · since Jan 2024 {x['byTerminal']}"
              f" · next {[(o['date'], o.get('percent')) for o in x['next']]}")

    if args.dry_run:
        print("\n--dry-run: nothing written")
        return
    for p, s in pages.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(s, encoding="utf-8")
    DATA.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    sm = ROOT / "sitemap.xml"
    sm.write_text(sitemap(sm.read_text(), published, today_iso), encoding="utf-8")
    lt = ROOT / "llms.txt"
    lt.write_text(llms(lt.read_text(), pubs), encoding="utf-8")
    print(f"\nwrote {len(pages)} pages, {DATA.relative_to(ROOT)}, sitemap.xml, llms.txt")


if __name__ == "__main__":
    main()
