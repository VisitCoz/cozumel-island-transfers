// ============================================================
// Cozumel Island Transfers — Booking System (CIT-only)
// Handles: Stripe PaymentIntent + Sheets + Email + Calendar
// + Daily 10 AM pickup confirmations to guests
// ============================================================
// Forked from apps-script-TM-COMPLETE.js (Tierra Maya) on 2026-05-24.
// Shape differences from TM:
//   - Products are route × vehicle (not tour tier × pax count)
//   - Sheet has explicit Pickup Location, Dropoff Location, Vehicle, Pax columns
//   - Confirmation email is operational (pickup info), not editorial
// ============================================================
// DEPLOYMENT INSTRUCTIONS:
// 1. Sign in to Google as hello@visitcozumel.com.mx
// 2. Create a new Google Sheet named "CIT Bookings"
// 3. Extensions → Apps Script → replace ALL code with this file
// 4. File → Project Properties → Script Properties:
//    - Add CIT_STRIPE_SK = sk_live_... (from the NEW Cozumel Island Transfers
//      Stripe account — do NOT reuse VC or TM keys)
// 5. Create a Google Calendar named "CIT Transfers" under this Workspace.
//    Copy its ID into CIT_CALENDAR_ID below (line ~36).
// 6. Deploy → New deployment → Web app
//    - Execute as: Me (hello@visitcozumel.com.mx)
//    - Who has access: Anyone
// 7. Copy the deployment URL into Cozumel_Island_Transfers/index.html
//    (STRIPE_SCRIPT_URL and BOOKING_SCRIPT_URL constants)
// 8. Triggers (clock icon) → Add Trigger
//    - Function: sendGuestConfirmations
//    - Time-driven → Day timer → 10am to 11am
// ============================================================
// SECURITY NOTE:
// Stripe secret is read from Script Properties ONLY. There is no fallback
// constant in this file by design — that's how TM and VC got their live
// keys leaked into Drive-synced files. Keep it that way.
// ============================================================

// ---------- Config ----------
var EMAILS = [
  'contabilidad@visitcozumel.com.mx',
  'hello@visitcozumel.com.mx',
  'operations@visitcozumel.com.mx',
  'admin@visitcozumel.com.mx',
  'e.magnusson@visitcozumel.com.mx'
];

// PLACEHOLDER — replace with the actual calendar ID after creating
// the "CIT Transfers" calendar under hello@visitcozumel.com.mx.
var CIT_CALENDAR_ID = 'REPLACE_WITH_CIT_TRANSFERS_CALENDAR_ID@group.calendar.google.com';

var CIT_DISCOUNT_CODES = {
  'WELCOME10': { percent: 10 }
  // Add more here. Format: { percent: <int> }
};

// USD prices on the form are converted to MXN at this fixed rate before
// charging Stripe. The CIT Stripe account settles in MXN, so charging in
// MXN avoids Visa Mexico's "currency_not_supported" decline on Mexican cards.
// IMPORTANT: this constant exists in BOTH this file and index.html.
// If you change it here, change it there too.
var USD_TO_MXN_RATE = 18.5;

// Server-side sanity bounds for incoming Stripe amounts (in MXN centavos,
// i.e. MXN × 100). Anything outside this window is rejected to limit
// obvious tampering. The minimum is set low enough to allow discounted
// bookings (e.g. WELCOME10 on the cheapest route) to pass through.
var MIN_AMOUNT_CENTS = 50000;     // 500 MXN ≈ $27 USD (covers heavy discounts on the cheapest van)
var MAX_AMOUNT_CENTS = 9250000;   // 92,500 MXN ≈ $5,000 USD

// ---------- Helpers ----------
function getSecret(key) {
  try {
    return PropertiesService.getScriptProperties().getProperty(key) || '';
  } catch (e) {
    return '';
  }
}

function formatDate(dateStr) {
  if (!dateStr) return 'N/A';
  try {
    var d;
    if (dateStr instanceof Date) {
      d = dateStr;
    } else {
      d = new Date(String(dateStr).substring(0, 10) + 'T12:00:00');
    }
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
  } catch (e) {
    return String(dateStr);
  }
}

