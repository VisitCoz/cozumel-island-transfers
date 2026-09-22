// The ship discount — how quiet is the port on her day, and what does that earn her.
//
// One rule, used twice: index.html shows it in step 2 the moment she types her ship, and
// create-checkout.js works it out AGAIN from her date before it touches Stripe. The browser
// is never trusted with the number.
//
// Where the day count comes from:
//   • APIQROO publishes the rest of the CURRENT month only (checked 2026-09-19: the schedule
//     ended on the 26th). Inside that window we use that day's real ship count.
//   • Outside it we use the average ships-per-day of her calendar month, from
//     data/port-month-averages.json (built by scripts/build_port_averages.py).
// Either way the answer is never blank: a fetch failure just means the month average.
//
// The ladder — Mike's decision 2026-09-18, deepened for the Minivan 2026-09-19:
//   Private minivan:     0–1 ships 40% · 2 ships 30% · 3–4 ships 20% · 5+ ships 10%
//   Every other vehicle: 0–1 ships 30% · 2 ships 20% · 3–4 ships 15% · 5+ ships 10%
//   The minivan is the cheapest vehicle for us to put on the road, so a quiet day is worth
//   buying with a deeper cut. Mike's call, 2026-09-19: "let's see how it goes."
//   🚨 On .org that means BOTH van_1_4 and van_1_6: _cit.js names them both "Private minivan",
//   so a guest who sees one ladder for a 4-seater and a shallower one for the same van with
//   two more seats is reading a bug, not a policy. Mike's call 2026-09-22.
//   Nov–Apr is clamped to 10–15%, whatever the vehicle.
//   A guest who is not on a cruise gets the 10% floor only.

const { parseShips } = require('./ships-today');
const AVERAGES = require('../../data/port-month-averages.json');

const SOURCE = 'https://servicios.apiqroo.com.mx/programacion/';
const MINIVAN = new Set(['van_1_4', 'van_1_6']);   // both are "Private minivan" in _cit.js
const FLOOR = 10;

// _cit.js's catalogue order, so the `vehicles` map reads the way the page lists them.
const SLUGS = ['van_1_4', 'van_1_6', 'van_7_14', 'van_15_18', 'coach_20', 'bus_40'];

function ladder(ships, minivan) {
  if (ships <= 1) return minivan ? 40 : 30;
  if (ships === 2) return minivan ? 30 : 20;
  if (ships <= 4) return minivan ? 20 : 15;
  return 10;
}

// The percent for one vehicle on one day. `ships` is null when the day is not published.
function rateFor({ dateISO, vehicleSlug, cruise = true, ships = null }) {
  const month = Number(dateISO.slice(5, 7));
  const avg = (AVERAGES.byMonth[String(month).padStart(2, '0')] || {}).shipsPerDay;

  if (!cruise) return { percent: FLOOR, basis: 'floor', ships: null, shipsPerDay: avg };

  const basis = ships === null ? 'average' : 'published';
  const count = ships === null ? Math.round(avg ?? 5) : ships;
  const highSeason = month >= 11 || month <= 4;
  const raw = ladder(count, MINIVAN.has(vehicleSlug));
  const percent = Math.max(FLOOR, highSeason ? Math.min(15, raw) : raw);
  return { percent, basis, ships: ships === null ? null : ships, shipsPerDay: avg };
}

// Today in America/Cancun (UTC-5, no DST) — same fixed offset ships-today.js uses.
function todayISO() {
  const now = new Date();
  const ms = now.getTime() + now.getTimezoneOffset() * 60000 - 5 * 3600000;
  return new Date(ms).toISOString().slice(0, 10);
}

// { window: {from, to}, byDay: {'YYYY-MM-DD': n} } for the published schedule, or null.
// Cancelled calls (status "red") are not ships in port.
async function publishedCalendar() {
  const res = await fetch(SOURCE, { headers: { 'User-Agent': 'Mozilla/5.0 (CIT port-rate)' } });
  if (!res.ok) throw new Error(`source ${res.status}`);
  const ships = parseShips(await res.text()).filter(s => s.status !== 'red');
  if (!ships.length) throw new Error('no ships parsed');
  const byDay = {};
  for (const s of ships) byDay[s.dateISO] = (byDay[s.dateISO] || 0) + 1;
  const dates = Object.keys(byDay).sort();
  return { window: { from: todayISO(), to: dates[dates.length - 1] }, byDay };
}

// Ship count for the date if it is inside the published window, else null.
function shipsOn(dateISO, cal) {
  if (!cal || dateISO < cal.window.from || dateISO > cal.window.to) return null;
  return cal.byDay[dateISO] || 0;
}

// A real calendar day, not merely ten characters that look like one. "2026-13-45" passes a
// shape test and then turns into an Invalid Date, which used to surface as a 500 — an outage
// as far as the browser is concerned. A malformed date is the caller's mistake: say so, in
// JSON, with a 400, and never throw.
function validDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const bad = (message) => ({
  statusCode: 400,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
             'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify({ error: message })
});

// GET /.netlify/functions/port-rate?date=YYYY-MM-DD[&vehicle=slug][&cruise=0]
//
// `date`    omitted → today in Cozumel; present and not a real day → 400.
// `vehicle` omitted → van_1_6, so a caller that only wants the day's shape still gets a
//           number; an unknown slug → 400 rather than a silent "every other vehicle" rate.
// `cruise`  0/false/no → she is not off a ship, so the floor is all she gets.
//
// The response carries the percent for EVERY vehicle as well as the one asked for, so the
// wizard can show the day's offer before she has picked a van.
exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};

  const dateISO = q.date === undefined ? todayISO() : q.date;
  if (!validDate(dateISO)) return bad(`date must be YYYY-MM-DD, got ${JSON.stringify(q.date)}`);

  const vehicleSlug = q.vehicle === undefined ? 'van_1_6' : q.vehicle;
  if (!SLUGS.includes(vehicleSlug)) {
    return bad(`unknown vehicle ${JSON.stringify(q.vehicle)}; expected one of ${SLUGS.join(', ')}`);
  }

  const cruise = !['0', 'false', 'no'].includes(String(q.cruise ?? '1').toLowerCase());

  let cal = null, error = null;
  try { cal = await publishedCalendar(); } catch (e) { error = e.message; }
  const ships = shipsOn(dateISO, cal);

  const vehicles = {};
  for (const slug of SLUGS) {
    vehicles[slug] = rateFor({ dateISO, vehicleSlug: slug, cruise, ships }).percent;
  }
  const any = rateFor({ dateISO, vehicleSlug, cruise, ships });

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': error ? 'public, max-age=300' : 'public, max-age=21600, s-maxage=21600',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify({
      date: dateISO,
      vehicle: vehicleSlug,
      cruise,
      percent: any.percent,        // the answer for the vehicle asked for
      basis: any.basis,            // 'published' | 'average' | 'floor'
      ships: any.ships,            // ships in port that day, or null when not published
      shipsPerDay: any.shipsPerDay,
      window: cal ? cal.window : null,
      vehicles,                    // percent per vehicle slug
      notCruise: FLOOR,
      source: 'apiqroo.com.mx',
      ...(error ? { error } : {})
    })
  };
};

module.exports.rateFor = rateFor;
module.exports.publishedCalendar = publishedCalendar;
module.exports.shipsOn = shipsOn;
module.exports.validDate = validDate;
