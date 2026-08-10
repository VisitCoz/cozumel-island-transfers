/**
 * Cozumel Island Transfers — the shared operations calendar.
 *
 * ONE JOB. Every paid booking becomes two events on a calendar the whole team
 * subscribes to, and the guest is invited to her own transfer. Nothing else.
 *
 * This is NOT apps_script/cit_bookings. That script writes a spreadsheet, mails the
 * team and posts to Slack — all three of which this system already does elsewhere, and
 * the spreadsheet is one Mike explicitly rejected. Do not merge them and do not point
 * BOOKINGS_URL at this deployment. Separate script, separate token, separate env pair.
 *
 * It never touches Stripe. It is told what happened by the Netlify webhook, which is
 * the only thing that can verify a Stripe signature (Apps Script cannot read request
 * headers — that is why the split exists at all).
 *
 * ── WHY THE ADVANCED CALENDAR SERVICE AND NOT CalendarApp ──────────────
 * CalendarApp cannot set iCalUID, and iCalUID is load-bearing twice over:
 *   1. Idempotency. Stripe retries a failed webhook for three days. Looking the UID up
 *      before inserting is what stops the same booking appearing five times, and it
 *      needs no spreadsheet to check against.
 *   2. Deduping against the guest's own copy. The confirmation screen and the emails
 *      both hand her an .ics carrying these exact UIDs (netlify/functions/_ics.js), so
 *      if she saves the file AND accepts the invite her calendar merges them instead of
 *      showing the same pickup twice.
 * Change a UID here and you must change _ics.js and index.html's downloadICS() with it.
 *
 * ── SETUP ──────────────────────────────────────────────────────────────
 * 1. calendar.google.com → create a calendar named "CIT Transfers".
 *    Share it with Emma, Adela, Gilberto and Mario ("See all event details").
 *    Settings → Integrate calendar → copy the Calendar ID.
 * 2. Project Settings → Script Properties:
 *      CIT_CALENDAR_ID    the ID from step 1
 *      CIT_SHARED_TOKEN   a long random string — run makeToken() once and copy the log
 * 3. Services (+) → Google Calendar API → v3, identifier "Calendar".
 *    (If this repo's appsscript.json was pushed, it is already enabled.)
 * 4. Deploy → New deployment → Web app.
 *      Execute as: Me        Who has access: Anyone
 *    Copy the /exec URL.
 * 5. Netlify → Environment variables → Production:
 *      CALENDAR_URL     the /exec URL from step 4
 *      CALENDAR_TOKEN   the same token from step 2
 *    ⚠️ Read the variable NAME back after pasting. Netlify's key field selects its
 *    contents on click, so a paste eats the first character — that is how we once got
 *    a variable called TRIPE_WEBHOOK_SECRET.
 * ──────────────────────────────────────────────────────────────────────
 */

var TIMEZONE = 'America/Cancun';   // UTC-5 all year, no daylight saving
var EVENT_MINUTES = 60;            // each leg blocks an hour, same as the .ics
var WHATSAPP = '+52 987 114 6853';

/** Run this once from the editor, then paste the result into Script Properties. */
function makeToken() {
  Logger.log(Utilities.getUuid() + Utilities.getUuid().replace(/-/g, ''));
}

function prop(k) {
  var v = PropertiesService.getScriptProperties().getProperty(k);
  return v && v.trim() ? v.trim() : null;
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function calendarId() {
  var id = prop('CIT_CALENDAR_ID');
  if (!id) throw new Error('CIT_CALENDAR_ID is not set in Script Properties');
  return id;
}

/** Same UIDs as netlify/functions/_ics.js and index.html. Do not diverge. */
function uidFor(ref, leg) {
  return ref + '-' + leg + '@cozumelislandtransfers.com';
}

/**
 * "9:00 AM" -> "09:00:00". The webhook sends the same hour12 strings that
 * create-checkout.js wrote into Stripe metadata, so this is the only parser needed.
 * An unreadable time is fatal on purpose: an event silently pinned to midnight is
 * worse than a booking that fails loudly and gets retried.
 */
function timeOf(t) {
  var m = String(t).match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) throw new Error('unreadable time: ' + t);
  var h = (Number(m[1]) % 12) + (/pm/i.test(m[3]) ? 12 : 0);
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return pad(h) + ':' + pad(Number(m[2])) + ':00';
}

/** The one existing event with this UID, or null. Cancelled ones do not count. */
function findByUid(uid) {
  var res = Calendar.Events.list(calendarId(), { iCalUID: uid, showDeleted: false, maxResults: 1 });
  var items = res.items || [];
  return items.length ? items[0] : null;
}

/** Everything the team needs to run the day, in the event body. */
function describe(b) {
  var wa = String(b.whatsapp || '').replace(/[^0-9]/g, '');
  // null = this booking has no such field, drop the line.
  // '' = a deliberate blank line, keep it. Filtering on truthiness would eat both.
  var lines = [
    'Ref ' + (b.ref || ''),
    '',
    (b.guest || 'Guest') + (b.email ? '  ·  ' + b.email : '') + (b.whatsapp ? '  ·  ' + b.whatsapp : ''),
    b.pax + ' passengers  ·  ' + (b.vehicle || ''),
    b.ship ? 'Ship: ' + b.ship : null,
    b.pickupAddr ? 'Pick up at: ' + b.pickupAddr : null,
    b.dropoff ? 'Going to: ' + b.dropoff : null,
    '',
    'Pick up ' + b.pickup + '  ·  back ' + b.ret + '  (Cozumel time)',
    'Paid $' + Number(b.amountUsd || 0).toFixed(2) + ' ' + (b.currency || 'USD') +
      (b.admissionPrepaid ? '  (admission prepaid)' : '') + '  ·  nothing owed to the driver',
    wa ? 'WhatsApp the guest: https://wa.me/' + wa : null,
    '',
    'Questions: ' + WHATSAPP
  ];
  return lines.filter(function (l) { return l !== null; }).join('\n');
}