// Parse "9:30 AM", "9:30am", or "14:30" into {hours, minutes}.
// Returns null if unparseable so the caller can fall back instead of
// silently producing a midnight calendar event.
function parseTime(input) {
  if (!input) return null;
  var s = String(input).trim();

  var m12 = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    var h = parseInt(m12[1], 10);
    var min = parseInt(m12[2], 10);
    var ampm = m12[3].toUpperCase();
    if (ampm === 'PM' && h < 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return { hours: h, minutes: min };
  }

  var m24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    var h2 = parseInt(m24[1], 10);
    var min2 = parseInt(m24[2], 10);
    if (h2 >= 0 && h2 <= 23 && min2 >= 0 && min2 <= 59) {
      return { hours: h2, minutes: min2 };
    }
  }

  return null;
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// CREATE PAYMENT INTENT
// ============================================================
function createPaymentIntent(data) {
  try {
    // Form sends the USD amount AFTER any discount has been applied client-side.
    // Server converts USD cents → MXN cents using the fixed rate. We do NOT
    // re-apply the discount here.
    var usdCents = Math.round(Number(data.amount));
    var amount = Math.round(usdCents * USD_TO_MXN_RATE);

    // Sanity bounds — reject obvious tampering before talking to Stripe.
    if (!isFinite(amount) || amount < MIN_AMOUNT_CENTS || amount > MAX_AMOUNT_CENTS) {
      return jsonResponse({ error: 'Invalid amount' });
    }

    // Coupon code is recorded in Stripe metadata for accounting/reconciliation
    // only. The discount itself is NOT re-applied to the amount.
    var couponCode = (data.coupon_code || '').toUpperCase();

    var stripeKey = getSecret('CIT_STRIPE_SK');
    if (!stripeKey) {
      return jsonResponse({ error: 'Stripe key not configured (set CIT_STRIPE_SK in Script Properties)' });
    }

    var payload = 'amount=' + amount
      + '&currency=mxn'
      + '&automatic_payment_methods[enabled]=true'
      + '&metadata[booking_id]=' + encodeURIComponent(data.booking_id || '')
      + '&metadata[coupon_code]=' + encodeURIComponent(couponCode)
      + '&metadata[usd_display]=' + encodeURIComponent((usdCents / 100).toFixed(2))
      + '&metadata[fx_rate]=' + encodeURIComponent(USD_TO_MXN_RATE)
      + '&metadata[route]=' + encodeURIComponent(data.route || '')
      + '&metadata[vehicle]=' + encodeURIComponent(data.vehicle || '');

    // If the form sent a customer email, attach it so Stripe sends an
    // automatic receipt after the charge succeeds.
    if (data.email) {
      payload += '&receipt_email=' + encodeURIComponent(data.email);
    }

    var response = UrlFetchApp.fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'post',
      headers: {
        'Authorization': 'Bearer ' + stripeKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      payload: payload,
      muteHttpExceptions: true
    });

    var responseCode = response.getResponseCode();
    var responseText = response.getContentText();

    if (responseCode === 200) {
      var intent = JSON.parse(responseText);
      return jsonResponse({
        clientSecret: intent.client_secret,
        booking_id: data.booking_id
      });
    }

    var error = JSON.parse(responseText);
    return jsonResponse({
      error: error.error ? error.error.message : 'Failed to create payment intent'
    });
  } catch (err) {
    return jsonResponse({ error: err.toString() });
  }
}

