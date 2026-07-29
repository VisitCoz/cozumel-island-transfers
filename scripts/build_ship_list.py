#!/usr/bin/env python3
"""
Build the cruise-ship type-ahead list for the CIT booking form.

Why this exists: APIQROO only publishes the arrival schedule about a month ahead, so
we can't ask a guest to pick their ship out of a dated schedule — anyone booking further
out would find nothing. Instead we ask for the ship by NAME, from a list of every ship
that has actually called at Cozumel, and we tell the guest we'll confirm their pier once
the port publishes it.

Source: https://servicios.apiqroo.com.mx/programacion/  (official Quintana Roo port authority)
Historical endpoint (GET, no auth, year selector goes back to 2010):
    controller.php?anio=YYYY&mes=MM&status=0&doAction=arribos.history.get

NOTE: this HTML is NOT shaped like the live page that netlify/functions/ships-today.js
parses. The live page tags cells with data-title="…"; the historical view uses positional
<td>s: PUERTO · BANDERA · CRUCERO · FECHA · ETA · ETD · STATUS · PASAJEROS. Hence its own parser.

Run manually — once or twice a year is plenty:
    python3 scripts/build_ship_list.py               # writes data/cozumel-ships.json
    python3 scripts/build_ship_list.py --dry-run     # print, write nothing
    python3 scripts/build_ship_list.py --years 2023 2024 2025 2026
"""

import argparse
import html as htmllib
import json
import re
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

ENDPOINT = ("https://servicios.apiqroo.com.mx/programacion/controller.php"
            "?anio={year}&mes={month:02d}&status=0&doAction=arribos.history.get")
UA = "Mozilla/5.0 (Cozumel Island Transfers ship-list builder)"
OUT = Path(__file__).resolve().parent.parent / "data" / "cozumel-ships.json"

# Vessel-type prefixes the port authority uses inconsistently: "M/S CARNIVAL BREEZE"
# and "CARNIVAL BREEZE" are the same ship.
PREFIX_RX = re.compile(r"^(M/S|M/V|M\.S\.|M\.V\.|MS|MV|S/S|SS)[.\s]+", re.I)

# Words that stay lowercase inside a ship name ("Wonder of the Seas", not "Wonder Of The Seas").
LOWER_WORDS = {"of", "the", "at", "da", "de", "van", "der", "and"}

# Tokens that must keep a fixed casing after title-casing.
FORCE_CASE = {
    "msc": "MSC", "ii": "II", "iii": "III", "iv": "IV", "vi": "VI",
    "aidabella": "AIDAbella", "aidadiva": "AIDAdiva", "aidaperla": "AIDAperla",
    "aidacosma": "AIDAcosma", "aidanova": "AIDAnova", "aidaluna": "AIDAluna",
    "aidasol": "AIDAsol", "aidamar": "AIDAmar",
}

# The port authority misspells a few ships. Left alone these show up as separate entries in
# the type-ahead ("Cristal Serenity" AND "Crystal Serenity"), which reads as sloppy to a guest.
SOURCE_TYPOS = {
    "Cristal Serenity": "Crystal Serenity",
    "Koningsdan": "Koningsdam",
    "Mein Shiff 6": "Mein Schiff 6",
}

# Cruise line inferred from the ship name. Shown under each type-ahead result so a guest
# can confirm they picked the right ship. Suffix/prefix rules first, then the explicit set.
LINE_BY_SUFFIX = [
    (" of the Seas", "Royal Caribbean"),
    (" Princess", "Princess Cruises"),
]
LINE_BY_PREFIX = [
    ("Carnival ", "Carnival Cruise Line"),
    ("Celebrity ", "Celebrity Cruises"),
    ("Norwegian ", "Norwegian Cruise Line"),
    ("Disney ", "Disney Cruise Line"),
    ("MSC", "MSC Cruises"),
    ("Viking ", "Viking"),
    ("Seven Seas ", "Regent Seven Seas"),
    ("Silver ", "Silversea"),
    ("AIDA", "AIDA Cruises"),
    ("Mein Schiff", "TUI Cruises"),
    ("Margaritaville", "Margaritaville at Sea"),
    ("Crystal ", "Crystal Cruises"),
    ("Sea Cloud", "Sea Cloud Cruises"),
    ("Azamara ", "Azamara"),
    ("Marella ", "Marella Cruises"),
    ("Club Med", "Club Med Cruises"),
    ("Vidantaworld", "Vidanta Cruises"),
]
LINE_BY_NAME = {
    # Royal Caribbean ships that don't end in "of the Seas"
    "Icon of the Seas": "Royal Caribbean",
    # Virgin Voyages
    "Scarlet Lady": "Virgin Voyages", "Valiant Lady": "Virgin Voyages",
    "Resilient Lady": "Virgin Voyages", "Brilliant Lady": "Virgin Voyages",
    # Holland America
    "Eurodam": "Holland America Line", "Nieuw Amsterdam": "Holland America Line",
    "Nieuw Statendam": "Holland America Line", "Zuiderdam": "Holland America Line",
    "Rotterdam": "Holland America Line", "Koningsdam": "Holland America Line",
    "Volendam": "Holland America Line", "Westerdam": "Holland America Line",
    "Oosterdam": "Holland America Line", "Noordam": "Holland America Line",
    # Oceania
    "Marina": "Oceania Cruises", "Riviera": "Oceania Cruises", "Insignia": "Oceania Cruises",
    "Nautica": "Oceania Cruises", "Sirena": "Oceania Cruises", "Regatta": "Oceania Cruises",
    "Vista": "Oceania Cruises", "Allura": "Oceania Cruises",
    # Cunard
    "Queen Elizabeth": "Cunard", "Queen Victoria": "Cunard", "Queen Anne": "Cunard",
    "Queen Mary 2": "Cunard",
    # P&O
    "Aurora": "P&O Cruises", "Ventura": "P&O Cruises", "Arcadia": "P&O Cruises",
    "Britannia": "P&O Cruises", "Iona": "P&O Cruises", "Azura": "P&O Cruises",
    # Fred. Olsen / Ambassador
    "Balmoral": "Fred. Olsen", "Bolette": "Fred. Olsen", "Borealis": "Fred. Olsen",
    "Braemar": "Fred. Olsen", "Ambience": "Ambassador Cruise Line",
    "Ambition": "Ambassador Cruise Line",
    # Ships whose name doesn't carry the line
    "Mardi Gras": "Carnival Cruise Line",
    "Ilma": "The Ritz-Carlton Yacht Collection",
    "Evrima": "The Ritz-Carlton Yacht Collection",
    "Windsurf": "Windstar Cruises",
    "Vasco da Gama": "nicko cruises",
    "Europa 2": "Hapag-Lloyd Cruises",
    "Hamburg": "Plantours Kreuzfahrten",
}


