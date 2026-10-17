/**
 * Cozumel Island Transfers — the shared operations calendar.
 *
 * ONE JOB. Every paid booking becomes two events on a calendar the whole team
 * subscribes to, and the guest is invited to her own transfer. Since 2026-10-11 it also
 * lands once on the dispatch calendar (see DISPATCH_CALENDAR_ID). Nothing else.
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
 * CalendarApp cannot set the event `id`, and a caller-chosen id is what makes this
 * idempotent: Stripe retries a failed webhook for three days, and Google refusing a
 * repeated id is what stops one booking appearing five times — with no spreadsheet to
 * check against. See eventIdFor() for why this is the `id` and not the `iCalUID`.
 *
 * ── WHO RUNS THIS, AND WHY IT IS THE WHOLE POINT ───────────────────────
 * 🚨 Deploy this as **hello@cozumelislandtransfers.com**, onto **that account's own
 * primary calendar**. Both halves matter and they are set in different places:
 *   - The `From:` on the invitation email follows the account EXECUTING the script.
 *   - The `organizer` shown inside the event, and the address the guest's RSVP and any
 *     reply go to, follows the CALENDAR the event lives on — and it is read-only on
 *     insert, so it cannot be overridden in code. On a secondary calendar the organizer
 *     is that calendar's own @group.calendar.google.com address, which nobody reads.
 * Deploying this from a different account silently changes who the guest hears from.
 *
 * ── SETUP ──────────────────────────────────────────────────────────────
 * Do ALL of this signed in as hello@cozumelislandtransfers.com.
 * 1. Calendar → Settings → hello@'s own calendar: rename it "Cozumel Island Transfers",
 *    then share with Emma, Adela and Gilberto ("See all event details") and with
 *    dispatch ("Make changes"). No secondary calendar is created.
 * 2. Calendar → Settings → Event settings → turn OFF "Automatically add Google Meet
 *    video conferences to events I create" — otherwise the guest's biggest button on a
 *    pier-pickup invitation is "Join with Google Meet".
 * 3. Calendar → Settings → this calendar → Event notifications → turn OFF "Event
 *    responses", or every guest RSVP lands in the inbox Adela and Emma watch.
 * 4. Project Settings → Script Properties:
 *      CIT_CALENDAR_ID    primary
 *      CIT_SHARED_TOKEN   a long random string — run makeToken() once and copy the log
 * 5. Services (+) → Google Calendar API → v3, identifier "Calendar".
 *    (If this repo's appsscript.json was pushed, it is already declared.)
 * 6. Deploy → New deployment → Web app.
 *      Execute as: Me (hello@)    Who has access: Anyone
 *    Copy the /exec URL.
 * 7. Netlify → Environment variables → Production:
 *      CALENDAR_URL     the /exec URL from step 6
 *      CALENDAR_TOKEN   the same token from step 4
 *    ⚠️ Read the variable NAME back after pasting. Netlify's key field selects its
 *    contents on click, so a paste eats the first character — that is how we once got
 *    a variable called TRIPE_WEBHOOK_SECRET.
 *    Then trigger a Netlify deploy: an env change alone does nothing.
 * ──────────────────────────────────────────────────────────────────────
 */

var TIMEZONE = 'America/Cancun';   // UTC-5 all year, no daylight saving
var EVENT_MINUTES = 60;            // each leg blocks an hour, same as the .ics
var WHATSAPP = '+52 987 114 6853';

// The dispatch calendar the drivers are assigned from. Until 2026-10-11 every booking was
// retyped onto it by hand, anywhere from an hour to six days after payment. Now it gets one
// event per booking, in the shape dispatch already typed: "RT Transfer <guest>", half an
// hour at the pickup time; dispatch adds the unit number to the title.
// hello@ needs "Make changes to events" on this calendar, or the write is refused.
var DISPATCH_CALENDAR_ID = 'b3f05d5ff0463c4168fcd27ca1c4e77e58f0dbc106cf3c04a4d3227af49e3fdf@group.calendar.google.com';
var DISPATCH_MINUTES = 30;
// The shared Minivan calendar (Jeep + Minivan pool with Visit Cozumel and Tierra Maya, Mike 2026-10-17).
// Shared with hello@ ("Make changes to events") from the account that owns it.
var MINIVAN_CALENDAR_ID = '0042044e539ce3b7177411b6dd0a48eddf1e4f178d853065a167327ff74ce292@group.calendar.google.com';

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

/**
 * The .ics UID for this leg, as netlify/functions/_ics.js and index.html emit it.
 * Kept only so it can be STORED on the event for traceability — see the note on
 * eventIdFor() for why it can no longer be the thing Google dedupes on.
 */