// ============================================================
// MAIN WEBHOOK
// ============================================================
function doPost(e) {
  var raw = e.postData.contents;
  var data = JSON.parse(raw);

  // Payment intent creation path — routed ONLY by explicit action field.
  if (data.action === 'create_intent') {
    return createPaymentIntent(data);
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('CIT Bookings');
  if (!sheet) {
    sheet = ss.insertSheet('CIT Bookings');
    sheet.appendRow([
      'Booking ID', 'Name', 'Email', 'WhatsApp', 'Date', 'Cruise Ship',
      'Pickup Time', 'Route', 'Vehicle', 'Pax',
      'Pickup Location', 'Dropoff Location',
      'Price USD', 'Total', 'Discount Code', 'Discount %',
      'Special Requests', 'Payment Status', 'Charged MXN', 'Stripe Payment ID'
    ]);
  }

  // MXN amount actually charged to Stripe (USD total × fixed rate, rounded to 2 decimals).
  var mxnCharged = data.total ? Math.round(Number(data.total) * USD_TO_MXN_RATE * 100) / 100 : '';

  sheet.appendRow([
    data.booking_id || '',
    data.name || '',
    data.email || '',
    data.whatsapp || '',
    data.date || '',
    data.cruise_ship || '',
    data.start_time || '',
    data.route || '',
    data.vehicle || '',
    data.pax || '',
    data.pickup_location || '',
    data.dropoff_location || '',
    data.price_usd || '',
    data.total || '',
    data.discount_code || '',
    data.discount_percent || '',
    data.special_requests || '',
    'Paid',
    mxnCharged,
    data.stripe_payment_id || ''
  ]);

  var dateFormatted = formatDate(data.date);
  var hasDiscount = data.discount_code && data.discount_code !== 'None';
  var discountNote = hasDiscount
    ? ' — ' + data.discount_code + ' (' + data.discount_percent + ' off)'
    : '';
  var lastName = String(data.name || 'Guest').split(' ').pop();
  var subject = 'CIT Booking: ' + lastName + ' — ' + dateFormatted
    + ' ' + (data.start_time || '') + ' — ' + (data.route || '')
    + ' ($' + data.total + ')' + discountNote;

  var body = 'NEW BOOKING FROM COZUMELISLANDTRANSFERS.COM\n\n'
    + 'Booking ID: ' + (data.booking_id || 'N/A') + '\n'
    + 'Name: ' + data.name + '\n'
    + 'Email: ' + data.email + '\n'
    + 'WhatsApp: ' + data.whatsapp + '\n\n'
    + 'Date: ' + dateFormatted + '\n'
    + 'Pickup Time: ' + data.start_time + '\n'
    + 'Route: ' + (data.route || 'N/A') + '\n'
    + 'Vehicle: ' + (data.vehicle || 'N/A') + '\n'
    + 'Pax: ' + (data.pax || 'N/A') + '\n'
    + 'Pickup Location: ' + (data.pickup_location || 'N/A') + '\n'
    + 'Dropoff Location: ' + (data.dropoff_location || 'N/A') + '\n'
    + 'Cruise Ship: ' + (data.cruise_ship || 'N/A') + '\n\n'
    + 'Price USD: $' + data.price_usd + '\n'
    + 'Total: $' + data.total + ' USD\n'
    + 'Charged: $' + mxnCharged + ' MXN (rate ' + USD_TO_MXN_RATE + ')\n'
    + (hasDiscount ? 'Discount: ' + data.discount_code + ' (' + data.discount_percent + ' off)\n' : '')
    + 'Special Requests: ' + (data.special_requests || 'None') + '\n\n'
    + 'Payment Status: PAID\n'
    + 'Stripe ID: ' + (data.stripe_payment_id || 'N/A') + '\n';

  // Send to team
  EMAILS.forEach(function (email) { MailApp.sendEmail(email, subject, body); });
  // Send same email to guest (acts as receipt)
  if (data.email) {
    MailApp.sendEmail(data.email, subject, body);
  }

  // Calendar event
  try {
    var cal = CalendarApp.getCalendarById(CIT_CALENDAR_ID);
    if (cal && data.date) {
      var startDate = new Date(data.date + 'T12:00:00');
      var parsed = parseTime(data.start_time);
      if (parsed) {
        startDate.setHours(parsed.hours, parsed.minutes, 0);
      } else if (data.start_time) {
        Logger.log('CIT: could not parse start_time "' + data.start_time + '" — defaulting to noon');
      }
      // Default duration: 1.5 hours (typical airport ↔ hotel transfer + buffer).
      var endDate = new Date(startDate.getTime() + 90 * 60 * 1000);
      var eventTitle = lastName + ' — ' + (data.route || 'Transfer')
        + ' · ' + (data.vehicle || '') + ' · ' + (data.pax || '?') + ' pax';
      var eventDesc = 'Booking ID: ' + (data.booking_id || 'N/A') + '\n'
        + 'Guest: ' + data.name + '\n'
        + 'Email: ' + data.email + '\nWhatsApp: ' + data.whatsapp + '\n\n'
        + 'Pickup: ' + (data.pickup_location || 'N/A') + '\n'
        + 'Dropoff: ' + (data.dropoff_location || 'N/A') + '\n'
        + 'Vehicle: ' + (data.vehicle || 'N/A') + '\n'
        + 'Pax: ' + (data.pax || 'N/A') + '\n\n'
        + 'Cruise: ' + (data.cruise_ship || 'N/A') + '\n'
        + 'Total: $' + data.total + ' USD\n'
        + (hasDiscount ? 'Discount: ' + data.discount_code + ' (' + data.discount_percent + ' off)\n' : '')
        + 'Special: ' + (data.special_requests || 'None') + '\n'
        + 'Payment: PAID';
      var eventOptions = {
        description: eventDesc,
        location: data.pickup_location || 'Cozumel'
      };
      if (data.email) {
        eventOptions.guests = data.email;
        eventOptions.sendInvites = true;
      }
      cal.createEvent(eventTitle, startDate, endDate, eventOptions);
    }
  } catch (calErr) {
    Logger.log('Calendar error: ' + calErr);
  }

  return jsonResponse({ status: 'success' });
}


// ============================================================
// GUEST PICKUP CONFIRMATIONS — daily 10 AM Cancun trigger
// Sends an operational pickup confirmation to each guest scheduled tomorrow,
// + a copy to the team for dispatch visibility.
// Setup: Triggers → Add Trigger → sendGuestConfirmations → Day timer → 10am to 11am
// ============================================================
function sendGuestConfirmations() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  var tomorrowStr = Utilities.formatDate(tomorrow, 'America/Cancun', 'yyyy-MM-dd');
  var tomorrowFormatted = formatDate(tomorrowStr);

  var sheet = ss.getSheetByName('CIT Bookings');
  if (!sheet || sheet.getLastRow() <= 1) return;

  var rows = sheet.getDataRange().getValues();
  // Column indices (0-based) — must match the schema in doPost
  var COL = {
    BOOKING_ID: 0, NAME: 1, EMAIL: 2, WHATSAPP: 3, DATE: 4, CRUISE: 5,
    TIME: 6, ROUTE: 7, VEHICLE: 8, PAX: 9,
    PICKUP_LOC: 10, DROPOFF_LOC: 11,
    SPECIAL: 16
  };

  for (var i = 1; i < rows.length; i++) {
    var dv = rows[i][COL.DATE];
    var bd = (dv instanceof Date)
      ? Utilities.formatDate(dv, 'America/Cancun', 'yyyy-MM-dd')
      : String(dv).substring(0, 10);
    if (bd !== tomorrowStr) continue;

    var bookingId = rows[i][COL.BOOKING_ID];
    var name = rows[i][COL.NAME];
    var email = rows[i][COL.EMAIL];
    var whatsapp = rows[i][COL.WHATSAPP];
    var cruise = rows[i][COL.CRUISE];
    var time = rows[i][COL.TIME];
    var route = rows[i][COL.ROUTE];
    var vehicle = rows[i][COL.VEHICLE];
    var pax = rows[i][COL.PAX];
    var pickupLoc = rows[i][COL.PICKUP_LOC];
    var dropoffLoc = rows[i][COL.DROPOFF_LOC];
    var requests = rows[i][COL.SPECIAL];

    if (time instanceof Date) {
      time = Utilities.formatDate(time, 'America/Cancun', 'hh:mm a');
    }

    var lastName = String(name || 'Guest').split(' ').pop();
    var subject = 'CIT Pickup Tomorrow — ' + time + ' — ' + lastName + ' (' + pax + ' guests)';

    var cruiseLine = cruise && cruise !== 'N/A'
      ? '\nCruise ship monitored: ' + cruise + ' (real-time tracking, return-on-time guarantee).'
      : '\nCruise ship monitored: yes (real-time tracking, return-on-time guarantee).';

    var body = 'Pickup Confirmation — Cozumel Island Transfers\n'
      + 'Booking ID: ' + bookingId + '\n\n'
      + 'Tomorrow, ' + tomorrowFormatted + ', ' + time + '\n'
      + 'Pickup: ' + pickupLoc + '\n'
      + 'Destination: ' + dropoffLoc + '\n'
      + 'Vehicle: ' + vehicle + '\n'
      + 'Guests: ' + pax + '\n'
      + cruiseLine + '\n\n'
      + 'Your driver will be at the pickup point holding a sign with your name.\n'
      + (requests ? 'We noted your request: ' + requests + '\n\n' : '\n')
      + 'Questions or changes? WhatsApp +52 987 114 6853 — quote booking ID ' + bookingId + '.\n\n'
      + 'Safe travels,\n'
      + 'Cozumel Island Transfers Team';

    if (email) {
      MailApp.sendEmail(email, subject, body);
    }

    // Dispatch copy to the team — so operations sees who's on the manifest for tomorrow.
    EMAILS.forEach(function (teamEmail) {
      MailApp.sendEmail(teamEmail, '[DISPATCH] ' + subject, 'GUEST EMAIL: ' + email + '\nWHATSAPP: ' + whatsapp + '\n\n' + body);
    });
  }
}

function doGet() {
  return jsonResponse({ status: 'ok', message: 'Cozumel Island Transfers booking endpoint is live' });
}
