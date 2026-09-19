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
// The ladder — Mike's decision 2026-09-18:
//   0–1 ships 25% · 2 ships 20% · 3–4 ships 15% · 5+ ships 10%
//   Nov–Apr is clamped to 10–15%. Vehicles above 14 seats are clamped to 10–15% all year:
//   a 25% cut on the $899 bus is $224.75 handed to a group that was never an impulse booking.
//   A guest who is not on a cruise gets the 10% floor only.

const { parseShips } = require('./ships-today');
const AVERAGES = require('../../data/port-month-averages.json');

const SOURCE = 'https://servicios.apiqroo.com.mx/programacion/';
const DEEP_TIER_VEHICLES = new Set(['van_1_6', 'van_7_14']);
const FLOOR = 10;

function ladder(ships) {
  if (ships <= 1) return 25;
  if (ships === 2) return 20;
  if (ships <= 4) return 15;
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
  const ceiling = highSeason || !DEEP_TIER_VEHICLES.has(vehicleSlug) ? 15 : 25;
  const percent = Math.min(ceiling, Math.max(FLOOR, ladder(count)));
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

// GET /.netlify/functions/port-rate?date=YYYY-MM-DD[&ship=Name]
// Returns the percent for every vehicle, so the wizard can show it before she picks one.
exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  const dateISO = /^\d{4}-\d{2}-\d{2}$/.test(q.date || '') ? q.date : todayISO();

  let cal = null, error = null;
  try { cal = await publishedCalendar(); } catch (e) { error = e.message; }
  const ships = shipsOn(dateISO, cal);

  const vehicles = {};
  for (const slug of ['van_1_6', 'van_7_14', 'van_15_18', 'coach_20', 'bus_40']) {
    vehicles[slug] = rateFor({ dateISO, vehicleSlug: slug, ships }).percent;
  }
  const any = rateFor({ dateISO, vehicleSlug: 'van_1_6', ships });

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': error ? 'public, max-age=300' : 'public, max-age=21600, s-maxage=21600',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify({
      date: dateISO,
      basis: any.basis,            // 'published' | 'average'
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