function uidFor(ref, leg) {
  return ref + '-' + leg + '@cozumelislandtransfers.com';
}

/**
 * The Google event id — our idempotency key.
 *
 * 🚨 WHY NOT iCalUID. The first version of this file set `iCalUID` on
 * Calendar.Events.insert and looked it up before inserting, so that the Google event and
 * the .ics we email would share an identifier. That does not work: `iCalUID` is not among
 * the request-body fields documented for events.insert — Google's own note reads "the
 * icalUID and the id are not identical and only one of them should be supplied at event
 * creation time", and iCalUID is documented as the field that "must be supplied when
 * importing events via the import method". events.import DOES accept it, but import takes
 * no sendUpdates parameter, so it cannot send the guest her invitation — which is the
 * entire point. So: insert, and use the identifier insert actually honours.
 *
 * `id` IS documented writable on insert, and for exactly this purpose: it "prevents
 * duplicate event creation if the operation fails at some point after it is successfully
 * executed in the Calendar backend". Stripe retries for three days; this is what makes
 * that safe.
 *
 * Format is base32hex — lowercase a-v and 0-9 only, 5-1024 chars — so the ref cannot be
 * used raw ("CIT-M6G0PQ-pickup" has uppercase, hyphens and letters past v). Hash it.
 */
function eventIdFor(ref, leg) {
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, ref + '|' + leg, Utilities.Charset.UTF_8);
  var alphabet = 'abcdefghijklmnopqrstuv0123456789';   // base32hex, 32 chars
  var s = '';
  for (var i = 0; i < 16; i++) s += alphabet[(raw[i] + 256) % 32];
  return s;
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

/**
 * The event body.
 *
 * 🚨 THE GUEST IS AN ATTENDEE, so she reads this. It is not a dispatch note. Anything the
 * team needs and she does not goes into extendedProperties.private instead, which is
 * invisible to attendees.
 *
 * The timezone line is not decoration. Google renders America/Cancun as "Eastern Standard
 * Time – Cancún" and stamps "(EST)" in the invitation subject; a guest in July reads that
 * as Eastern DAYLIGHT time and arrives an hour late for a pier pickup she has already paid
 * $369 for. Say the number in her terms, in words, first.
 */
function describe(b, leg) {
  var isReturn = leg === 'return';
  var when = isReturn ? b.ret : b.pickup;
  // null = this booking has no such field, drop the line.
  // '' = a deliberate blank line, keep it. Filtering on truthiness would eat both.
  var lines = [
    when + ' Cozumel time (UTC−5 — the same clock as US Eastern in winter, one hour ' +
      'behind it in summer). Not your ship\'s onboard clock; many ships run an hour ahead.',
    '',
    isReturn
      ? 'Your driver comes back for you at ' + b.destination + ', the same spot you were ' +
        'dropped off. The whole group travels back together on one run.'
      : 'Our English-speaking representative will be waiting with a sign reading ' +
        (b.guest || 'your name').toUpperCase() + '. Please be there 15 minutes early.',
    '',
    b.pax + ' passengers  ·  ' + (b.vehicle || ''),
    b.ship ? 'Ship: ' + b.ship : null,
    b.pickupAddr ? 'Pick up at: ' + b.pickupAddr : null,
    b.dropoff ? 'Going to: ' + b.dropoff : null,
    // Her own name and number. Ordinary on a booking she is looking at, and the one line
    // that saves dispatch a lookup on the morning — the amount paid and the Stripe session
    // stay in extendedProperties, where she cannot see them.
    b.whatsapp ? 'Booked by ' + (b.guest || 'guest') + '  ·  ' + b.whatsapp : null,
    '',
    'Paid in full' + (b.admissionPrepaid ? ', admission included' : '') +
      '. Nothing is owed to the driver.',
    'Booking reference ' + (b.ref || ''),
    '',
    'Any question at all, message us on WhatsApp — we answer in English: ' + WHATSAPP
  ];
  return lines.filter(function (l) { return l !== null; }).join('\n');
}

/** What the team needs and the guest must not see. Attendees cannot read these. */
function opsProperties(b, leg) {
  return {
    citSessionId: String(b.sessionId || ''),
    citRef: String(b.ref || ''),
    citLeg: String(leg),
    citIcsUid: uidFor(b.ref, leg),          // ties the event back to the emailed .ics
    citGuestEmail: String(b.email || ''),
    citWhatsApp: String(b.whatsapp || ''),
    citPaid: Number(b.amountUsd || 0).toFixed(2) + ' ' + (b.currency || 'USD')
  };
}

