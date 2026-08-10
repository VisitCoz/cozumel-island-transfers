// The calendar file, built server-side from Stripe metadata.
//
// ⚠️ TWIN OF `downloadICS()` IN index.html (~line 1657). Same UIDs, same two events,
// same floating local times. They cannot share a module — that one is browser JS, this
// one is Node CJS, and `scripts/build.js` was deleted on purpose — so if you change the
// shape of an event here, change it there too. Same rule as DEST/grid markup and
// VEH/VEHICLES.
//
// WHY THE UIDs MATTER. Three things now try to put this booking on a calendar: the
// button on the confirmation screen, this file attached to the emails, and the Google
// Calendar invite from apps_script/cit_calendar. Calendar clients dedupe on UID, so
// giving all three the same UID is what stops a guest ending up with three copies of
// her pickup. Never make a UID unique per send.
//
// Times are FLOATING (no Z, no TZID) and that is deliberate: the guest's phone will be
// on Cozumel time when the alarm fires, and a floating time is the only kind that is
// right on every device without shipping a VTIMEZONE block.

const { minutesOf } = require('./_cit');

const WA_NUMBER = '5219871146853';   // twin of index.html:1332

// iCalendar escaping: comma, semicolon and backslash are field separators.
const esc = (s) => String(s ?? '').replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, '\\n');

// "2026-11-14" + 570 minutes -> "20261114T093000"
function stamp(dateIso, mins) {
  const p = (n) => String(n).padStart(2, '0');
  const [y, mo, d] = String(dateIso).split('-').map(Number);
  return `${y}${p(mo)}${p(d)}T${p(Math.floor(mins / 60))}${p(mins % 60)}00`;
}

// A stable UID per booking per leg. The domain half is cosmetic; the ref is what makes
// it unique, and it is the same ref printed on the confirmation screen and the voucher.
const uidFor = (ref, leg) => `${ref}-${leg}@cozumelislandtransfers.com`;

/**
 * Both legs of one booking as a single VCALENDAR.
 * `m` is the Stripe metadata object exactly as create-checkout.js builds it —
 * `pickup` and `ret` are hour12 strings ("9:00 AM"), not numbers.
 */
function bookingIcs(m) {
  const ref = m.booking_ref || '';
  const dest = m.destination_name || m.destination || 'your destination';
  const vehicle = m.vehicle_name || m.vehicle || 'Private vehicle';
  const day = m.date;
  const start = minutesOf(m.pickup);
  const end = minutesOf(m.ret);

  // Where the pickup happens. A cruise guest is met at the terminal; a guest who gave us
  // an address is collected there. We never assert WHICH terminal — the port publishes
  // that late, and a wrong guess is worse than a short list.
  const pickPlace = m.pickup_addr
    ? String(m.pickup_addr)
    : 'Cozumel cruise terminal — our meeting point, just outside';
  const dropPlace = m.dropoff
    ? String(m.dropoff)
    : `${dest}, Cozumel — same spot you were dropped off`;

  const notes = `Booking ${ref}. Look for a sign reading ${String(m.guest || 'YOUR NAME').toUpperCase()}. `
    + `${vehicle} to ${dest}. Paid in full — nothing to pay the driver. `
    + `Message us on WhatsApp: wa.me/${WA_NUMBER} (+52 987 114 6853). We answer in English.`;

  // DTSTAMP must be a UTC instant. Noon on the travel day is stable across re-sends,
  // which matters: a DTSTAMP built from Date.now() changes on every Stripe retry and
  // some clients read that as a modified event.
  const dtstamp = `${stamp(day, 12 * 60)}Z`;

  const vevent = (leg, summary, mins, place, alarmMins) => [
    'BEGIN:VEVENT',
    `UID:${uidFor(ref, leg)}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${stamp(day, mins)}`,
    `DTEND:${stamp(day, mins + 60)}`,
    `SUMMARY:${esc(summary)}`,
    `LOCATION:${esc(place)}`,
    `DESCRIPTION:${esc(notes)}`,
    'BEGIN:VALARM',
    `TRIGGER:-PT${alarmMins}M`,
    'ACTION:DISPLAY',
    `DESCRIPTION:${esc(summary)}`,
    'END:VALARM',
    'END:VEVENT',
  ].join('\r\n');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Cozumel Island Transfers//Transfer//EN',
    'CALSCALE:GREGORIAN',
    // PUBLISH, not REQUEST. This is a file she saves, not an invitation she answers —
    // the RSVP version is the Google Calendar invite, which carries the same UID.
    'METHOD:PUBLISH',
    vevent('pickup', `Transfer to ${dest} — look for your name on a sign`, start, pickPlace, 30),
    vevent('return', `Your driver comes back for you at ${dest}`, end, dropPlace, 30),
    'END:VCALENDAR',
  ].join('\r\n');
}

/** Resend wants attachments base64-encoded. */
function icsAttachment(m) {
  return {
    filename: `${m.booking_ref || 'cozumel-transfer'}.ics`,
    content: Buffer.from(bookingIcs(m), 'utf8').toString('base64'),
    contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
  };
}

module.exports = { bookingIcs, icsAttachment, uidFor, stamp };
