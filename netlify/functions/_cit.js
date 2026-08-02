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

// Destinations that ignore the vehicle price list and charge a fixed amount.
//
// 'somewhere-else' is deliberately MX$100. It is a real, bookable item — not a
// test mode, not a fake card — so Mike can run the whole chain end to end with
// real money whenever he wants, for about six dollars. It also happens to be a
// genuine product: someone wanting a destination we don't list pays a holding
// amount and we agree the rest on WhatsApp.
//
// Reprice or remove this before the site takes real traffic.
const FIXED_PRICE = {
  'somewhere-else': {
    amount: 100,
    currency: 'mxn',
    name: 'Private transfer — destination to be confirmed',
    blurb: 'We will agree the destination and the final price with you on WhatsApp.',
  },
};

const CURRENCY = 'usd';
const MIN_NOTICE_HOURS = 24;
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

module.exports = {
  VEHICLES, DESTINATIONS, FIXED_PRICE, CURRENCY, MIN_NOTICE_HOURS, FLEET_RUNS_PER_DAY,
  COZUMEL_UTC_OFFSET, vehicleFor, json, stripe, verifyStripeSignature, bookings,
};