/**
 * Insert one leg. Returns true if it created something, false if it was already there.
 *
 * The guest is the only attendee. The team sees this because the CALENDAR is shared with
 * them, not because they are invited — which also means her invitation does not carry a
 * list of staff email addresses.
 */
function insertLeg(b, leg, summary, time, location) {
  var uid = uidFor(b.ref, leg);
  if (findByUid(uid)) return false;

  // End is start + EVENT_MINUTES, computed rather than passed in, so the two legs can
  // never drift apart in length. The -05:00 is Cozumel, which has no daylight saving.
  var end = new Date(b.date + 'T' + time + '-05:00');
  end.setMinutes(end.getMinutes() + EVENT_MINUTES);

  var resource = {
    iCalUID: uid,
    summary: summary,
    location: location,
    description: describe(b),
    start: { dateTime: b.date + 'T' + time, timeZone: TIMEZONE },
    end: { dateTime: Utilities.formatDate(end, TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss"), timeZone: TIMEZONE },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    extendedProperties: { private: { citSessionId: String(b.sessionId || ''), citRef: String(b.ref || '') } }
  };

  if (b.email) resource.attendees = [{ email: b.email }];

  Calendar.Events.insert(resource, calendarId(), { sendUpdates: b.email ? 'all' : 'none' });
  return true;
}

/**
 * Two events — the pickup and the return. Two, not one, because the return is the run
 * dispatch forgets and the one the guest must not miss. The existing .ics has always
 * split them; this matches it.
 */
function upsertBooking(b) {
  if (!b || !b.ref) return out({ error: 'no booking ref' });
  if (!b.date || !b.pickup || !b.ret) return out({ error: 'missing date, pickup or return' });

  // Her FULL name, not just the first — the whole product is a rep holding a sign with
  // it on, so it is the one string someone reading this calendar actually needs.
  var tail = ' · ' + b.pax + ' pax' + (b.guest ? ' · ' + b.guest : '');

  var madePickup = insertLeg(
    b, 'pickup',
    'CIT · ' + b.destination + tail,
    timeOf(b.pickup),
    b.pickupAddr || 'Cozumel cruise terminal — our meeting point, just outside'
  );
  var madeReturn = insertLeg(
    b, 'return',
    'CIT return · ' + b.destination + tail,
    timeOf(b.ret),
    b.dropoff || (b.destination + ', Cozumel')
  );

  // Both already present means this is a Stripe retry, not a new booking.
  if (!madePickup && !madeReturn) return out({ calendared: false, duplicate: true });
  return out({ calendared: true, pickup: madePickup, ret: madeReturn });
}

/**
 * For the refund path. Nothing calls this yet — a refund does not cancel a booking
 * automatically anywhere in this system, and pretending otherwise in a comment is how
 * someone comes to rely on it. Written now because deleting by UID belongs next to
 * creating by UID.
 */
function cancelBooking(b) {
  if (!b || !b.ref) return out({ error: 'no booking ref' });
  var removed = 0;
  ['pickup', 'return'].forEach(function (leg) {
    var ev = findByUid(uidFor(b.ref, leg));
    if (ev) {
      Calendar.Events.remove(calendarId(), ev.id, { sendUpdates: 'all' });
      removed++;
    }
  });
  return out({ cancelled: removed });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    // The only gate on this endpoint. It is deployed as "Anyone", because the Netlify
    // function calls it without a Google login.
    var expected = prop('CIT_SHARED_TOKEN');
    if (!expected || body.token !== expected) return out({ error: 'unauthorized' });

    if (body.action === 'upsertBooking') return upsertBooking(body.booking);
    if (body.action === 'cancelBooking') return cancelBooking(body.booking);
    return out({ error: 'unknown action' });
  } catch (err) {
    return out({ error: String(err) });
  }
}

function doGet() {
  return ContentService.createTextOutput('CIT calendar endpoint OK');
}

/**
 * Run from the editor to prove the whole thing works without spending money.
 * Run it TWICE: the second run must report duplicate: true and create nothing.
 * Delete the two events afterwards, or call cancelBooking with the same ref.
 */
function selfTest() {
  var b = {
    sessionId: 'cs_test_selftest', ref: 'CIT-SELFTS',
    date: Utilities.formatDate(new Date(Date.now() + 7 * 86400000), TIMEZONE, 'yyyy-MM-dd'),
    pickup: '9:00 AM', ret: '2:00 PM',
    destination: 'Mr. Sanchos', pax: 6, vehicle: 'Private van',
    ship: 'Celebrity Equinox', guest: 'Self Test', email: '',
    whatsapp: '', pickupAddr: '', dropoff: '',
    amountUsd: 369, currency: 'USD', admissionPrepaid: false
  };
  Logger.log(upsertBooking(b).getContent());
}