/**
 * Insert one leg. Returns true if it created something, false if it was already there.
 *
 * The guest is the only attendee. The team sees this because the CALENDAR is shared with
 * them, not because they are invited — which also means her invitation does not carry a
 * list of staff email addresses.
 */
function insertLeg(b, leg, summary, time, location) {
  // End is start + EVENT_MINUTES, computed rather than passed in, so the two legs can
  // never drift apart in length. The -05:00 is Cozumel, which has no daylight saving.
  var end = new Date(b.date + 'T' + time + '-05:00');
  end.setMinutes(end.getMinutes() + EVENT_MINUTES);

  var resource = {
    id: eventIdFor(b.ref, leg),
    summary: summary,
    location: location,
    description: describe(b, leg),
    start: { dateTime: b.date + 'T' + time, timeZone: TIMEZONE },
    end: { dateTime: Utilities.formatDate(end, TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss"), timeZone: TIMEZONE },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    extendedProperties: { private: opsProperties(b, leg) }
  };

  if (b.email) resource.attendees = [{ email: b.email }];

  // No read-then-write check. Two Stripe retries can arrive at once, and a check followed
  // by an insert is a race with a window between them — whereas a duplicate id is refused
  // by Google itself, atomically. Let it fail and read the failure.
  try {
    Calendar.Events.insert(resource, calendarId(), { sendUpdates: b.email ? 'all' : 'none' });
    return true;
  } catch (err) {
    if (isDuplicate(err)) return false;
    throw err;
  }
}

/**
 * Google refuses a repeated event id with 409 "The requested identifier already exists".
 * Apps Script surfaces that as a thrown exception whose message carries the text, so this
 * matches on both the code and the wording — the message is localised in some tenants and
 * the code is not always present in the Apps Script wrapper.
 */
function isDuplicate(err) {
  var s = String((err && err.message) || err);
  return /409|already exists|duplicate/i.test(s);
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

  // Written whatever happened to the two legs: a Stripe retry that finds both legs already
  // there still gets its dispatch event if the first attempt could not write one.
  var dispatch = insertDispatch(b);
  var fleet = insertFleet(b);

  // Both already present means this is a Stripe retry, not a new booking.
  if (!madePickup && !madeReturn) return out({ calendared: false, duplicate: true, dispatch: dispatch, fleet: fleet });
  return out({ calendared: true, pickup: madePickup, ret: madeReturn, dispatch: dispatch, fleet: fleet });
}

/**
 * The booking on the dispatch calendar. No attendees and no invitation — the guest already
 * has hers. Returns true if created, false if already there, or the error as a string.
 *
 * 🚨 It never throws. A throw would reach the webhook as a calendar failure, and the webhook
 * answers that by attaching the .ics to the guest's confirmation — on top of the Google
 * invitation she has already been sent.
 */
function insertDispatch(b) {
  try {
    var time = timeOf(b.pickup);
    var end = new Date(b.date + 'T' + time + '-05:00');
    end.setMinutes(end.getMinutes() + DISPATCH_MINUTES);
    var lines = [
      'Guest: ' + (b.guest || ''),
      b.email ? 'Email: ' + b.email : null,
      b.whatsapp ? 'WhatsApp: ' + b.whatsapp : null,
      b.ship ? 'Ship: ' + b.ship : null,
      b.ref,
      'Destino: ' + b.destination,
      b.vehicle + ' · ' + b.pax + ' pax',
      'Pick-up: ' + b.pickup + (b.pickupAddr ? ' · ' + b.pickupAddr : ''),
      'Pick-up ' + (b.dropoff || b.destination) + ': ' + b.ret
    ];
    Calendar.Events.insert({
      id: eventIdFor(b.ref, 'dispatch'),
      summary: 'RT Transfer ' + (b.guest || b.ref) + ' · ' + b.vehicle,
      description: lines.filter(function (l) { return l !== null; }).join('\n'),
      start: { dateTime: b.date + 'T' + time, timeZone: TIMEZONE },
      end: { dateTime: Utilities.formatDate(end, TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss"), timeZone: TIMEZONE },
      extendedProperties: { private: opsProperties(b, 'dispatch') }
    }, DISPATCH_CALENDAR_ID, { sendUpdates: 'none' });
    return true;
  } catch (err) {
    if (isDuplicate(err)) return false;
    return 'error: ' + String((err && err.message) || err);
  }
}

/**
 * A Private minivan booking (up to 4 or up to 6) also goes on the shared Minivan calendar, which Visit Cozumel's availability
 * engine counts for all three sites. The larger vans are Uniper's and stay off it.
 * 🚨 The engine reads the TITLE: "Minivan" is the word that makes it count one minivan. Keep the
 * guest's name and the ref out of the title (a name with "XL" or "cancel" in it would be misread).
 * Same rules as insertDispatch: no invitation, never throws; true / false (already there) / a string.
 */
function insertFleet(b) {
  if (!/minivan/i.test(String(b.vehicle || ''))) return 'not a minivan';
  if (!MINIVAN_CALENDAR_ID) return 'error: MINIVAN_CALENDAR_ID is not set';
  var r = insertFleetOnce(b);
  if (typeof r === 'string') { Utilities.sleep(2000); r = insertFleetOnce(b); }   // one second try for a passing hiccup
  return r;
}

function insertFleetOnce(b) {
  try {
    var start = new Date(b.date + 'T' + timeOf(b.pickup) + '-05:00');
    var end = new Date(b.date + 'T' + timeOf(b.ret) + '-05:00');
    end.setMinutes(end.getMinutes() + EVENT_MINUTES);
    if (end <= start) end = new Date(start.getTime() + EVENT_MINUTES * 60 * 1000);   // never an empty range
    Calendar.Events.insert({
      id: eventIdFor(b.ref, 'fleet'),
      summary: 'CIT · Minivan · ' + b.pax + ' pax · ' + b.destination,
      description: [b.ref, 'Guest: ' + (b.guest || ''), 'Pick-up: ' + b.pickup, 'Return: ' + b.ret,
        'Cancelled or refunded? Delete this event (or add "cancel" to its title): the websites count it until then.'].join('\n'),
      start: { dateTime: b.date + 'T' + timeOf(b.pickup), timeZone: TIMEZONE },
      end: { dateTime: Utilities.formatDate(end, TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss"), timeZone: TIMEZONE },
      extendedProperties: { private: opsProperties(b, 'fleet') }
    }, MINIVAN_CALENDAR_ID, { sendUpdates: 'none' });
    return true;
  } catch (err) {
    if (isDuplicate(err)) return false;
    return 'error: ' + String((err && err.message) || err);
  }
}

/**
 * Read-only: can this account reach the shared Minivan calendar? Reads one event, writes nothing.
 */
function fleetAccess() {
  if (!MINIVAN_CALENDAR_ID) return out({ minivan: 'error: MINIVAN_CALENDAR_ID is not set' });
  try {
    // The list answer carries this account's role on the calendar; only writer/owner can add bookings.
    var role = Calendar.Events.list(MINIVAN_CALENDAR_ID, { maxResults: 1, timeMin: new Date().toISOString() }).accessRole;
    return out({ minivan: role === 'writer' || role === 'owner' ? 'ok' : 'error: can only ' + (role || 'see') + ' — needs "Make changes to events"' });
  } catch (err) {
    return out({ minivan: 'error: ' + String((err && err.message) || err) });
  }
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
    try {
      Calendar.Events.remove(calendarId(), eventIdFor(b.ref, leg), { sendUpdates: 'all' });
      removed++;
    } catch (err) {
      // 404/410 means it was never there or is already gone — both are the desired state.
      if (!/404|410|[Nn]ot ?[Ff]ound|deleted/.test(String((err && err.message) || err))) throw err;
    }
  });
  [[DISPATCH_CALENDAR_ID, 'dispatch'], [MINIVAN_CALENDAR_ID, 'fleet']].forEach(function (c) {
    if (!c[0]) return;
    try {
      Calendar.Events.remove(c[0], eventIdFor(b.ref, c[1]), { sendUpdates: 'none' });
      removed++;
    } catch (err) {
      if (!/404|410|[Nn]ot ?[Ff]ound|deleted/.test(String((err && err.message) || err))) throw err;
    }
  });
  return out({ cancelled: removed });
}

/**
 * Read back what Google actually stored, for one booking. Diagnostic only — it changes
 * nothing and sends nothing. It exists because the two things that decide whether the
 * guest is really invited (the organizer address, and whether the attendee is attached
 * with what responseStatus) are invisible from the outside once the event is created.
 */
function inspectBooking(b) {
  if (!b || !b.ref) return out({ error: 'no booking ref' });
  var legs = {};
  ['pickup', 'return'].forEach(function (leg) {
    try {
      var ev = Calendar.Events.get(calendarId(), eventIdFor(b.ref, leg));
      legs[leg] = {
        id: ev.id, iCalUID: ev.iCalUID, status: ev.status,
        organizer: ev.organizer, creator: ev.creator,
        attendees: ev.attendees || [],
        start: ev.start, reminders: ev.reminders
      };
    } catch (err) {
      legs[leg] = { error: String((err && err.message) || err) };
    }
  });
  return out(legs);
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
    if (body.action === 'inspectBooking') return inspectBooking(body.booking);
    if (body.action === 'fleetAccess') return fleetAccess();
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
