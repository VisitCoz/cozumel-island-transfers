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

const { json, verifyStripeSignature, sendEmail, teamEmails, bookings,
        calendar, calendarConfigured } = require('./_cit');
const { bookingEmail, bookingSubject, confirmationEmail, confirmationSubject } = require('./_emails');
const { icsAttachment } = require('./_ics');

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
  const failures = [];

  // Every send below carries an Idempotency-Key built from the Checkout session id. That is
  // what makes the retries this function now ASKS for safe: Stripe re-delivers, Resend sees
  // the same key and drops the duplicate, and nobody gets five copies of one booking.
  //
  // Without a mail key nothing can be announced at all. That used to return 200 and the
  // booking disappeared in silence with the dashboard still green. Fail loudly instead — a
  // 500 both retries and turns the webhook red, which is the only signal anyone would see.
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY missing — cannot announce paid booking', m.booking_ref);
    return json(500, { error: 'mail is not configured; refusing to lose this booking quietly' });
  }

  // The .ics, built once for whichever emails end up needing it. It is a nicety and the
  // email is the booking, so building it is never allowed to throw its way past the
  // announcements — a paid guest nobody hears about is the one outcome this whole function
  // exists to prevent.
  let ics = null;
  try { ics = icsAttachment(m); }
  catch (err) { console.error('ics build failed, mailing without it', m.booking_ref, err); }

  // Whether the shared calendar accepted this booking. When it did, the calendar IS the
  // calendar entry for everyone — the guest by invitation, the team by subscription — and
  // nobody gets the file. When it did not, the file is the fallback for both.
  let calendarOk = false;

  // Put it on the shared calendar FIRST, before anything is mailed.
  //
  // The order is the whole design. A calendar failure has to be retryable, and it can only
  // be retried for free while no mail has gone out yet — Stripe re-delivers for three days,
  // Resend's idempotency memory is 24 hours, so a retry on day two duplicates the emails.
  // Doing the calendar first means the common failure costs nothing. Apps Script dedupes on
  // the event UID, so the retry itself is harmless.
  //
  // It must NOT be able to block the emails, though: an unreachable Apps Script deployment
  // would otherwise silence every booking notification in the business. So it is caught,
  // recorded, and the mail runs regardless — the 500 at the bottom is what asks for a retry.
  if (calendarConfigured()) {
    try {
      const r = await calendar('upsertBooking', { booking: {
        sessionId: s.id, ref: m.booking_ref || s.client_reference_id || '',
        date: m.date || '', pickup: m.pickup || '', ret: m.ret || '',
        destination: m.destination_name || m.destination || '',
        pax: Number(m.pax) || 0, vehicle: m.vehicle_name || m.vehicle || '',
        ship: m.ship || '', guest: m.guest || '', email, whatsapp: m.whatsapp || '',
        pickupAddr: m.pickup_addr || '', dropoff: m.dropoff || '',
        amountUsd: amount, currency,
        admissionPrepaid: m.admission_prepaid === 'true',
      }});
      done.calendared = r.duplicate ? 'already there' : true;
      calendarOk = true;
    } catch (err) {
      console.error('calendar write failed', m.booking_ref, err);
      failures.push('calendar');
    }
  }

  // One rule, both audiences: the file only when the calendar did not take the booking.
  const fallbackIcs = (calendarOk || !ics) ? undefined : [ics];

  // Tell the team. Reply-to is the guest, so hitting reply in Gmail reaches them.
  const team = teamEmails();
  if (team.length) {
    try {
      await sendEmail({
        to: team,
        replyTo: email || undefined,
        subject: bookingSubject(m),
        html: bookingEmail(m, amount, currency, email),
        // Same rule as the guest's copy: only when the calendar did not take it.
        // Once the shared calendar has the booking the team is already covered, and the
        // attachment actively hurts — Gmail turns it into an "Add to calendar" card, checks
        // it against the calendar, finds the event the script just made, and reports the
        // booking as clashing with itself. Five people, every booking.
        attachments: fallbackIcs,
        idempotencyKey: `team-${s.id}`,
      });
      done.teamEmailed = team.length;
    } catch (err) {
      // No longer swallowed. See the failures check at the end.
      console.error('team email failed', m.booking_ref, err);
      failures.push('team');
    }
  }

  // Tell HER. She may have booked three weeks before she sails; until 2026-08-08 this did
  // not exist and her first word from us was the day-before email.
  //
  // 🚨 She gets the .ics ONLY when the calendar did not take the booking — see fallbackIcs
  // above. If the Google invitation went out, that IS her calendar entry, and attaching the
  // file as well would put the same pickup on her phone twice.
  //
  // The original design claimed a shared UID would make the two merge. It cannot: the
  // invitation has to be created with events.insert to send at all, insert does not accept
  // an iCalUID, and Google assigns its own — so the two objects can never carry the same
  // identifier. One or the other, never both. See eventIdFor() in cit_calendar/Code.gs.
  if (email) {
    try {
      await sendEmail({
        to: email,
        subject: confirmationSubject(m),
        html: confirmationEmail(m, amount, currency, email),
        attachments: fallbackIcs,
        idempotencyKey: `guest-${s.id}`,
      });
      done.guestEmailed = true;
    } catch (err) {
      console.error('guest confirmation failed', m.booking_ref, err);
      failures.push('guest');
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

  // A notification that did not go out is a booking nobody knows about. 500 tells Stripe to
  // try again — it will, repeatedly, for up to three days — and the idempotency keys above
  // mean the sends that already worked are not repeated.
  if (failures.length) {
    return json(500, { error: 'notification failed', failed: failures, ...done });
  }

  return json(200, { received: true, ...done });
};
