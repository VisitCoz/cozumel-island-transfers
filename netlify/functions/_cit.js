// Shared bits for the Cozumel Island Transfers booking functions.
// Built from scratch for CIT — nothing here is inherited from Visit Cozumel
// or Tierra Maya. Zero dependencies: Node 18+ on Netlify has fetch and crypto.

const crypto = require('crypto');

// ---------- The catalogue ----------
// One list, one truth. The site shows these prices; this file charges them.
// Amounts are USD. We charge in USD so the card statement matches the page —
// never a hard-coded peso rate, which drifts and turns into a surprise charge.
const VEHICLES = [
  { slug: 'van_1_8',   name: 'Private van',       maxPax: 8,  usd: 369 },
  { slug: 'van_9_14',  name: 'Large private van', maxPax: 14, usd: 425 },
  { slug: 'van_15_18', name: 'Extra-large van',   maxPax: 18, usd: 549 },
  { slug: 'coach_20',  name: 'Mini coach',        maxPax: 20, usd: 609 },
  { slug: 'bus_40',    name: 'Private bus',       maxPax: 40, usd: 899 },
];

const DESTINATIONS = {
  'tierra-maya':    'Tierra Maya',
  'kuza':           'KUZÁ',
  'san-gervasio':   'San Gervasio',
  'chankanaab':     'Chankanaab',
  'bucanos':        'Buccanos',
  'paradise-beach': 'Paradise Beach',
  'mr-sanchos':     'Mr. Sanchos',
  'nachi-cocom':    'Nachi Cocom',
  'somewhere-else': 'Somewhere else on the island',
};

// There used to be a FIXED_PRICE table here that sold 'somewhere-else' for a flat
// MX$100 "holding amount". It was built as a cheap way to run the live chain end to
// end, and on 2026-08-06 a travel agency used it to book an 8-passenger transfer off
// the Disney Treasure for about five dollars — booking CIT-M6G0PQ.
//
// It is gone, and there is no replacement, because the price list is already flat and
// per-vehicle for anywhere on the island. A custom destination is the same van for the
// same day, so it costs the same; only the address needs agreeing. Cheap live testing
// is the CITFLOW90R4K promotion code now, which is better anyway — the real price stays
// on the page and the discount reads as a discount.
//
// Do not reintroduce a per-destination price override without a server-side floor.

// ---------- Venue admission ----------
// The gate price per adult, charged as a second line item when a guest chooses to
// prepay it. These live here, not in the browser. The page used to send the amount
// along with the booking, which meant anyone could post `admissionUsd: 1` and prepay
// a $65 day pass for a dollar. The page still displays these numbers; this file is
// what charges them.
//
// `verified` means the rate is confirmed with the venue in writing. Prepay is
// REFUSED for anything unverified — if the real gate price turns out to be higher we
// eat the difference in person, in front of the guest, which is the one place this
// business cannot afford to look wrong. Pax is collecting the signed B2B rate cards;
// flip these to true as they land. Until then those destinations still sell the
// transfer, the guest simply pays her own admission at the gate.
const ADMISSION = {
  'tierra-maya':    { usd: 70, verified: true,  name: 'Sacred Roots experience' },
  'kuza':           { usd: 45, verified: false, name: 'KUZÁ day pass' },
  'san-gervasio':   { usd: 13, verified: true,  name: 'San Gervasio site entry' },
  'chankanaab':     { usd: 31, verified: true,  name: 'Chankanaab park entry' },
  'bucanos':        { usd: 55, verified: false, name: 'Buccanos day pass' },
  'paradise-beach': { usd: 18, verified: true,  name: 'Paradise Beach Fun Pass' },
  'mr-sanchos':     { usd: 65, verified: false, name: 'Mr. Sanchos all-inclusive day pass' },
  'nachi-cocom':    { usd: 75, verified: false, name: 'Nachi Cocom day pass' },
};

const CURRENCY = 'usd';

// Online booking for a given day closes at 9 AM Cozumel time the day before —
// the same moment the manifest goes out and the vans get assigned.
//
// This used to be a rolling 24 hours, which let a booking land after the day was
// already planned. Mike's call: anything inside the window is arranged by hand,
// because a van that appears on the schedule after the schedule was made is how
// two guests end up promised the same vehicle.
const BOOKING_CUTOFF_HOUR = 9;
const FLEET_RUNS_PER_DAY = 100;   // 20 vans x up to 5 runs
const COZUMEL_UTC_OFFSET = '-05:00';   // no daylight saving, year round

const vehicleFor = (pax) => VEHICLES.find(v => pax <= v.maxPax) || null;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

