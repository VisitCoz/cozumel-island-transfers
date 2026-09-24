#!/usr/bin/env python3
"""
Build the month-by-month "how busy is the port" baseline for the ship discount.

Why this exists: APIQROO only publishes the rest of the CURRENT month (checked 2026-09-19:
the schedule ended on the 26th). A guest booking further out has no day count to price
from, so netlify/functions/port-rate.js falls back to the average ships-per-day of her
calendar month, which this file provides. Same source and same endpoint as
build_ship_list.py — see the notes there about the positional <td> layout.

Positional cells in the history table:
    PUERTO · BANDERA · CRUCERO · FECHA · ETA · ETD · STATUS · PASAJEROS
A red status circle is a cancelled call and is not counted.

Run manually — once a season is plenty:
    python3 scripts/build_port_averages.py                   # writes data/port-month-averages.json
    python3 scripts/build_port_averages.py --dry-run         # print, write nothing
    python3 scripts/build_port_averages.py --from 2024-09    # widen the sample
"""

import argparse
import calendar
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_ship_list import fetch  # noqa: E402  (same endpoint, same user agent)

OUT = Path(__file__).resolve().parent.parent / "data" / "port-month-averages.json"
ROW_RX = re.compile(r'<tr id="tr-id-\d+".*?</tr>', re.S)
CELL_RX = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
FECHA_RX = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})")


def daily_counts(year, month):
    """{ 'YYYY-MM-DD': ships } for every calendar day of the month, cancelled calls excluded.
    Days with no row are 0. Returns (counts, last_published_day)."""
    page = fetch(year, month)
    days = calendar.monthrange(year, month)[1]
    counts = {f"{year}-{month:02d}-{d:02d}": 0 for d in range(1, days + 1)}
    last = 0
    for row in ROW_RX.findall(page):
        cells = CELL_RX.findall(row)
        if len(cells) < 4 or "circle_red" in row:
            continue
        m = FECHA_RX.search(cells[3])
        if not m:
            continue
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if (y, mo) != (year, month):
            continue
        counts[f"{y}-{mo:02d}-{d:02d}"] += 1
        last = max(last, d)
    return counts, last


def month_iter(start, end):
    y, m = start
    while (y, m) <= end:
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", default="2025-09", help="first month, YYYY-MM")
    ap.add_argument("--to", dest="end", default=None, help="last month, YYYY-MM (default: this month)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    start = tuple(int(x) for x in args.start.split("-"))
    today = date.today()
    end = tuple(int(x) for x in args.end.split("-")) if args.end else (today.year, today.month)

    # Per calendar month (01–12): total calls and total days covered, across every sampled year.
    agg = {f"{m:02d}": {"calls": 0, "days": 0, "daysWithNoShip": 0, "from": []} for m in range(1, 13)}
    for y, m in month_iter(start, end):
        try:
            counts, last = daily_counts(y, m)
        except Exception as e:
            print(f"  {y}-{m:02d}  skipped ({e})", file=sys.stderr)
            continue
        # The current month is only published up to `last`; count only the days we can see.
        covered = last if (y, m) == (today.year, today.month) else len(counts)
        seen = {k: v for k, v in counts.items() if int(k[-2:]) <= covered}
        calls = sum(seen.values())
        a = agg[f"{m:02d}"]
        a["calls"] += calls
        a["days"] += covered
        a["daysWithNoShip"] += sum(1 for v in seen.values() if v == 0)
        a["from"].append(f"{y}-{m:02d}")
        print(f"  {y}-{m:02d}  {calls:4d} calls over {covered:2d} days  = {calls / covered:.2f}/day", file=sys.stderr)

    by_month = {}
    for k, a in agg.items():
        if not a["days"]:
            continue
        by_month[k] = {"shipsPerDay": round(a["calls"] / a["days"], 2), **a}

    payload = {
        "source": "https://servicios.apiqroo.com.mx/programacion/ (controller.php arribos.history.get)",
        "builtAt": datetime.now().strftime("%Y-%m-%d"),
        "sample": f"{args.start} to {end[0]}-{end[1]:02d}",
        "byMonth": by_month,
    }
    print(json.dumps(payload, indent=2))
    if args.dry_run:
        print("\n--dry-run: nothing written", file=sys.stderr)
        return
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"\nwrote {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
