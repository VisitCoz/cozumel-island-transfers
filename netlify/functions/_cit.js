// Shared bits for the Cozumel Island Transfers booking functions.
// Built from scratch for CIT — nothing here is inherited from Visit Cozumel
// or Tierra Maya. Zero dependencies: Node 18+ on Netlify has fetch and crypto.

const crypto = require('crypto');

// ---------- The catalogue ----------
// One list, one truth. The site shows these prices; this file charges them.
// Amounts are USD. We charge in USD so the card statement matches the page —
// never a hard-coded peso rate, which drifts and turns into a surprise charge.
const VEHICLES = [
  { slug: 'van_1_4',   name: 'Private minivan',   maxPax: 4,  usd: 150 },
  { slug: 'van_1_6',   name: 'Private minivan',   maxPax: 6,  usd: 250 },
  { slug: 'van_7_14',  name: 'Large private van', maxPax: 14, usd: 425 },
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
  'marina':         'Marina Cozumel',
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
// Only San Gervasio and Chankanaab. Mike's decision 2026-08-07: we publish a gate price
// and take money for it ONLY where the rate is confirmed with the venue in writing.
// Everywhere else the page names the fee and says she pays it at the gate, quoting no
// number — we had been publishing six prices we could not stand behind, and llms.txt was
// repeating them to AI assistants as fact.
//
// A destination absent from this table can never have an admission line added to its
// Stripe session, whatever the browser sends. That is the point of the table.
const ADMISSION = {
  // $23 confirmed by Mike 2026-08-07. It was $13, which matched neither published
  // source — INAH lists MX$105 for the ruins and Cozumel Parks lists $14.50 for the
  // parador, and the two authorities charge separately. Every prepaid San Gervasio
  // booking before this date under-collected by $10 a head.
  'san-gervasio':   { usd: 23, verified: true, name: 'San Gervasio site entry' },
  'chankanaab':     { usd: 31, verified: true, name: 'Chankanaab park entry' },
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

// ---------- The shared minivans ----------
// Both Private minivans (up to 4, up to 6) run on the two minivans Visit Cozumel and Tierra Maya
// also sell (Mike, 2026-10-17: "Our minivans: count them"). The larger vans are Uniper's and are not in it.
// Visit Cozumel's availability engine is the referee: it counts every site's bookings plus the
// Jeep and Minivan calendars, and answers only sold out or not — never how many (Mike, 2026-09-29).
// true = a minivan is free that day · false = booked · null = no clear answer (fail closed).
const SHARED_MINIVANS = ['van_1_4', 'van_1_6'];
const SHARED_FLEET_URL = 'https://www.visitcozumel.com.mx/.netlify/functions/availability?date=';
// Past 400 days the engine answers nothing (its own cut-off), so the checkout sends those to WhatsApp.
const pastFleetHorizon = (dateIso) => dateIso > new Date(Date.now() + 400 * 864e5).toISOString().slice(0, 10);
async function minivanFree(dateIso) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(SHARED_FLEET_URL + encodeURIComponent(dateIso), { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const m = (((await res.json()) || {}).products || {}).vc_minivan;
    return m && typeof m.sold_out === 'boolean' ? !m.sold_out : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

// ---------- Stripe, over plain fetch ----------
// Stripe's API is form-encoded. Nested keys use bracket notation, which is why
// the payload is built as flat "a[b][c]" strings rather than a JSON object.
//
// `signal` is passed only by the day-before list's pay-page lookups, so that one given up on
// is not left running (see bookingsOn). Every other call is sent exactly as before, with no
// time limit.
async function stripe(path, params, method = 'POST', signal) {
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
  if (signal) opts.signal = signal;

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

// ---------- Talking to the shared calendar ----------
// Same shape as bookings() above, DELIBERATELY on its own pair of variables.
//
// 🚨 Do not fold this into BOOKINGS_URL / BOOKINGS_TOKEN. That pair switches on
// apps_script/cit_bookings, which writes the Google Sheet Mike rejected and sends its
// own team email and Slack post — a second copy of the booking mail this system already
// sends through Resend. Two endpoints, two tokens, two jobs.
//
// Apps Script owns the calendar write because it runs AS a real Google user — so there is
// no service-account key and no Google Cloud project anywhere in this repo, only a URL and
// a shared secret.
//
// That user is hello@cozumelislandtransfers.com, deliberately, and NOT contabilidad@. The
// account that deploys the script is the identity the guest sees on her invitation, and the
// guest has already had one email from hello@ (the Resend confirmation). One brand, one
// sender. Redeploying this from another account silently changes who she hears from.
async function calendar(action, payload = {}) {
  const url = process.env.CALENDAR_URL;
  const token = process.env.CALENDAR_TOKEN;
  if (!url || !token) throw new Error('CALENDAR_URL / CALENDAR_TOKEN are not set');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, action, ...payload }),
  });
  const text = await res.text();
  let out;
  try { out = JSON.parse(text); }
  catch { throw new Error(`Calendar endpoint returned non-JSON: ${text.slice(0, 200)}`); }
  // Apps Script answers 200 with an {error} body rather than an HTTP error code, so a
  // failure here looks like success unless it is checked explicitly.
  if (out.error) throw new Error(`Calendar endpoint: ${out.error}`);
  return out;
}

const calendarConfigured = () => Boolean(process.env.CALENDAR_URL && process.env.CALENDAR_TOKEN);


// ---------- Email ----------
// Netlify functions cannot send mail on their own, so this goes through Resend.
// Team and guests only ever receive email — nobody needs a login anywhere.
// `idempotencyKey` is what makes the webhook safe to retry. Stripe re-delivers a failed
// event for up to three days, and without a key a retry would mail the same booking again.
// Resend remembers a key for 24 hours and silently drops the duplicate.
//
// ⚠️ Resend's memory is 24 h; Stripe's retries run to 72 h. A retry that finally succeeds on
// day two or three CAN duplicate. That is the correct trade: a second copy of a booking two
// days late is recoverable, a booking nobody ever heard about is not.
async function sendEmail({ to, subject, html, replyTo, idempotencyKey, attachments, bcc }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set');
  const from = process.env.MAIL_FROM || 'Cozumel Island Transfers <onboarding@resend.dev>';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 256) } : {}),
    },
    body: JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
      // Recipients who must not appear in the visible header — see the note on the team
      // email in stripe-webhook.js. A Reply All can only ever expose what is in `to`.
      ...(bcc && bcc.length ? { bcc: Array.isArray(bcc) ? bcc : [bcc] } : {}),
      // Base64 content, per Resend. Used for the .ics calendar file — see _ics.js.
      ...(attachments && attachments.length ? { attachments } : {}),
    }),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(`Resend: ${out.message || JSON.stringify(out)}`);
  return out;
}

