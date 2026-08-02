// POST /.netlify/functions/stripe-webhook   (Stripe calls this, not the site)
//
// THIS IS THE MOMENT A BOOKING EXISTS — not the button click.
// A card can succeed and the guest's browser can still die on the way back, or
// they close the tab, or the wifi drops as the ship pulls out. If we wrote the
// booking from the browser we would lose those guests silently, having already
// taken their money. So nothing is recorded until Stripe tells us it happened.
//
// Stripe retries a failed webhook for up to three days, which is a feature —
// but it means the same event can arrive more than once, so the write has to be
// idempotent. The Sheet dedups on the Checkout session id.

const { json, verifyStripeSignature, bookings } = require('./_cit');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  // PHASE ONE: Stripe is the booking list. There is no sheet yet, so there is
  // nothing for this to record — acknowledge and stay quiet. Returning 200 keeps
  // the Stripe dashboard green; a 4xx here would light up the error rate on an
  // endpoint that is working exactly as intended.
  //
  // The moment BOOKINGS_URL and STRIPE_WEBHOOK_SECRET are set, everything below
  // switches on by itself and starts writing rows. No code change needed.
  if (!process.env.BOOKINGS_URL || !process.env.STRIPE_WEBHOOK_SECRET) {
    return json(200, { received: true, recording: false });
  }

  // The signature is computed over the EXACT bytes Stripe sent. Do not parse,
  // re-encode or trim before verifying.
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : (event.body || '');

  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!verifyStripeSignature(raw, sig, secret)) {
    // 400 tells Stripe not to keep retrying something that will never verify.
    return json(400, { error: 'signature verification failed' });
  }

  let evt;
  try { evt = JSON.parse(raw); }
  catch { return json(400, { error: 'unparseable body' }); }

  // Acknowledge anything we don't handle, so Stripe stops retrying it.
  if (evt.type !== 'checkout.session.completed') {
    return json(200, { received: true, ignored: evt.type });
  }

  const s = evt.data.object;
  if (s.payment_status !== 'paid') {
    return json(200, { received: true, ignored: 'not paid' });
  }

  const m = s.metadata || {};
  const booking = {
    sessionId: s.id,
    ref: m.booking_ref || s.client_reference_id || '',
    amountUsd: (s.amount_total || 0) / 100,
    currency: (s.currency || '').toUpperCase(),
    email: s.customer_details?.email || s.customer_email || '',
    guest: m.guest || s.customer_details?.name || '',
    whatsapp: m.whatsapp || '',
    destination: m.destination || '',
    destinationName: m.destination_name || '',
    date: m.date || '',
    pickup: m.pickup || '',
    ret: m.ret || '',
    pax: Number(m.pax) || 0,
    vehicle: m.vehicle || '',
    vehicleName: m.vehicle_name || '',
    ship: m.ship || '',
    admissionPrepaid: m.admission_prepaid === 'true',
  };

  try {
    // Apps Script writes the row, posts to Slack and emails the team.
    // It dedups on sessionId, so a Stripe retry is harmless.
    const out = await bookings('recordBooking', { booking });
    return json(200, { received: true, recorded: out?.recorded !== false });
  } catch (err) {
    console.error('stripe-webhook: failed to record', booking.ref, err);
    // 500 makes Stripe retry — which is exactly what we want, because the money
    // is already taken and this booking must not be lost. It will show up in
    // Stripe's webhook log as failing, which is the alarm.
    return json(500, { error: 'could not record booking' });
  }
};