// ---------- Stripe, over plain fetch ----------
// Stripe's API is form-encoded. Nested keys use bracket notation, which is why
// the payload is built as flat "a[b][c]" strings rather than a JSON object.
async function stripe(path, params, method = 'POST') {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set in Netlify environment variables');

  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };
  if (method === 'POST') opts.body = new URLSearchParams(params).toString();

  const res = await fetch(`https://api.stripe.com/v1/${path}`, opts);
  const out = await res.json();
  if (out.error) throw new Error(`Stripe: ${out.error.message}`);
  return out;
}

// ---------- Webhook signature ----------
// This is the whole reason Stripe lives in a Netlify Function rather than in
// Apps Script: Apps Script cannot read request headers, so it cannot verify
// that an incoming "payment succeeded" actually came from Stripe.
function verifyStripeSignature(rawBody, sigHeader, secret, toleranceSec = 300) {
  if (!sigHeader || !secret) return false;

  let t = null, v1 = [];
  for (const part of sigHeader.split(',')) {
    const [k, v] = part.trim().split('=');
    if (k === 't') t = v;
    if (k === 'v1') v1.push(v);
  }
  if (!t || !v1.length) return false;

  // Reject replays of an old, genuinely-signed event.
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > toleranceSec) return false;

  const expected = crypto.createHmac('sha256', secret)
    .update(`${t}.${rawBody}`, 'utf8').digest('hex');

  // Constant-time compare, and only against equal-length candidates.
  return v1.some(sig =>
    sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
}

// ---------- Talking to the Sheet ----------
// Apps Script owns the spreadsheet, the email and the Slack post, because that
// is what Apps Script is good at. It is reached with a shared token so nobody
// else can write bookings into it.
async function bookings(action, payload = {}) {
  const url = process.env.BOOKINGS_URL;
  const token = process.env.BOOKINGS_TOKEN;
  if (!url || !token) throw new Error('BOOKINGS_URL / BOOKINGS_TOKEN are not set');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, action, ...payload }),
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Bookings endpoint returned non-JSON: ${text.slice(0, 200)}`); }
}


// ---------- Email ----------
// Netlify functions cannot send mail on their own, so this goes through Resend.
// Team and guests only ever receive email — nobody needs a login anywhere.
async function sendEmail({ to, subject, html, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set');
  const from = process.env.MAIL_FROM || 'Cozumel Island Transfers <onboarding@resend.dev>';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(`Resend: ${out.message || JSON.stringify(out)}`);
  return out;
}

const teamEmails = () =>
  (process.env.TEAM_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);

// ---------- Reading bookings back out of Stripe ----------
// There is no database. Every booking carries its date in metadata, so Stripe's
// own search is the query layer. Note Stripe's search index lags new objects by
// up to a minute — irrelevant for a job that runs the evening before.
async function bookingsOn(dateIso) {
  const q = encodeURIComponent(`metadata['date']:'${dateIso}' AND status:'succeeded'`);
  const out = await stripe(`payment_intents/search?query=${q}&limit=100`, null, 'GET');
  return (out.data || []).map(pi => ({
    ref: pi.metadata.booking_ref || '',
    date: pi.metadata.date || '',
    pickup: pi.metadata.pickup || '',
    ret: pi.metadata.ret || '',
    destination: pi.metadata.destination_name || pi.metadata.destination || '',
    pax: Number(pi.metadata.pax) || 0,
    vehicle: pi.metadata.vehicle_name || pi.metadata.vehicle || '',
    ship: pi.metadata.ship || '',
    guest: pi.metadata.guest || '',
    whatsapp: pi.metadata.whatsapp || '',
    email: pi.metadata.email || pi.receipt_email || '',
    amount: (pi.amount || 0) / 100,
    currency: (pi.currency || '').toUpperCase(),
  }));
}

/* Tomorrow, in Cozumel time (UTC-5, no daylight saving). */
function tomorrowInCozumel() {
  const now = new Date(Date.now() - 5 * 3600 * 1000);   // shift to Cozumel local
  now.setUTCDate(now.getUTCDate() + 1);
  return now.toISOString().slice(0, 10);
}

/* Sort "9:00 AM" style times chronologically. */
const minutesOf = (t) => {
  const m = String(t).match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return 0;
  return ((+m[1] % 12) + (/pm/i.test(m[3]) ? 12 : 0)) * 60 + (+m[2]);
};

module.exports = {
  VEHICLES, DESTINATIONS, ADMISSION, CURRENCY, BOOKING_CUTOFF_HOUR, FLEET_RUNS_PER_DAY,
  COZUMEL_UTC_OFFSET, vehicleFor, json, stripe, verifyStripeSignature, bookings,
  sendEmail, teamEmails, bookingsOn, tomorrowInCozumel, minutesOf,
};