def fetch(year, month):
    req = urllib.request.Request(ENDPOINT.format(year=year, month=month), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def parse_rows(page):
    """Yield (port, raw_ship_name) from the historical (positional <td>) table."""
    for row in re.findall(r'<tr id="tr-id-\d+".*?</tr>', page, re.S):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
        if len(cells) < 3:
            continue
        strip = lambda c: htmllib.unescape(re.sub(r"<[^>]+>", " ", c)).strip()
        port, ship = strip(cells[0]), strip(cells[2])
        if ship:
            yield port, ship


def normalize(raw):
    """'M/S CARNIVAL BREEZE' -> 'Carnival Breeze'; 'MSC. DIVINA' -> 'MSC Divina'."""
    name = PREFIX_RX.sub("", raw.strip())
    name = re.sub(r"\s+", " ", name)
    name = re.sub(r"^MSC\.\s*", "MSC ", name, flags=re.I)

    out = []
    for i, word in enumerate(name.split(" ")):
        key = word.lower().strip(".,")
        if key in FORCE_CASE:
            out.append(FORCE_CASE[key])
        elif key in LOWER_WORDS and i > 0:
            out.append(key)
        elif word.isdigit():
            out.append(word)
        else:
            # .title() mangles apostrophes ("Vidantaworld'S"); fix the letter after one.
            out.append(re.sub(r"'(\w)", lambda m: "'" + m.group(1).lower(), word.title()))
    name = " ".join(out)
    return SOURCE_TYPOS.get(name, name)


def infer_line(name):
    if name in LINE_BY_NAME:
        return LINE_BY_NAME[name]
    for suffix, line in LINE_BY_SUFFIX:
        if name.endswith(suffix):
            return line
    for prefix, line in LINE_BY_PREFIX:
        if name.startswith(prefix):
            return line
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", nargs="+", type=int, default=[2024, 2025, 2026])
    ap.add_argument("--dry-run", action="store_true", help="print the result, write nothing")
    args = ap.parse_args()

    ships, arrivals, ports = {}, 0, {}
    for year in args.years:
        for month in range(1, 13):
            try:
                page = fetch(year, month)
            except Exception as e:                        # a future month simply has no data
                print(f"  {year}-{month:02d}  skipped ({e})", file=sys.stderr)
                continue
            found = 0
            for port, raw in parse_rows(page):
                name = normalize(raw)
                if not name:
                    continue
                ports[port] = ports.get(port, 0) + 1
                arrivals += 1
                found += 1
                rec = ships.setdefault(name, {"name": name, "line": infer_line(name), "calls": 0,
                                              "first": f"{year}-{month:02d}", "last": None})
                rec["calls"] += 1
                rec["last"] = f"{year}-{month:02d}"
            print(f"  {year}-{month:02d}  {found:4d} arrivals", file=sys.stderr)

    # Most-frequent callers first — the type-ahead should surface the common ships first.
    ordered = sorted(ships.values(), key=lambda s: (-s["calls"], s["name"]))
    payload = {
        "source": "https://servicios.apiqroo.com.mx/programacion/",
        "builtAt": datetime.now().strftime("%Y-%m-%d"),
        "years": args.years,
        "arrivalsScanned": arrivals,
        "shipCount": len(ordered),
        "ships": ordered,
    }

    print(f"\n{len(ordered)} distinct ships from {arrivals} arrivals across {args.years}")
    print("terminals: " + ", ".join(f"{p} ({c})" for p, c in sorted(ports.items(), key=lambda x: -x[1])))
    unknown = [s["name"] for s in ordered if not s["line"]]
    if unknown:
        print(f"no cruise line inferred for {len(unknown)}: {', '.join(unknown)}")

    if args.dry_run:
        print("\n--dry-run: nothing written")
        return
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
