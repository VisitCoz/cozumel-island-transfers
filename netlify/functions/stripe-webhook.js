// POST /.netlify/functions/stripe-webhook   (Stripe calls this, not the site)
//
// THIS IS THE MOMENT A BOOKING EXISTS — not the button click.
// A card can succeed and the guest's browser can still die on the way back, or
// they close the tab, or the wifi drops as the ship pulls out. If we told the
// team from the browser we would silently miss those guests, having already
// taken their money. So nothing is announced until Stripe says it happened.
//
// Stripe retries a failed webhook for up to three days, which is a feature —
// but it means the same event can arrive twice. Everything here must therefore
// be safe to run more than once.

const { json, verifyStripeSignature, sendEmail, teamEmails, bookings } = require('./_cit');
const { bookingEmail, bookingSubject } = require('./_emails');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  // Without the signing secret we cannot prove an event came from Stripe, so we
  // must not act on it. Acknowledge so the dashboard stays green.
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return json(200, { received: true, verified: false, note: 'STRIPE_WEBHOOK_SECRET not set' });
  }

  // The signature covers the EXACT bytes Stripe sent. Do not parse before verifying.
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : (event.body || '');
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  if (!verifyStripeSignature(raw, sig, process.env.STRIPE_WEBHOOK_SECRET)) {
    return json(400, { error: 'signature verification failed' });
  }

  let evt;
  try { evt = JSON.parse(raw); } catch { return json(400, { error: 'unparseable body' }); }

  if (evt.type !== 'checkout.session.completed') return json(200, { received: true, ignored: evt.type });

  const s = evt.data.object;
  if (s.payment_status !== 'paid') return json(200, { received: true, ignored: 'not paid' });

  const m = s.metadata || {};
  const amount = (s.amount_total || 0) / 100;
  const currency = (s.currency || '').toUpperCase();
  const email = s.customer_details?.email || s.customer_email || '';
  const done = {};

  // Tell the team. Reply-to is the guest, so hitting reply in Gmail reaches them.
  const team = teamEmails();
  if (process.env.RESEND_API_KEY && team.length) {
    try {
      await sendEmail({
        to: team,
        replyTo: email || undefined,
        subject: bookingSubject(m),
        html: bookingEmail(m, amount, currency, email),
      });
      done.teamEmailed = team.length;
    } catch (err) {
      console.error('team email failed', m.booking_ref, err);
      done.teamEmailed = false;
    }
  }

  // The sheet is optional and switches itself on the moment it is configured.
  if (process.env.BOOKINGS_URL && process.env.BOOKINGS_TOKEN) {
    try {
      await bookings('recordBooking', { booking: {
        sessionId: s.id, ref: m.booking_ref || s.client_reference_id || '',
        amountUsd: amount, currency, email, guest: m.guest || '', whatsapp: m.whatsapp || '',
        destination: m.destination || '', destinationName: m.destination_name || '',
        date: m.date || '', pickup: m.pickup || '', ret: m.ret || '',
        pax: Number(m.pax) || 0, vehicle: m.vehicle || '', vehicleName: m.vehicle_name || '',
        ship: m.ship || '', admissionPrepaid: m.admission_prepaid === 'true',
      }});
      done.recorded = true;
    } catch (err) {
      console.error('sheet write failed', m.booking_ref, err);
      // 500 makes Stripe retry, which is what we want — the money is already taken.
      return json(500, { error: 'could not record booking' });
    }
  }

  return json(200, { received: true, ...done });
};