const teamEmails = () =>
  (process.env.TEAM_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);

// ---------- Who booked, wherever Stripe holds it ----------
// Today's page asks for the name, email and phone itself and sends them as metadata. A page
// that leaves those questions to Stripe's own pay page finds them on the Checkout Session
// instead, all three in customer_details: the name for the pier sign comes from Stripe's own
// name box (`individual_name`), or from the name on the card when there was no box. Only the
// ship is a custom field of ours (key `ship`). The name never is: Stripe's rule is that custom
// fields must not collect personal data, and a name is personal data. One reader for both
// kinds, used by the webhook and the day-before list, so the two can never disagree about a guest.
//
// Metadata wins for the name and the phone, which is what keeps a booking made the old way
// reading exactly as it always has. It calls nothing and never throws: by the time it runs the
// guest has paid, and whatever comes after it is the announcement she is owed.
//
// The ship is the one answer the pay page wins. `asked` says the `ship` box was on her pay
// page, which is how a booking made the new way is recognised: an old one carries no custom
// fields at all. Then what she typed or left in that box beats a ship the page sent from the
// guide link she arrived by, because she may have browsed another ship's guide. With the box
// empty the page's ship stands, and with neither it is "Not given", so dispatch reads a
// decision rather than a gap. The guest's own confirmation hides that, like "Not on a cruise".
const SHIP_NOT_GIVEN = 'Not given';

// A number a WhatsApp link can be built from with nothing guessed: "+" and 8 to 15 digits.
const STRICT_PHONE = /^\+[0-9]{8,15}$/;

function contactFrom(session, metadata) {
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const cut = (v, n) => v.slice(0, n).trim();
  // The metadata is read first, so that whatever happens below she never comes out with less.
  const out = { guest: '', email: '', whatsapp: '', ship: '', asked: false };
  try {
    const m = metadata || {};
    out.guest = cut(text(m.guest), 400);
    out.email = text(m.email);
    out.whatsapp = text(m.whatsapp);
    out.ship = text(m.ship);

    const s = session || {};
    const who = s.customer_details || {};
    const fields = Array.isArray(s.custom_fields) ? s.custom_fields : [];
    const field = (key) => fields.find(f => f && f.key === key);
    const typed = (key) => text((((field(key) || {}).text) || {}).value);

    // The name box first, then Stripe's second copy of it, then the name on the card.
    if (!out.guest) out.guest = cut(text(who.individual_name)
      || text((s.collected_information || {}).individual_name) || text(who.name), 400);
    // The email is the one read the other way round: Stripe's own copy of her address first,
    // exactly as the webhook has always read it, and the metadata only when Stripe has none.
    out.email = text(who.email) || text(s.customer_email) || out.email;

    if (!out.whatsapp) {
      // Stripe's phone box gives "+<country><number>". Apple Pay and Google Pay may hand
      // over a number as she saved it: with no country code, a trunk "(0)", an extension, or
      // digits of another script. Only a clean "+" number is tidied to "+<digits>"; any other
      // is kept AS TYPED, never glued together and never given a "+", because guessing what
      // it meant would one day text a stranger.
      const phone = text(who.phone);
      const bare = phone.replace(/[\s.()-]/g, '');
      if (STRICT_PHONE.test(bare) && !phone.includes('(0)')) out.whatsapp = bare;
      else if (phone) out.whatsapp = cut(phone, 40);
    }

    out.asked = Boolean(field('ship'));
    if (out.asked) out.ship = cut(typed('ship'), 400) || out.ship || SHIP_NOT_GIVEN;
  } catch (err) {
    console.error('contactFrom: unreadable session, keeping what was read', err);
  }
  return out;
}

