// POST /.netlify/functions/create-checkout
// The site sends a booking; this returns a Stripe Checkout URL to send the guest to.
//
// Every rule that protects the business is enforced HERE, not in the browser.
// The page's 24-hour cutoff and fleet allotment are conveniences for the guest;
// this is the version that a stale tab or an open dev-tools console cannot get past.

const {
  DESTINATIONS, ADMISSION, BOOKING_CUTOFF_HOUR,
  COZUMEL_UTC_OFFSET, vehicleFor, json, stripe,
} = require('./_cit');
const { logRefusal } = require('./_refusals');
const { rateFor, publishedCalendar, shipsOn, validDate } = require('./port-rate');

const pad = (n) => String(n).padStart(2, '0');
const hour12 = (h) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h >= 12 ? 'PM' : 'AM'}`;

// ---- the Port Meter, enforced ----
//
// The card in the booking bar shows a percent off. This works the SAME percent out again,
// here, from the date and the vehicle — and then prices the Stripe line at the cut amount.
// Nothing the browser sends about the discount is read: a page with dev-tools open can
// change what the guest SEES, and it still cannot change what her card is charged.
//
// Why the price is cut rather than couponed: the .org Stripe key is a restricted LIVE key
// with Checkout Sessions write and PaymentIntents read, and nothing else. It cannot create
// a coupon, so there is no coupon to attach. The discount is the line price.
//
// Fail open on the DISCOUNT, never on the BOOKING. If the port authority's schedule cannot
// be reached we fall back to the month average; if even that fails we charge the list price
// and write rate_basis 'unavailable'. A guest is never turned away because a third-party
// schedule was down — she simply pays what the price list says.
const NOT_ON_A_CRUISE = /^not on a cruise$/i;

// PRICED IN DOLLARS, CHARGED IN PESOS. Mike 2026-09-23: "Charge everything in pesos with an
// exchange rate of 18 pesos. The price displayed online will be in US dollars, but we will
// charge them in pesos, and they will make the conversion."
// Why: Mexican-issued cards refuse USD charges (Mike could not test with his own), and Stripe
// takes ~2% converting a USD charge on payout into this MXN account.
// Every USD figure below — the ladder, the cut, the metadata — stays in dollars. Only the
// Stripe line amounts are multiplied, here and nowhere else. The page shows the same peso
// figure from its own FX_MXN_PER_USD in index.html: change one, change both.
const FX_MXN_PER_USD = 18;
const toMxn = (usd) => Math.round(usd * FX_MXN_PER_USD);           // whole pesos
const fmtMxn = (mxn) => `MX$${mxn.toLocaleString('en-US')}`;

// Whole dollars, the way the card in the bar rounds it (index.html fillMeter()):
//   Math.round(list × (100 − percent) / 100)
// Both ends must round identically or the receipt disagrees with the page she agreed to.
const cutPrice = (listUsd, percent) => Math.round(listUsd * (100 - percent) / 100);

// The half-sentence appended to the Stripe line so the receipt says why it is not the
// ladder price. Empty when there is nothing to explain.
function discountLine(basis, percent, listUsd) {
  const was = ` (was $${listUsd.toLocaleString('en-US')})`;
  if (basis === 'test') return ` · LIVE TEST — $1 (MX$${FX_MXN_PER_USD}) instead of $${cutPrice(listUsd, percent)}`;
  if (!percent) return '';
  if (basis === 'floor') return ` · hotel-pickup discount ${percent}%${was}`;
  return ` · quiet-day discount ${percent}%${was}`;
}

// One schedule fetch, once, per booking — called from a single place below.
async function meter({ dateISO, vehicleSlug, cruise }) {
  try {
    const cal = await publishedCalendar();
    return rateFor({ dateISO, vehicleSlug, cruise, ships: shipsOn(dateISO, cal) });
  } catch (err) {
    console.warn('port-rate: schedule unavailable, falling back to the month average —', err.message);
    try {
      return rateFor({ dateISO, vehicleSlug, cruise, ships: null });   // basis 'average' / 'floor'
    } catch (err2) {
      console.error('port-rate: no rate at all, charging list price —', err2.message);
      return { percent: 0, basis: 'unavailable', ships: null };
    }
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let b;
  try { b = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Could not read that booking.' }); }

  // ---- shape ----
  const pax = Number(b.pax);
  const vehicle = vehicleFor(pax);
  // hasOwnProperty, not a plain lookup: DESTINATIONS['__proto__'] and ['toString'] are
  // inherited from Object.prototype and are truthy, so those two walked straight past
  // "Pick a destination." and opened a real Stripe session reading "Private minivan to
  // [object Object]". Only the ten keys in the table are destinations.
  const destName = Object.prototype.hasOwnProperty.call(DESTINATIONS, b.destination)
    ? DESTINATIONS[b.destination] : undefined;

  // A refusal is logged ONLY where a business rule turns a willing buyer away — the five
  // paths below. The other 400s here are form validation: a missing name is a stale tab,
  // not lost demand, and logging those would bury the signal under noise.
  const refusal = (reason, extra) => logRefusal({
    reason, wantedDate: b.date, destination: b.destination, destinationName: destName,
    pax, ship: b.ship, pickupHour: b.pickupHour, durationHours: b.durationHours,
    vehicleUsd: vehicle && vehicle.usd, ...extra,
  });

  if (!pax || pax < 1)  return json(400, { error: 'Tell us how many people are travelling.' });
  if (!vehicle) {
    await refusal('over_40');
    return json(400, { error: 'Groups over 40 are arranged by hand.', useWhatsApp: true });
  }
  if (!destName)        return json(400, { error: 'Pick a destination.' });
  if (!b.email)         return json(400, { error: 'We need an email for your confirmation.' });
  // The rep meets her holding a sign with this on it. A booking without a name is a
  // van arriving at a pier to look for nobody.
  if (!String(b.name || '').trim()) return json(400, { error: 'We need the name that goes on the sign.' });
  // Required from 2026-08-08, and stored in E.164 from 2026-08-10.
  //
  // It was on the form unchecked, so a booking could be paid in full with a blank number. Then
  // it was required but stored exactly as typed — and "407 555 0142" is not dialable by any SMS
  // or WhatsApp API, because nothing says which country it belongs to.
  //
  // The browser now sends "+<country><number>". A stale tab might send bare digits, and that is
  // REFUSED rather than guessed: assuming +1 for ten digits would eventually text a stranger in
  // another country. Losing one booking to a clear error beats messaging the wrong person.
  const wa = String(b.whatsapp || '').trim();
  const waDigits = wa.replace(/\D/g, '');
  if (!wa.startsWith('+') || waDigits.length < 8 || waDigits.length > 15) {
    return json(400, { error: 'We need your phone number with its country code. Reload the page and pick your country from the list beside the number.' });
  }
  const waE164 = '+' + waDigits;
  // "Somewhere else on the island" is the one destination that doesn't say where it is.
  // The page asks for an address; this is the half a stale tab cannot walk past.
  if (b.destination === 'somewhere-else' && !String(b.dropoff || '').trim()) {
    return json(400, { error: 'Tell us where you’re going — a hotel, an address, or the ferry terminal.' });
  }
  // validDate, not a shape test. "2026-11-31" matches the pattern and JS rolls it forward
  // to 1 December, so the cutoff below passed, the meter priced it as November, and Stripe
  // took money for a day that does not exist — filed in metadata under "2026-11-31", which
  // is a date no manifest will ever ask for. Same helper port-rate.js already uses.
  if (!validDate(String(b.date || ''))) return json(400, { error: 'Pick a date.' });

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
    // The single most valuable row in the log: she wanted to pay, on a real date, for a
    // real destination, and the clock is the only thing that stopped her.
    await refusal('past_cutoff');
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
        await refusal('fleet_full');
        return json(409, {
          error: 'We are fully booked that day. Message us — we sometimes free a vehicle up.',
          useWhatsApp: true,
        });
      }
    } catch (err) {
      // Fail closed. Selling a van we cannot confirm is worse than losing a booking.
      console.error('allotment check failed', err);
      await refusal('availability_unknown');
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
  //
  // SITE_URL pins it to the site's real address. Two Netlify sites now deploy this
  // repo, and each one also answers on its own *.netlify.app alias and on every deploy
  // preview — without this, a booking that happened to start on an alias would send the
  // guest back to that alias after paying, and she would land on a URL she has never
  // seen. Unset, it falls back to the requesting host, which is what it always did.
  const origin = (process.env.SITE_URL || `https://${event.headers.host}`).replace(/\/+$/, '');

  const meta = {
    booking_ref: ref,
    // Which of the two sites sold this. Both brands run on one Stripe account and one
    // webhook, so without this tag the manifest and the team email cannot tell a
    // cozumeltransfers.org booking from a cozumelislandtransfers.com one — and the guest
    // has to be met with the right board and answered in the right brand's voice.
    site: origin.replace(/^https?:\/\//, ''),
    destination: b.destination,
    destination_name: destName,
    date: b.date,
    pickup: hour12(pickupHour),
    ret: hour12(returnHour),
    pax: String(pax),
    vehicle: vehicle.slug,
    vehicle_name: vehicle.name,
    // Trimmed for the same reason `dropoff` below is: Stripe caps a metadata value at 500
    // characters and rejects the WHOLE session if one is over, so a 600-character paste in
    // either box turned into "We couldn't open the payment page" and a lost booking.
    ship: String(b.ship || 'Not on a cruise').slice(0, 400),
    guest: String(b.name || '').slice(0, 400),
    // The guest's address goes in metadata on purpose. Reading it back off the
    // PaymentIntent's receipt_email depends on Stripe's own receipt settings,
    // and if it ever comes back empty the day-before email silently goes to
    // nobody. Metadata is ours and always there.
    email: b.email,
    // Normalized, not as typed — this is the value any messaging API would have to dial.
    whatsapp: waE164,
    admission_prepaid: b.admissionPrepaid ? 'true' : 'false',
    // Free text, so it is trimmed to fit. Stripe caps a metadata value at 500 characters
    // and rejects the whole session if one is over, which would turn a typed paragraph
    // into a failed checkout.
    dropoff: String(b.dropoff || '').trim().slice(0, 400),
    // NOT `pickup`. That key is already taken above by the pickup TIME, and a JS object
    // literal keeps only the last of a duplicated key — so from 2026-08-07 to 2026-08-08
    // this line silently overwrote the time with a box that is empty for every cruise
    // guest. The manifest lost its sort, and guests were emailed "We pick you up:" with
    // nothing after it. Renaming is the whole fix; the time was never the problem.
    pickup_addr: String(b.pickup || '').trim().slice(0, 400),
  };

  // ---- the discount, worked out here and nowhere else ----
  //
  // She is on a cruise unless the ship box is empty or holds the escape phrase. The page
  // sends '' for a hotel guest (barGo() prefills the box from the bar's ship picker); the
  // words "not on a cruise" are accepted too, because that is what the old flow wrote and
  // what a stale tab may still send.
  const shipName = String(b.ship || '').trim();
  const cruise = Boolean(shipName) && !NOT_ON_A_CRUISE.test(shipName);

  // 🚨 `b.rate`, `b.percent`, `b.discount` are NEVER read. The browser is told the number,
  // it does not get to tell us one. A POST carrying one is either a stale build or somebody
  // trying it on, and both are worth a line in the log.
  if (b.rate !== undefined || b.percent !== undefined || b.discount !== undefined) {
    console.warn('create-checkout: ignoring a discount sent by the browser',
      { rate: b.rate, percent: b.percent, discount: b.discount });
  }

  const rate = await meter({ dateISO: b.date, vehicleSlug: vehicle.slug, cruise });
  const listUsd = vehicle.usd;                       // always the real list price
  let chargeUsd = cutPrice(listUsd, rate.percent);   // what she agreed to on the card
  let rateBasis = rate.basis;

  // TEMPORARY LIVE-TEST OVERRIDE.
  // Set TEST_PRICE_USD=5 in Netlify to charge $5 instead of the real price, so
  // the first end-to-end run on a live key costs $5 rather than $369. Only Mike
  // can set it (it's an environment variable, not anything a guest can send).
  // DELETE THE VARIABLE the moment the test passes — while it is set, every
  // booking on the site charges $5.
  const testPrice = Number(process.env.TEST_PRICE_USD) || 0;
  if (testPrice > 0) {
    console.warn(`TEST_PRICE_USD is set — charging ${testPrice} instead of ${chargeUsd}`);
    chargeUsd = testPrice;
  }

  // THE TEST SWITCH — a $1 live booking, for proving the chain end to end without a coupon.
  //
  // This replaces the promotion code the old site used for cheap live tests. A restricted
  // key cannot make coupons, so the switch is a shared secret instead: set CT_TEST_SWITCH in
  // the .org Netlify environment, open the site with ?ts=<that value>, and the page passes
  // it back here with the booking. Nothing else unlocks it — with the variable unset the
  // switch cannot fire at all, whatever a guest sends.
  //
  // The real percent is still recorded, so a test booking shows what it WOULD have charged;
  // rate_basis 'test' and test '1' are what mark it as not a sale.
  const switchSecret = String(process.env.CT_TEST_SWITCH || '');
  const isTest = switchSecret !== '' && String(b.test_switch || '') === switchSecret;
  if (isTest) {
    chargeUsd = 1;                 // → MX$18.00 on Stripe (1 USD × 18)
    rateBasis = 'test';
    console.warn(`CT_TEST_SWITCH matched — charging $1 (MX$${FX_MXN_PER_USD}) instead of ${cutPrice(listUsd, rate.percent)}`);
  }

  // What the Port Meter did to this booking, on the reservation record. Every existing key
  // above stays exactly as it was — the old site's webhook reads them by name.
  //   rate_percent         the percent applied, 0 when we could not work one out
  //   rate_basis           published · average · floor · unavailable · test
  //   ships_in_port        the real count for her day, '' when the port had not published it
  //   list_price_usd       the price on the ladder
  //   charged_vehicle_usd  what the vehicle line actually charges
  Object.assign(meta, {
    rate_percent: String(rate.percent),
    rate_basis: rateBasis,
    ships_in_port: rate.ships === null || rate.ships === undefined ? '' : String(rate.ships),
    list_price_usd: String(listUsd),
    charged_vehicle_usd: String(chargeUsd),
    ...(isTest ? { test: '1' } : {}),
  });

  // Always pesos — see FX_MXN_PER_USD at the top. The old TEST_CURRENCY override is gone:
  // with every charge already in MXN it had nothing left to switch, and a leftover
  // TEST_CURRENCY=usd would have charged dollar amounts multiplied by 18.
  // (`CURRENCY` in _cit.js stays 'usd' — it is the currency the PRICES are in, and the
  // other site on main still charges in it.)
  const currency = 'mxn';
  const vehicleMxn = toMxn(chargeUsd);
  const adm = ADMISSION[b.destination];
  const admPrepaid = Boolean(b.admissionPrepaid && adm && adm.verified && adm.usd > 0);
  const admMxnEach = admPrepaid ? toMxn(adm.usd) : 0;
  const totalMxn = vehicleMxn + admMxnEach * (admPrepaid ? pax : 0);
  Object.assign(meta, {
    fx_rate: String(FX_MXN_PER_USD),
    charged_currency: currency,
    charged_vehicle_mxn: String(vehicleMxn),
    charged_total_mxn: String(totalMxn),
  });

  // Every destination prices the same way: by vehicle, from the one list. The
  // per-destination override that used to sit here sold an 8-pax transfer for MX$100
  // to a real agency — see the note where FIXED_PRICE used to live in _cit.js.
  const params = {
    mode: 'payment',
    customer_email: b.email,
    client_reference_id: ref,
    success_url: `${origin}?paid=1&ref=${ref}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}?cancelled=1`,
    // Pesos only on the Stripe page. Adaptive Pricing (on by default) offered her USD at
    // Stripe's own rate — a $90 booking showed $96.43 — so the page contradicted ours.
    // Off, she sees MX$1,620 and her own bank converts, as the site says it will.
    'adaptive_pricing[enabled]': 'false',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': currency,
    'line_items[0][price_data][unit_amount]': String(Math.round(chargeUsd * FX_MXN_PER_USD * 100)),
    'line_items[0][price_data][product_data][name]': `${vehicle.name} to ${destName}`,
    // `dateLabel` is the one piece of this line the browser writes, so it is cut to the
    // length of a date. Uncut, a POST could put two thousand characters of its own wording
    // directly above the discount sentence below — on our receipt, in our Stripe dashboard.
    'line_items[0][price_data][product_data][description]':
      `${String(b.dateLabel || b.date).slice(0, 80)} · ${hour12(pickupHour)}–${hour12(returnHour)} · ${pax} people · round trip`
      // The receipt has to say WHY it is not the ladder price, or a guest comparing her
      // statement to the site sees a number that appears from nowhere. Stripe shows this
      // line under the item on Checkout and on the emailed receipt.
      //
      // The words follow the basis. A hotel guest never had a ship count, so calling her
      // floor a "quiet-day" discount would be describing a rule she was not priced under —
      // and the card in the bar already told her it was for hotel pickups.
      + discountLine(rateBasis, rate.percent, listUsd)
      // The dollars she saw, and the pesos her card is actually charged.
      + ` · charged ${fmtMxn(vehicleMxn)} (US$${chargeUsd.toLocaleString('en-US')} at ${FX_MXN_PER_USD} MXN/USD)`,
  };

  // Optional prepaid venue admission, per person. The price comes from ADMISSION in
  // _cit.js, never from the request — `b.admissionUsd` is ignored on purpose.
  // Unverified rates cannot be prepaid at all; see the note beside the table.
  if (admPrepaid) {
    params['line_items[1][quantity]'] = String(pax);
    params['line_items[1][price_data][currency]'] = currency;
    params['line_items[1][price_data][unit_amount]'] = String(Math.round(adm.usd * FX_MXN_PER_USD * 100));
    params['line_items[1][price_data][product_data][name]'] = `${destName} admission`;
    params['line_items[1][price_data][product_data][description]'] =
      `Paid now — nothing at the gate · US$${adm.usd} per person, charged ${fmtMxn(admMxnEach)} at ${FX_MXN_PER_USD} MXN/USD`;
  }

  // NO "Add promotion code" box. It was on permanently from 2026-08-07, on the argument
  // that a code would always be live and advertised, so the box was an asset rather than a
  // leak. The Port Meter is the discount now: it is worked out from her own day, it is
  // already in the price above, and it needs no code from anybody.
  //
  // 🚨 Do not switch it back on here. The .org Stripe key is restricted to writing Checkout
  // Sessions and reading PaymentIntents — it cannot create a coupon or a promotion code — so
  // the box would open on a screen where every code she types comes back invalid. That is
  // worse than no box at all: it tells a buyer at the last step that she is missing a deal.

  // Metadata on the session AND the payment, so it survives on the charge too.
  // This is what makes the Stripe dashboard readable as a reservation list.
  for (const [k, v] of Object.entries(meta)) {
    params[`metadata[${k}]`] = v;
    params[`payment_intent_data[metadata][${k}]`] = v;
  }

  try {
    const session = await stripe('checkout/sessions', params);
    // `charged` is what this booking was actually priced at, echoed back. The page ignores
    // it; it exists so the pricing can be read without opening a live Checkout page, and so
    // a mismatch between the card and the receipt is one request away from being proved.
    // Nothing in it is secret — it is the same arithmetic the guest is looking at.
    return json(200, {
      url: session.url,
      ref,
      charged: {
        vehicle_usd: chargeUsd,
        list_usd: listUsd,
        fx_rate: FX_MXN_PER_USD,
        currency,
        vehicle_mxn: vehicleMxn,
        total_mxn: totalMxn,
        percent: rate.percent,
        basis: rateBasis,
        ships: rate.ships === undefined ? null : rate.ships,
      },
    });
  } catch (err) {
    console.error('create-checkout', err);
    // She got all the way to the price screen and Stripe would not open. Worth knowing how
    // often, because unlike the other four this one is not a rule we chose.
    await refusal('payment_open_failed');
    return json(502, { error: "We couldn't open the payment page. Message us and we'll sort it out.", useWhatsApp: true });
  }
};
