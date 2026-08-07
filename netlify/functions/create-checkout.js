// POST /.netlify/functions/create-checkout
// The site sends a booking; this returns a Stripe Checkout URL to send the guest to.
//
// Every rule that protects the business is enforced HERE, not in the browser.
// The page's 24-hour cutoff and fleet allotment are conveniences for the guest;
// this is the version that a stale tab or an open dev-tools console cannot get past.

const {
  DESTINATIONS, ADMISSION, CURRENCY, BOOKING_CUTOFF_HOUR,
  COZUMEL_UTC_OFFSET, vehicleFor, json, stripe,
} = require('./_cit');

const pad = (n) => String(n).padStart(2, '0');
const hour12 = (h) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h >= 12 ? 'PM' : 'AM'}`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let b;
  try { b = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Could not read that booking.' }); }

  // ---- shape ----
  const pax = Number(b.pax);
  const vehicle = vehicleFor(pax);
  const destName = DESTINATIONS[b.destination];

  if (!pax || pax < 1)  return json(400, { error: 'Tell us how many people are travelling.' });
  if (!vehicle)         return json(400, { error: 'Groups over 40 are arranged by hand.', useWhatsApp: true });
  if (!destName)        return json(400, { error: 'Pick a destination.' });
  if (!b.email)         return json(400, { error: 'We need an email for your confirmation.' });
  // The rep meets her holding a sign with this on it. A booking without a name is a
  // van arriving at a pier to look for nobody.
  if (!String(b.name || '').trim()) return json(400, { error: 'We need the name that goes on the sign.' });
  // "Somewhere else on the island" is the one destination that doesn't say where it is.
  // The page asks for an address; this is the half a stale tab cannot walk past.
  if (b.destination === 'somewhere-else' && !String(b.dropoff || '').trim()) {
    return json(400, { error: 'Tell us where you’re going — a hotel, an address, or the ferry terminal.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) return json(400, { error: 'Pick a date.' });

  const pickupHour = Number(b.pickupHour);
  const durationHours = Number(b.durationHours);
  if (!(pickupHour >= 6 && pickupHour <= 20)) return json(400, { error: 'Pick a pickup time.' });
  if (!(durationHours >= 1 && durationHours <= 12)) return json(400, { error: 'Pick how long you want to stay.' });

  // ---- the cutoff: 9 AM Cozumel the day before ----
  // Not a rolling 24 hours. The day gets planned when the manifest goes out at
  // 9 AM, so a booking that arrives after that is a van nobody has allocated.
  // Those guests are worth more on WhatsApp than in the database.
  const cutoff = new Date(`${b.date}T${pad(BOOKING_CUTOFF_HOUR)}:00:00${COZUMEL_UTC_OFFSET}`);
  if (isNaN(cutoff)) return json(400, { error: 'That date did not read correctly.' });
  cutoff.setUTCDate(cutoff.getUTCDate() - 1);
  if (Date.now() >= cutoff.getTime()) {
    return json(409, {
      error: "Online booking for that day has closed — we plan the vans the morning before. Message us and we'll arrange it for you directly.",
      useWhatsApp: true,
    });
  }

  // ---- the fleet allotment ----
  // OFF by default. Set FLEET_RUNS_PER_DAY in Netlify to switch it on — at launch
  // volume the guard is theatre, and every extra moving part is a thing that can
  // break at 7am. When it IS set, the count comes from Stripe itself (search on
  // the date we wrote into metadata), so there is still no database to run.
  //
  // Stripe's search index lags new objects by up to a minute. That is fine for a
  // ceiling of 100 runs; it is not fine if you ever set this to something tight.
  const fleetCap = Number(process.env.FLEET_RUNS_PER_DAY) || 0;
  if (fleetCap > 0) {
    try {
      const q = encodeURIComponent(`metadata['date']:'${b.date}' AND status:'succeeded'`);
      const found = await stripe(`payment_intents/search?query=${q}&limit=100`, null, 'GET');
      if ((found.data || []).length >= fleetCap) {
        return json(409, {
          error: 'We are fully booked that day. Message us — we sometimes free a vehicle up.',
          useWhatsApp: true,
        });
      }
    } catch (err) {
      // Fail closed. Selling a van we cannot confirm is worse than losing a booking.
      console.error('allotment check failed', err);
      return json(503, {
        error: "We couldn't confirm availability just now. Message us and we'll book you by hand.",
        useWhatsApp: true,
      });
    }
  }

  // ---- build the session ----
  const ref = 'CIT-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const returnHour = pickupHour + durationHours;
  // Where Stripe sends the guest afterwards. Built from OUR host, never from the
  // request. It used to read `b.returnUrl`, which meant anyone could POST a booking
  // with someone else's address and get a genuine Stripe Checkout page, on this
  // account, that handed the buyer off to their site the moment she paid.
  const origin = `https://${event.headers.host}`;

  const meta = {
    booking_ref: ref,
    destination: b.destination,
    destination_name: destName,
    date: b.date,
    pickup: hour12(pickupHour),
    ret: hour12(returnHour),
    pax: String(pax),
    vehicle: vehicle.slug,
    vehicle_name: vehicle.name,
    ship: b.ship || 'Not on a cruise',
    guest: b.name || '',
    // The guest's address goes in metadata on purpose. Reading it back off the
    // PaymentIntent's receipt_email depends on Stripe's own receipt settings,
    // and if it ever comes back empty the day-before email silently goes to
    // nobody. Metadata is ours and always there.
    email: b.email,
    whatsapp: b.whatsapp || '',
    admission_prepaid: b.admissionPrepaid ? 'true' : 'false',
    // Free text, so it is trimmed to fit. Stripe caps a metadata value at 500 characters
    // and rejects the whole session if one is over, which would turn a typed paragraph
    // into a failed checkout.
    dropoff: String(b.dropoff || '').trim().slice(0, 400),
    pickup:  String(b.pickup  || '').trim().slice(0, 400),
  };

  // TEMPORARY LIVE-TEST OVERRIDE.
  // Set TEST_PRICE_USD=5 in Netlify to charge $5 instead of the real price, so
  // the first end-to-end run on a live key costs $5 rather than $369. Only Mike
  // can set it (it's an environment variable, not anything a guest can send).
  // DELETE THE VARIABLE the moment the test passes — while it is set, every
  // booking on the site charges $5.
  const testPrice = Number(process.env.TEST_PRICE_USD) || 0;
  const chargeUsd = testPrice > 0 ? testPrice : vehicle.usd;
  if (testPrice > 0) console.warn(`TEST_PRICE_USD is set — charging ${testPrice} instead of ${vehicle.usd}`);

  // TEMPORARY CURRENCY OVERRIDE, for testing only.
  // Mexican-issued cards are frequently blocked by their own issuer from foreign
  // currency charges ("Your card doesn't support this currency"), so Mike cannot
  // test a USD charge with his own card. Setting TEST_CURRENCY=mxn lets him prove
  // the chain works using pesos.
  //
  // GUESTS MUST STAY IN USD. Charging pesos to a US card means her bank converts
  // at its own rate plus a foreign-transaction fee, so her statement never matches
  // the price she agreed to on the page — the exact surprise charge this site
  // exists to avoid. DELETE THIS VARIABLE AFTER THE TEST.
  const currency = (process.env.TEST_CURRENCY || CURRENCY).toLowerCase();
  if (currency !== CURRENCY) console.warn(`TEST_CURRENCY is set — charging ${currency}, not ${CURRENCY}`);

  // Every destination prices the same way: by vehicle, from the one list. The
  // per-destination override that used to sit here sold an 8-pax transfer for MX$100
  // to a real agency — see the note where FIXED_PRICE used to live in _cit.js.
  const params = {
    mode: 'payment',
    customer_email: b.email,
    client_reference_id: ref,
    success_url: `${origin}?paid=1&ref=${ref}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}?cancelled=1`,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': currency,
    'line_items[0][price_data][unit_amount]': String(Math.round(chargeUsd * 100)),
    'line_items[0][price_data][product_data][name]': `${vehicle.name} to ${destName}`,
    'line_items[0][price_data][product_data][description]':
      `${b.dateLabel || b.date} · ${hour12(pickupHour)}–${hour12(returnHour)} · ${pax} people · round trip`,
  };

  // Optional prepaid venue admission, per person. The price comes from ADMISSION in
  // _cit.js, never from the request — `b.admissionUsd` is ignored on purpose.
  // Unverified rates cannot be prepaid at all; see the note beside the table.
  const adm = ADMISSION[b.destination];
  if (b.admissionPrepaid && adm && adm.verified && adm.usd > 0) {
    params['line_items[1][quantity]'] = String(pax);
    params['line_items[1][price_data][currency]'] = currency;
    params['line_items[1][price_data][unit_amount]'] = String(Math.round(adm.usd * 100));
    params['line_items[1][price_data][product_data][name]'] = `${destName} admission`;
    params['line_items[1][price_data][product_data][description]'] = 'Paid now — nothing at the gate';
  }

  // The "Add promotion code" box on Stripe Checkout. ON permanently, by Mike's decision
  // on 2026-08-07: he runs discounts through the season and wants a code to work at every
  // checkout, all year.
  //
  // I removed this earlier the same day on the argument that an empty promo box sends a
  // nervous buyer off to hunt for a code she'll never find. That argument only holds when
  // there IS no code. Mike's answer: there will always be a live one, advertised on the
  // site, so she isn't hunting — she already has it. That is the right call and it makes
  // the box an asset rather than a leak.
  //
  // The condition attached to it: a code must always be live and advertised. If you ever
  // retire every coupon, take this line out the same day.
  params.allow_promotion_codes = 'true';

  // Metadata on the session AND the payment, so it survives on the charge too.
  // This is what makes the Stripe dashboard readable as a reservation list.
  for (const [k, v] of Object.entries(meta)) {
    params[`metadata[${k}]`] = v;
    params[`payment_intent_data[metadata][${k}]`] = v;
  }

  try {
    const session = await stripe('checkout/sessions', params);
    return json(200, { url: session.url, ref });
  } catch (err) {
    console.error('create-checkout', err);
    return json(502, { error: "We couldn't open the payment page. Message us and we'll sort it out.", useWhatsApp: true });
  }
};