// ---------- Reading bookings back out of Stripe ----------
// There is no database. Every booking carries its date in metadata, so Stripe's
// own search is the query layer. Note Stripe's search index lags new objects by
// up to a minute — irrelevant for a job that runs the evening before.
const LOOKUP_MS = 4000;    // one pay-page lookup, at most
const LOOKUPS_MS = 12000;  // all of them together, at most
async function bookingsOn(dateIso) {
  const q = encodeURIComponent(`metadata['date']:'${dateIso}' AND status:'succeeded'`);
  const out = await stripe(`payment_intents/search?query=${q}&limit=100`, null, 'GET');
  const pis = out.data || [];
  const runs = pis.map(pi => ({
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
    // cozumeltransfers.org's optional "Anything we should know?" box. Absent everywhere else.
    // Trimmed, so a note of nothing but spaces leaves no bare "Guest note:" line.
    note: String(pi.metadata.guest_note || '').trim(),
    amount: (pi.amount || 0) / 100,
    currency: (pi.currency || '').toUpperCase(),
  }));

  // A booking whose name, phone or email was asked on Stripe's pay page has none of them in
  // its metadata, so the list would send the team a run with no name and her no reminder.
  // Only those bookings cost one more Stripe call, to the Checkout Session that holds them;
  // a booking made the old way is read exactly as above, with no extra call.
  //
  // One at a time, not all at once: a burst of parallel reads is how a busy day would meet
  // Stripe's rate limit. And a lookup that fails keeps the metadata values, because the
  // list going out with a gap beats no list at all.
  //
  // Nor may a slow Stripe hold the list up. The job that sends it is a scheduled function,
  // stopped at 30 seconds, and the team list and every reminder go out only after this
  // returns: one lookup that never answered would silence the whole day, old bookings
  // included. So each lookup is given up after 4 seconds and all of them together after 12,
  // and a booking not read in time keeps its metadata values, like one whose lookup failed.
  const blank = (v) => !(typeof v === 'string' && v.trim());
  let outOfTime = false;
  let endAll;
  const allLate = new Promise((resolve) => { endAll = resolve; });
  const allTimer = setTimeout(() => { outOfTime = true; endAll(); }, LOOKUPS_MS);
  try {
    for (let i = 0; i < pis.length; i++) {
      const pi = pis[i];
      if (!blank(pi.metadata.guest) && !blank(pi.metadata.whatsapp) && !blank(pi.metadata.email)) continue;
      const ctl = new AbortController();
      let timer;
      try {
        if (outOfTime) throw new Error(`not looked up: the lookups had used their ${LOOKUPS_MS / 1000} seconds`);
        const found = await Promise.race([
          stripe('checkout/sessions?payment_intent=' + pi.id + '&limit=1', null, 'GET', ctl.signal),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer in ${LOOKUP_MS / 1000} seconds`)), LOOKUP_MS);
          }),
          allLate.then(() => { throw new Error(`no answer before the lookups' ${LOOKUPS_MS / 1000} seconds ran out`); }),
        ]);
        const c = contactFrom(((found || {}).data || [])[0], pi.metadata);
        // Same keys, same places in the object: only their values change.
        runs[i].ship = c.ship;
        runs[i].guest = c.guest;
        runs[i].whatsapp = c.whatsapp;
        runs[i].email = c.email || pi.receipt_email || '';
      } catch (err) {
        ctl.abort();   // a lookup given up on is not left running
        console.error('bookingsOn: could not read the pay page details, using the metadata', pi.metadata.booking_ref, err);
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    clearTimeout(allTimer);
  }
  return runs;
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
  COZUMEL_UTC_OFFSET, vehicleFor, SHARED_MINIVANS, minivanFree, pastFleetHorizon, json, stripe, verifyStripeSignature, bookings,
  calendar, calendarConfigured,
  sendEmail, teamEmails, bookingsOn, tomorrowInCozumel, minutesOf,
  contactFrom, SHIP_NOT_GIVEN, STRICT_PHONE,
};
